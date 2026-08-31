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
  effectDescriptorBoundsError,
  effectDescriptorBudget,
  type EffectBudgetUsage,
} from './effectBounds'

export const AUDIO_EFFECT_STACK_LIMITS = Object.freeze({
  maxEffectsPerStack: EFFECT_STACK_LIMITS.maxEffectsPerClip,
  maxEffectParams: EFFECT_STACK_LIMITS.maxEffectParams,
  maxTotalEffects: EFFECT_STACK_LIMITS.maxTotalEffects,
  maxTotalEffectParams: EFFECT_STACK_LIMITS.maxTotalEffectParams,
  maxTotalEffectStringCharacters: EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters,
  maxEffectStringCharacters: EFFECT_STACK_LIMITS.maxEffectStringCharacters,
  maxIdCharacters: EFFECT_STACK_LIMITS.maxIdCharacters,
  maxTypeAndParamKeyCharacters: EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters,
  maxFiniteMagnitude: EFFECT_STACK_LIMITS.maxFiniteMagnitude,
})

export function audioEffectDescriptorBoundsError(value: unknown): string | null {
  return effectDescriptorBoundsError(value)
}

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

export function audioEffectDescriptorBudget(
  effect: AudioEffectDescriptor,
): EffectBudgetUsage {
  return effectDescriptorBudget(effect)
}

function stackBudgetUsage(
  effects: readonly AudioEffectDescriptor[],
): EffectBudgetUsage {
  let params = 0
  let stringCharacters = 0
  for (const effect of effects) {
    const descriptor = audioEffectDescriptorBudget(effect)
    params += descriptor.params
    stringCharacters += descriptor.stringCharacters
  }
  return { effects: effects.length, params, stringCharacters }
}

function addUsage(left: EffectBudgetUsage, right: EffectBudgetUsage): EffectBudgetUsage {
  return {
    effects: left.effects + right.effects,
    params: left.params + right.params,
    stringCharacters: left.stringCharacters + right.stringCharacters,
  }
}

export function documentAudioEffectBudgetUsage(doc: TimelineDoc): EffectBudgetUsage {
  let usage: EffectBudgetUsage = { effects: 0, params: 0, stringCharacters: 0 }
  usage = addUsage(usage, stackBudgetUsage(masterAudioEffects(doc.masterAudio)))
  for (const track of doc.tracks) {
    usage = addUsage(usage, stackBudgetUsage(trackAudioEffects(track)))
    for (const clip of track.clips) {
      usage = addUsage(usage, stackBudgetUsage(clipAudioEffects(clip)))
    }
  }
  return usage
}

function aggregateBudgetError(usage: EffectBudgetUsage): string | null {
  if (usage.effects > AUDIO_EFFECT_STACK_LIMITS.maxTotalEffects) {
    return `project exceeds ${AUDIO_EFFECT_STACK_LIMITS.maxTotalEffects} audio effects in total`
  }
  if (usage.params > AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectParams) {
    return `project exceeds ${AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectParams} audio-effect parameters in total`
  }
  if (usage.stringCharacters > AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters) {
    return `project exceeds ${AUDIO_EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters} audio-effect-string characters in total`
  }
  return null
}

export function audioEffectCollectionAppendBudgetError(
  doc: TimelineDoc,
  effects: readonly AudioEffectDescriptor[],
): string | null {
  if (effects.length === 0) return null
  const current = documentAudioEffectBudgetUsage(doc)
  const added = stackBudgetUsage(effects)
  return aggregateBudgetError(addUsage(current, added))
}

export function audioEffectAppendBudgetError(
  doc: TimelineDoc,
  stack: readonly AudioEffectDescriptor[],
  effect: AudioEffectDescriptor,
): string | null {
  if (stack.length + 1 > AUDIO_EFFECT_STACK_LIMITS.maxEffectsPerStack) {
    return `audio-effect stack has reached the ${AUDIO_EFFECT_STACK_LIMITS.maxEffectsPerStack}-effect limit`
  }
  return audioEffectCollectionAppendBudgetError(doc, [effect])
}

export function audioEffectReplacementBudgetError(
  doc: TimelineDoc,
  previous: AudioEffectDescriptor,
  next: AudioEffectDescriptor,
): string | null {
  const current = documentAudioEffectBudgetUsage(doc)
  const removed = audioEffectDescriptorBudget(previous)
  const added = audioEffectDescriptorBudget(next)
  return aggregateBudgetError({
    effects: current.effects,
    params: current.params - removed.params + added.params,
    stringCharacters:
      current.stringCharacters - removed.stringCharacters + added.stringCharacters,
  })
}

export function audioEffectIdExists(doc: TimelineDoc, effectId: string): boolean {
  if (masterAudioEffects(doc.masterAudio).some((effect) => effect.id === effectId)) {
    return true
  }
  for (const track of doc.tracks) {
    if (trackAudioEffects(track).some((effect) => effect.id === effectId)) return true
    for (const clip of track.clips) {
      if (clipAudioEffects(clip).some((effect) => effect.id === effectId)) return true
    }
  }
  return false
}
