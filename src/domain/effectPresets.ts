/** Bounded data-only local presets. No media, execution, trust or fetch authority. */
import type { Clip, EffectDescriptor } from './schema'
import type { ClipAttributeTemplate } from './clipAttributes'
import { effectDescriptorBoundsError } from './effectBounds'
import { cloneEffectDescriptor } from './effectStack'
import { resolveClipAnimationAtFrame } from './clipAnimation'

export const EFFECT_PRESET_LIMITS = Object.freeze({ presets: 100, name: 80, effects: 32, presetBytes: 128 * 1024, libraryBytes: 2 * 1024 * 1024 })
export interface EffectPreset { readonly id: string; readonly name: string; readonly effects: readonly EffectDescriptor[] }
export interface EffectPresetLibrary { readonly version: 1; readonly presets: readonly unknown[] }
export interface EffectPresetLibraryView {
  readonly presets: readonly EffectPreset[]
  readonly unavailable: readonly { index: number; reason: string }[]
  readonly readOnlyReason: string | null
}
export type PresetLibraryMutation =
  | { kind: 'save'; preset: EffectPreset }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; id: string }

const bytes = (text: string): number => new TextEncoder().encode(text).length
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
export function presetNameError(name: unknown): string | null {
  return typeof name !== 'string' || name !== name.trim() || !name.length || name.length > EFFECT_PRESET_LIMITS.name
    || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? 'Use a name of 1–80 characters without surrounding spaces or control characters.' : null
}
function resourceString(value: string): boolean {
  return value.includes('://') || /(?:\b(?:https?|ftp|wss?|data|blob|file|javascript|mailto):|^\s*(?:\/|\\|[a-z]:\\))/iu.test(value)
}
const resourceKey = /^(?:url|uri|src|assetId|mediaId|package|packageBytes|signature|grant|grants|permissions|code|wasm|wasmBytes|module|script|file|handle)$/iu

export function effectPresetError(value: unknown): string | null {
  if (!record(value) || !exactKeys(value, ['id', 'name', 'effects'])) return 'Preset fields must be exactly id, name and effects.'
  if (typeof value.id !== 'string' || !/^[a-z0-9_-]{1,128}$/iu.test(value.id)) return 'Preset identity is invalid.'
  const nameError = presetNameError(value.name)
  if (nameError) return nameError
  if (!Array.isArray(value.effects) || value.effects.length < 1 || value.effects.length > EFFECT_PRESET_LIMITS.effects) return 'Presets contain 1–32 effects.'
  const ids = new Set<string>()
  for (const raw of value.effects) {
    const error = effectDescriptorBoundsError(raw)
    if (error) return error
    const effect = raw as EffectDescriptor
    if (ids.has(effect.id)) return 'Preset effect identities must be unique.'
    ids.add(effect.id)
    if (resourceString(effect.type) || resourceString(effect.id)) return 'Preset descriptors cannot reference external resources.'
    for (const [key, parameter] of Object.entries(effect.params)) {
      if (resourceKey.test(key) || (typeof parameter === 'string' && resourceString(parameter))) return 'Preset parameters cannot contain resource or executable references.'
    }
  }
  if (bytes(JSON.stringify(value)) > EFFECT_PRESET_LIMITS.presetBytes) return 'Preset exceeds the 128 KiB limit.'
  return null
}

export function readEffectPresetLibrary(raw: unknown): { library: EffectPresetLibrary | null; view: EffectPresetLibraryView } {
  const unavailable = (reason: string) => ({ library: null, view: { presets: [], unavailable: [], readOnlyReason: reason } })
  if (raw === undefined) return { library: { version: 1, presets: [] }, view: { presets: [], unavailable: [], readOnlyReason: null } }
  if (typeof raw !== 'string' || raw.length > EFFECT_PRESET_LIMITS.libraryBytes || bytes(raw) > EFFECT_PRESET_LIMITS.libraryBytes) return unavailable('The local preset library exceeds its limit or has an invalid storage format. It remains untouched.')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return unavailable('The local preset library is corrupt. It remains untouched.') }
  if (!record(parsed) || !exactKeys(parsed, ['version', 'presets'])) return unavailable('The library envelope is invalid. It remains untouched.')
  if (parsed.version !== 1) return unavailable('This preset library version is unsupported. It is read-only and remains untouched.')
  if (!Array.isArray(parsed.presets) || parsed.presets.length > EFFECT_PRESET_LIMITS.presets) return unavailable('The local preset library exceeds 100 entries or is invalid. It remains untouched.')
  const valid: EffectPreset[] = []
  const invalid: { index: number; reason: string }[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  parsed.presets.forEach((value: unknown, index: number) => {
    let error = effectPresetError(value)
    if (!error) {
      const preset = value as EffectPreset
      if (ids.has(preset.id) || names.has(preset.name.toLowerCase())) error = 'Duplicate preset identity or name.'
      else { ids.add(preset.id); names.add(preset.name.toLowerCase()); valid.push(preset) }
    }
    if (error) invalid.push({ index, reason: error })
  })
  return { library: parsed as unknown as EffectPresetLibrary, view: { presets: valid, unavailable: invalid, readOnlyReason: null } }
}

/** Called inside a single storage read/write transaction; never drops corrupt siblings. */
export function mutateEffectPresetLibrary(raw: unknown, mutation: PresetLibraryMutation): string {
  const { library, view } = readEffectPresetLibrary(raw)
  if (!library) throw new Error(view.readOnlyReason!)
  const presets = [...library.presets]
  if (mutation.kind === 'save') {
    const error = effectPresetError(mutation.preset)
    if (error) throw new Error(error)
    if (presets.length >= EFFECT_PRESET_LIMITS.presets) throw new Error('The local library already contains 100 presets.')
    if (presets.some((value) => record(value) && value.id === mutation.preset.id)) throw new Error('Preset identity already exists.')
    if (presets.some((value) => record(value) && typeof value.name === 'string' && value.name.toLowerCase() === mutation.preset.name.toLowerCase())) throw new Error('A preset already uses this name.')
    presets.push(mutation.preset)
  } else {
    const preset = view.presets.find((entry) => entry.id === mutation.id)
    if (!preset) throw new Error('The preset is unavailable or was removed. Reload the library.')
    const index = presets.indexOf(preset)
    if (mutation.kind === 'delete') presets.splice(index, 1)
    else {
      const error = presetNameError(mutation.name)
      if (error) throw new Error(error)
      if (presets.some((value) => value !== preset && record(value) && typeof value.name === 'string' && value.name.toLowerCase() === mutation.name.toLowerCase())) throw new Error('A preset already uses this name.')
      presets[index] = { ...preset, name: mutation.name }
    }
  }
  const serialized = JSON.stringify({ version: 1, presets })
  if (bytes(serialized) > EFFECT_PRESET_LIMITS.libraryBytes) throw new Error('The local preset library exceeds 2 MiB.')
  return serialized
}

export function captureEffectPreset(clip: Clip, frame: number, id: string, name: string): EffectPreset {
  if (!Number.isSafeInteger(frame)) throw new Error('The playhead frame is invalid.')
  const effects = resolveClipAnimationAtFrame(clip, frame).effects.map((effect, index) => ({ ...cloneEffectDescriptor(effect), id: `template-${index + 1}` }))
  const preset: EffectPreset = { id, name: name.trim(), effects }
  const error = effectPresetError(preset)
  if (error) throw new Error(error)
  return preset
}

export function presetAttributeTemplate(effects: readonly EffectDescriptor[]): ClipAttributeTemplate {
  return { version: 1, attributes: [{ kind: 'effects', value: effects.map(cloneEffectDescriptor) }], animation: { tracks: [], effectTracks: [] } }
}
