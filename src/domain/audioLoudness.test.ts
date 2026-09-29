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

  test('sums stereo channel energy instead of averaging it', () => {
    const sampleRate = 48_000
    const tone = new Float32Array(sampleRate)
    const silence = new Float32Array(sampleRate)
    const step = 2 * Math.PI * 1_000 / sampleRate
    for (let index = 0; index < tone.length; index++) {
      tone[index] = Math.sin(index * step) * 0.25
    }
    const mono = new LoudnessMeter(sampleRate, sampleRate)
    mono.process(tone, silence)
    const stereo = new LoudnessMeter(sampleRate, sampleRate)
    stereo.process(tone, tone.slice())

    const monoLufs = mono.result().integratedLufs
    const stereoLufs = stereo.result().integratedLufs
    expect(monoLufs).not.toBeNull()
    expect(stereoLufs).not.toBeNull()
    expect((stereoLufs ?? 0) - (monoLufs ?? 0)).toBeCloseTo(10 * Math.log10(2), 5)
  })

  test('four-phase FIR reveals a true peak above the stored sample peak', () => {
    const sampleRate = 48_000
    const meter = new LoudnessMeter(sampleRate, sampleRate)
    const samples = new Float32Array(sampleRate)
    const step = 2 * Math.PI * 12_000 / sampleRate
    for (let index = 0; index < samples.length; index++) {
      samples[index] = Math.sin(index * step + Math.PI / 4)
    }
    const samplePeakDb = 20 * Math.log10(
      samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
    )

    meter.process(samples, samples.slice())
    const result = meter.result()

    expect(samplePeakDb).toBeCloseTo(-3.0103, 3)
    expect(result.truePeakDbtp ?? -99).toBeGreaterThan(-0.4)
    expect(result.truePeakDbtp ?? 99).toBeLessThan(0.3)
  })

  test('keeps true-peak and loudness results bit-identical across chunking and the tail', () => {
    let seed = 0x2545f491
    const noise = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 2_147_483_648 - 1
    }
    const measure = (length: number, chunk: number, sample: (index: number) => number) => {
      const left = new Float32Array(length)
      const right = new Float32Array(length)
      for (let index = 0; index < length; index++) {
        left[index] = sample(index)
        right[index] = sample(index + 7) * 0.5
      }
      const meter = new LoudnessMeter(48_000, length)
      for (let start = 0; start < length; start += chunk) {
        meter.process(left.subarray(start, start + chunk), right.subarray(start, start + chunk))
      }
      const result = meter.result()
      return [result.truePeakDbtp, result.integratedLufs]
    }
    const values = new Float32Array(30_011)
    for (let index = 0; index < values.length; index++) values[index] = noise()
    // A short quarter-rate burst peaks between samples while zeros flush the filter.
    const burst = (index: number) => Math.sin(index * Math.PI / 2 + Math.PI / 4)
    expect([
      measure(30_000, 1_024, (index) => values[index]),
      measure(30_000, 777, (index) => values[index]),
      measure(24_000, 480, (index) => Math.sin(index * 2 * Math.PI * 11_025 / 48_000 + 0.3)),
      measure(6, 4, burst),
      measure(13, 13, burst),
      measure(1, 1, () => -0.75),
    ]).toEqual([
      [4.363646019195476, -0.7478040246798848],
      [4.363646019195476, -0.7478040246798848],
      [0.21551680230756046, 1.2669795457748974],
      [0.041706806747927976, null],
      [0.6795359163497701, null],
      [-2.4987747321659985, null],
    ])
  })

  test('normalize gain is an ordinary linear volume change', () => {
    expect(normalizeGainFromLufs(-22, -16, 1)).toBeCloseTo(10 ** (6 / 20), 5)
    expect(normalizeGainFromLufs(-6, -16, 1)).toBeCloseTo(10 ** (-10 / 20), 5)
    expect(normalizeGainFromLufs(-60, -16, 1)).toBe(2)
  })
})
