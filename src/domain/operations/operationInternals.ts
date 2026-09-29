import type { AdjustmentItem, Clip, ClipId, MulticamInstance, SequenceInstance, TimeRange, TimelineDoc, Track, TrackId, Transition, TransitionId } from '../schema';
import { resolveCrossfadeGeometry, type CrossfadeGeometry } from '../crossfadePlan';
import { rangeOverlap } from '../time';

/** Where a clip lives inside a doc. */
export interface ClipLocation {
  trackIndex: number
  track: Track
  clipIndex: number
  clip: Clip
}

export interface TransitionLocation {
  trackIndex: number
  track: Track
  transitionIndex: number
  transition: Transition
}

export function locateClip(doc: TimelineDoc, clipId: ClipId): ClipLocation | null {
  for (let t = 0; t < doc.tracks.length; t++) {
    const track = doc.tracks[t]
    const c = track.clips.findIndex((cl) => cl.id === clipId)
    if (c !== -1) {
      return { trackIndex: t, track, clipIndex: c, clip: track.clips[c] }
    }
  }
  return null
}

/** Keep authored fades valid when a geometry edit shortens a clip. */
export function withClampedAudioFades(clip: Clip): Clip {
  if (!clip.audio) return clip
  const maximum = clip.timelineRange.durationFrames
  const fadeInFrames = Math.min(clip.audio.fadeInFrames, maximum)
  const fadeOutFrames = Math.min(clip.audio.fadeOutFrames, maximum)
  return fadeInFrames === clip.audio.fadeInFrames
    && fadeOutFrames === clip.audio.fadeOutFrames
    ? clip
    : {
        ...clip,
        audio: { ...clip.audio, fadeInFrames, fadeOutFrames },
      }
}

/** Every occurrence on one owning track, so corrupt duplicate ids stay ambiguous. */
export function locateTrackTransitions(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
): TransitionLocation[] {
  const locations: TransitionLocation[] = []
  const trackIndex = doc.tracks.findIndex((track) => track.id === trackId)
  if (trackIndex < 0) return locations
  const track = doc.tracks[trackIndex]
  for (let i = 0; i < track.transitions.length; i++) {
    const transition = track.transitions[i]
    if (transition.id === transitionId) {
      locations.push({ trackIndex, track, transitionIndex: i, transition })
    }
  }
  return locations
}

/** Rejection path: warn and hand back the SAME doc reference. */
export function reject(doc: TimelineDoc, op: string, why: string): TimelineDoc {
  console.warn(`[operations] ${op} rejected: ${why}`)
  return doc
}

export function byStart(a: Clip, b: Clip): number {
  return a.timelineRange.startFrame - b.timelineRange.startFrame
}

/** Rebuild a clip with the optional link key genuinely absent. */
export function withoutLinkGroupId(clip: Clip): Clip {
  if (clip.linkGroupId === undefined) return clip
  const { linkGroupId: _linkGroupId, ...rest } = clip
  return rest
}

/** True when `range` overlaps any other clip, instance, or adjustment. */
export function overlapsAny(
  track: Pick<Track, 'clips' | 'adjustments' | 'sequenceInstances' | 'multicamInstances'>,
  range: TimeRange,
  excludeId?: ClipId,
): boolean {
  return track.clips.some(
    (c) => c.id !== excludeId && rangeOverlap(c.timelineRange, range),
  ) || (track.adjustments ?? []).some(
    (adjustment) => rangeOverlap(adjustment.timelineRange, range),
  ) || (track.sequenceInstances ?? []).some(
    (instance) => rangeOverlap(instance.timelineRange, range),
  ) || (track.multicamInstances ?? []).some(
    (instance) => rangeOverlap(instance.timelineRange, range),
  )
}

/** True when any clip occupies the same half-open range as another lane item. */
export function clipsOverlapAdjustments(
  clips: readonly Clip[],
  adjustments: readonly AdjustmentItem[] | undefined,
  sequenceInstances: readonly SequenceInstance[] | undefined,
  multicamInstances: readonly MulticamInstance[] | undefined,
): boolean {
  const items = [
    ...(adjustments ?? []),
    ...(sequenceInstances ?? []),
    ...(multicamInstances ?? []),
  ]
  if (items.length === 0) return false
  return clips.some((clip) =>
    items.some((item) => rangeOverlap(clip.timelineRange, item.timelineRange)),
  )
}

/**
 * Shift every adjustment that starts at or after `fromFrame`. Returns the
 * original array reference when nothing moves, or null when the result would
 * leave the non-negative safe-integer timeline.
 */
export function shiftLaterAdjustments(
  adjustments: readonly AdjustmentItem[] | undefined,
  fromFrame: number,
  deltaFrames: number,
): AdjustmentItem[] | undefined | null {
  if (!adjustments || adjustments.length === 0 || deltaFrames === 0) {
    return adjustments as AdjustmentItem[] | undefined
  }
  const next: AdjustmentItem[] = []
  let changed = false
  for (const item of adjustments) {
    if (item.timelineRange.startFrame < fromFrame) {
      next.push(item)
      continue
    }
    const startFrame = item.timelineRange.startFrame + deltaFrames
    if (!Number.isSafeInteger(startFrame) || startFrame < 0) return null
    changed = true
    next.push({
      ...item,
      timelineRange: { ...item.timelineRange, startFrame },
    })
  }
  return changed ? next : adjustments as AdjustmentItem[]
}

/** New doc with one track replaced (structural sharing everywhere else). */
export function withTrack(
  doc: TimelineDoc,
  trackIndex: number,
  track: Track,
): TimelineDoc {
  const tracks = doc.tracks.slice()
  tracks[trackIndex] = track
  return { ...doc, tracks }
}

interface TrackClipSlot {
  index: number
  count: number
}

/**
 * Canonical crossfade geometry for every transition on one track, from one
 * clip-id index instead of a track scan per transition. A seam needs unique,
 * ordered-adjacent endpoints; once the index proves that, the canonical
 * resolver sees only that adjacent pair — it reads nothing else from the
 * track — so every other rule (and the resulting window) stays its own.
 */
function resolveTrackCrossfades(track: Track): Array<CrossfadeGeometry | null> {
  const slots = new Map<ClipId, TrackClipSlot>()
  for (let index = 0; index < track.clips.length; index++) {
    const slot = slots.get(track.clips[index].id)
    if (slot) slot.count += 1
    else slots.set(track.clips[index].id, { index, count: 1 })
  }
  return track.transitions.map((transition) => {
    const from = slots.get(transition.fromClipId)
    const to = slots.get(transition.toClipId)
    if (
      !from
      || !to
      || from.count !== 1
      || to.count !== 1
      || to.index !== from.index + 1
    ) return null
    return resolveCrossfadeGeometry(
      { ...track, clips: [track.clips[from.index], track.clips[to.index]] },
      transition,
    )
  })
}

/**
 * Transition array positions whose definitions resolve without overlap.
 * Duplicate ids invalidate every copy; two overlapping windows invalidate
 * each other (resolved duplicates still count as overlap partners).
 */
export function validTransitionIndexes(track: Track): Set<number> {
  const resolved = resolveTrackCrossfades(track)
  const invalid = new Set<number>()
  const indexesById = new Map<TransitionId, number[]>()

  for (let i = 0; i < track.transitions.length; i++) {
    if (!resolved[i]) invalid.add(i)
    const transition = track.transitions[i]
    const indexes = indexesById.get(transition.id)
    if (indexes) indexes.push(i)
    else indexesById.set(transition.id, [i])
  }

  for (const indexes of indexesById.values()) {
    if (indexes.length > 1) {
      for (const index of indexes) invalid.add(index)
    }
  }

  // Sorted by start, a window overlaps an earlier one exactly when the
  // running maximum end passes its start, and a later one exactly when the
  // next start falls before its end (windows are never empty).
  const windows: Array<{ index: number; startFrame: number; endFrame: number }> = []
  resolved.forEach((window, index) => {
    if (window) windows.push({ index, startFrame: window.startFrame, endFrame: window.endFrame })
  })
  windows.sort((left, right) => left.startFrame - right.startFrame)
  let maximumEnd = -Infinity
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i]
    const next = windows[i + 1]
    if (maximumEnd > window.startFrame || (next && next.startFrame < window.endFrame)) {
      invalid.add(window.index)
    }
    maximumEnd = Math.max(maximumEnd, window.endFrame)
  }

  const indexes = new Set<number>()
  for (let i = 0; i < track.transitions.length; i++) {
    if (!invalid.has(i)) indexes.add(i)
  }
  return indexes
}

/**
 * Carry only transitions that were valid before a geometry edit and remain
 * valid afterwards. This prevents a stale serialized definition from
 * springing alive merely because an unrelated ripple makes its endpoints
 * touch. Call only after the geometry operation itself has succeeded.
 */
export function reconcileTransitions(before: Track, after: Track): Track {
  if (after.transitions.length === 0) return after
  const beforeValid = validTransitionIndexes(before)
  const candidates = after.transitions.filter((_transition, index) =>
    beforeValid.has(index),
  )
  // Stale-before definitions are excluded BEFORE after-state ambiguity is
  // measured; otherwise one that merely became geometrically plausible could
  // suppress a legitimate survivor by overlapping it.
  const candidateTrack =
    candidates.length === after.transitions.length
      ? after
      : { ...after, transitions: candidates }
  const afterValid = validTransitionIndexes(candidateTrack)
  const transitions = candidates.filter((_transition, index) =>
    afterValid.has(index),
  )
  return transitions.length === after.transitions.length
    ? after
    : { ...after, transitions }
}

/**
 * Unique id for entities created by operations (split's right half, copied
 * effects). crypto.randomUUID is a standard global in Node and workers too,
 * so domain/ stays runnable outside the browser.
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** Mint an id unique on the owning track (schema.ts's TransitionId scope). */
export function newTransitionId(track: Track): TransitionId {
  const existing = new Set(
    track.transitions.map((transition) => transition.id),
  )
  let id = newId('transition')
  while (existing.has(id)) id = newId('transition')
  return id
}
