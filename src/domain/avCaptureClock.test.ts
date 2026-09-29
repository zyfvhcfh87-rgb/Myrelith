import { describe, expect, test } from 'vitest'
import {
  AV_DRIFT_TOLERANCE_US,
  createAvClock,
  describeAvClock,
  microsecondsForSamples,
  planAvAudioChunk,
  planAvVideoFrame,
  samplesForMicroseconds,
  type AvClockState,
} from './avCaptureClock'

const RATE = 48_000
const CHUNK = 480 // 10 ms

function video(state: AvClockState, us: number) { return planAvVideoFrame(state, us) }
function audio(state: AvClockState, us: number, frames = CHUNK) { return planAvAudioChunk(state, us, frames, RATE) }

describe('A/V capture clock', () => {
  test('video before the first audio is dropped; audio before video is held', () => {
    let state = createAvClock(true)
    const early = video(state, 1_000_000)
    expect(early.decision).toEqual({ action: 'drop', reason: 'waiting-for-audio' })
    state = early.state
    const held = audio(state, 1_010_000)
    expect(held.decision).toEqual({ action: 'hold' })
    state = held.state
    const first = video(state, 1_033_000)
    expect(first.decision).toEqual({ action: 'write', timestampUs: 0 })
    expect(first.state.baseUs).toBe(1_033_000)
    expect(first.state.droppedVideoFrames).toBe(1)
  })

  test('held audio that starts before the base is trimmed to the base', () => {
    let state = createAvClock(true)
    state = audio(state, 1_000_000).state // held
    state = video(state, 1_004_000).state // base = 1.004 s
    const replay = audio(state, 1_000_000)
    expect(replay.decision).toEqual({ action: 'write', leadingSilenceSamples: 0, trimSamples: 192, timestampUs: 0 })
    expect(replay.state.audioSamples).toBe(CHUNK - 192)
    const next = audio(replay.state, 1_010_000)
    expect(next.decision).toMatchObject({ action: 'write', timestampUs: microsecondsForSamples(288, RATE) })
  })

  test('audio that starts after the base gets exact leading silence', () => {
    let state = createAvClock(true)
    state = audio(state, 1_000_000).state
    state = video(state, 1_000_000).state
    // The first audio chunk replayed is already at the base: no padding.
    const replay = audio(state, 1_000_000)
    expect(replay.decision).toMatchObject({ leadingSilenceSamples: 0, trimSamples: 0 })

    let late = createAvClock(true)
    late = { ...late, firstAudioUs: 1_050_000 }
    late = video(late, 1_000_000).state
    const first = audio(late, 1_050_000)
    expect(first.decision).toEqual({ action: 'write', leadingSilenceSamples: 2_400, trimSamples: 0, timestampUs: 0 })
  })

  test('audio time follows its sample count; jitter within tolerance is only measured', () => {
    let state = createAvClock(true)
    state = audio(state, 0).state
    state = video(state, 0).state
    state = audio(state, 0).state
    // Next chunk arrives stamped 15 ms late: within tolerance, no padding.
    const jitter = audio(state, 10_000 + 15_000)
    expect(jitter.decision).toMatchObject({ leadingSilenceSamples: 0, timestampUs: 10_000 })
    expect(jitter.state.driftUs).toBe(15_000)
    expect(jitter.state.maxAbsDriftUs).toBe(15_000)
  })

  test('a lost-input gap beyond tolerance is padded to resynchronize', () => {
    let state = createAvClock(true)
    state = audio(state, 0).state
    state = video(state, 0).state
    state = audio(state, 0).state
    const gap = audio(state, 10_000 + 200_000)
    expect(gap.decision).toEqual({ action: 'write', leadingSilenceSamples: 9_600, trimSamples: 0, timestampUs: 10_000 })
    expect(gap.state.audioSamples).toBe(CHUNK + 9_600 + CHUNK)
    expect(gap.state.gapEvents).toBe(1)
    // After padding, the next on-time chunk has no drift.
    const after = audio(gap.state, 210_000 + 10_000)
    expect(after.state.driftUs).toBe(0)
    expect(describeAvClock(after.state)).toMatch(/paused 1 time\(s\); 200 ms of silence/)
  })

  test('negative drift beyond tolerance is reported, never hidden', () => {
    let state = createAvClock(true)
    state = audio(state, 0).state
    state = video(state, 0).state
    state = audio(state, 0).state
    const ahead = audio(state, 10_000 - AV_DRIFT_TOLERANCE_US - 1)
    expect(ahead.decision).toMatchObject({ action: 'write', leadingSilenceSamples: 0 })
    expect(ahead.state.uncorrectedDriftEvents).toBe(1)
    expect(describeAvClock(ahead.state)).toMatch(/could not be corrected/)
  })

  test('faults: a gap over one second, a changed sample rate', () => {
    let state = createAvClock(true)
    state = audio(state, 0).state
    state = video(state, 0).state
    state = audio(state, 0).state
    expect(audio(state, 1_500_000).decision).toMatchObject({ action: 'fault' })
    expect(planAvAudioChunk(state, 10_000, CHUNK, 44_100).decision).toMatchObject({ action: 'fault' })
  })

  test('video frames keep capture spacing and drop non-increasing stamps', () => {
    let state = createAvClock(false)
    const first = video(state, 5_000_000)
    expect(first.decision).toEqual({ action: 'write', timestampUs: 0 })
    state = first.state
    const second = video(state, 5_033_367)
    expect(second.decision).toEqual({ action: 'write', timestampUs: 33_367 })
    const repeat = video(second.state, 5_033_367)
    expect(repeat.decision).toEqual({ action: 'drop', reason: 'non-increasing' })
    expect(video(repeat.state, 4_000_000).decision).toEqual({ action: 'drop', reason: 'before-base' })
  })

  test('integer sample/microsecond conversions are exact and floor', () => {
    expect(samplesForMicroseconds(1_000_000, 48_000)).toBe(48_000)
    expect(samplesForMicroseconds(20, 48_000)).toBe(0)
    expect(samplesForMicroseconds(21, 48_000)).toBe(1)
    expect(microsecondsForSamples(1, 48_000)).toBe(20)
    expect(microsecondsForSamples(44_100, 44_100)).toBe(1_000_000)
    expect(() => samplesForMicroseconds(0.5, 48_000)).toThrow(RangeError)
  })
})
