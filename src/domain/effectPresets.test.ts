import { describe, expect, test } from 'vitest'
import { captureEffectPreset, effectPresetError, mutateEffectPresetLibrary, readEffectPresetLibrary, type EffectPreset } from './effectPresets'
import { attributeProject } from '../test/clipAttributeFixtures'
import { createMaskEffect } from './effectStack'
const source = () => attributeProject().sequences[0].tracks[0].clips[0]
const preset = (name = 'Look', id = 'preset'): EffectPreset => captureEffectPreset(source(), 5, id, name)
const envelope = (presets: unknown[], version = 1) => JSON.stringify({ version, presets })

describe('bounded local effect presets', () => {
  test('captures resolved current values, disabled/future intent, omitted defaults and no keys or media', () => {
    const clip = source()
    clip.effects[0].params.exposure = 0
    const result = captureEffectPreset(clip, 5, 'id', ' Look ')
    expect(result.name).toBe('Look')
    expect(result.effects[0]).toMatchObject({ id: 'template-1', params: { exposure: 1 } })
    expect(result.effects[0].params).not.toHaveProperty('temperature')
    expect(result.effects[1]).toMatchObject({ type: 'future.effect', version: 17, enabled: false })
    expect(Object.keys(result)).toEqual(['id', 'name', 'effects'])
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
    const raw = scenario === 'future' ? envelope([], 2) : scenario === 'corrupt' ? '{' : scenario === 'unknown-fields' ? JSON.stringify({ version: 1, presets: [], authority: true }) : 'x'.repeat(2 * 1024 * 1024 + 1)
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
    expect(effectPresetError({ id: 'mask', name: 'Mask', effects: [createMaskEffect('shape', 'bezier')] })).toBeNull()
  })
  test('enforces exact templates, primitive payloads, descriptor and UTF-8 byte bounds', () => {
    const entry = preset()
    expect(effectPresetError({ ...entry, media: [] })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: [{ ...entry.effects[0], runtime: {} }] })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: [{ ...entry.effects[0], params: { nested: {} } }] })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: Array.from({ length: 33 }, (_, i) => ({ ...entry.effects[0], id: `id-${i}` })) })).toBeTruthy()
    expect(effectPresetError({ ...entry, effects: [{ ...entry.effects[0], params: { large: 'é'.repeat(65_536) } }] })).toMatch(/128 KiB/)
    expect(effectPresetError({ ...entry, name: 'a'.repeat(81) })).toBeTruthy()
  })
  test('enforces duplicate name/id, record count and cumulative byte bounds', () => {
    const raw = mutateEffectPresetLibrary(undefined, { kind: 'save', preset: preset() })
    expect(() => mutateEffectPresetLibrary(raw, { kind: 'save', preset: preset('LOOK', 'second') })).toThrow(/name/)
    expect(() => mutateEffectPresetLibrary(raw, { kind: 'save', preset: preset('Other') })).toThrow(/identity/)
    const full = envelope(Array.from({ length: 100 }, (_, i) => preset(`Look ${i}`, `id-${i}`)))
    expect(() => mutateEffectPresetLibrary(full, { kind: 'save', preset: preset() })).toThrow(/100/)
    const heavy = Array.from({ length: 16 }, (_, i) => {
      const entry = preset(`Heavy ${i}`, `id-${i}`)
      entry.effects[0].params = { a: 'a'.repeat(65_000), b: 'b'.repeat(65_000) }
      return entry
    })
    const extra = structuredClone(heavy[0]); (extra as { id: string; name: string }).id = 'extra'; (extra as { name: string }).name = 'Extra'
    expect(() => mutateEffectPresetLibrary(envelope(heavy), { kind: 'save', preset: extra })).toThrow(/2 MiB/)
  })
})
