import { describe, expect, test } from 'vitest'
import {
  createAudioEffectChainFromReady,
  processAudioBufferWithChain,
} from './audioDsp'
import {
  createCompressorEffect,
  createLimiterEffect,
  createParametricEqEffect,
  DEFAULT_EQ_PARAMS,
} from './audioEffectStack'

const SAMPLE_RATE = 48_000
const EQ_CENTER_GAIN_EPSILON = 0.06

function sine(length: number, hz: number, amplitude = 1): Float32Array {
  const out = new Float32Array(length)
  const step = 2 * Math.PI * hz / SAMPLE_RATE
  for (let i = 0; i < length; i++) out[i] = Math.sin(i * step) * amplitude
  return out
}

function rms(samples: Float32Array, start: number): number {
  let sum = 0
  for (let i = start; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length - start))
}

describe('audio DSP processors', () => {
  test('default EQ and compressor chains are exact identity', () => {
    const left = sine(128, 440)
    const right = sine(128, 440, 0.5)
    const beforeL = Array.from(left)
    const beforeR = Array.from(right)
    createAudioEffectChainFromReady(
      [createParametricEqEffect('eq'), createCompressorEffect('comp')],
      SAMPLE_RATE,
    ).process(left, right)
    expect(Array.from(left)).toEqual(beforeL)
    expect(Array.from(right)).toEqual(beforeR)
  })

  test('peaking EQ at the probe frequency raises amplitude by the authored gain', () => {
    const eq = createParametricEqEffect('eq')
    eq.params = {
      ...DEFAULT_EQ_PARAMS,
      band2Type: 'peak',
      band2Freq: 1_000,
      band2Q: 1,
      band2Gain: 6,
    }
    const left = sine(4_096, 1_000, 0.25)
    const right = left.slice()
    const chain = createAudioEffectChainFromReady([eq], SAMPLE_RATE)
    processAudioBufferWithChain(left, right, chain)
    const expected = 0.25 * 10 ** (6 / 20) / Math.SQRT2
    expect(Math.abs(rms(left, 2_048) - expected)).toBeLessThan(EQ_CENTER_GAIN_EPSILON)
  })

  test('compressor with ratio 2 reduces a full-scale tone', () => {
    const compressor = createCompressorEffect('comp')
    compressor.params.thresholdDb = -6
    compressor.params.ratio = 4
    compressor.params.attackMs = 0.1
    compressor.params.releaseMs = 50
    compressor.params.makeupDb = 0
    const left = sine(8_192, 1_000, 1)
    const right = left.slice()
    const chain = createAudioEffectChainFromReady([compressor], SAMPLE_RATE)
    processAudioBufferWithChain(left, right, chain)
    expect(rms(left, 4_096)).toBeLessThan(0.6)
  })

  test('limiter at -6 dB keeps the settled peak at the ceiling', () => {
    const limiter = createLimiterEffect('lim')
    limiter.params.ceilingDb = -6
    limiter.params.releaseMs = 20
    const left = sine(4_096, 1_000, 1)
    const right = left.slice()
    const chain = createAudioEffectChainFromReady([limiter], SAMPLE_RATE)
    processAudioBufferWithChain(left, right, chain)
    let peak = 0
    for (let i = 2_048; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]))
    const ceiling = 10 ** (-6 / 20)
    expect(peak).toBeLessThanOrEqual(ceiling + 0.04)
    expect(peak).toBeGreaterThan(ceiling - 0.08)
  })
})
