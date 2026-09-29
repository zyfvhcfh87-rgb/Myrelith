/** Shared portable and live-edit bounds for durable audio-effect descriptors. */

import type {
  AudioEffectDescriptor,
  Clip,
  MasterAudioSettings,
  TimelineDoc,
  Track,
} from './schema'
import {
  EFFECT_STACK_LIMITS,
  effectAppendBudgetError,
  effectCollectionAppendBudgetError,
  effectReplacementBudgetError,
  effectStacksBudgetUsage,
  type EffectBudgetScope,
  type EffectBudgetUsage,
} from './effectBounds'

// Audio descriptors share the video descriptor contract and budget exactly.
export {
  effectDescriptorBoundsError as audioEffectDescriptorBoundsError,
  effectDescriptorBudget as audioEffectDescriptorBudget,
} from './effectBounds'

const { maxEffectsPerClip, ...SHARED_EFFECT_LIMITS } = EFFECT_STACK_LIMITS

/** Every video effect bound applies; only the per-owner stack name differs. */
export const AUDIO_EFFECT_STACK_LIMITS = Object.freeze({
  maxEffectsPerStack: maxEffectsPerClip,
  ...SHARED_EFFECT_LIMITS,
})

export function clipAudioEffects(clip: Clip): readonly AudioEffectDescriptor[] {
  return clip.audioEffects ?? []
}

export function trackAudioEffects(track: Track): readonly AudioEffectDescriptor[] {
  return track.audioEffects ?? []
}

export function masterAudioEffects(
  master: MasterAudioSettings | undefined,
): readonly AudioEffectDescriptor[] {
  return master?.audioEffects ?? []
}

function* documentAudioEffectStacks(doc: TimelineDoc): Generator<readonly AudioEffectDescriptor[]> {
  yield masterAudioEffects(doc.masterAudio)
  for (const track of doc.tracks) {
    yield trackAudioEffects(track)
    for (const clip of track.clips) yield clipAudioEffects(clip)
  }
}

export function documentAudioEffectBudgetUsage(doc: TimelineDoc): EffectBudgetUsage {
  return effectStacksBudgetUsage(documentAudioEffectStacks(doc))
}

const AUDIO_EFFECT_BUDGET: EffectBudgetScope = Object.freeze({
  usage: documentAudioEffectBudgetUsage,
  effects: 'audio effects',
  params: 'audio-effect parameters',
  strings: 'audio-effect-string characters',
})

export function audioEffectCollectionAppendBudgetError(
  doc: TimelineDoc,
  effects: readonly AudioEffectDescriptor[],
): string | null {
  return effectCollectionAppendBudgetError(doc, effects, AUDIO_EFFECT_BUDGET)
}

export function audioEffectAppendBudgetError(
  doc: TimelineDoc,
  stack: readonly AudioEffectDescriptor[],
  effect: AudioEffectDescriptor,
): string | null {
  return effectAppendBudgetError(doc, { effects: stack }, effect, 'audio-effect stack', AUDIO_EFFECT_BUDGET)
}

export function audioEffectReplacementBudgetError(
  doc: TimelineDoc,
  previous: AudioEffectDescriptor,
  next: AudioEffectDescriptor,
): string | null {
  return effectReplacementBudgetError(doc, previous, next, AUDIO_EFFECT_BUDGET)
}

export function audioEffectIdExists(doc: TimelineDoc, effectId: string): boolean {
  for (const stack of documentAudioEffectStacks(doc)) {
    if (stack.some((effect) => effect.id === effectId)) return true
  }
  return false
}
