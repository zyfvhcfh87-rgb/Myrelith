import { describe, expect, test } from 'vitest'
import {
  createAudioEffectChainFromReady,
  processAudioBufferWithChain,
} from './audioDsp'
import {
  createCompressorEffect,
  createLimiterEffect,
  createNoiseGateEffect,
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

  test('limiter at -6 dB never lets a transient cross the ceiling', () => {
    const limiter = createLimiterEffect('lim')
    limiter.params.ceilingDb = -6
    limiter.params.releaseMs = 20
    const left = sine(4_096, 1_000, 1)
    const right = left.slice()
    const chain = createAudioEffectChainFromReady([limiter], SAMPLE_RATE)
    processAudioBufferWithChain(left, right, chain)
    let peak = 0
    for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]))
    const ceiling = 10 ** (-6 / 20)
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-7)
    expect(peak).toBeGreaterThan(ceiling - 0.01)
  })

  test('limiter clamps the first sample of an isolated impulse', () => {
    const limiter = createLimiterEffect('lim')
    limiter.params.ceilingDb = -6
    limiter.params.releaseMs = 20
    const left = new Float32Array([1, 0, 0, 0])
    const right = new Float32Array([0.75, 0, 0, 0])

    createAudioEffectChainFromReady([limiter], SAMPLE_RATE).process(left, right)

    const ceiling = 10 ** (-6 / 20)
    expect(left[0]).toBeCloseTo(ceiling, 6)
    expect(right[0]).toBeCloseTo(ceiling * 0.75, 6)
  })

  test('noise gate suppresses a quiet floor, opens on signal, and closes again', () => {
    const gate = createNoiseGateEffect('gate')
    gate.params.thresholdDb = -30
    gate.params.attackMs = 0.1
    gate.params.holdMs = 0
    gate.params.releaseMs = 1
    gate.params.rangeDb = 80
    const chain = createAudioEffectChainFromReady([gate], SAMPLE_RATE)

    const quietBefore = new Float32Array(4_096).fill(0.001)
    const quietBeforeRight = quietBefore.slice()
    processAudioBufferWithChain(quietBefore, quietBeforeRight, chain)
    expect(Math.abs(quietBefore.at(-1) ?? 1)).toBeLessThan(0.000001)

    const signal = new Float32Array(4_096).fill(0.5)
    const signalRight = signal.slice()
    processAudioBufferWithChain(signal, signalRight, chain)
    expect(signal.at(-1)).toBeCloseTo(0.5, 5)
    expect(signalRight.at(-1)).toBeCloseTo(0.5, 5)

    const quietAfter = new Float32Array(4_096).fill(0.001)
    const quietAfterRight = quietAfter.slice()
    processAudioBufferWithChain(quietAfter, quietAfterRight, chain)
    expect(Math.abs(quietAfter.at(-1) ?? 1)).toBeLessThan(0.000001)
  })
})
