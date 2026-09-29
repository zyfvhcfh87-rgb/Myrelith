import { CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import { describe, expect, test } from 'vitest'
import type { AudioEffectDescriptor, Clip, EffectDescriptor, TimelineDoc, Track } from './schema'
import {
  EFFECT_STACK_LIMITS,
  documentEffectBudgetUsage,
  effectAppendBudgetError,
  effectCollectionAppendBudgetError,
  effectDescriptorBoundsError,
  effectReplacementBudgetError,
} from './effectBounds'
import {
  AUDIO_EFFECT_STACK_LIMITS,
  audioEffectAppendBudgetError,
  audioEffectCollectionAppendBudgetError,
  audioEffectIdExists,
  audioEffectReplacementBudgetError,
  documentAudioEffectBudgetUsage,
} from './audioEffectBounds'

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
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
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

describe('audio effect stack budgets share the video rules with audio wording', () => {
  const full = Object.fromEntries(Array.from(
    { length: EFFECT_STACK_LIMITS.maxEffectParams },
    (_value, index) => [`p-${index}`, index],
  ))
  const chunk = { value: 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters) }
  const audioDoc = (clipEffects: AudioEffectDescriptor[], trackEffects: AudioEffectDescriptor[] = [],
    masterEffects: AudioEffectDescriptor[] = []): TimelineDoc => ({
    ...docWithEffects([]),
    masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: masterEffects },
    tracks: [{
      id: 'A1', name: 'A1', kind: 'audio', transitions: [], hidden: false, muted: false, solo: false, locked: false,
      audioEffects: trackEffects, clips: [{ ...clip('audio-clip'), audioEffects: clipEffects }],
    }],
  })
  const many = (count: number, params: EffectDescriptor['params'] = {}) =>
    Array.from({ length: count }, (_value, index) => effect(`a-${index}`, params))

  test('reports exact aggregate, per-stack, and replacement messages', () => {
    const total = audioDoc(many(9_000), many(999), many(1))
    expect(documentAudioEffectBudgetUsage(total).effects).toBe(10_000)
    expect(audioEffectCollectionAppendBudgetError(total, [])).toBeNull()
    expect(audioEffectCollectionAppendBudgetError(total, [effect('over')]))
      .toBe('project exceeds 10000 audio effects in total')
    expect(audioEffectCollectionAppendBudgetError(audioDoc(many(196, full)), [effect('over')]))
      .toBe('project exceeds 50000 audio-effect parameters in total')
    expect(audioEffectCollectionAppendBudgetError(audioDoc(many(153, chunk)), [effect('over')]))
      .toBe('project exceeds 10000000 audio-effect-string characters in total')
    const stack = many(EFFECT_STACK_LIMITS.maxEffectsPerClip)
    expect(audioEffectAppendBudgetError(audioDoc([]), stack, effect('over')))
      .toBe('audio-effect stack has reached the 256-effect limit')
    const target = effect('target')
    const nearFull = audioDoc([...many(195, full), target])
    expect(audioEffectReplacementBudgetError(nearFull, target, target)).toBeNull()
    expect(audioEffectReplacementBudgetError(nearFull, target, effect('target', full)))
      .toBe('project exceeds 50000 audio-effect parameters in total')
    expect(AUDIO_EFFECT_STACK_LIMITS).toEqual({
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
  })

  test('keeps the exact video wording and finds audio ids on every owner', () => {
    expect(effectCollectionAppendBudgetError(docWithEffects(many(10_000)), [effect('over')]))
      .toBe('project exceeds 10000 effects in total')
    expect(effectCollectionAppendBudgetError(docWithEffects(many(196, full)), [effect('over')]))
      .toBe('project exceeds 50000 effect parameters in total')
    expect(effectCollectionAppendBudgetError(docWithEffects(many(153, chunk)), [effect('over')]))
      .toBe('project exceeds 10000000 effect-string characters in total')
    const doc = audioDoc([effect('on-clip')], [effect('on-track')], [effect('on-master')])
    for (const id of ['on-clip', 'on-track', 'on-master']) expect(audioEffectIdExists(doc, id)).toBe(true)
    expect(audioEffectIdExists(doc, 'missing')).toBe(false)
  })
})
