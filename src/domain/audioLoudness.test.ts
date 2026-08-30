import { describe, expect, test } from 'vitest'
import {
  LoudnessMeter,
  normalizeGainFromLufs,
} from './audioLoudness'

describe('loudness meter', () => {
  test('reports incomplete coverage before the expected sample count', () => {
    const meter = new LoudnessMeter(48_000, 48_000)
    const left = new Float32Array(1_000).fill(0.1)
    meter.process(left, left.slice())
    const result = meter.result()
    expect(result.coverage).toBe('incomplete')
    expect(result.measuredSamples).toBe(1_000)
  })

  test('a long full-scale tone yields a finite integrated loudness and true peak', () => {
    const sampleRate = 48_000
    const meter = new LoudnessMeter(sampleRate, sampleRate)
    const left = new Float32Array(sampleRate)
    const step = 2 * Math.PI * 1_000 / sampleRate
    for (let i = 0; i < left.length; i++) left[i] = Math.sin(i * step)
    meter.process(left, left.slice())
    const result = meter.result()
    expect(result.coverage).toBe('complete')
    expect(result.integratedLufs).not.toBeNull()
    expect(result.integratedLufs ?? 0).toBeGreaterThan(-8)
    expect(result.integratedLufs ?? 0).toBeLessThan(0)
    expect(result.truePeakDbtp ?? -99).toBeGreaterThan(-1)
    expect(result.truePeakDbtp ?? 99).toBeLessThan(1)
  })

  test('normalize gain is an ordinary linear volume change', () => {
    expect(normalizeGainFromLufs(-22, -16, 1)).toBeCloseTo(10 ** (6 / 20), 5)
    expect(normalizeGainFromLufs(-6, -16, 1)).toBeCloseTo(10 ** (-10 / 20), 5)
    expect(normalizeGainFromLufs(-60, -16, 1)).toBe(2)
  })
})
