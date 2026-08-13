import { describe, expect, test } from 'vitest'
import { defaultClipAnimation, evaluateAnimationTrack } from './clipAnimation'
import { defaultClipVisualSettings } from './clipInspector'
import {
  createMotionTrackingPlan,
  createMotionTrackingSamplePlan,
  MOTION_TRACKING_RESULT_VERSION,
  type MotionTrackingBoxAnalysis,
  type MotionTrackingPointAnalysis,
  type MotionTrackingSource,
} from './motionTracking'
import type { Clip, TimelineDoc } from './schema'
import { sourceTimeSpeedRateFromPercent } from './sourceTimeMap'

function clip(id: string, startFrame: number, durationFrames: number): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame, durationFrames },
    transform: {
      x: 10,
      y: 20,
      scaleX: 2,
      scaleY: 3,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function doc(source = clip('source', 10, 10), target = clip('target', 8, 20)): TimelineDoc {
  return {
    schemaVersion: 13,
    id: 'tracking-doc',
    name: 'Tracking',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [source, target].map((item, index) => ({
      id: `video-${index + 1}`,
      kind: 'video' as const,
      name: `Video ${index + 1}`,
      clips: [item],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    })),
  }
}

const source: MotionTrackingSource = {
  width: 200,
  height: 100,
  firstTimestampUs: 0,
  frameRate: { num: 30, den: 1 },
}

describe('motion-tracking sample planning', () => {
  test('creates exact forward and backward monotonic sparse schedules from the playhead', () => {
    const item = clip('source', 10, 5)
    const bounds = { firstTimestampUs: 0, endTimestampUs: 166_667 }
    const forward = createMotionTrackingSamplePlan(
      doc(item), item, source, bounds, 12, 'forward',
    )
    const backward = createMotionTrackingSamplePlan(
      doc(item), item, source, bounds, 12, 'backward',
    )

    expect(forward.sampleLocalFrames).toEqual([2, 3, 4])
    expect(backward.sampleLocalFrames).toEqual([2, 1, 0])
    expect(forward.sampleTimestampsUs.every((value, index, values) => index === 0 || value > values[index - 1]!)).toBe(true)
    expect(backward.sampleTimestampsUs.every((value, index, values) => index === 0 || value < values[index - 1]!)).toBe(true)
    expect(backward.sourceStartMicroseconds).toBe(Math.min(...backward.sampleTimestampsUs))
    expect(backward.sourceEndMicroseconds).toBeGreaterThan(Math.max(...backward.sampleTimestampsUs))
  })

  test('rejects a direction with fewer than two distinct rendered source frames', () => {
    const item = clip('source', 10, 5)
    expect(() => createMotionTrackingSamplePlan(
      doc(item), item, source, { firstTimestampUs: 0, endTimestampUs: 166_667 }, 10, 'backward',
    )).toThrow(/at least two distinct/)
  })

  test('rejects duplicate conformed source frames from a freeze before decode', () => {
    const item = {
      ...clip('source', 10, 5),
      sourceTimeMap: {
        sourceStartTicks: 0,
        sourceDurationTicks: 5_000_000,
        rate: { numerator: 1, denominator: 1 },
        speedCurve: {
          originFrame: 0,
          points: [
            { frame: 0, rate: sourceTimeSpeedRateFromPercent(0), easing: 'hold' as const },
            { frame: 3, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' as const },
          ],
        },
      },
    }
    expect(() => createMotionTrackingSamplePlan(
      doc(item),
      item,
      source,
      { firstTimestampUs: 0, endTimestampUs: 166_667 },
      10,
      'forward',
    )).toThrow(/duplicate conformed source frames/)
  })
})

describe('motion-tracking product planning', () => {
  test('maps box samples to ordinary target Position/Scale tracks anchored at the selection frame', () => {
    const sourceClip = clip('source', 10, 10)
    const target = clip('target', 8, 20)
    const analysis: MotionTrackingBoxAnalysis = {
      version: MOTION_TRACKING_RESULT_VERSION,
      kind: 'box',
      direction: 'forward',
      selectionLocalFrame: 2,
      width: 100,
      height: 50,
      failure: null,
      samples: [
        { timestampUs: 66_667, sourceTimeTicks: 2_000_000, localFrame: 2, x: 40, y: 20, width: 20, height: 10, confidence: 1 },
        { timestampUs: 100_000, sourceTimeTicks: 3_000_000, localFrame: 3, x: 45, y: 22, width: 22, height: 12, confidence: 0.8 },
        { timestampUs: 133_333, sourceTimeTicks: 4_000_000, localFrame: 4, x: 50, y: 24, width: 24, height: 14, confidence: 0.7 },
      ],
    }
    const result = createMotionTrackingPlan(
      doc(sourceClip, target), sourceClip, target, source, { width: 200, height: 100 }, analysis, true,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.includeScale).toBe(true)
    expect(result.plan.tracks.map((track) => track.property)).toEqual([
      'position-x', 'position-y', 'scale-x', 'scale-y',
    ])
    const selectionTargetFrame = 4
    expect(result.plan.tracks.map((track) => (
      evaluateAnimationTrack(track, selectionTargetFrame, -1)
    ))).toEqual([10, 20, 2, 3])
    expect(result.plan.tracks.every((track) => track.keyframes.every((keyframe) => (
      Number.isSafeInteger(keyframe.sourceTimeTicks)
    )))).toBe(true)
    expect(result.plan.confidenceMinimum).toBe(0.7)
  })

  test('sorts backward accepted samples while retaining the selection sample as the authored base', () => {
    const sourceClip = clip('source', 10, 10)
    const target = clip('target', 8, 20)
    const analysis: MotionTrackingPointAnalysis = {
      version: MOTION_TRACKING_RESULT_VERSION,
      kind: 'point',
      direction: 'backward',
      selectionLocalFrame: 5,
      width: 100,
      height: 50,
      failure: { localFrame: 2, code: 'lost-point', detail: 'lost' },
      samples: [
        { timestampUs: 166_667, sourceTimeTicks: 5_000_000, localFrame: 5, x: 50, y: 25, confidence: 1 },
        { timestampUs: 133_333, sourceTimeTicks: 4_000_000, localFrame: 4, x: 48, y: 24, confidence: 0.8 },
        { timestampUs: 100_000, sourceTimeTicks: 3_000_000, localFrame: 3, x: 46, y: 23, confidence: 0.7 },
      ],
    }
    const result = createMotionTrackingPlan(
      doc(sourceClip, target), sourceClip, target, source, { width: 200, height: 100 }, analysis, false,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.tracks[0]?.keyframes.map((keyframe) => keyframe.frame)).toEqual([5, 6, 7])
    expect(evaluateAnimationTrack(result.plan.tracks[0]!, 7, -1)).toBe(10)
    expect(result.plan.stopped?.localFrame).toBe(2)
  })

  test('uses the tracked box center so pure growth does not create false position motion', () => {
    const sourceClip = clip('source', 10, 10)
    const target = clip('target', 8, 20)
    const analysis: MotionTrackingBoxAnalysis = {
      version: MOTION_TRACKING_RESULT_VERSION,
      kind: 'box',
      direction: 'forward',
      selectionLocalFrame: 2,
      width: 100,
      height: 50,
      failure: null,
      samples: [
        { timestampUs: 0, sourceTimeTicks: 2_000_000, localFrame: 2, x: 40, y: 20, width: 20, height: 10, confidence: 1 },
        { timestampUs: 1, sourceTimeTicks: 3_000_000, localFrame: 3, x: 35, y: 17.5, width: 30, height: 15, confidence: 1 },
      ],
    }
    const result = createMotionTrackingPlan(
      doc(sourceClip, target),
      sourceClip,
      target,
      source,
      { width: 200, height: 100 },
      analysis,
      true,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.tracks.find((track) => track.property === 'position-x')
      ?.keyframes.map((keyframe) => keyframe.value)).toEqual([10, 10])
    expect(result.plan.tracks.find((track) => track.property === 'position-y')
      ?.keyframes.map((keyframe) => keyframe.value)).toEqual([20, 20])
  })

  test('resolves preserved target rotation for every position and box-scale sample', () => {
    const sourceClip = clip('source', 10, 10)
    const animatedTarget: Clip = {
      ...clip('target', 8, 20),
      visual: {
        ...defaultClipVisualSettings(),
        crop: { top: 0, right: 0, bottom: 0, left: 0.2 },
      },
      animation: {
        tracks: [{
          property: 'rotation',
          keyframes: [
            { frame: 4, sourceTimeTicks: 4_000_000, value: 0, easing: { type: 'linear' } },
            { frame: 5, sourceTimeTicks: 5_000_000, value: 90, easing: { type: 'linear' } },
          ],
        }],
        effectTracks: [],
      },
    }
    const point: MotionTrackingPointAnalysis = {
      version: MOTION_TRACKING_RESULT_VERSION,
      kind: 'point',
      direction: 'forward',
      selectionLocalFrame: 2,
      width: 100,
      height: 50,
      failure: null,
      samples: [
        { timestampUs: 0, sourceTimeTicks: 2_000_000, localFrame: 2, x: 50, y: 25, confidence: 1 },
        { timestampUs: 1, sourceTimeTicks: 3_000_000, localFrame: 3, x: 50, y: 25, confidence: 1 },
      ],
    }
    const pointPlan = createMotionTrackingPlan(
      doc(sourceClip, animatedTarget),
      sourceClip,
      animatedTarget,
      source,
      { width: 200, height: 100 },
      point,
      false,
    )

    expect(pointPlan.ok).toBe(true)
    if (!pointPlan.ok) return
    const positionX = pointPlan.plan.tracks.find((track) => track.property === 'position-x')!
    const positionY = pointPlan.plan.tracks.find((track) => track.property === 'position-y')!
    expect(positionX.keyframes[0]?.value).toBeCloseTo(10, 12)
    expect(positionX.keyframes[1]?.value).toBeCloseTo(50, 12)
    expect(positionY.keyframes[0]?.value).toBeCloseTo(20, 12)
    expect(positionY.keyframes[1]?.value).toBeCloseTo(-20, 12)

    const box: MotionTrackingBoxAnalysis = {
      ...point,
      kind: 'box',
      samples: point.samples.map((sample) => ({
        ...sample,
        x: 40,
        y: 20,
        width: 20,
        height: 10,
      })),
    }
    const boxPlan = createMotionTrackingPlan(
      doc(sourceClip, animatedTarget),
      sourceClip,
      animatedTarget,
      source,
      { width: 200, height: 100 },
      box,
      true,
    )

    expect(boxPlan.ok).toBe(true)
    if (!boxPlan.ok) return
    expect(boxPlan.plan.tracks.find((track) => track.property === 'scale-x')
      ?.keyframes.map((keyframe) => keyframe.value)).toEqual([2, 1.5])
    expect(boxPlan.plan.tracks.find((track) => track.property === 'scale-y')
      ?.keyframes.map((keyframe) => keyframe.value)).toEqual([3, 4])
  })

  test('rejects targets that do not cover the complete accepted sample range', () => {
    const sourceClip = clip('source', 10, 10)
    const target = clip('target', 12, 2)
    const analysis: MotionTrackingPointAnalysis = {
      version: 1,
      kind: 'point',
      direction: 'forward',
      selectionLocalFrame: 2,
      width: 100,
      height: 50,
      failure: null,
      samples: [
        { timestampUs: 0, sourceTimeTicks: 2_000_000, localFrame: 2, x: 50, y: 25, confidence: 1 },
        { timestampUs: 1, sourceTimeTicks: 3_000_000, localFrame: 3, x: 51, y: 25, confidence: 1 },
        { timestampUs: 2, sourceTimeTicks: 4_000_000, localFrame: 4, x: 52, y: 25, confidence: 1 },
      ],
    }
    expect(createMotionTrackingPlan(
      doc(sourceClip, target), sourceClip, target, source, { width: 200, height: 100 }, analysis, false,
    )).toEqual({ ok: false, reason: 'The target clip must overlap the complete accepted tracking range.' })
  })
})
