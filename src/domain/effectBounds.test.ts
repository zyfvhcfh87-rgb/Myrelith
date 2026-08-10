import { describe, expect, test } from 'vitest'
import type { Clip, EffectDescriptor, TimelineDoc, Track } from './schema'
import {
  EFFECT_STACK_LIMITS,
  documentEffectBudgetUsage,
  effectAppendBudgetError,
  effectDescriptorBoundsError,
  effectReplacementBudgetError,
} from './effectBounds'

function effect(
  id: string,
  params: EffectDescriptor['params'] = {},
): EffectDescriptor {
  return { id, type: 'test.opaque', version: 1, enabled: true, params }
}

function clip(id: string, effects: EffectDescriptor[] = []): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 1 },
    timelineRange: { startFrame: 0, durationFrames: 1 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects,
  }
}

function docWithEffects(effects: EffectDescriptor[], selected: Clip = clip('selected')): TimelineDoc {
  const clips: Clip[] = [selected]
  for (let offset = 0; offset < effects.length; offset += EFFECT_STACK_LIMITS.maxEffectsPerClip) {
    clips.push(clip(
      `budget-${offset}`,
      effects.slice(offset, offset + EFFECT_STACK_LIMITS.maxEffectsPerClip),
    ))
  }
  const track: Track = {
    id: 'V1',
    kind: 'video',
    name: 'V1',
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
  return {
    schemaVersion: 11,
    id: 'effect-budget-doc',
    name: 'Effect budget',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [track],
  }
}

describe('shared effect descriptor bounds', () => {
  test('accepts exact field, parameter, number, and string limits', () => {
    const params: EffectDescriptor['params'] = Object.fromEntries(Array.from(
      { length: EFFECT_STACK_LIMITS.maxEffectParams },
      (_value, index) => [`parameter-${index}`, index],
    ))
    params['parameter-0'] = EFFECT_STACK_LIMITS.maxFiniteMagnitude
    params['parameter-1'] = -EFFECT_STACK_LIMITS.maxFiniteMagnitude
    params['parameter-2'] = 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters)
    expect(effectDescriptorBoundsError({
      id: 'i'.repeat(EFFECT_STACK_LIMITS.maxIdCharacters),
      type: 't'.repeat(EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters),
      version: Number.MAX_SAFE_INTEGER,
      enabled: false,
      params,
    })).toBeNull()
  })

  test('rejects every over-limit or non-portable descriptor shape', () => {
    const base = effect('fx')
    const cases: unknown[] = [
      { ...base, extra: true },
      { ...base, id: 'x'.repeat(EFFECT_STACK_LIMITS.maxIdCharacters + 1) },
      { ...base, type: 'x'.repeat(EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters + 1) },
      { ...base, version: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...base,
        params: Object.fromEntries(Array.from(
          { length: EFFECT_STACK_LIMITS.maxEffectParams + 1 },
          (_value, index) => [`p-${index}`, index],
        )),
      },
      { ...base, params: { ['x'.repeat(EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters + 1)]: 1 } },
      { ...base, params: { amount: EFFECT_STACK_LIMITS.maxFiniteMagnitude + 1 } },
      { ...base, params: { label: 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters + 1) } },
      { ...base, params: JSON.parse('{"__proto__":true}') as Record<string, boolean> },
      { ...base, params: { nested: {} } },
    ]
    for (const candidate of cases) {
      expect(effectDescriptorBoundsError(candidate)).not.toBeNull()
    }
  })
})

describe('shared effect stack budgets', () => {
  test('allows the exact per-clip and document effect limits, then rejects one more', () => {
    const perClip = clip(
      'selected',
      Array.from(
        { length: EFFECT_STACK_LIMITS.maxEffectsPerClip - 1 },
        (_value, index) => effect(`clip-effect-${index}`),
      ),
    )
    const perClipDoc = docWithEffects([], perClip)
    expect(effectAppendBudgetError(perClipDoc, perClip, effect('last-clip-effect'))).toBeNull()
    perClip.effects.push(effect('last-clip-effect'))
    expect(effectAppendBudgetError(perClipDoc, perClip, effect('over-clip-effect')))
      .toMatch(/256-effect limit/)

    const aggregate = Array.from(
      { length: EFFECT_STACK_LIMITS.maxTotalEffects - 1 },
      (_value, index) => effect(`aggregate-${index}`),
    )
    const aggregateDoc = docWithEffects(aggregate)
    const selected = aggregateDoc.tracks[0].clips[0]
    expect(effectAppendBudgetError(aggregateDoc, selected, effect('aggregate-last'))).toBeNull()
    aggregate.push(effect('aggregate-last'))
    const fullDoc = docWithEffects(aggregate)
    expect(effectAppendBudgetError(fullDoc, fullDoc.tracks[0].clips[0], effect('aggregate-over')))
      .toMatch(/10000 effects in total/)
  })

  test('allows exact aggregate parameter and string budgets, then rejects one more', () => {
    const fullParams = Object.fromEntries(Array.from(
      { length: EFFECT_STACK_LIMITS.maxEffectParams },
      (_value, index) => [`p-${index}`, index],
    ))
    const parameterEffects = Array.from({ length: 195 }, (_value, index) =>
      effect(`parameter-${index}`, fullParams),
    )
    const target = effect('parameter-target', Object.fromEntries(Array.from(
      { length: 79 },
      (_value, index) => [`tail-${index}`, index],
    )))
    const parameterDoc = docWithEffects([...parameterEffects, target])
    const exactParams = { ...target, params: { ...target.params, exact: true } }
    const overParams = { ...exactParams, params: { ...exactParams.params, over: true } }
    expect(documentEffectBudgetUsage(parameterDoc).params).toBe(49_999)
    expect(effectReplacementBudgetError(parameterDoc, target, exactParams)).toBeNull()
    expect(effectReplacementBudgetError(parameterDoc, target, overParams))
      .toMatch(/50000 effect parameters in total/)

    const chunk = 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters)
    const stringEffects = Array.from({ length: 152 }, (_value, index) =>
      effect(`string-${index}`, { value: chunk }),
    )
    const remaining = EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters
      - 152 * EFFECT_STACK_LIMITS.maxEffectStringCharacters
    const stringTarget = effect('string-target', { value: 'x'.repeat(remaining - 1) })
    const stringDoc = docWithEffects([...stringEffects, stringTarget])
    const exactString = { ...stringTarget, params: { value: 'x'.repeat(remaining) } }
    const overString = { ...stringTarget, params: { value: 'x'.repeat(remaining + 1) } }
    expect(documentEffectBudgetUsage(stringDoc).stringCharacters).toBe(9_999_999)
    expect(effectReplacementBudgetError(stringDoc, stringTarget, exactString)).toBeNull()
    expect(effectReplacementBudgetError(stringDoc, stringTarget, overString))
      .toMatch(/10000000 effect-string characters in total/)
  })
})
