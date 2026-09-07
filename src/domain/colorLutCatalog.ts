/** Immutable portable tables, budgeted independently of derived render caches. */
import { COLOR_LUT_LIMITS, COLOR_LUT_TYPE, colorLutMetadataError, colorLutSampleCount, decodeColorLut, type PortableColorLutV1 } from './colorLut'
import type { EffectDescriptor } from './schema'
import { utf8ByteLength } from './documentMemory'
import type { SequenceProject } from './projectSequences'

export type ColorLutJson = null | boolean | number | string | readonly ColorLutJson[] | { readonly [key: string]: ColorLutJson }
export interface FutureColorLut { readonly id: string; readonly version: number; readonly [key: string]: ColorLutJson }
export type PortableColorLut = PortableColorLutV1 | FutureColorLut
export function isColorLutV1(value: PortableColorLut): value is PortableColorLutV1 { return value.version === 1 }

function jsonStringBytes(value: string): number {
  let bytes = 2
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 32) bytes += [8, 9, 10, 12, 13].includes(c) ? 2 : 6
    else if (c === 34 || c === 92) bytes += 2
    else if (c < 128) bytes++
    else if (c < 2048) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += c >= 0xd800 && c <= 0xdfff ? 6 : 3
  }
  return bytes
}

/** Bounded walk before copying/stringifying opaque future records. Cycles also fail. */
function opaqueBytes(value: unknown, depth = 0, budget = { entries: 0 }): number {
  if (++budget.entries > 256 || depth > 8) throw new Error('A future LUT record exceeds its structural limit.')
  if (typeof value === 'string') {
    if (value.length > COLOR_LUT_LIMITS.catalogBytes) throw new Error('A future LUT string exceeds the catalog limit.')
    return jsonStringBytes(value)
  }
  if (value === null || typeof value === 'boolean') return String(value).length
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).length
  if (typeof value !== 'object' || !value || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('LUT records must contain plain JSON data.')
  const entries = Object.entries(value)
  if (entries.length > 256) throw new Error('A future LUT record has too many entries.')
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, entry]) => {
    if (key.length > 128) throw new Error('A future LUT field name is too long.')
    return sum + (Array.isArray(value) ? 0 : jsonStringBytes(key) + 1) + opaqueBytes(entry, depth + 1, budget)
  }, 0)
}

export function colorLutCatalogError(value: unknown, inspectSamples = false): string | null {
  try {
    if (!Array.isArray(value) || value.length > COLOR_LUT_LIMITS.records) throw new Error('A project supports at most 16 embedded LUTs.')
    const ids = new Set<string>()
    let decoded = 0, serialized = 2 + Math.max(0, value.length - 1)
    for (const raw of value) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
        || typeof raw.id !== 'string' || !/^[a-z0-9_-]{1,256}$/iu.test(raw.id)
        || !Number.isSafeInteger(raw.version) || raw.version < 1) throw new Error('LUT identity or version is invalid.')
      if (ids.has(raw.id)) throw new Error('LUT identities must be unique.')
      ids.add(raw.id)
      if (raw.version === 1) {
        const error = colorLutMetadataError(raw)
        if (error) throw new Error(error)
        const entry = raw as PortableColorLutV1
        decoded += colorLutSampleCount(entry.kind, entry.size) * 8
        // Canonical payload is ASCII. Metadata is small; no full table copy here.
        serialized += entry.data.length + utf8ByteLength(JSON.stringify({ ...entry, data: '' }))
        if (decoded > COLOR_LUT_LIMITS.decodedBytes) throw new Error('Embedded LUTs exceed 4 MiB of decoded tables.')
        if (inspectSamples) decodeColorLut(entry)
      } else serialized += opaqueBytes(raw)
      if (serialized > COLOR_LUT_LIMITS.catalogBytes) throw new Error('The embedded LUT catalog exceeds 6 MiB.')
    }
    return null
  } catch (cause) { return cause instanceof Error ? cause.message : 'Invalid LUT catalog.' }
}

function immutableJson(value: ColorLutJson): ColorLutJson {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson))
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutableJson(entry)])))
  return value
}
/** Call only at external boundaries; ordinary edits share these records. */
export function immutableColorLuts(value: readonly PortableColorLut[]): readonly PortableColorLut[] {
  const error = colorLutCatalogError(value, true)
  if (error) throw new Error(error)
  return Object.freeze(value.map((entry) => Object.isFrozen(entry) ? entry : immutableJson(entry as unknown as ColorLutJson) as unknown as PortableColorLut))
}
export function sameColorLut(a: PortableColorLutV1, b: PortableColorLutV1): boolean {
  return a.kind === b.kind && a.size === b.size && a.encoding === b.encoding && a.data === b.data
    && a.domainMin.every((v, i) => v === b.domainMin[i]) && a.domainMax.every((v, i) => v === b.domainMax[i])
}
export function mergeColorLuts(current: readonly PortableColorLut[], incoming: readonly PortableColorLut[], freshId: () => string): { catalog: readonly PortableColorLut[]; ids: ReadonlyMap<string, string> } {
  const verified = immutableColorLuts(incoming)
  const catalog = [...current], ids = new Map<string, string>()
  for (const entry of verified) {
    const match = catalog.find((existing) => existing === entry || (isColorLutV1(existing) && isColorLutV1(entry) && sameColorLut(existing, entry)))
    if (match) { ids.set(entry.id, match.id); continue }
    if (!isColorLutV1(entry) && catalog.some((item) => item.id === entry.id)) throw new Error('A future LUT identity collides with this project. Its unknown references cannot be remapped safely.')
    let id = entry.id
    for (let attempts = 0; catalog.some((item) => item.id === id); attempts++) {
      if (attempts >= 100) throw new Error('Could not allocate a unique LUT identity.')
      id = freshId()
    }
    const added = id === entry.id ? entry : Object.freeze({ ...entry, id }) as PortableColorLut
    catalog.push(added); ids.set(entry.id, id)
  }
  const error = colorLutCatalogError(catalog)
  if (error) throw new Error(error)
  return { catalog: catalog.length === current.length ? current : Object.freeze(catalog), ids }
}
export function colorLutsForEffects(effects: readonly EffectDescriptor[], catalog: readonly PortableColorLut[]): readonly PortableColorLut[] {
  const references = new Set(effects.flatMap((effect) => Object.values(effect.params).filter((value): value is string => typeof value === 'string')))
  return catalog.filter((entry) => references.has(entry.id))
}
export function remapColorLutEffects(effects: readonly EffectDescriptor[], ids: ReadonlyMap<string, string>): EffectDescriptor[] {
  for (const effect of effects) {
    if (effect.type === COLOR_LUT_TYPE && effect.version === 1) continue
    if (Object.values(effect.params).some((value) => typeof value === 'string' && ids.has(value) && ids.get(value) !== value)) throw new Error('An unsupported effect references a conflicting LUT identity. Its reference cannot be remapped safely.')
  }
  return effects.map((effect) => effect.type === COLOR_LUT_TYPE && typeof effect.params.lutId === 'string' && ids.has(effect.params.lutId)
    ? { ...effect, params: { ...effect.params, lutId: ids.get(effect.params.lutId)! } } : effect)
}
export function projectVideoEffects(project: SequenceProject): EffectDescriptor[] {
  return project.sequences.flatMap((sequence) => [
    ...(sequence.masterVideoEffects ?? []),
    ...sequence.tracks.flatMap((track) => [...(track.videoEffects ?? []), ...track.clips.flatMap((clip) => clip.effects), ...(track.adjustments ?? []).flatMap((item) => item.effects)]),
  ])
}
/** Count distinct immutable records, including the clipboard and both history branches. */
export function retainedColorLutBytes(projects: readonly SequenceProject[], clipboard: readonly PortableColorLut[] = []): number {
  const records = new Set([...projects.flatMap((project) => project.colorLuts ?? []), ...clipboard])
  let bytes = 0
  for (const entry of records) bytes += isColorLutV1(entry) ? entry.data.length * 2 : opaqueBytes(entry) * 2
  return bytes
}
export function newColorLutReferenceError(previous: SequenceProject, next: SequenceProject): string | null {
  const existing = new Map(projectVideoEffects(previous).map((effect) => [effect.id, effect]))
  for (const effect of projectVideoEffects(next)) {
    if (effect.type !== COLOR_LUT_TYPE) continue
    const old = existing.get(effect.id)
    if (old?.type === effect.type && old.version === effect.version && old.params.lutId === effect.params.lutId) {
      if ((previous.colorLuts ?? []).some((entry) => entry.id === effect.params.lutId) && !(next.colorLuts ?? []).some((entry) => entry.id === effect.params.lutId)) return 'A referenced LUT cannot be removed from the project.'
      continue
    }
    if (typeof effect.params.lutId !== 'string' || !(next.colorLuts ?? []).some((entry) => entry.id === effect.params.lutId)) return 'The LUT reference is unavailable. Choose an embedded table first.'
  }
  return null
}
