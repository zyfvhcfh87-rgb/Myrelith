import { describe, expect, test } from 'vitest'
import type { Clip } from './schema'
import {
  canonicalSourceTimeRate,
  audioSampleFromSourceTicks,
  clipAudioPresentation,
  defaultSourceTimeMap,
  sourceTicksToSeconds,
  retimeClipAnimation,
  sourceFrameAtTimelineFrame,
  sourceRangeForMap,
  sourceTicksAtTimelineOffset,
  sourceTimeAudioPolicy,
  sourceTimeMapAtOffset,
  sourceTimeMapForTimelineDuration,
  sourceTimeMapValidationError,
  sourceTimeMapWholeClipSpeed,
  sourceTimeMapWithSpeedPoint,
  sourceTimeRateFromPercent,
  sourceTimeRatePercent,
  sourceTimeSpeedRateFromPercent,
  stretchQualityBand,
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

  test('keeps legacy 1x clips byte-behavior compatible and classifies constant stretch', () => {
    const legacy = clip()
    delete legacy.sourceTimeMap
    legacy.sourceRange = { startFrame: 10, durationFrames: 13 }
    expect(sourceFrameAtTimelineFrame(legacy, 55)).toBe(15)
    expect(sourceTimeAudioPolicy(legacy)).toEqual({
      status: 'supported',
      kind: 'direct',
    })
    expect(sourceTimeAudioPolicy(clip())).toEqual({
      status: 'supported',
      kind: 'stretched',
      rate: { numerator: 3, denominator: 2 },
    })
    expect(defaultSourceTimeMap(10)).toEqual({
      sourceStartTicks: 10_000_000,
      sourceDurationTicks: 1_000_000,
      rate: { numerator: 1, denominator: 1 },
      speedCurve: { originFrame: 0, points: [] },
    })
  })

  test('classifies an all-constant non-unity curve as stretch', () => {
    const stretched = clip()
    stretched.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      rate: sourceTimeRateFromPercent(100),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(200), easing: 'hold' },
          { frame: 10, rate: sourceTimeSpeedRateFromPercent(200), easing: 'linear' },
        ],
      },
    }

    expect(sourceTimeAudioPolicy(stretched)).toEqual({
      status: 'supported',
      kind: 'stretched',
      rate: { numerator: 2, denominator: 1 },
    })
  })

  test('admits mixed positive ramps and freeze maps with explicit bounded policy', () => {
    const ramp = clip()
    ramp.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' },
          { frame: 10, rate: sourceTimeSpeedRateFromPercent(200), easing: 'hold' },
        ],
      },
    }
    const freeze = clip()
    freeze.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(0), easing: 'hold' },
          { frame: 10, rate: sourceTimeSpeedRateFromPercent(100), easing: 'hold' },
        ],
      },
    }
    const zeroBoundary = clip()
    zeroBoundary.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(0), easing: 'linear' },
          { frame: 10, rate: sourceTimeSpeedRateFromPercent(100), easing: 'hold' },
        ],
      },
    }

    expect(sourceTimeAudioPolicy(ramp)).toEqual({
      status: 'supported',
      kind: 'ramped',
      quality: 'edge',
      hasSilence: false,
    })
    expect(sourceTimeAudioPolicy(freeze)).toEqual({
      status: 'supported',
      kind: 'ramped',
      quality: 'edge',
      hasSilence: true,
    })
    expect(sourceTimeAudioPolicy(zeroBoundary)).toEqual({
      status: 'supported',
      kind: 'ramped',
      quality: 'edge',
      hasSilence: false,
    })
  })

  test('requires an integer source origin only for direct 1x audio', () => {
    const subFrame = clip()
    subFrame.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      sourceStartTicks: 500_000,
    }
    const allUnity = clip()
    allUnity.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      speedCurve: {
        originFrame: 0,
        points: [
          { frame: 0, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' },
          { frame: 10, rate: sourceTimeSpeedRateFromPercent(100), easing: 'hold' },
        ],
      },
    }
    const subFrameAllUnity = clip()
    subFrameAllUnity.sourceTimeMap = {
      ...allUnity.sourceTimeMap,
      sourceStartTicks: 500_000,
    }

    expect(sourceTimeAudioPolicy(subFrame)).toEqual({
      status: 'muted',
      reason: 'sub-frame-origin-audio-unsupported',
    })
    expect(sourceTimeAudioPolicy(allUnity)).toEqual({
      status: 'supported',
      kind: 'direct',
    })
    expect(sourceTimeAudioPolicy(subFrameAllUnity)).toEqual({
      status: 'muted',
      reason: 'sub-frame-origin-audio-unsupported',
    })
  })

  test('reports stretch quality and clip audio presentation', () => {
    expect(stretchQualityBand(sourceTimeRateFromPercent(75))).toBe('nominal')
    expect(stretchQualityBand(sourceTimeRateFromPercent(150))).toBe('nominal')
    expect(stretchQualityBand(sourceTimeRateFromPercent(50))).toBe('edge')
    expect(stretchQualityBand(sourceTimeRateFromPercent(175))).toBe('edge')
    expect(clipAudioPresentation(clip())).toEqual({
      state: 'ready',
      kind: 'stretched',
      rate: { numerator: 3, denominator: 2 },
      quality: 'nominal',
    })
    const edge = clip()
    edge.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      rate: sourceTimeRateFromPercent(200),
    }
    expect(clipAudioPresentation(edge)).toEqual({
      state: 'fallback',
      kind: 'stretched',
      rate: { numerator: 2, denominator: 1 },
      quality: 'edge',
    })
    const direct = clip()
    delete direct.sourceTimeMap
    expect(clipAudioPresentation(direct)).toEqual({
      state: 'ready',
      kind: 'direct',
    })
    const silence = clip()
    silence.sourceTimeMap = {
      ...defaultSourceTimeMap(0, 20),
      sourceStartTicks: 500_000,
    }
    expect(clipAudioPresentation(silence)).toEqual({
      state: 'silence',
      reason: 'sub-frame-origin-audio-unsupported',
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
    expect(sourceTimeAudioPolicy({
      ...clip(),
      sourceTimeMap: {
        ...defaultSourceTimeMap(0, 10),
        rate: { numerator: -1, denominator: 1 },
        speedCurve: {
          originFrame: 0,
          points: [
            { frame: 0, rate: sourceTimeSpeedRateFromPercent(100), easing: 'linear' },
            { frame: 5, rate: sourceTimeSpeedRateFromPercent(200), easing: 'linear' },
          ],
        },
      },
    })).toEqual({
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

  test('whole-clip speed reads a constant playhead curve instead of the 100% fallback', () => {
    const unity = defaultSourceTimeMap(0, 40)
    expect(sourceTimeMapWholeClipSpeed(unity)).toEqual({
      kind: 'constant',
      percent: 100,
    })
    const curved = sourceTimeMapWithSpeedPoint(
      unity,
      0,
      sourceTimeRateFromPercent(400),
      'hold',
    )
    expect(curved.rate).toEqual({ numerator: 1, denominator: 1 })
    expect(sourceTimeMapWholeClipSpeed(curved)).toEqual({
      kind: 'constant',
      percent: 400,
    })
  })

  test('whole-clip speed reports mixed when ramp points disagree', () => {
    const unity = defaultSourceTimeMap(0, 40)
    const first = sourceTimeMapWithSpeedPoint(
      unity,
      0,
      sourceTimeRateFromPercent(25),
      'hold',
    )
    const mixed = sourceTimeMapWithSpeedPoint(
      first,
      10,
      sourceTimeRateFromPercent(100),
      'hold',
    )
    expect(sourceTimeMapWholeClipSpeed(mixed)).toEqual({ kind: 'mixed' })
  })

  test('maps source ticks onto decoder seconds and the audio sample grid', () => {
    expect(sourceTicksToSeconds(30_000_000, { num: 30, den: 1 })).toBe(1)
    expect(audioSampleFromSourceTicks(30_000_000, { num: 30, den: 1 }, 48_000))
      .toBe(48_000)
    expect(audioSampleFromSourceTicks(-500_000, { num: 30, den: 1 }, 48_000))
      .toBe(-800)
  })
})
