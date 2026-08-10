/** Shared portable and live-edit bounds for durable effect descriptors. */

import type { Clip, EffectDescriptor, TimelineDoc } from './schema'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'

export const EFFECT_STACK_LIMITS = Object.freeze({
  maxEffectsPerClip: 256,
  maxEffectParams: 256,
  maxTotalEffects: 10_000,
  maxTotalEffectParams: 50_000,
  maxTotalEffectStringCharacters: 10_000_000,
  maxEffectStringCharacters: 65_536,
  maxIdCharacters: MAX_DOCUMENT_ID_CHARACTERS,
  maxTypeAndParamKeyCharacters: MAX_PROJECT_NAME_CHARACTERS,
  maxFiniteMagnitude: 1_000_000_000,
})

const EFFECT_DESCRIPTOR_KEYS = Object.freeze([
  'id',
  'type',
  'version',
  'enabled',
  'params',
] as const)
const EFFECT_DESCRIPTOR_KEY_SET = new Set<string>(EFFECT_DESCRIPTOR_KEYS)
const UNSAFE_PARAM_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface EffectBudgetUsage {
  readonly effects: number
  readonly params: number
  readonly stringCharacters: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedRequiredStringError(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (typeof value !== 'string') return `${label} must be a string`
  if (value.length > maximum) return `${label} exceeds ${maximum} characters`
  if (value.trim().length === 0) return `${label} must not be empty`
  return null
}

/** Structural/bounded contract shared by live edits and portable validation. */
export function effectDescriptorBoundsError(value: unknown): string | null {
  if (!isRecord(value)) return 'effect descriptor must be an object'
  for (const key of EFFECT_DESCRIPTOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return `effect descriptor is missing field ${key}`
    }
  }
  const unknownKey = Object.keys(value).find((key) => !EFFECT_DESCRIPTOR_KEY_SET.has(key))
  if (unknownKey) return `effect descriptor has unknown field ${unknownKey}`

  const idError = boundedRequiredStringError(
    value.id,
    'effect id',
    EFFECT_STACK_LIMITS.maxIdCharacters,
  )
  if (idError) return idError
  const typeError = boundedRequiredStringError(
    value.type,
    'effect type',
    EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters,
  )
  if (typeError) return typeError
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 0) {
    return 'effect version must be a non-negative safe integer'
  }
  if (typeof value.enabled !== 'boolean') return 'effect enabled must be a boolean'
  if (!isRecord(value.params)) return 'effect params must be a record'

  const keys = Object.keys(value.params)
  if (keys.length > EFFECT_STACK_LIMITS.maxEffectParams) {
    return `effect params exceed ${EFFECT_STACK_LIMITS.maxEffectParams} entries`
  }
  for (const key of keys) {
    const keyError = boundedRequiredStringError(
      key,
      'effect parameter key',
      EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters,
    )
    if (keyError) return keyError
    if (UNSAFE_PARAM_KEYS.has(key)) return `unsafe parameter key ${key}`
    const parameter = value.params[key]
    if (typeof parameter === 'number') {
      if (
        !Number.isFinite(parameter)
        || Math.abs(parameter) > EFFECT_STACK_LIMITS.maxFiniteMagnitude
      ) {
        return `effect parameter ${key} must be a finite number between -${EFFECT_STACK_LIMITS.maxFiniteMagnitude} and ${EFFECT_STACK_LIMITS.maxFiniteMagnitude}`
      }
    } else if (typeof parameter === 'string') {
      if (parameter.length > EFFECT_STACK_LIMITS.maxEffectStringCharacters) {
        return `effect parameter ${key} exceeds ${EFFECT_STACK_LIMITS.maxEffectStringCharacters} characters`
      }
    } else if (typeof parameter !== 'boolean') {
      return `effect parameter ${key} must be a finite number, string, or boolean`
    }
  }
  return null
}

export function effectDescriptorBudget(effect: EffectDescriptor): EffectBudgetUsage {
  const values = Object.values(effect.params)
  return {
    effects: 1,
    params: values.length,
    stringCharacters: values.reduce<number>(
      (total, value) => total + (typeof value === 'string' ? value.length : 0),
      0,
    ),
  }
}

export function documentEffectBudgetUsage(doc: TimelineDoc): EffectBudgetUsage {
  let effects = 0
  let params = 0
  let stringCharacters = 0
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      effects += clip.effects.length
      for (const effect of clip.effects) {
        const descriptor = effectDescriptorBudget(effect)
        params += descriptor.params
        stringCharacters += descriptor.stringCharacters
      }
    }
  }
  return { effects, params, stringCharacters }
}

function effectBudgetUsage(
  effects: readonly EffectDescriptor[],
): EffectBudgetUsage {
  let params = 0
  let stringCharacters = 0
  for (const effect of effects) {
    const descriptor = effectDescriptorBudget(effect)
    params += descriptor.params
    stringCharacters += descriptor.stringCharacters
  }
  return { effects: effects.length, params, stringCharacters }
}

function aggregateBudgetError(usage: EffectBudgetUsage): string | null {
  if (usage.effects > EFFECT_STACK_LIMITS.maxTotalEffects) {
    return `project exceeds ${EFFECT_STACK_LIMITS.maxTotalEffects} effects in total`
  }
  if (usage.params > EFFECT_STACK_LIMITS.maxTotalEffectParams) {
    return `project exceeds ${EFFECT_STACK_LIMITS.maxTotalEffectParams} effect parameters in total`
  }
  if (usage.stringCharacters > EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters) {
    return `project exceeds ${EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters} effect-string characters in total`
  }
  return null
}

/** Explain whether cloning a bounded descriptor collection would exceed totals. */
export function effectCollectionAppendBudgetError(
  doc: TimelineDoc,
  effects: readonly EffectDescriptor[],
): string | null {
  if (effects.length === 0) return null
  const current = documentEffectBudgetUsage(doc)
  const added = effectBudgetUsage(effects)
  return aggregateBudgetError({
    effects: current.effects + added.effects,
    params: current.params + added.params,
    stringCharacters: current.stringCharacters + added.stringCharacters,
  })
}

/** Explain whether appending one already-bounded descriptor would exceed a budget. */
export function effectAppendBudgetError(
  doc: TimelineDoc,
  clip: Clip,
  effect: EffectDescriptor,
): string | null {
  if (clip.effects.length + 1 > EFFECT_STACK_LIMITS.maxEffectsPerClip) {
    return `clip has reached the ${EFFECT_STACK_LIMITS.maxEffectsPerClip}-effect limit`
  }
  return effectCollectionAppendBudgetError(doc, [effect])
}

/** Explain whether replacing one descriptor would exceed aggregate budgets. */
export function effectReplacementBudgetError(
  doc: TimelineDoc,
  previous: EffectDescriptor,
  next: EffectDescriptor,
): string | null {
  const current = documentEffectBudgetUsage(doc)
  const removed = effectDescriptorBudget(previous)
  const added = effectDescriptorBudget(next)
  return aggregateBudgetError({
    effects: current.effects,
    params: current.params - removed.params + added.params,
    stringCharacters:
      current.stringCharacters - removed.stringCharacters + added.stringCharacters,
  })
}
