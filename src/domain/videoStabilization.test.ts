import { describe, expect, test } from 'vitest'
import { defaultClipAnimation, evaluateAnimationTrack } from './clipAnimation'
import { defaultClipVisualSettings } from './clipInspector'
import type { GlobalMotionEstimate, SimilarityTransform } from './motionAnalysis'
import type { Clip, TimelineDoc } from './schema'
import {
  createVideoStabilizationSamplePlan,
  createVideoStabilizationPlan,
  requiredVideoStabilizationSafeZoom,
  sourceTicksToTimestamp,
  timestampToSourceTicks,
  VIDEO_STABILIZATION_ALGORITHM_VERSION,
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
    schemaVersion: 19,
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
    version: 3,
    width: 320,
    height: 180,
    samples: [
      { timestampUs: 0, sourceTimeTicks: 0, estimateFromPrevious: null },
      ...transforms.map((transform, index) => ({
        timestampUs: Math.ceil((index + 1) * 1_000_000 / 30),
        sourceTimeTicks: (index + 1) * 1_000_000,
        estimateFromPrevious: estimate(transform),
      })),
    ],
  }
}

describe('video stabilization product planning', () => {
  test('maps source timestamps with integer source-time arithmetic', () => {
    expect(timestampToSourceTicks(0, doc().frameRate)).toBe(0)
    expect(timestampToSourceTicks(33_333, doc().frameRate)).toBe(1_000_000)
    expect(timestampToSourceTicks(33_334, doc().frameRate)).toBe(1_000_000)
    expect(timestampToSourceTicks(1_000_000, doc().frameRate)).toBe(30_000_000)
  })

  test('converts conformed source ticks at the project rate instead of the native rate', () => {
    const project30 = { num: 30, den: 1 }

    expect(sourceTicksToTimestamp(30_000_000, project30, 'floor'))
      .toBe(1_000_000)
    expect(timestampToSourceTicks(1_000_000, project30))
      .toBe(30_000_000)
    expect(sourceTicksToTimestamp(1, project30, 'floor')).toBe(0)
    expect(sourceTicksToTimestamp(1, project30, 'ceil')).toBe(1)
    expect(() => timestampToSourceTicks(-1, project30))
      .toThrow('outside the connected source')
  })

  test.each([7_000, -7_000])(
    'normalizes first presentation timestamp %i to the rendered zero-relative timeline',
    (firstTimestampUs) => {
      const native24: VideoStabilizationSource = {
        ...source,
        firstTimestampUs,
        frameRate: { num: 24, den: 1 },
      }
      const item = clip({ timelineRange: { startFrame: 10, durationFrames: 3 } })
      const plan = createVideoStabilizationSamplePlan(
        doc(item),
        item,
        native24,
        { firstTimestampUs, endTimestampUs: firstTimestampUs + 1_000_000 },
      )

      expect(plan.sampleTimestampsUs).toEqual([0, 33_333, 66_667])
      expect(plan.sampleSourceTimeTicks).toEqual([0, 1_000_000, 2_000_000])
      expect(plan.sourceStartMicroseconds).toBe(0)
      expect(plan.sourceEndMicroseconds).toBe(100_000)
      expect(VIDEO_STABILIZATION_ALGORITHM_VERSION).toBe('similarity-product-v5')
    },
  )

  test('selects the exact rendered native-frame sequence for fractional bounds and retiming', () => {
    const native24: VideoStabilizationSource = {
      ...source,
      frameRate: { num: 24, den: 1 },
    }
    const ordinary = clip({
      sourceTimeMap: {
        sourceStartTicks: 500_000,
        sourceDurationTicks: 90_000_000,
        rate: { numerator: 1, denominator: 1 },
      },
      timelineRange: { startFrame: 10, durationFrames: 6 },
    })
    const ordinaryPlan = createVideoStabilizationSamplePlan(
      doc(ordinary),
      ordinary,
      native24,
      { firstTimestampUs: 0, endTimestampUs: 2_000_000 },
    )

    expect(ordinaryPlan.sampleTimestampsUs).toEqual([0, 33_333, 66_667, 100_000, 133_333, 166_667])
    expect(ordinaryPlan.sampleSourceTimeTicks).toEqual([
      500_000,
      1_500_000,
      2_500_000,
      3_500_000,
      4_500_000,
      5_500_000,
    ])
    expect(ordinaryPlan.sourceStartMicroseconds).toBe(0)
    expect(ordinaryPlan.sourceEndMicroseconds).toBe(200_000)

    const fast = clip({
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 90_000_000,
        rate: { numerator: 4, denominator: 1 },
      },
      timelineRange: { startFrame: 10, durationFrames: 3 },
    })
    const fastPlan = createVideoStabilizationSamplePlan(
      doc(fast),
      fast,
      native24,
      { firstTimestampUs: 0, endTimestampUs: 2_000_000 },
    )
    expect(fastPlan.sampleTimestampsUs).toEqual([0, 133_333, 266_667])
    expect(fastPlan.sampleSourceTimeTicks).toEqual([0, 4_000_000, 8_000_000])
    expect(() => createVideoStabilizationSamplePlan(
      doc(fast),
      fast,
      native24,
      { firstTimestampUs: 0, endTimestampUs: 2_000_000 },
      2,
    )).toThrow('sample plan exceeds the reviewed product envelope')
  })

  test('holds corrections when native-rate conforming repeats a rendered image at 1x', () => {
    const native24: VideoStabilizationSource = {
      ...source,
      frameRate: { num: 24, den: 1 },
    }
    const item = clip({ timelineRange: { startFrame: 10, durationFrames: 6 } })
    const analyzed = analysis([
      { a: 1, b: 0, tx: 1, ty: 0 },
      { a: 1, b: 0, tx: -2, ty: 1 },
      { a: 1, b: 0, tx: 3, ty: -1 },
      { a: 1, b: 0, tx: -1, ty: 2 },
      { a: 1, b: 0, tx: 2, ty: -2 },
    ])
    const nativeSamples: VideoStabilizationAnalysis = {
      ...analyzed,
      samples: analyzed.samples.map((sample, index) => ({
        ...sample,
        timestampUs: [0, 0, 66_667, 100_000, 133_333, 166_667][index]!,
        sourceTimeTicks: [0, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000][index]!,
        estimateFromPrevious: index === 1 ? null : sample.estimateFromPrevious,
      })),
    }
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      native24,
      nativeSamples,
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )

    if (!result.ok) throw new Error(result.reason)
    for (const track of result.plan.tracks) {
      expect(evaluateAnimationTrack(track, 0, -1)).toBe(
        evaluateAnimationTrack(track, 1, -1),
      )
      expect(track.keyframes.find((key) => key.frame === 0)?.easing)
        .toEqual({ type: 'hold' })
    }
  })

  test('holds corrections when adjacent render targets decode the same media sample', () => {
    const item = clip({ timelineRange: { startFrame: 10, durationFrames: 6 } })
    const decoded = analysis([
      { a: 1, b: 0, tx: 1, ty: 0 },
      { a: 1, b: 0, tx: -2, ty: 1 },
      { a: 1, b: 0, tx: 3, ty: -1 },
      { a: 1, b: 0, tx: -1, ty: 2 },
      { a: 1, b: 0, tx: 2, ty: -2 },
    ])
    const duplicateSample: VideoStabilizationAnalysis = {
      ...decoded,
      samples: decoded.samples.map((sample, index) => ({
        ...sample,
        timestampUs: [0, 0, 66_667, 100_000, 133_333, 166_667][index]!,
        estimateFromPrevious: index === 1 ? null : sample.estimateFromPrevious,
      })),
    }
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      duplicateSample,
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )

    if (!result.ok) throw new Error(result.reason)
    for (const track of result.plan.tracks) {
      expect(evaluateAnimationTrack(track, 0, -1)).toBe(
        evaluateAnimationTrack(track, 1, -1),
      )
      expect(track.keyframes.find((key) => key.frame === 0)?.easing)
        .toEqual({ type: 'hold' })
    }
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

  test('pins both edges of a source-time freeze with hold keyframes', () => {
    const item = clip({
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 90_000_000,
        rate: { numerator: 1, denominator: 1 },
        speedCurve: {
          originFrame: 0,
          points: [
            { frame: 0, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
            { frame: 2, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
            { frame: 5, rate: { numerator: 1, denominator: 1 }, easing: 'hold' },
          ],
        },
      },
      sourceRange: { startFrame: 0, durationFrames: 90 },
      timelineRange: { startFrame: 10, durationFrames: 8 },
    })
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(),
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const track of result.plan.tracks) {
      const freezeStart = track.keyframes.find((keyframe) => keyframe.frame === 2)
      const freezeEnd = track.keyframes.find((keyframe) => keyframe.frame === 5)
      expect(freezeStart?.easing).toEqual({ type: 'hold' })
      expect(freezeEnd?.value).toBe(freezeStart?.value)
      const values = [2, 3, 4, 5].map((frame) => evaluateAnimationTrack(track, frame, -1))
      expect(new Set(values).size).toBe(1)
    }
    const positionX = result.plan.tracks.find((track) => track.property === 'position-x')!
    expect(evaluateAnimationTrack(positionX, 1, -1)).not.toBe(
      evaluateAnimationTrack(positionX, 2, -1),
    )
  })

  test('holds corrections while slow motion repeats each decoded source frame', () => {
    const item = clip({
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 90_000_000,
        rate: { numerator: 1, denominator: 4 },
      },
      sourceRange: { startFrame: 0, durationFrames: 90 },
      timelineRange: { startFrame: 10, durationFrames: 12 },
    })
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(),
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const track of result.plan.tracks) {
      for (const [start, end] of [[0, 3], [4, 7], [8, 11]] as const) {
        const first = track.keyframes.find((keyframe) => keyframe.frame === start)
        const last = track.keyframes.find((keyframe) => keyframe.frame === end)
        expect(first?.easing).toEqual({ type: 'hold' })
        expect(last?.value).toBe(first?.value)
        const values = Array.from(
          { length: end - start + 1 },
          (_, offset) => evaluateAnimationTrack(track, start + offset, -1),
        )
        expect(new Set(values).size).toBe(1)
      }
    }
    const positionX = result.plan.tracks.find((track) => track.property === 'position-x')!
    expect(evaluateAnimationTrack(positionX, 3, -1)).not.toBe(
      evaluateAnimationTrack(positionX, 4, -1),
    )
  })

  test('aligns fractional-speed corrections to the frame actually displayed', () => {
    const analyzed = analysis([
      { a: 1, b: 0, tx: 1, ty: 0 },
      { a: 1, b: 0, tx: -2, ty: 1 },
      { a: 1, b: 0, tx: 3, ty: -1 },
      { a: 1, b: 0, tx: -1, ty: 2 },
      { a: 1, b: 0, tx: 2, ty: -2 },
    ])
    const ordinary = clip({
      sourceRange: { startFrame: 0, durationFrames: 90 },
      timelineRange: { startFrame: 10, durationFrames: 6 },
    })
    const slow = clip({
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 90_000_000,
        rate: { numerator: 3, denominator: 4 },
      },
      sourceRange: { startFrame: 0, durationFrames: 90 },
      timelineRange: { startFrame: 10, durationFrames: 8 },
    })
    const ordinaryResult = createVideoStabilizationPlan(
      doc(ordinary),
      ordinary,
      source,
      analyzed,
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )
    const slowResult = createVideoStabilizationPlan(
      doc(slow),
      slow,
      source,
      analyzed,
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )

    expect(ordinaryResult.ok).toBe(true)
    expect(slowResult.ok).toBe(true)
    if (!ordinaryResult.ok || !slowResult.ok) return
    const displayedAt = [0, 2, 3, 4, 6, 7]
    for (const ordinaryTrack of ordinaryResult.plan.tracks) {
      const slowTrack = slowResult.plan.tracks.find(
        (track) => track.property === ordinaryTrack.property,
      )!
      for (let sourceFrame = 0; sourceFrame < displayedAt.length; sourceFrame++) {
        expect(evaluateAnimationTrack(slowTrack, displayedAt[sourceFrame]!, -1)).toBeCloseTo(
          evaluateAnimationTrack(ordinaryTrack, sourceFrame, -1),
          10,
        )
      }
    }
  })

  test('rejects repeated-frame boundaries beyond the keyframe envelope', () => {
    const item = clip({
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 90_000_000,
        rate: { numerator: 1, denominator: 4 },
      },
      sourceRange: { startFrame: 0, durationFrames: 90 },
      timelineRange: { startFrame: 10, durationFrames: 2_052 },
    })
    const result = createVideoStabilizationPlan(
      doc(item),
      item,
      source,
      analysis(),
      { strengthPercent: 50, smoothingRadiusFrames: 2 },
    )

    expect(result).toEqual({
      ok: false,
      reason: 'Stabilization exceeds the bounded simplification envelope or 1024 keys per track.',
    })
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

  test('reviews exact coverage from a single-pass transform stream', () => {
    const item = clip()
    const transforms = [
      item.transform,
      { ...item.transform, x: 12, y: -7, rotation: 1.5, scaleX: 1.02, scaleY: 1.02 },
    ]
    let iteratorCount = 0
    const singlePass = {
      [Symbol.iterator](): Iterator<Clip['transform']> {
        iteratorCount++
        if (iteratorCount > 1) throw new Error('coverage stream was consumed more than once')
        return transforms[Symbol.iterator]()
      },
    }

    expect(requiredVideoStabilizationSafeZoom(doc(item), item, source, singlePass))
      .toBeGreaterThanOrEqual(1)
    expect(iteratorCount).toBe(1)
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
