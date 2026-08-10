import { describe, expect, test } from 'vitest'
import type { Clip } from './schema'
import {
  canonicalSourceTimeRate,
  defaultSourceTimeMap,
  retimeClipAnimation,
  sourceFrameAtTimelineFrame,
  sourceRangeForMap,
  sourceTicksAtTimelineOffset,
  sourceTimeAudioPolicy,
  sourceTimeMapAtOffset,
  sourceTimeMapForTimelineDuration,
  sourceTimeMapValidationError,
  sourceTimeRateFromPercent,
  sourceTimeRatePercent,
  sourceTimeSpeedRateFromPercent,
  timelineFramesWithinSourceMap,
  timelineOffsetAtSourceTicks,
  timelineFramesWithinSourceTicks,
  SOURCE_TIME_TICKS_PER_FRAME,
} from './sourceTimeMap'

function clip(): Clip {
  return {
    id: 'clip',
    assetId: 'asset',
    name: 'Clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 10, durationFrames: 20 },
    sourceTimeMap: {
      sourceStartTicks: 10 * SOURCE_TIME_TICKS_PER_FRAME,
      sourceDurationTicks: 20 * SOURCE_TIME_TICKS_PER_FRAME,
      rate: { numerator: 3, denominator: 2 },
    },
    timelineRange: { startFrame: 50, durationFrames: 13 },
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
    effects: [],
  }
}

describe('SourceTimeMap', () => {
  test('maps every frame from one fixed rational origin without drift', () => {
    const map = clip().sourceTimeMap!
    expect(sourceTicksAtTimelineOffset(map, 1)).toBe(11_500_000)
    expect(sourceTicksAtTimelineOffset(map, 10_000)).toBe(15_010_000_000)
    expect(sourceFrameAtTimelineFrame(clip(), 50)).toBe(10)
    expect(sourceFrameAtTimelineFrame(clip(), 51)).toBe(11)
    expect(sourceFrameAtTimelineFrame(clip(), 52)).toBe(13)
  })

  test('keeps exact fractional phase when split or trimmed at slow speed', () => {
    const map = {
      sourceStartTicks: 0,
      sourceDurationTicks: 2_000_000,
      rate: sourceTimeRateFromPercent(50),
    }
    const left = sourceTimeMapForTimelineDuration(map, 1)
    const right = sourceTimeMapAtOffset(map, 1)
    expect(right.sourceStartTicks).toBe(500_000)
    expect(sourceRangeForMap(left, 1)).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(sourceRangeForMap(right, 3)).toEqual({ startFrame: 0, durationFrames: 2 })
  })

  test('split and trim origins compose exactly for every accepted rational step', () => {
    const map = {
      sourceStartTicks: 125_000,
      sourceDurationTicks: 20_000_000,
      rate: { numerator: 3, denominator: 4 },
    }
    const direct = sourceTimeMapAtOffset(map, 7)
    const splitThenTrimmed = sourceTimeMapAtOffset(
      sourceTimeMapAtOffset(map, 3),
      4,
    )

    expect(splitThenTrimmed).toEqual(direct)
    expect(direct.sourceStartTicks).toBe(5_375_000)
  })

  test('uses reduced bounded rational Inspector rates', () => {
    expect(sourceTimeRateFromPercent(25)).toEqual({ numerator: 1, denominator: 4 })
    expect(sourceTimeRateFromPercent(150)).toEqual({ numerator: 3, denominator: 2 })
    expect(sourceTimeRatePercent(sourceTimeRateFromPercent(400))).toBe(400)
    expect(() => sourceTimeRateFromPercent(10)).toThrow(/25% step/)
    expect(() => sourceTimeRateFromPercent(425)).toThrow(/1\/4x through 4x/)
    expect(() => canonicalSourceTimeRate(1, 3)).toThrow(/fixed source-time tick precision/)
  })

  test('converts exact source handle capacity back to whole timeline frames', () => {
    expect(timelineFramesWithinSourceTicks(9_000_000, { numerator: 3, denominator: 2 })).toBe(6)
    expect(timelineFramesWithinSourceTicks(1_000_000, { numerator: 1, denominator: 2 })).toBe(2)
  })

  test('keeps legacy 1x clips byte-behavior compatible and mutes unsupported audio maps', () => {
    const legacy = clip()
    delete legacy.sourceTimeMap
    legacy.sourceRange = { startFrame: 10, durationFrames: 13 }
    expect(sourceFrameAtTimelineFrame(legacy, 55)).toBe(15)
    expect(sourceTimeAudioPolicy(legacy)).toEqual({ status: 'supported' })
    expect(sourceTimeAudioPolicy(clip())).toEqual({
      status: 'muted',
      reason: 'constant-speed-audio-unsupported',
    })
    expect(defaultSourceTimeMap(10)).toEqual({
      sourceStartTicks: 10_000_000,
      sourceDurationTicks: 1_000_000,
      rate: { numerator: 1, denominator: 1 },
      speedCurve: { originFrame: 0, points: [] },
    })
  })

  test('integrates hold, linear, smooth, and bounded freeze segments deterministically', () => {
    const linear = {
      ...defaultSourceTimeMap(0, 20),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' as const },
          { frame: 4, rate: sourceTimeSpeedRateFromPercent(200), easing: 'linear' as const },
        ],
      },
    }
    expect(sourceTicksAtTimelineOffset(linear, 1)).toBe(1_125_000)
    expect(sourceTicksAtTimelineOffset(linear, 2)).toBe(2_500_000)
    expect(sourceTicksAtTimelineOffset(linear, 4)).toBe(6_000_000)
    expect(sourceTicksAtTimelineOffset(linear, 5)).toBe(8_000_000)

    const smooth = {
      ...linear,
      speedCurve: {
        ...linear.speedCurve,
        points: linear.speedCurve.points.map((point, index) => ({
          ...point,
          easing: index === 0 ? 'smooth' as const : point.easing,
        })),
      },
    }
    expect(sourceTicksAtTimelineOffset(smooth, 2)).toBe(2_375_000)
    expect(sourceTicksAtTimelineOffset(smooth, 4)).toBe(6_000_000)

    const freeze = {
      ...defaultSourceTimeMap(0, 4),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(0), easing: 'hold' as const },
          { frame: 3, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' as const },
        ],
      },
    }
    expect(sourceTicksAtTimelineOffset(freeze, 3)).toBe(0)
    expect(sourceTicksAtTimelineOffset(freeze, 4)).toBe(1_000_000)
    expect(timelineFramesWithinSourceMap(freeze)).toBe(7)
    expect(timelineOffsetAtSourceTicks(freeze, 0, 0, 7)).toBe(3)
  })

  test('keeps ramp phase exact across split and trim origins', () => {
    const map = {
      ...defaultSourceTimeMap(5, 30),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(50), easing: 'smooth' as const },
          { frame: 6, rate: sourceTimeSpeedRateFromPercent(200), easing: 'linear' as const },
        ],
      },
    }
    const direct = sourceTimeMapAtOffset(map, 5)
    const composed = sourceTimeMapAtOffset(sourceTimeMapAtOffset(map, 2), 3)
    expect(composed).toEqual(direct)
    expect(direct.speedCurve?.originFrame).toBe(5)
    expect(sourceTicksAtTimelineOffset(direct, 4)).toBe(
      sourceTicksAtTimelineOffset(map, 9),
    )
  })

  test('falls back to the preserved constant map for invalid in-memory curves', () => {
    const invalid = {
      ...defaultSourceTimeMap(2, 10),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 3, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' as const },
          { frame: 3, rate: sourceTimeSpeedRateFromPercent(200), easing: 'linear' as const },
        ],
      },
    }
    expect(sourceTimeMapValidationError(invalid)).toMatch(/strictly increasing/)
    expect(sourceTicksAtTimelineOffset(invalid, 4)).toBe(6_000_000)
    const invalidClip = { ...clip(), sourceTimeMap: invalid }
    expect(sourceTimeAudioPolicy(invalidClip)).toEqual({
      status: 'muted',
      reason: 'invalid-speed-curve',
    })
    expect(sourceTimeMapValidationError({
      ...invalid,
      speedCurve: {
        originFrame: 0,
        points: [{
          frame: 0,
          rate: sourceTimeSpeedRateFromPercent(0),
          easing: 'hold' as const,
        }],
      },
    })).toMatch(/final speed point must be positive/)
  })

  test('finds extreme finite ramp capacity after an overflowed exponential probe', () => {
    const map = {
      sourceStartTicks: 0,
      sourceDurationTicks: Number.MAX_SAFE_INTEGER,
      rate: sourceTimeRateFromPercent(100),
      speedCurve: {
        originFrame: 0,
        points: [{
          frame: 0,
          rate: sourceTimeSpeedRateFromPercent(25),
          easing: 'hold' as const,
        }],
      },
    }

    expect(timelineFramesWithinSourceMap(map)).toBe(
      Number(BigInt(Number.MAX_SAFE_INTEGER) / 250_000n),
    )
  })

  test('preserves the exact out-point across non-divisible speed changes', () => {
    const original = defaultSourceTimeMap(0, 100)
    const slow = {
      ...original,
      rate: sourceTimeRateFromPercent(75),
    }
    expect(timelineFramesWithinSourceTicks(
      slow.sourceDurationTicks,
      slow.rate,
    )).toBe(133)
    expect(sourceRangeForMap(slow, 133)).toEqual({
      startFrame: 0,
      durationFrames: 100,
    })
    expect(timelineFramesWithinSourceTicks(
      slow.sourceDurationTicks,
      sourceTimeRateFromPercent(100),
    )).toBe(100)
  })

  test('keeps durable keyframe source intent across repeated rate round trips', () => {
    const unity = defaultSourceTimeMap(10, 3)
    const oneFifty = { ...unity, rate: sourceTimeRateFromPercent(150) }
    const twoHundred = { ...unity, rate: sourceTimeRateFromPercent(200) }
    const seventyFive = { ...unity, rate: sourceTimeRateFromPercent(75) }
    const original = {
      tracks: [{
        property: 'opacity' as const,
        keyframes: [{ frame: 1, value: 0.5, easing: { type: 'linear' as const } }],
      }],
    }

    const atOneFifty = retimeClipAnimation(original, unity, oneFifty, 2)
    expect(atOneFifty?.tracks[0].keyframes[0]).toMatchObject({
      frame: 0,
      sourceTimeTicks: 11_000_000,
    })
    const atTwoHundred = retimeClipAnimation(atOneFifty!, oneFifty, twoHundred, 1)
    const atSeventyFive = retimeClipAnimation(atTwoHundred!, twoHundred, seventyFive, 4)
    const restored = retimeClipAnimation(atSeventyFive!, seventyFive, unity, 3)

    expect(restored?.tracks[0].keyframes[0]).toMatchObject({
      frame: 1,
      sourceTimeTicks: 11_000_000,
    })
  })
})
