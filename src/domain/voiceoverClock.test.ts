import { describe, expect, test } from 'vitest'
import { audioSampleBoundary } from './time'
import {
  voiceoverCaptureSample,
  voiceoverLimitStop,
  MAX_VOICEOVER_COMPENSATION_SECONDS,
  planVoiceoverSampleWindow,
  voiceoverCountInWindow,
  voiceoverCountInCues,
  voiceoverStopBoundary,
  voiceoverSampleAtTimelineFrame,
  voiceoverTimelineFrameAtSample,
} from './voiceoverClock'

const ntsc = { frameRate: { num: 30_000, den: 1_001 }, audioSampleRate: 48_000 }
const film = { frameRate: { num: 24_000, den: 1_001 }, audioSampleRate: 48_000 }

describe('voiceover count-in and frame anchor', () => {
  test('schedules exact fractional-frame count-in without crossing context zero', () => {
    expect(voiceoverCountInWindow(48_048, 30, ntsc)).toEqual({ startSample: 0, endSample: 48_048 })
    expect(voiceoverCountInWindow(9, 0, ntsc)).toEqual({ startSample: 9, endSample: 9 })
    expect(() => voiceoverCountInWindow(48_047, 30, ntsc)).toThrow(RangeError)
  })

  test('uses the target frame grid phase rather than a rounded uniform frame length', () => {
    expect(audioSampleBoundary(1, ntsc)).toBe(1_602)
    expect(audioSampleBoundary(2, ntsc)).toBe(3_203)
    expect(voiceoverSampleAtTimelineFrame(0, 10_000, 1, ntsc)).toBe(8_398)
    expect(voiceoverSampleAtTimelineFrame(1, 10_000, 1, ntsc)).toBe(10_000)
    expect(voiceoverSampleAtTimelineFrame(2, 10_000, 1, ntsc)).toBe(11_601)
    expect(voiceoverTimelineFrameAtSample(11_600, 10_000, 1, ntsc)).toBe(1)
    expect(voiceoverTimelineFrameAtSample(11_601, 10_000, 1, ntsc)).toBe(2)
  })

  test('assigns one-sample edges and long fractional timelines without float drift', () => {
    for (const doc of [ntsc, film]) {
      const target = 1_000_000
      const anchor = 2_000_000_000
      for (let frame = target; frame < target + 500; frame++) {
        const boundary = voiceoverSampleAtTimelineFrame(frame, anchor, target, doc)
        expect(voiceoverTimelineFrameAtSample(boundary, anchor, target, doc)).toBe(frame)
        if (frame > target) {
          expect(voiceoverTimelineFrameAtSample(boundary - 1, anchor, target, doc)).toBe(frame - 1)
        }
      }
    }
    expect(voiceoverTimelineFrameAtSample(0, 1, 0, ntsc)).toBe(null)
  })

  test('rejects invalid sample/frame inputs and unsafe results', () => {
    expect(() => voiceoverCountInWindow(-1, 1, ntsc)).toThrow(RangeError)
    expect(() => voiceoverSampleAtTimelineFrame(0, 0, 1, ntsc)).toThrow(RangeError)
    expect(() => voiceoverSampleAtTimelineFrame(1.5, 20, 0, ntsc)).toThrow(RangeError)
    expect(() => voiceoverSampleAtTimelineFrame(1, Number.MAX_SAFE_INTEGER, 0, ntsc)).toThrow(RangeError)
    expect(() => voiceoverTimelineFrameAtSample(1, 0, 0, {
      frameRate: { num: 96_000, den: 1 }, audioSampleRate: 48_000,
    })).toThrow(RangeError)
  })

  test('count-in cues and stop land on the rational frame grid', () => {
    expect(voiceoverCountInCues(58_048, 30, ntsc)).toEqual([
      10_000, 21_211, 34_024, 45_235,
    ])
    expect(voiceoverCountInCues(10_000, 0, ntsc)).toEqual([])
    const stop = voiceoverStopBoundary(11_603, 10_000, 1, 2_400, ntsc)
    expect(stop.stopFrame).toBe(4)
    expect(stop.stopSample).toBe(14_804)
    expect(() => voiceoverStopBoundary(9_999, 10_000, 1, 0, ntsc)).toThrow(RangeError)
  })
})

describe('fixed-window voiceover trim and pad', () => {
  const window = {
    anchorSample: 100, stopSample: 110,
    inputStartSample: 95, inputEndSample: 115,
    audioSampleRate: 48_000,
  }

  test('discards all count-in and post-stop input, then advances or delays without moving the target', () => {
    expect(planVoiceoverSampleWindow({ ...window, compensationSamples: 0 })).toEqual({
      outputSamples: 10, leadingSilenceSamples: 0, sourceOffsetSamples: 5,
      sourceSamples: 10, trailingSilenceSamples: 0, missingInputSamples: 0,
    })
    expect(planVoiceoverSampleWindow({ ...window, compensationSamples: 2 })).toEqual({
      outputSamples: 10, leadingSilenceSamples: 0, sourceOffsetSamples: 7,
      sourceSamples: 8, trailingSilenceSamples: 2, missingInputSamples: 0,
    })
    expect(planVoiceoverSampleWindow({ ...window, compensationSamples: -2 })).toEqual({
      outputSamples: 10, leadingSilenceSamples: 2, sourceOffsetSamples: 5,
      sourceSamples: 8, trailingSilenceSamples: 0, missingInputSamples: 0,
    })
  })

  test('reports a late or early source as missing input and preserves exact output length', () => {
    expect(planVoiceoverSampleWindow({ ...window, inputStartSample: 103,
      inputEndSample: 109, compensationSamples: 0 })).toEqual({
      outputSamples: 10, leadingSilenceSamples: 3, sourceOffsetSamples: 0,
      sourceSamples: 6, trailingSilenceSamples: 1, missingInputSamples: 4,
    })
    const shifted = planVoiceoverSampleWindow({ ...window, inputStartSample: 104,
      inputEndSample: 109, compensationSamples: 2 })
    expect(shifted).toEqual({ outputSamples: 10, leadingSilenceSamples: 2,
      sourceOffsetSamples: 0, sourceSamples: 5, trailingSilenceSamples: 3,
      missingInputSamples: 3 })
  })

  test('handles zero/one-sample windows and totally absent source without borrowing preroll', () => {
    expect(planVoiceoverSampleWindow({ ...window, stopSample: 100,
      compensationSamples: 0 }).outputSamples).toBe(0)
    for (const compensationSamples of [-1, 1]) {
      expect(planVoiceoverSampleWindow({ ...window, stopSample: 101,
        compensationSamples })).toEqual({
        outputSamples: 1, leadingSilenceSamples: 1, sourceOffsetSamples: 0,
        sourceSamples: 0, trailingSilenceSamples: 0, missingInputSamples: 0,
      })
    }
    expect(planVoiceoverSampleWindow({ ...window, inputStartSample: 110,
      inputEndSample: 110, compensationSamples: 0 }).missingInputSamples).toBe(10)
  })

  test('permits signed half-second offsets and rejects the next sample and bad ranges', () => {
    expect(MAX_VOICEOVER_COMPENSATION_SECONDS).toBe(0.5)
    for (const value of [-24_000, 24_000]) {
      const result = planVoiceoverSampleWindow({ ...window, compensationSamples: value })
      expect(result.leadingSilenceSamples + result.sourceSamples + result.trailingSilenceSamples)
        .toBe(result.outputSamples)
    }
    for (const value of [-24_001, 24_001, 1.5, Number.NaN]) {
      expect(() => planVoiceoverSampleWindow({ ...window, compensationSamples: value })).toThrow(RangeError)
    }
    expect(() => planVoiceoverSampleWindow({ ...window, stopSample: 99,
      compensationSamples: 0 })).toThrow(RangeError)
    expect(() => planVoiceoverSampleWindow({ ...window, inputStartSample: 116,
      compensationSamples: 0 })).toThrow(RangeError)
  })
})

describe('voiceover take limit and capture window', () => {
  const rates = [
    { num: 30000, den: 1001 }, { num: 24000, den: 1001 }, { num: 25, den: 1 }, { num: 60, den: 1 },
  ]

  test('the limit stop is the last frame boundary within the sample budget', () => {
    for (const frameRate of rates) {
      const doc = { frameRate, audioSampleRate: 48_000 }
      for (const startFrame of [0, 1, 17, 90_001]) {
        const anchor = 1_000_000
        const limit = 60 * 60 * 48_000
        const { stopFrame, stopSample } = voiceoverLimitStop(anchor, startFrame, limit, doc)
        const length = (frame: number) => audioSampleBoundary(frame, doc) - audioSampleBoundary(startFrame, doc)
        expect(length(stopFrame)).toBeLessThanOrEqual(limit)
        expect(length(stopFrame + 1)).toBeGreaterThan(limit)
        expect(stopSample - anchor).toBe(length(stopFrame))
      }
    }
  })

  test('a one-frame budget and an impossible budget', () => {
    const doc = { frameRate: { num: 30000, den: 1001 }, audioSampleRate: 48_000 }
    expect(voiceoverLimitStop(0, 0, 1602, doc)).toEqual({ stopFrame: 1, stopSample: 1602 })
    expect(() => voiceoverLimitStop(0, 0, 1000, doc)).toThrow(RangeError)
  })

  test('capture samples shift by the signed compensation within ±0.5 s', () => {
    expect(voiceoverCaptureSample(48_000, 0, 48_000)).toBe(48_000)
    expect(voiceoverCaptureSample(48_000, 3_840, 48_000)).toBe(51_840)
    expect(voiceoverCaptureSample(48_000, -24_000, 48_000)).toBe(24_000)
    expect(() => voiceoverCaptureSample(48_000, 24_001, 48_000)).toThrow(RangeError)
    expect(() => voiceoverCaptureSample(10, -11, 48_000)).toThrow(RangeError)
    expect(() => voiceoverCaptureSample(10, 0.5, 48_000)).toThrow(RangeError)
  })
})
