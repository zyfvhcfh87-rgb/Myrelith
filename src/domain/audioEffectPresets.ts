/** Built-in audio-effect presets on the version-1 descriptor contract. */

import type { AudioEffectDescriptor, EffectParamValue } from './schema'
import {
  COMPRESSOR_EFFECT_TYPE,
  COMPRESSOR_EFFECT_VERSION,
  DEFAULT_COMPRESSOR_PARAMS,
  DEFAULT_EQ_PARAMS,
  DEFAULT_LIMITER_PARAMS,
  LIMITER_EFFECT_TYPE,
  LIMITER_EFFECT_VERSION,
  PARAMETRIC_EQ_EFFECT_TYPE,
  PARAMETRIC_EQ_EFFECT_VERSION,
} from './audioEffectStack'

export interface AudioEffectPreset {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly effects: readonly Omit<AudioEffectDescriptor, 'id'>[]
}

function eq(params: Record<string, EffectParamValue>): Omit<AudioEffectDescriptor, 'id'> {
  return {
    type: PARAMETRIC_EQ_EFFECT_TYPE,
    version: PARAMETRIC_EQ_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_EQ_PARAMS, ...params },
  }
}

function compressor(
  params: Record<string, EffectParamValue>,
): Omit<AudioEffectDescriptor, 'id'> {
  return {
    type: COMPRESSOR_EFFECT_TYPE,
    version: COMPRESSOR_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_COMPRESSOR_PARAMS, ...params },
  }
}

function limiter(
  params: Record<string, EffectParamValue>,
): Omit<AudioEffectDescriptor, 'id'> {
  return {
    type: LIMITER_EFFECT_TYPE,
    version: LIMITER_EFFECT_VERSION,
    enabled: true,
    params: { ...DEFAULT_LIMITER_PARAMS, ...params },
  }
}

export const AUDIO_EFFECT_PRESETS: readonly AudioEffectPreset[] = Object.freeze([
  {
    id: 'voice',
    label: 'Voice',
    detail: 'Presence EQ, gentle compression, and a safety limiter.',
    effects: [
      eq({
        band1Type: 'highpass',
        band1Freq: 80,
        band1Q: 0.7,
        band1Gain: 0,
        band3Type: 'peak',
        band3Freq: 3_500,
        band3Q: 1.2,
        band3Gain: 2.5,
      }),
      compressor({
        thresholdDb: -18,
        ratio: 3,
        attackMs: 8,
        releaseMs: 80,
        kneeDb: 6,
        makeupDb: 3,
      }),
      limiter({ ceilingDb: -1, releaseMs: 40 }),
    ],
  },
  {
    id: 'music',
    label: 'Music',
    detail: 'Wide EQ and a slow compressor for mixed music beds.',
    effects: [
      eq({
        band1Type: 'lowshelf',
        band1Freq: 120,
        band1Q: 0.7,
        band1Gain: 1,
        band4Type: 'highshelf',
        band4Freq: 8_000,
        band4Q: 0.7,
        band4Gain: 1.5,
      }),
      compressor({
        thresholdDb: -16,
        ratio: 2,
        attackMs: 20,
        releaseMs: 200,
        kneeDb: 8,
        makeupDb: 1.5,
      }),
    ],
  },
  {
    id: 'podcast',
    label: 'Podcast',
    detail: 'Speech high-pass, denser compression, and a tighter ceiling.',
    effects: [
      eq({
        band1Type: 'highpass',
        band1Freq: 90,
        band1Q: 0.7,
        band1Gain: 0,
        band2Type: 'peak',
        band2Freq: 200,
        band2Q: 0.8,
        band2Gain: -2,
      }),
      compressor({
        thresholdDb: -20,
        ratio: 4,
        attackMs: 5,
        releaseMs: 60,
        kneeDb: 4,
        makeupDb: 4,
      }),
      limiter({ ceilingDb: -1.5, releaseMs: 30 }),
    ],
  },
])

export function audioEffectPreset(id: string): AudioEffectPreset | null {
  return AUDIO_EFFECT_PRESETS.find((preset) => preset.id === id) ?? null
}
