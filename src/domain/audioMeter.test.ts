import { describe, expect, test } from 'vitest'
import {
  AUDIO_METER_FLOOR_DB,
  advanceAudioMeterBallistics,
  audioMeterReadout,
  clearAudioMeterOverload,
  createAudioMeterBallistics,
  linearPeakToDb,
  measureAudioMeterSample,
  silenceAudioMeterBallistics,
} from './audioMeter'

describe('audio meter reference fixtures', () => {
  test('measures independent channel peaks, master peak, and stereo RMS', () => {
    const sample = measureAudioMeterSample(
      new Float32Array([0, 0.5, -1, 0.25]),
      new Float32Array([0.25, -0.25, 0.5, -0.5]),
    )

    expect(sample.left).toBe(1)
    expect(sample.right).toBe(0.5)
    expect(sample.master).toBe(1)
    expect(sample.rms).toBeCloseTo(Math.sqrt(1.9375 / 8), 7)
  })

  test('uses an explicit -60 dBFS floor and a 0 dBFS overload boundary', () => {
    expect(linearPeakToDb(0)).toBe(AUDIO_METER_FLOOR_DB)
    expect(linearPeakToDb(0.5)).toBeCloseTo(-6.0206, 3)
    expect(linearPeakToDb(1)).toBe(0)
    expect(linearPeakToDb(2)).toBeCloseTo(6, 12)
  })

  test('applies immediate attack, timed release, hold, latch, silence, and reset', () => {
    let state = advanceAudioMeterBallistics(
      createAudioMeterBallistics(),
      { left: 0.5, right: 0.25, master: 0.5 },
      1_000,
    )
    state = advanceAudioMeterBallistics(
      state,
      { left: 0.1, right: 0.1, master: 0.1 },
      1_100,
    )
    expect(state.peaks.left).toBeCloseTo(0.5 * 10 ** (-1.8 / 20), 6)

    state = advanceAudioMeterBallistics(
      state,
      { left: 1.2, right: 0.8, master: 1.2 },
      1_200,
    )
    expect(audioMeterReadout(state, 3_199).overloadHeld).toEqual({
      left: true,
      right: false,
      master: true,
    })
    expect(audioMeterReadout(state, 3_201).overloadLatched).toEqual({
      left: true,
      right: false,
      master: true,
    })

    state = silenceAudioMeterBallistics(state)
    expect(state.peaks).toEqual({ left: 0, right: 0, master: 0 })
    expect(state.overloadLatched.master).toBe(true)
    expect(clearAudioMeterOverload(state).overloadLatched).toEqual({
      left: false,
      right: false,
      master: false,
    })
  })
})
