/** Shared aggregate bounds for one portable multi-sequence project. */

import { AUDIO_EFFECT_STACK_LIMITS } from './audioEffectBounds'
import { MAX_TOTAL_ANIMATION_KEYFRAMES } from './clipAnimation'
import { EFFECT_STACK_LIMITS } from './effectBounds'

export const SEQUENCE_PROJECT_LIMITS = Object.freeze({
  maxSequences: 256,
  maxTotalTracks: 4_096,
  maxTotalClips: 100_000,
  maxTotalAdjustments: 100_000,
  maxTotalTransitions: 100_000,
  maxTotalMarkers: 100_000,
  maxTotalCaptionTracks: 4_096,
  maxTotalCaptionItems: 100_000,
  maxTotalEffects: EFFECT_STACK_LIMITS.maxTotalEffects,
  maxTotalEffectParams: EFFECT_STACK_LIMITS.maxTotalEffectParams,
  maxTotalEffectStringCharacters:
    EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters,
  maxTotalAudioEffects: AUDIO_EFFECT_STACK_LIMITS.maxTotalEffects,
  maxTotalAudioEffectParams: AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectParams,
  maxTotalAudioEffectStringCharacters:
    AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters,
  maxTotalKeyframes: MAX_TOTAL_ANIMATION_KEYFRAMES,
  maxTotalSpeedPoints: 100_000,
  maxTotalTextCharacters: 10_000_000,
})
