import { describe, expect, test } from 'vitest'
import { captureEffectPreset, effectPresetError, mutateEffectPresetLibrary, readEffectPresetLibrary, type EffectPreset } from './effectPresets'
import { attributeProject } from '../test/clipAttributeFixtures'
import { createMaskEffect } from './effectStack'
import { parseCube, portableColorLut } from './colorLut'
import { COLOR_GRADING_RECIPES } from './colorGradingRecipes'
const source = () => attributeProject().sequences[0].tracks[0].clips[0]
const preset = (name = 'Look', id = 'preset'): EffectPreset => captureEffectPreset(source(), 5, id, name)
const envelope = (presets: unknown[], version = 2) => JSON.stringify({ version, presets })

describe('bounded local effect presets', () => {
  test('captures resolved current values, disabled/future intent, omitted defaults and no keys or media', () => {
    const clip = source()
    clip.effects[0].params.exposure = 0
    const result = captureEffectPreset(clip, 5, 'id', ' Look ')
    expect(result.name).toBe('Look')
    expect(result.effects[0]).toMatchObject({ id: 'template-1', params: { exposure: 1 } })
    expect(result.effects[0].params).not.toHaveProperty('temperature')
    expect(result.effects[1]).toMatchObject({ type: 'future.effect', version: 17, enabled: false })
    expect(Object.keys(result)).toEqual(['id', 'name', 'effects', 'colorLuts'])
    clip.effects[0].params.exposure = -4
    expect(result.effects[0].params.exposure).toBe(1)
  })
  test('roundtrips, renames and deletes without altering applied templates', () => {
    const first = preset()
    const saved = mutateEffectPresetLibrary(undefined, { kind: 'save', preset: first })
    const renamed = mutateEffectPresetLibrary(saved, { kind: 'rename', id: first.id, name: 'Cool look' })
    expect(readEffectPresetLibrary(renamed).view.presets[0].name).toBe('Cool look')
    expect(readEffectPresetLibrary(mutateEffectPresetLibrary(renamed, { kind: 'delete', id: first.id })).view.presets).toEqual([])
    expect(first.name).toBe('Look')
  })
  test('valid siblings survive corrupt, duplicate and unsupported entries; writes preserve their raw data', () => {
    const corrupt = { name: 'Broken', execute: 'no' }
    const raw = envelope([preset(), corrupt, preset('Duplicate', 'preset')])
    const view = readEffectPresetLibrary(raw).view
    expect(view.presets).toHaveLength(1)
    expect(view.unavailable).toHaveLength(2)
    const changed = mutateEffectPresetLibrary(raw, { kind: 'save', preset: preset('Second', 'second') })
    expect(JSON.parse(changed).presets[1]).toEqual(corrupt)
    expect(readEffectPresetLibrary(changed).view.presets).toHaveLength(2)
  })
  test.each(['future', 'corrupt', 'unknown-fields', 'oversize'])('invalid or future %s envelopes remain read-only', (scenario) => {
    const raw = scenario === 'future' ? envelope([], 3) : scenario === 'corrupt' ? '{' : scenario === 'unknown-fields' ? JSON.stringify({ version: 1, presets: [], authority: true }) : 'x'.repeat(8 * 1024 * 1024 + 1)
    expect(readEffectPresetLibrary(raw).view.readOnlyReason).toBeTruthy()
    expect(() => mutateEffectPresetLibrary(raw, { kind: 'save', preset: preset() })).toThrow()
  })
  test.each(['https://host/file', 'blob:origin/id', 'data:application/wasm;base64,AAAA', 'file:/private/secret', '//host/image', '/media/file', 'javascript:run()'])('rejects resource value %s', (value) => {
    const entry = preset()
    entry.effects[0].params.future = value
    expect(effectPresetError(entry)).toMatch(/resource|executable/)
  })
  test.each(['url', 'code', 'wasm', 'package', 'signature', 'grants', 'mediaId', 'assetId'])('rejects resource/executable key %s', (key) => {
    const entry = preset(); entry.effects[0].params[key] = 'value'
    expect(effectPresetError(entry)).toMatch(/resource|executable/)
  })
  test('accepts bounded Bezier path primitives without granting any loader', () => {
    expect(effectPresetError({ id: 'mask', name: 'Mask', effects: [createMaskEffect('shape', 'bezier')], colorLuts: [] })).toBeNull()
  })
  test('enforces exact templates, primitive payloads, descriptor and UTF-8 byte bounds', () => {
    const entry = preset()
    expect(effectPresetError({ ...entry, media: [] })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: [{ ...entry.effects[0], runtime: {} }] })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: [{ ...entry.effects[0], params: { nested: {} } }] })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: Array.from({ length: 33 }, (_, i) => ({ ...entry.effects[0], id: `id-${i}` })) })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: [{ ...entry.effects[0], params: { large: 'é'.repeat(65_537) } }] })).toBeTruthy()
    expect(effectPresetError({ ...entry, name: 'a'.repeat(81) })).toBeTruthy()
  })
  test('enforces duplicate name/id, record count and cumulative byte bounds', () => {
    const raw = mutateEffectPresetLibrary(undefined, { kind: 'save', preset: preset() })
    expect(() => mutateEffectPresetLibrary(raw, { kind: 'save', preset: preset('LOOK', 'second') })).toThrow(/name/)
    expect(() => mutateEffectPresetLibrary(raw, { kind: 'save', preset: preset('Other') })).toThrow(/identity/)
    const full = envelope(Array.from({ length: 100 }, (_, i) => preset(`Look ${i}`, `id-${i}`)))
    expect(() => mutateEffectPresetLibrary(full, { kind: 'save', preset: preset() })).toThrow(/100/)
    const heavy = Array.from({ length: 64 }, (_, i) => {
      const entry = preset(`Heavy ${i}`, `id-${i}`)
      entry.effects[0].params = { a: 'a'.repeat(65_000), b: 'b'.repeat(65_000) }
      return entry
    })
    const extra = structuredClone(heavy[0]); (extra as { id: string; name: string }).id = 'extra'; (extra as { name: string }).name = 'Extra'
    expect(() => mutateEffectPresetLibrary(envelope(heavy), { kind: 'save', preset: extra })).toThrow(/8 MiB/)
  })
})

test('version 1 migrates transactionally to empty bundles and preserves corrupt siblings', () => {
  const { colorLuts: _tables, ...legacy } = preset()
  const corrupt = { name: 'Keep this', nested: { future: ['opaque'] } }
  const parsed = readEffectPresetLibrary(envelope([legacy, corrupt], 1))
  expect(parsed.view.presets[0]).toMatchObject({ ...legacy, colorLuts: [] })
  expect(JSON.parse(parsed.migration!)).toEqual({ version: 2, presets: [{ ...legacy, colorLuts: [] }, corrupt] })
  expect(readEffectPresetLibrary(envelope([], 99)).migration).toBeUndefined()
})

test('a portable preset requires exactly its referenced supported LUTs and captures static values', () => {
  const table = portableColorLut('table', 'Local', parseCube('LUT_1D_SIZE 2\n0.1 0.2 0.3\n0.8 0.7 0.6'))
  const clip = source()
  clip.effects = [{ id: 'lut', type: 'builtin.cube-lut', version: 1, enabled: true, params: { lutId: 'table', strength: 1 } }]
  clip.animation = { tracks: [], effectTracks: [{ effectId: 'lut', parameter: 'strength', keyframes: [{ frame: 0, value: 0.4, easing: { type: 'hold' } }] }] }
  expect(() => captureEffectPreset(clip, 5, 'p', 'Look')).toThrow(/missing.*LUT/)
  const captured = captureEffectPreset(clip, 5, 'p', 'Look', [table])
  expect(captured.colorLuts).toEqual([table])
  expect(captured.effects[0].params.strength).toBe(0.4)
  expect(effectPresetError(captured)).toBeNull()
  expect(effectPresetError({ ...captured, colorLuts: [{ ...table, data: 'broken' }] })).toMatch(/LUT/)
  expect(effectPresetError({ ...captured, colorLuts: [table, { ...table, id: 'unused' }] })).toMatch(/unreferenced/)
  expect(effectPresetError({ ...captured, colorLuts: [{ id: 'table', version: 99 }] })).toMatch(/unsupported/)
})

test('a native 33 LUT fits one preset while two exact tables exceed its 2 MiB serialized ceiling', () => {
  const table = portableColorLut('table', 'Native 33', { kind: '3d', size: 33, title: '', domainMin: [0, 0, 0], domainMax: [1, 1, 1], samples: new Float64Array(33 ** 3 * 3).fill(0.5) })
  const effects = [{ id: 'lut', type: 'builtin.cube-lut', version: 1, enabled: true, params: { lutId: table.id, strength: 1 } }]
  const native = { id: 'native', name: 'Native', effects, colorLuts: [table] }
  expect(effectPresetError(native)).toBeNull()
  expect(effectPresetError({ ...native, effects: [...effects, { ...effects[0], id: 'second', params: { lutId: 'second', strength: 1 } }], colorLuts: [table, { ...table, id: 'second' }] })).toMatch(/2 MiB/)
  const envelopeWithCorruptSibling = envelope([native, { opaque: 'é'.repeat(3_700_000) }])
  expect(readEffectPresetLibrary(envelopeWithCorruptSibling).view.readOnlyReason).toMatch(/8 MiB/)
})

test('first-party correction recipes are stable numeric descriptors without LUT or execution payloads', () => {
  for (const { description: _description, ...recipe } of COLOR_GRADING_RECIPES) {
    expect(effectPresetError(recipe)).toBeNull()
    expect(recipe.colorLuts).toEqual([])
  }
})
