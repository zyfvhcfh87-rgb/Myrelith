import { describe, expect, test } from 'vitest'
import { defaultClipAnimation } from './clipAnimation'
import { defaultClipVisualSettings } from './clipInspector'
import type { GlobalMotionEstimate, SimilarityTransform } from './motionAnalysis'
import type { Clip, TimelineDoc } from './schema'
import {
  createVideoStabilizationPlan,
  requiredVideoStabilizationSafeZoom,
  timestampToSourceTicks,
  VIDEO_STABILIZATION_PROPERTIES,
  type VideoStabilizationAnalysis,
  type VideoStabilizationSource,
} from './videoStabilization'

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    name: 'Stabilize me',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 90 },
    timelineRange: { startFrame: 10, durationFrames: 90 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
    ...overrides,
  }
}

function doc(item = clip(), width = 1_920, height = 1_080): TimelineDoc {
  return {
    schemaVersion: 13,
    id: 'doc-stabilize',
    name: 'Stabilization',
    frameRate: { num: 30, den: 1 },
    width,
    height,
    audioSampleRate: 48_000,
    tracks: [{
      id: 'video-1',
      kind: 'video',
      name: 'Video 1',
      clips: [item],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
}

const source: VideoStabilizationSource = {
  width: 1_920,
  height: 1_080,
  firstTimestampUs: 0,
  frameRate: { num: 30, den: 1 },
}

function estimate(transform: SimilarityTransform): GlobalMotionEstimate {
  return {
    transform,
    matchCount: 32,
    inlierCount: 30,
    inlierRatio: 30 / 32,
    meanInlierError: 0.2,
    confidence: 0.82,
  }
}

function analysis(
  transforms: readonly SimilarityTransform[] = [
    { a: 1, b: 0, tx: 1, ty: 0 },
    { a: 1, b: 0, tx: -2, ty: 1 },
    { a: 1, b: 0, tx: 2, ty: -1 },
  ],
): VideoStabilizationAnalysis {
  return {
    version: 1,
    width: 320,
    height: 180,
    samples: [
      { timestampUs: 0, estimateFromPrevious: null },
      ...transforms.map((transform, index) => ({
        timestampUs: Math.ceil((index + 1) * 1_000_000 / 30),
        estimateFromPrevious: estimate(transform),
      })),
    ],
  }
}

describe('video stabilization product planning', () => {
  test('maps source timestamps with integer source-time arithmetic', () => {
    expect(timestampToSourceTicks(0, source)).toBe(0)
    expect(timestampToSourceTicks(33_333, source)).toBe(1_000_000)
    expect(timestampToSourceTicks(33_334, source)).toBe(1_000_000)
    expect(timestampToSourceTicks(1_000_000, source)).toBe(30_000_000)
  })

  test('authors only five ordinary equal-scale tracks with explicit safe zoom', () => {
    const item = clip()
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(),
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.tracks.map((track) => track.property)).toEqual(
      VIDEO_STABILIZATION_PROPERTIES,
    )
    expect(result.plan.safeZoom).toBeGreaterThanOrEqual(1)
    expect(result.plan.safeZoom).toBeLessThanOrEqual(1.35)
    expect(result.plan.requiredCropRatio).toBeCloseTo(1 - 1 / result.plan.safeZoom, 12)
    expect(result.plan.tracks[3]?.keyframes.map((key) => key.value)).toEqual(
      result.plan.tracks[4]?.keyframes.map((key) => key.value),
    )
    expect(result.plan.tracks.every((track) => track.keyframes.every((key) => (
      Number.isSafeInteger(key.frame)
      && Number.isSafeInteger(key.sourceTimeTicks)
      && key.easing.type === 'linear'
    )))).toBe(true)
  })

  test('solves exact project coverage with crop, off-center anchor, flips, and rotation', () => {
    const item = clip({
      transform: {
        ...clip().transform,
        x: 7,
        y: -4,
        scaleX: 1.8,
        scaleY: 1.8,
        rotation: 23,
        anchorX: 0.23,
        anchorY: 0.74,
      },
      visual: {
        ...defaultClipVisualSettings(),
        crop: { left: 0.04, right: 0.03, top: 0.06, bottom: 0.02 },
        flipHorizontal: true,
      },
    })
    const transforms = [
      item.transform,
      { ...item.transform, x: 18, y: -13, rotation: 24.5, scaleX: 1.82, scaleY: 1.82 },
    ]
    const zoom = requiredVideoStabilizationSafeZoom(
      doc(item, 1_280, 720),
      item,
      source,
      transforms,
    )
    expect(zoom).not.toBeNull()
    expect(zoom!).toBeGreaterThanOrEqual(1)
  })

  test('rejects duplicate retime projections before authoring', () => {
    const item = clip({
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 90_000_000,
        rate: { numerator: 4, denominator: 1 },
      },
      sourceRange: { startFrame: 0, durationFrames: 90 },
      timelineRange: { startFrame: 10, durationFrames: 23 },
    })
    const rawDuplicate = analysis([
      { a: 1, b: 0, tx: 0, ty: 0 },
      { a: 1, b: 0, tx: 0, ty: 0 },
      { a: 1, b: 0, tx: 0, ty: 0 },
    ])
    const duplicate: VideoStabilizationAnalysis = {
      ...rawDuplicate,
      samples: rawDuplicate.samples.map((sample, index) => ({
        ...sample,
        timestampUs: index === 1 ? 1_000 : index === 2 ? 2_000 : sample.timestampUs,
      })),
    }
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      duplicate,
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )
    expect(result).toEqual({
      ok: false,
      reason: 'Source-time mapping produced duplicate stabilization frames.',
    })
  })

  test('requires explicit replacement when any owned property already animates', () => {
    const item = clip({
      animation: {
        tracks: [{
          property: 'rotation',
          keyframes: [{ frame: 0, sourceTimeTicks: 0, value: 0, easing: { type: 'linear' } }],
        }],
        effectTracks: [],
      },
    })
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(),
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.replacementRequired).toBe(true)
  })

  test('allows an owned-track replacement that reduces the document key count', () => {
    const item = clip({
      animation: {
        tracks: VIDEO_STABILIZATION_PROPERTIES.map((property) => ({
          property,
          keyframes: Array.from({ length: 80 }, (_, frame) => ({
            frame,
            sourceTimeTicks: frame * 1_000_000,
            value: property.startsWith('scale') ? 1 : 0,
            easing: { type: 'linear' as const },
          })),
        })),
        effectTracks: [],
      },
    })
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(),
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.retainedKeyframeCount * 5).toBeLessThan(400)
  })

  test('rejects anisotropic base scale rather than silently changing composition', () => {
    const item = clip({ transform: { ...clip().transform, scaleY: 1.2 } })
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(),
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('equal positive Scale X and Scale Y')
  })

  test('supports product smoothing beyond the research-only 300-frame envelope', () => {
    const durationFrames = 321
    const item = clip({
      sourceRange: { startFrame: 0, durationFrames },
      timelineRange: { startFrame: 10, durationFrames },
    })
    const transforms = Array.from({ length: durationFrames - 1 }, (_, index) => ({
      a: 1,
      b: 0,
      tx: index % 2 === 0 ? 0.05 : -0.05,
      ty: 0,
    }))
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(transforms),
      { strengthPercent: 50, smoothingRadiusFrames: 8 },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.sampleCount).toBe(durationFrames)
  })

  test('rejects an aspect-rounded analysis projection that is no longer a similarity', () => {
    const oddSource = { ...source, width: 1_921 }
    const item = clip()
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      oddSource,
      {
        ...analysis([{ a: Math.cos(0.1), b: Math.sin(0.1), tx: 0, ty: 0 }]),
        width: 320,
        height: 179,
      },
      { strengthPercent: 100, smoothingRadiusFrames: 1 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('source-projection tolerance')
  })
})
