/** Held path values and budget hooks; shared timeline traversal belongs to #199. */
import { EFFECT_STACK_LIMITS, isUnsafeEffectParamKey } from './effectBounds'
import { maskBezierPathValidationError, MAX_MASK_PATH_CHARACTERS } from './maskPath'
import { MAX_KEYFRAME_FRAME } from './scalarAnimation'
import type { EffectDescriptor } from './schema'

export const MASK_PATH_VALUE_TYPE = 'mask-bezier-path'
export const MASK_PATH_VALUE_VERSION = 1
export const MASK_PATH_ANIMATION_LIMITS = Object.freeze({
  keysPerTrack: 256,
  tracksPerClip: 256,
  projectKeys: 4_096,
  projectValueCharacters: 1_048_576,
  retainedBytes: 32 * 1024 * 1024,
  keyMetadataBytes: 128,
  trackMetadataBytes: 128,
  historySnapshotsPerBranch: 100,
  maximumFrameMagnitude: MAX_KEYFRAME_FRAME,
})

export interface EffectPathAnimationKeyframe {
  frame: number
  /** Portable validation requires ticks; only historical in-memory values may omit them. */
  sourceTimeTicks?: number
  value: string
  easing: { type: 'hold' }
}

export interface EffectPathAnimationTrack {
  effectId: string
  parameter: string
  valueType: string
  valueVersion: number
  keyframes: EffectPathAnimationKeyframe[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return keys.length <= required.length + optional.length
    && required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && value.trim().length > 0
}

/** Structural bounds intentionally do not parse opaque, future or malformed path values. */
export function effectPathAnimationTrackBoundsError(value: unknown, requireSourceTicks = false): string | null {
  if (!record(value) || !exactKeys(value, ['effectId', 'parameter', 'valueType', 'valueVersion', 'keyframes'])) return 'Path tracks must have the exact versioned envelope.'
  if (!boundedString(value.effectId, EFFECT_STACK_LIMITS.maxIdCharacters)) return 'Path effect identity is missing or too long.'
  if (!boundedString(value.parameter, EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters) || isUnsafeEffectParamKey(value.parameter)) return 'Path parameter identity is invalid.'
  if (!boundedString(value.valueType, EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters)) return 'Path value type is missing or too long.'
  if (!Number.isSafeInteger(value.valueVersion) || (value.valueVersion as number) < 1) return 'Path value version must be a positive safe integer.'
  if (!Array.isArray(value.keyframes) || value.keyframes.length < 1 || value.keyframes.length > MASK_PATH_ANIMATION_LIMITS.keysPerTrack) return 'A path track requires 1 to 256 keys.'
  let previous = -Infinity
  for (const key of value.keyframes) {
    if (!record(key) || !exactKeys(key, ['frame', 'value', 'easing'], ['sourceTimeTicks'])) return 'Path keys must have the exact frame/value/easing envelope.'
    if (!Number.isSafeInteger(key.frame) || Math.abs(key.frame as number) > MASK_PATH_ANIMATION_LIMITS.maximumFrameMagnitude || (key.frame as number) <= previous) return 'Path frames must be bounded, strictly increasing unique integers.'
    if ((requireSourceTicks || Object.hasOwn(key, 'sourceTimeTicks')) && !Number.isSafeInteger(key.sourceTimeTicks)) return 'Path source ticks must be safe integers.'
    if (typeof key.value !== 'string' || key.value.length > MAX_MASK_PATH_CHARACTERS) return 'A path value exceeds its 2,048-character bound.'
    if (!record(key.easing) || !exactKeys(key.easing, ['type']) || key.easing.type !== 'hold') return 'Path v1 timing supports hold easing only.'
    previous = key.frame as number
  }
  return null
}

function collectionError(tracks: readonly EffectPathAnimationTrack[], maximum: number, requireSourceTicks: boolean): string | null {
  if (!Array.isArray(tracks) || tracks.length > maximum) return 'Too many path animation tracks.'
  const targets = new Map<string, Set<string>>()
  for (const track of tracks) {
    const error = effectPathAnimationTrackBoundsError(track, requireSourceTicks)
    if (error) return error
    let parameters = targets.get(track.effectId)
    if (!parameters) { parameters = new Set(); targets.set(track.effectId, parameters) }
    if (parameters.has(track.parameter)) return 'Duplicate path target; versions cannot compete for one property.'
    parameters.add(track.parameter)
  }
  return null
}

export function effectPathAnimationTracksBoundsError(tracks: readonly EffectPathAnimationTrack[], requireSourceTicks = false): string | null {
  return collectionError(tracks, MASK_PATH_ANIMATION_LIMITS.tracksPerClip, requireSourceTicks)
}

/** Budget the complete candidate first; this bounded value hook does not own history. */
export function cloneEffectPathAnimationTrack(track: EffectPathAnimationTrack): EffectPathAnimationTrack {
  const error = effectPathAnimationTrackBoundsError(track)
  if (error) throw new RangeError(error)
  return { ...track, keyframes: track.keyframes.map((key) => ({ ...key, easing: { type: 'hold' } })) }
}

export type PreparedEffectPathAnimationTrack =
  | { readonly ok: true; readonly keyframes: readonly Readonly<Pick<EffectPathAnimationKeyframe, 'frame' | 'value'>>[] }
  | { readonly ok: false; readonly reason: string }

/** Validate once per immutable target/track; callers own any bounded memoization. */
export function prepareEffectPathAnimationTrack(track: EffectPathAnimationTrack, effect: EffectDescriptor | undefined): PreparedEffectPathAnimationTrack {
  const error = effectPathAnimationTrackBoundsError(track)
  if (error) return { ok: false, reason: error }
  if (track.valueType !== MASK_PATH_VALUE_TYPE || track.valueVersion !== MASK_PATH_VALUE_VERSION) return { ok: false, reason: 'This path value version is unavailable.' }
  if (!effect || effect.id !== track.effectId || effect.type !== 'builtin.mask' || effect.version !== 1 || track.parameter !== 'path') return { ok: false, reason: 'The path effect target is unavailable.' }
  if (effect.params.shape !== 'bezier') return { ok: false, reason: 'Path animation is dormant while this mask is not Bezier.' }
  for (const key of track.keyframes) {
    if (maskBezierPathValidationError(key.value)) return { ok: false, reason: 'A stored path is malformed; this complete path track is unavailable.' }
  }
  return { ok: true, keyframes: Object.freeze(track.keyframes.map((key) => Object.freeze({ frame: key.frame, value: key.value }))) }
}

/** Binary-search held value selection; no per-frame parse, clone or retained geometry. */
export function evaluatePreparedEffectPathAnimationTrack(prepared: PreparedEffectPathAnimationTrack, localFrame: number, fallback: string): string {
  if (!prepared.ok || !Number.isSafeInteger(localFrame)) return fallback
  const keys = prepared.keyframes
  if (keys.length === 0 || keys.length > MASK_PATH_ANIMATION_LIMITS.keysPerTrack) return fallback
  let low = 0, high = keys.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (keys[middle].frame <= localFrame) low = middle + 1
    else high = middle
  }
  return keys[Math.max(0, low - 1)].value
}

/** A bounded projection of all path tracks in an immutable project or clipboard.
 * The shared traversal checks each clip collection and the global key/string/file
 * budgets; it collects only track references, never copies path values to make this.
 */
export interface MaskPathAnimationSnapshot { readonly tracks: readonly EffectPathAnimationTrack[] }
export interface MaskPathAnimationBudgetUsage {
  readonly keys: number
  readonly valueCharacters: number
  readonly retainedBytes: number
}
export type MaskPathAnimationBudgetResult =
  | { readonly ok: true; readonly usage: MaskPathAnimationBudgetUsage }
  | { readonly ok: false; readonly reason: string }

/** Counts all strings, including unsupported/malformed intent, before parsing or copying. */
export function maskPathAnimationSnapshotBudget(snapshot: MaskPathAnimationSnapshot): MaskPathAnimationBudgetResult {
  if (!Array.isArray(snapshot.tracks) || snapshot.tracks.length > MASK_PATH_ANIMATION_LIMITS.projectKeys) return { ok: false, reason: 'Too many path animation tracks.' }
  let declaredKeys = 0
  for (const track of snapshot.tracks) {
    if (!record(track) || !Array.isArray(track.keyframes)) return { ok: false, reason: 'Path keyframes must be an array.' }
    declaredKeys += track.keyframes.length
    if (declaredKeys > MASK_PATH_ANIMATION_LIMITS.projectKeys) return { ok: false, reason: 'A project or clipboard exceeds 4,096 path keys.' }
  }
  const error = collectionError(snapshot.tracks, MASK_PATH_ANIMATION_LIMITS.projectKeys, false)
  if (error) return { ok: false, reason: error }
  let keys = 0, valueCharacters = 0, retainedBytes = 0
  for (const track of snapshot.tracks) {
    keys += track.keyframes.length
    if (keys > MASK_PATH_ANIMATION_LIMITS.projectKeys) return { ok: false, reason: 'A project or clipboard exceeds 4,096 path keys.' }
    retainedBytes += MASK_PATH_ANIMATION_LIMITS.trackMetadataBytes
      + 2 * (track.effectId.length + track.parameter.length + track.valueType.length)
    for (const key of track.keyframes) {
      valueCharacters += key.value.length
      if (valueCharacters > MASK_PATH_ANIMATION_LIMITS.projectValueCharacters) return { ok: false, reason: 'A project or clipboard exceeds 1,048,576 path-value characters.' }
      retainedBytes += 2 * key.value.length + MASK_PATH_ANIMATION_LIMITS.keyMetadataBytes
    }
  }
  return { ok: true, usage: { keys, valueCharacters, retainedBytes } }
}

export interface MaskPathAnimationRetention {
  readonly candidate: MaskPathAnimationSnapshot
  readonly current: MaskPathAnimationSnapshot
  readonly past: readonly MaskPathAnimationSnapshot[]
  readonly future: readonly MaskPathAnimationSnapshot[]
  readonly attributeClipboard: MaskPathAnimationSnapshot | null
  readonly keyClipboard: MaskPathAnimationSnapshot | null
}

/** Admission must precede history/clipboard mutation, especially clearing redo.
 * Identical immutable snapshot/track objects may share ownership; equal strings
 * in distinct track objects are charged separately. This lets removals preserve
 * shared survivors without manufacturing extra retained payload. This is
 * accounted data, not measured JS heap.
 */
export function maskPathAnimationRetentionError(retention: MaskPathAnimationRetention): string | null {
  if (retention.past.length > MASK_PATH_ANIMATION_LIMITS.historySnapshotsPerBranch
    || retention.future.length > MASK_PATH_ANIMATION_LIMITS.historySnapshotsPerBranch) return 'Path history exceeds its snapshot limit.'
  const snapshots = [retention.candidate, retention.current, ...retention.past, ...retention.future, retention.attributeClipboard, retention.keyClipboard]
  const seen = new Set<MaskPathAnimationSnapshot>()
  const seenTracks = new Set<EffectPathAnimationTrack>()
  let bytes = 0
  for (const snapshot of snapshots) {
    if (snapshot === null || seen.has(snapshot)) continue
    seen.add(snapshot)
    const budget = maskPathAnimationSnapshotBudget(snapshot)
    if (!budget.ok) return budget.reason
    for (const track of snapshot.tracks) {
      if (seenTracks.has(track)) continue
      seenTracks.add(track)
      bytes += MASK_PATH_ANIMATION_LIMITS.trackMetadataBytes
        + 2 * (track.effectId.length + track.parameter.length + track.valueType.length)
      for (const key of track.keyframes) bytes += MASK_PATH_ANIMATION_LIMITS.keyMetadataBytes + 2 * key.value.length
      if (bytes > MASK_PATH_ANIMATION_LIMITS.retainedBytes) return 'This edit exceeds 32 MiB of path-animation history and clipboard data.'
    }
  }
  return null
}
