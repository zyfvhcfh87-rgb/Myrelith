/** Stateful stereo block processors for registered audio effects. */

import type { AudioEffectDescriptor } from './schema'

export const AUDIO_DSP_BLOCK_SAMPLES = 128
export const PLAYBACK_AUDIO_DSP_BLOCK_SAMPLES = 256

interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

interface BiquadState {
  x1: number
  x2: number
  y1: number
  y2: number
}

function identityCoeffs(): BiquadCoeffs {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
}

function rbjCoeffs(
  type: string,
  freq: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): BiquadCoeffs {
  const nyquist = sampleRate * 0.5
  const f = Math.min(nyquist * 0.999, Math.max(1, freq))
  const w0 = 2 * Math.PI * f / sampleRate
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const safeQ = Math.max(0.05, q)
  const alpha = sinw / (2 * safeQ)
  const A = 10 ** (gainDb / 40)
  if (type === 'peak' && gainDb === 0) return identityCoeffs()
  if ((type === 'lowshelf' || type === 'highshelf') && gainDb === 0) {
    return identityCoeffs()
  }

  let b0 = 0
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0
  if (type === 'peak') {
    b0 = 1 + alpha * A
    b1 = -2 * cosw
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cosw
    a2 = 1 - alpha / A
  } else if (type === 'lowpass') {
    b0 = (1 - cosw) / 2
    b1 = 1 - cosw
    b2 = (1 - cosw) / 2
    a0 = 1 + alpha
    a1 = -2 * cosw
    a2 = 1 - alpha
  } else if (type === 'highpass') {
    b0 = (1 + cosw) / 2
    b1 = -(1 + cosw)
    b2 = (1 + cosw) / 2
    a0 = 1 + alpha
    a1 = -2 * cosw
    a2 = 1 - alpha
  } else if (type === 'notch') {
    b0 = 1
    b1 = -2 * cosw
    b2 = 1
    a0 = 1 + alpha
    a1 = -2 * cosw
    a2 = 1 - alpha
  } else if (type === 'lowshelf') {
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
    b0 = A * ((A + 1) - (A - 1) * cosw + twoSqrtAAlpha)
    b1 = 2 * A * ((A - 1) - (A + 1) * cosw)
    b2 = A * ((A + 1) - (A - 1) * cosw - twoSqrtAAlpha)
    a0 = (A + 1) + (A - 1) * cosw + twoSqrtAAlpha
    a1 = -2 * ((A - 1) + (A + 1) * cosw)
    a2 = (A + 1) + (A - 1) * cosw - twoSqrtAAlpha
  } else {
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
    b0 = A * ((A + 1) + (A - 1) * cosw + twoSqrtAAlpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cosw)
    b2 = A * ((A + 1) + (A - 1) * cosw - twoSqrtAAlpha)
    a0 = (A + 1) - (A - 1) * cosw + twoSqrtAAlpha
    a1 = 2 * ((A - 1) - (A + 1) * cosw)
    a2 = (A + 1) - (A - 1) * cosw - twoSqrtAAlpha
  }
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  }
}

function processBiquad(sample: number, coeffs: BiquadCoeffs, state: BiquadState): number {
  const y = coeffs.b0 * sample
    + coeffs.b1 * state.x1
    + coeffs.b2 * state.x2
    - coeffs.a1 * state.y1
    - coeffs.a2 * state.y2
  state.x2 = state.x1
  state.x1 = sample
  state.y2 = state.y1
  state.y1 = y
  return y
}

function emptyBiquad(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 }
}

function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

function attackReleaseCoef(seconds: number, sampleRate: number): number {
  const samples = Math.max(1, seconds * sampleRate)
  return 1 - Math.exp(-1 / samples)
}

interface Stage {
  process(left: Float32Array, right: Float32Array): void
}

function eqStage(effect: AudioEffectDescriptor, sampleRate: number): Stage | null {
  const bands: {
    coeffs: BiquadCoeffs
    left: BiquadState
    right: BiquadState
  }[] = []
  for (const band of [1, 2, 3, 4] as const) {
    const type = effect.params[`band${band}Type`]
    const freq = effect.params[`band${band}Freq`]
    const q = effect.params[`band${band}Q`]
    const gain = effect.params[`band${band}Gain`]
    if (
      typeof type !== 'string'
      || typeof freq !== 'number'
      || typeof q !== 'number'
      || typeof gain !== 'number'
    ) continue
    const coeffs = rbjCoeffs(type, freq, q, gain, sampleRate)
    if (coeffs.b0 === 1 && coeffs.b1 === 0 && coeffs.b2 === 0
      && coeffs.a1 === 0 && coeffs.a2 === 0) continue
    bands.push({ coeffs, left: emptyBiquad(), right: emptyBiquad() })
  }
  if (bands.length === 0) return null
  return {
    process(left, right) {
      for (let i = 0; i < left.length; i++) {
        let l = left[i]
        let r = right[i]
        for (const band of bands) {
          l = processBiquad(l, band.coeffs, band.left)
          r = processBiquad(r, band.coeffs, band.right)
        }
        left[i] = l
        right[i] = r
      }
    },
  }
}

function compressorStage(effect: AudioEffectDescriptor, sampleRate: number): Stage | null {
  const ratio = effect.params.ratio
  const makeupDb = effect.params.makeupDb
  const thresholdDb = effect.params.thresholdDb
  const attackMs = effect.params.attackMs
  const releaseMs = effect.params.releaseMs
  const kneeDb = effect.params.kneeDb
  if (
    typeof ratio !== 'number'
    || typeof makeupDb !== 'number'
    || typeof thresholdDb !== 'number'
    || typeof attackMs !== 'number'
    || typeof releaseMs !== 'number'
    || typeof kneeDb !== 'number'
  ) return null
  if (ratio === 1 && makeupDb === 0) return null
  const makeup = dbToGain(makeupDb)
  const attack = attackReleaseCoef(attackMs / 1000, sampleRate)
  const release = attackReleaseCoef(releaseMs / 1000, sampleRate)
  const knee = Math.max(0, kneeDb)
  const kneeHalf = knee / 2
  let envelope = 0
  return {
    process(left, right) {
      for (let i = 0; i < left.length; i++) {
        const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]))
        envelope += (peak - envelope) * (peak > envelope ? attack : release)
        const envDb = envelope > 1e-12 ? 20 * Math.log10(envelope) : -120
        const overshoot = envDb - thresholdDb
        let reduction = 0
        if (knee > 0 && overshoot > -kneeHalf && overshoot < kneeHalf) {
          const x = overshoot + kneeHalf
          reduction = (1 - 1 / ratio) * x * x / (2 * knee)
        } else if (overshoot > 0) {
          reduction = overshoot * (1 - 1 / ratio)
        }
        const gain = dbToGain(-reduction) * makeup
        left[i] *= gain
        right[i] *= gain
      }
    },
  }
}

function limiterStage(effect: AudioEffectDescriptor, sampleRate: number): Stage | null {
  const ceilingDb = effect.params.ceilingDb
  const releaseMs = effect.params.releaseMs
  if (typeof ceilingDb !== 'number' || typeof releaseMs !== 'number') return null
  const ceiling = dbToGain(ceilingDb)
  const attack = attackReleaseCoef(0.0005, sampleRate)
  const release = attackReleaseCoef(releaseMs / 1000, sampleRate)
  let envelope = 0
  return {
    process(left, right) {
      for (let i = 0; i < left.length; i++) {
        const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]))
        envelope += (peak - envelope) * (peak > envelope ? attack : release)
        const gain = envelope > ceiling && envelope > 1e-12 ? ceiling / envelope : 1
        left[i] *= gain
        right[i] *= gain
      }
    },
  }
}

function stageForReadyEffect(
  effect: AudioEffectDescriptor,
  sampleRate: number,
): Stage | null {
  if (effect.type === 'builtin.eq' && effect.version === 1) {
    return eqStage(effect, sampleRate)
  }
  if (effect.type === 'builtin.compressor' && effect.version === 1) {
    return compressorStage(effect, sampleRate)
  }
  if (effect.type === 'builtin.limiter' && effect.version === 1) {
    return limiterStage(effect, sampleRate)
  }
  return null
}

export interface AudioEffectChain {
  readonly identity: boolean
  process(left: Float32Array, right: Float32Array): void
}

export function createAudioEffectChainFromReady(
  readyEffects: readonly AudioEffectDescriptor[],
  sampleRate: number,
): AudioEffectChain {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('audio-effect sample rate must be a positive finite number')
  }
  const stages: Stage[] = []
  for (const effect of readyEffects) {
    const stage = stageForReadyEffect(effect, sampleRate)
    if (stage) stages.push(stage)
  }
  if (stages.length === 0) {
    return {
      identity: true,
      process() {},
    }
  }
  return {
    identity: false,
    process(left, right) {
      if (left.length !== right.length) {
        throw new RangeError('audio-effect blocks must have matching stereo lengths')
      }
      for (const stage of stages) stage.process(left, right)
    },
  }
}

export function processAudioBufferWithChain(
  left: Float32Array,
  right: Float32Array,
  chain: AudioEffectChain,
  blockSamples: number = AUDIO_DSP_BLOCK_SAMPLES,
): void {
  if (chain.identity) return
  const size = Math.max(1, blockSamples)
  for (let start = 0; start < left.length; start += size) {
    const end = Math.min(left.length, start + size)
    chain.process(left.subarray(start, end), right.subarray(start, end))
  }
}
