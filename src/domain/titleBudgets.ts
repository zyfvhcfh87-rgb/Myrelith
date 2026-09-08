/** Pure admission accounting for expanded title data; never a browser heap estimate. */
import { utf8ByteLength } from './documentMemory'
import { MAX_KEYFRAMES_PER_TRACK } from './scalarAnimation'
import { TEXT_OVERLAY_LIMITS } from './textOverlay'
import { TITLE_LIMITS, type TitleDefinition, type TitleElementIntent } from './titleElements'

export const TITLE_BUDGET_LIMITS = Object.freeze({
  tracksPerTitle: 256,
  retainedBytes: 64 * 1024 * 1024,
  historySnapshotsPerBranch: 100,
  ownersPerSnapshot: 100_000,
  clipboardRoots: 100_000,
})

/** Structural projection only. The shared animation authority validates track semantics. */
export interface TitleTrackBudgetData { readonly keyframes: readonly unknown[] }
export type TitleBudgetOwner =
  | { readonly title: TitleDefinition; readonly titleTracks?: readonly TitleTrackBudgetData[] }
  // Schema 22 can preserve element lanes before schema 23 supplies their owner.
  | { readonly title?: undefined; readonly titleTracks: readonly TitleTrackBudgetData[] }
export interface TitlePayloadBudgetUsage {
  readonly serializedUtf8Bytes: number
  readonly tracks: number
  readonly keyframes: number
}
export type TitlePayloadBudgetResult =
  | { readonly ok: true; readonly usage: TitlePayloadBudgetUsage }
  | { readonly ok: false; readonly reason: string }

/** Project projections include every sequence, including dormant/hidden owners.
 * Keep original immutable references. Compact legacy text has no entry here and
 * keeps its existing file/text/history bounds. These arrays are never serialized.
 */
export interface TitleDataRetention {
  readonly candidate: readonly TitleBudgetOwner[]
  readonly current: readonly TitleBudgetOwner[]
  readonly past: readonly (readonly TitleBudgetOwner[])[]
  readonly future: readonly (readonly TitleBudgetOwner[])[]
  readonly clipboards: {
    readonly titles: readonly TitleBudgetOwner[]
    readonly elements: readonly TitleElementIntent[]
    /** Complete copied key data, including target/easing/future metadata. */
    readonly keys: readonly object[]
  }
}
export type TitleDataRetentionResult =
  | { readonly ok: true; readonly retainedBytes: number }
  | { readonly ok: false; readonly reason: string }

class TitleBudgetError extends Error {}
function fail(reason: string): never { throw new TitleBudgetError(reason) }

interface JsonSubtreeSize {
  readonly bytes: number
  readonly entries: number
  /** Greatest descendant depth relative to this object's own depth. */
  readonly height: number
}
interface Accounting {
  readonly subtrees: WeakMap<object, JsonSubtreeSize>
  retainedBytes: number
}

/** Sizes complete JSON without invoking getters/toJSON or building a large string.
 * The relaxed entry ceiling admits 1,024-key tracks; it does not replace the
 * title reader's stricter 4,096-entry opaque-title boundary. At least two JSON
 * bytes per entry keep this walk bounded by the 1 MiB payload limit as well.
 */
function jsonBytes(root: object, accounting: Accounting): number {
  let bytes = 0
  let entries = 0
  const ancestors = new Set<object>()
  const charge = (amount: number, retained: boolean): void => {
    bytes += amount
    if (bytes > TITLE_LIMITS.serializedBytes) fail('Title payload exceeds 1 MiB including animation data.')
    if (retained) {
      // Twice UTF-8 JSON bytes conservatively prices serialized string data;
      // object headers, allocator metadata and media/render resources are excluded.
      accounting.retainedBytes += 2 * amount
      if (accounting.retainedBytes > TITLE_BUDGET_LIMITS.retainedBytes) fail('This edit exceeds 64 MiB of expanded title history and clipboard data.')
    }
  }
  const chargeEntries = (amount: number): void => {
    entries += amount
    if (entries > TITLE_LIMITS.serializedBytes / 2) fail('Title data has too many entries.')
  }
  const walk = (value: unknown, depth: number): number => {
    if (depth > TITLE_LIMITS.jsonDepth) fail('Title data exceeds eight nested levels.')
    if (value === null || typeof value === 'boolean') { charge(value === null ? 4 : value ? 4 : 5, true); return 0 }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('Title data numbers must be finite.')
      charge(JSON.stringify(value).length, true)
      return 0
    }
    if (typeof value === 'string') {
      if (value.length > TEXT_OVERLAY_LIMITS.maxCharacters) fail('Title data string exceeds 20,000 characters.')
      charge(utf8ByteLength(JSON.stringify(value)), true)
      return 0
    }
    if (typeof value !== 'object') fail('Title data must contain only JSON values.')
    if (ancestors.has(value)) fail('Title data must not contain cycles.')
    const cached = accounting.subtrees.get(value)
    if (cached) {
      // Serialization expands each occurrence even though retention and traversal
      // share the object. Cached height also protects a later, deeper occurrence.
      if (depth + cached.height > TITLE_LIMITS.jsonDepth) fail('Title data exceeds eight nested levels.')
      chargeEntries(cached.entries)
      charge(cached.bytes, false)
      return cached.height
    }
    const bytesBefore = bytes
    const entriesBefore = entries
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('Title data must contain plain JSON objects and arrays.')
    if (array && value.length > TITLE_LIMITS.serializedBytes / 2 - entries) fail('Title data has too many entries.')
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'))
    chargeEntries(keys.length)
    if (array && keys.length !== value.length) fail('Title data arrays must be dense without extra fields.')
    charge(2 + Math.max(0, keys.length - 1), true)
    let height = 0
    ancestors.add(value)
    try {
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]
        if (typeof key !== 'string') fail('Title data cannot contain symbol keys.')
        if (array) {
          if (key !== String(index)) fail('Title data arrays must have only ordered index fields.')
        } else {
          if (key.length === 0 || key.length > TITLE_LIMITS.jsonKeyCharacters
            || key === '__proto__' || key === 'constructor' || key === 'prototype') fail('Unsafe title data key.')
          charge(utf8ByteLength(JSON.stringify(key)) + 1, true)
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('Title data cannot contain accessors or hidden fields.')
        height = Math.max(height, 1 + walk(descriptor.value, depth + 1))
      }
    } finally { ancestors.delete(value) }
    // Publish only a complete, validated subtree. A cached object's entire graph
    // has already paid its retained contribution in this invocation.
    accounting.subtrees.set(value, { bytes: bytes - bytesBefore, entries: entries - entriesBefore, height })
    return height
  }
  walk(root, 0)
  return bytes
}

/** Called with boundary-admitted immutable title/track data. Budget success does
 * not establish field validity, font availability or animation applicability.
 */
function payloadUsage(owner: TitleBudgetOwner, accounting: Accounting = { subtrees: new WeakMap(), retainedBytes: 0 }): TitlePayloadBudgetUsage {
  const tracks = owner.titleTracks ?? []
  if (tracks.length > TITLE_BUDGET_LIMITS.tracksPerTitle) fail('Title payload exceeds 256 animation tracks.')
  let keyframes = 0
  for (const track of tracks) {
    const descriptor = Object.getOwnPropertyDescriptor(track, 'keyframes')
    if (!descriptor || !('value' in descriptor)) fail('Title animation track must own a non-executing key array.')
    const keys: unknown = descriptor.value
    if (!Array.isArray(keys) || keys.length > MAX_KEYFRAMES_PER_TRACK) fail('Title animation track exceeds 1,024 keys or has no key array.')
    keyframes += keys.length
  }
  const titleBytes = owner.title === undefined ? 0 : jsonBytes(owner.title, accounting)
  // Absent and empty collections both cost zero; this helper does not add wire fields.
  const trackBytes = tracks.length === 0 ? 0 : jsonBytes(tracks, accounting)
  const serializedUtf8Bytes = titleBytes + trackBytes
  if (serializedUtf8Bytes > TITLE_LIMITS.serializedBytes) fail('Title payload exceeds 1 MiB including animation data.')
  return { serializedUtf8Bytes, tracks: tracks.length, keyframes }
}

export function titlePayloadBudget(owner: TitleBudgetOwner): TitlePayloadBudgetResult {
  try { return { ok: true, usage: payloadUsage(owner) } }
  catch (error) { if (error instanceof TitleBudgetError) return { ok: false, reason: error.message }; throw error }
}

/** Check the complete candidate together with both history branches BEFORE
 * clearing redo or changing clipboard/history ownership. Counts shared nested
 * objects once; strings in different owning fields are conservatively charged
 * separately. No persistent cache, pruning, mutation or retained runtime object.
 */
export function retainedTitleDataBudget(retention: TitleDataRetention): TitleDataRetentionResult {
  try {
    if (retention.past.length > TITLE_BUDGET_LIMITS.historySnapshotsPerBranch
      || retention.future.length > TITLE_BUDGET_LIMITS.historySnapshotsPerBranch) fail('Title retention projection exceeds the existing 100-entry limit for a history branch.')
    const accounting: Accounting = { subtrees: new WeakMap(), retainedBytes: 0 }
    const seenSnapshots = new Set<readonly TitleBudgetOwner[]>()
    const seenOwners = new Set<TitleBudgetOwner>()
    const snapshots = [retention.candidate, retention.current, ...retention.past, ...retention.future, retention.clipboards.titles]
    for (const owners of snapshots) {
      if (seenSnapshots.has(owners)) continue
      seenSnapshots.add(owners)
      if (owners.length > TITLE_BUDGET_LIMITS.ownersPerSnapshot) fail('Title retention projection has too many owners.')
      for (const owner of owners) {
        if (seenOwners.has(owner)) continue
        seenOwners.add(owner)
        payloadUsage(owner, accounting)
      }
    }
    for (const roots of [retention.clipboards.elements, retention.clipboards.keys]) {
      if (roots.length > TITLE_BUDGET_LIMITS.clipboardRoots) fail('Title clipboard has too many data roots.')
      for (const root of roots) jsonBytes(root, accounting)
    }
    return { ok: true, retainedBytes: accounting.retainedBytes }
  } catch (error) { if (error instanceof TitleBudgetError) return { ok: false, reason: error.message }; throw error }
}
