/** Pure audio-effect descriptor registry, validation, resolution, and shared stereo-block DSP. */

import type { AudioEffectDescriptor, EffectParamValue } from './schema'
import {
  createAudioEffectChainFromReady,
  type AudioEffectChain,
} from './audioDsp'

export const PARAMETRIC_EQ_EFFECT_TYPE = 'builtin.eq' as const
export const PARAMETRIC_EQ_EFFECT_VERSION = 1 as const
export const COMPRESSOR_EFFECT_TYPE = 'builtin.compressor' as const
export const COMPRESSOR_EFFECT_VERSION = 1 as const
export const LIMITER_EFFECT_TYPE = 'builtin.limiter' as const
export const LIMITER_EFFECT_VERSION = 1 as const
export const JS_STEREO_BLOCK_CAPABILITY = 'js-stereo-block' as const

export const EQ_BAND_TYPES = Object.freeze([
  'peak',
  'lowshelf',
  'highshelf',
  'lowpass',
  'highpass',
  'notch',
] as const)

export type EqBandType = (typeof EQ_BAND_TYPES)[number]

export interface AudioEffectParamSpec {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
}

export interface EqParams extends Record<string, EffectParamValue> {
  band1Type: EqBandType
  band1Freq: number
  band1Q: number
  band1Gain: number
  band2Type: EqBandType
  band2Freq: number
  band2Q: number
  band2Gain: number
  band3Type: EqBandType
  band3Freq: number
  band3Q: number
  band3Gain: number
  band4Type: EqBandType
  band4Freq: number
  band4Q: number
  band4Gain: number
}

export interface CompressorParams extends Record<string, EffectParamValue> {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  kneeDb: number
  makeupDb: number
}

export interface LimiterParams extends Record<string, EffectParamValue> {
  ceilingDb: number
  releaseMs: number
}

export const EQ_BAND_FREQ_LIMITS = Object.freeze({
  min: 20,
  max: 20_000,
  step: 1,
  label: 'Frequency (Hz)',
})

export const EQ_BAND_Q_LIMITS = Object.freeze({
  min: 0.1,
  max: 18,
  step: 0.1,
  label: 'Q',
})

export const EQ_BAND_GAIN_LIMITS = Object.freeze({
  min: -24,
  max: 24,
  step: 0.1,
  label: 'Gain (dB)',
})

export const DEFAULT_EQ_PARAMS: Readonly<EqParams> = Object.freeze({
  band1Type: 'lowshelf',
  band1Freq: 100,
  band1Q: 0.7,
  band1Gain: 0,
  band2Type: 'peak',
  band2Freq: 400,
  band2Q: 1,
  band2Gain: 0,
  band3Type: 'peak',
  band3Freq: 2_500,
  band3Q: 1,
  band3Gain: 0,
  band4Type: 'highshelf',
  band4Freq: 8_000,
  band4Q: 0.7,
  band4Gain: 0,
})

export const COMPRESSOR_LIMITS = Object.freeze({
  thresholdDb: Object.freeze({ min: -60, max: 0, step: 0.1, label: 'Threshold (dB)' }),
  ratio: Object.freeze({ min: 1, max: 20, step: 0.1, label: 'Ratio' }),
  attackMs: Object.freeze({ min: 0.1, max: 200, step: 0.1, label: 'Attack (ms)' }),
  releaseMs: Object.freeze({ min: 1, max: 2_000, step: 1, label: 'Release (ms)' }),
  kneeDb: Object.freeze({ min: 0, max: 24, step: 0.1, label: 'Knee (dB)' }),
  makeupDb: Object.freeze({ min: 0, max: 24, step: 0.1, label: 'Makeup (dB)' }),
})

export const DEFAULT_COMPRESSOR_PARAMS: Readonly<CompressorParams> = Object.freeze({
  thresholdDb: 0,
  ratio: 1,
  attackMs: 10,
  releaseMs: 100,
  kneeDb: 0,
  makeupDb: 0,
})

export const LIMITER_LIMITS = Object.freeze({
  ceilingDb: Object.freeze({ min: -24, max: 0, step: 0.1, label: 'Ceiling (dB)' }),
  releaseMs: Object.freeze({ min: 1, max: 1_000, step: 1, label: 'Release (ms)' }),
})

export const DEFAULT_LIMITER_PARAMS: Readonly<LimiterParams> = Object.freeze({
  ceilingDb: 0,
  releaseMs: 50,
})

export type AudioEffectCapability = typeof JS_STEREO_BLOCK_CAPABILITY

export type AudioEffectResolutionStatus = 'ready' | 'disabled' | 'invalid' | 'unsupported'

export interface AudioEffectResolution {
  readonly effect: AudioEffectDescriptor
  readonly label: string
  readonly status: AudioEffectResolutionStatus
  readonly detail: string
  readonly identity: boolean
}

export interface AudioEffectRegistration {
  readonly type: string
  readonly version: number
  readonly label: string
  readonly capabilities: readonly AudioEffectCapability[]
  readonly defaultParams: Readonly<Record<string, EffectParamValue>>
  readonly validateParams: (params: Readonly<Record<string, EffectParamValue>>) => string | null
}

function finiteInRange(value: EffectParamValue | undefined, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isEqBandType(value: EffectParamValue | undefined): value is EqBandType {
  return typeof value === 'string' && (EQ_BAND_TYPES as readonly string[]).includes(value)
}

function validateEqBand(
  params: Readonly<Record<string, EffectParamValue>>,
  band: 1 | 2 | 3 | 4,
): string | null {
  const typeKey = `band${band}Type`
  const freqKey = `band${band}Freq`
  const qKey = `band${band}Q`
  const gainKey = `band${band}Gain`
  if (!isEqBandType(params[typeKey])) {
    return `${typeKey} must be peak, lowshelf, highshelf, lowpass, highpass, or notch`
  }
  if (!finiteInRange(params[freqKey], EQ_BAND_FREQ_LIMITS.min, EQ_BAND_FREQ_LIMITS.max)) {
    return `${freqKey} must be between ${EQ_BAND_FREQ_LIMITS.min} and ${EQ_BAND_FREQ_LIMITS.max}`
  }
  if (!finiteInRange(params[qKey], EQ_BAND_Q_LIMITS.min, EQ_BAND_Q_LIMITS.max)) {
    return `${qKey} must be between ${EQ_BAND_Q_LIMITS.min} and ${EQ_BAND_Q_LIMITS.max}`
  }
  if (!finiteInRange(params[gainKey], EQ_BAND_GAIN_LIMITS.min, EQ_BAND_GAIN_LIMITS.max)) {
    return `${gainKey} must be between ${EQ_BAND_GAIN_LIMITS.min} and ${EQ_BAND_GAIN_LIMITS.max}`
  }
  return null
}

function validateEqParams(
  params: Readonly<Record<string, EffectParamValue>>,
): string | null {
  return validateEqBand(params, 1)
    ?? validateEqBand(params, 2)
    ?? validateEqBand(params, 3)
    ?? validateEqBand(params, 4)
}

function validateCompressorParams(
  params: Readonly<Record<string, EffectParamValue>>,
): string | null {
  for (const key of Object.keys(COMPRESSOR_LIMITS) as (keyof typeof COMPRESSOR_LIMITS)[]) {
    const limit = COMPRESSOR_LIMITS[key]
    if (!finiteInRange(params[key], limit.min, limit.max)) {
      return `${key} must be between ${limit.min} and ${limit.max}`
    }
  }
  return null
}

function validateLimiterParams(
  params: Readonly<Record<string, EffectParamValue>>,
): string | null {
  for (const key of Object.keys(LIMITER_LIMITS) as (keyof typeof LIMITER_LIMITS)[]) {
    const limit = LIMITER_LIMITS[key]
    if (!finiteInRange(params[key], limit.min, limit.max)) {
      return `${key} must be between ${limit.min} and ${limit.max}`
    }
  }
  return null
}

const EQ_REGISTRATION: AudioEffectRegistration = Object.freeze({
  type: PARAMETRIC_EQ_EFFECT_TYPE,
  version: PARAMETRIC_EQ_EFFECT_VERSION,
  label: 'Parametric EQ',
  capabilities: Object.freeze([JS_STEREO_BLOCK_CAPABILITY]),
  defaultParams: DEFAULT_EQ_PARAMS,
  validateParams: validateEqParams,
})

const COMPRESSOR_REGISTRATION: AudioEffectRegistration = Object.freeze({
  type: COMPRESSOR_EFFECT_TYPE,
  version: COMPRESSOR_EFFECT_VERSION,
  label: 'Compressor',
  capabilities: Object.freeze([JS_STEREO_BLOCK_CAPABILITY]),
  defaultParams: DEFAULT_COMPRESSOR_PARAMS,
  validateParams: validateCompressorParams,
})

const LIMITER_REGISTRATION: AudioEffectRegistration = Object.freeze({
  type: LIMITER_EFFECT_TYPE,
  version: LIMITER_EFFECT_VERSION,
  label: 'Limiter',
  capabilities: Object.freeze([JS_STEREO_BLOCK_CAPABILITY]),
  defaultParams: DEFAULT_LIMITER_PARAMS,
  validateParams: validateLimiterParams,
})

const AUDIO_EFFECT_REGISTRY = new Map<string, AudioEffectRegistration>([
  [PARAMETRIC_EQ_EFFECT_TYPE, EQ_REGISTRATION],
  [COMPRESSOR_EFFECT_TYPE, COMPRESSOR_REGISTRATION],
  [LIMITER_EFFECT_TYPE, LIMITER_REGISTRATION],
])

export function registeredAudioEffects(): readonly AudioEffectRegistration[] {
  return [...AUDIO_EFFECT_REGISTRY.values()]
}

export function audioEffectRegistration(type: string): AudioEffectRegistration | null {
  return AUDIO_EFFECT_REGISTRY.get(type) ?? null
}

export function cloneAudioEffectDescriptor(
  effect: AudioEffectDescriptor,
): AudioEffectDescriptor {
  return { ...effect, params: { ...effect.params } }
}

export function cloneAudioEffectStack(
  effects: readonly AudioEffectDescriptor[] | undefined,
): AudioEffectDescriptor[] {
  return (effects ?? []).map(cloneAudioEffectDescriptor)
}

export function createParametricEqEffect(id: string): AudioEffectDescriptor {
  return {
    id,
    type: PARAMETRIC_EQ_EFFECT_TYPE,
    version: PARAMETRIC_EQ_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_EQ_PARAMS },
  }
}

export function createCompressorEffect(id: string): AudioEffectDescriptor {
  return {
    id,
    type: COMPRESSOR_EFFECT_TYPE,
    version: COMPRESSOR_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_COMPRESSOR_PARAMS },
  }
}

export function createLimiterEffect(id: string): AudioEffectDescriptor {
  return {
    id,
    type: LIMITER_EFFECT_TYPE,
    version: LIMITER_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_LIMITER_PARAMS },
  }
}

export function audioEffectParamsValidationError(
  effect: AudioEffectDescriptor,
): string | null {
  const registration = audioEffectRegistration(effect.type)
  if (!registration) return null
  if (effect.version !== registration.version) {
    return `unsupported ${effect.type} version ${effect.version}; expected ${registration.version}`
  }
  return registration.validateParams(effect.params)
}

/**
 * Upgrade descriptors owned by this registry. Unknown types and future
 * versions are cloned byte-for-byte at the JSON value level and remain opaque.
 */
export function migrateAudioEffectDescriptor(
  effect: AudioEffectDescriptor,
): AudioEffectDescriptor {
  return cloneAudioEffectDescriptor(effect)
}

export function jsStereoBlockCapabilities(): ReadonlySet<AudioEffectCapability> {
  return new Set<AudioEffectCapability>([JS_STEREO_BLOCK_CAPABILITY])
}

/** Structural probe shared by live playback and export hosts. */
export function supportsJsStereoBlock(
  host: { readonly processStereoBlock?: unknown },
): boolean {
  return typeof host.processStereoBlock === 'function'
}

export function audioEffectHostCapabilities(options: {
  readonly jsStereoBlock: boolean
}): ReadonlySet<AudioEffectCapability> {
  const capabilities = new Set<AudioEffectCapability>()
  if (options.jsStereoBlock) capabilities.add(JS_STEREO_BLOCK_CAPABILITY)
  return capabilities
}

function resolveOne(
  effect: AudioEffectDescriptor,
  capabilities: ReadonlySet<AudioEffectCapability>,
): AudioEffectResolution {
  const registration = audioEffectRegistration(effect.type)
  if (!registration) {
    return {
      effect,
      label: effect.type || 'Unknown audio effect',
      status: 'unsupported',
      detail: `Audio effect type “${effect.type || '(empty)'}” is not installed; its data is preserved.`,
      identity: true,
    }
  }
  if (effect.version !== registration.version) {
    return {
      effect,
      label: registration.label,
      status: 'unsupported',
      detail: `Version ${effect.version} is not supported; expected ${registration.version}. Its data is preserved.`,
      identity: true,
    }
  }
  const validationError = audioEffectParamsValidationError(effect)
  if (validationError) {
    return {
      effect,
      label: registration.label,
      status: 'invalid',
      detail: `${validationError}; the effect is bypassed.`,
      identity: true,
    }
  }
  const missingCapability = registration.capabilities.find((capability) =>
    !capabilities.has(capability),
  )
  if (missingCapability) {
    return {
      effect,
      label: registration.label,
      status: 'unsupported',
      detail: `This audio host does not provide ${missingCapability}; the effect is bypassed.`,
      identity: true,
    }
  }
  if (!effect.enabled) {
    return {
      effect,
      label: registration.label,
      status: 'disabled',
      detail: 'Bypassed by the effect toggle.',
      identity: true,
    }
  }
  return {
    effect,
    label: registration.label,
    status: 'ready',
    detail: 'Applied in stack order.',
    identity: false,
  }
}

/** Resolve an ordered stack deterministically. Bad entries are reported and bypassed. */
export function resolveAudioEffectStack(
  effects: readonly AudioEffectDescriptor[],
  capabilities: ReadonlySet<AudioEffectCapability>,
): readonly AudioEffectResolution[] {
  return effects.map((effect) => resolveOne(effect, capabilities))
}

/** Stateful chain used by live playback and export. */
export function createAudioEffectChain(
  effects: readonly AudioEffectDescriptor[],
  sampleRate: number,
  capabilities: ReadonlySet<AudioEffectCapability> = jsStereoBlockCapabilities(),
): AudioEffectChain {
  const ready = resolveAudioEffectStack(effects, capabilities)
    .filter((resolution) => resolution.status === 'ready')
    .map((resolution) => resolution.effect)
  return createAudioEffectChainFromReady(ready, sampleRate)
}

/**
 * Run the ordered stereo block processor. Disabled, invalid, and unsupported
 * entries are skipped. Both playback and export must call this helper, or
 * the stateful `createAudioEffectChain` equivalent, so order stays identical.
 */
export function applyAudioEffectStack(
  left: Float32Array,
  right: Float32Array,
  effects: readonly AudioEffectDescriptor[],
  capabilities: ReadonlySet<AudioEffectCapability>,
  sampleRate = 48_000,
): readonly AudioEffectResolution[] {
  if (left.length !== right.length) {
    throw new RangeError('audio-effect blocks must have matching stereo lengths')
  }
  const resolutions = resolveAudioEffectStack(effects, capabilities)
  createAudioEffectChain(effects, sampleRate, capabilities).process(left, right)
  return resolutions
}
