/**
 * domain/operations.ts — Pure, immutable edit operations on a TimelineDoc.
 * Phase 1.1.
 *
 * Contract (ARCHITECTURE.md):
 * - Every operation returns a NEW TimelineDoc; the input is never mutated.
 * - Invalid operations return the ORIGINAL doc unchanged (same reference,
 *   so callers can detect rejection with `result === doc`) and log a
 *   console.warn explaining why.
 * - Invariants enforced here, assumed everywhere else:
 *   - clips on one track never overlap (half-open ranges),
 *   - clip duration >= 1 frame,
 *   - timed source duration equals timeline duration (speed 1.0),
 *   - still source range is exactly frame 0 with duration 1,
 *   - clips stay sorted by timelineRange.startFrame,
 *   - locked tracks reject all edits.
 *
 * Note: asset length is NOT known here (assets live in state/mediaStore), so
 * trimming past the end of the source material is validated at the store
 * layer, not in domain/. Trimming before frame 0 of the source IS caught.
 */

import type {
  Clip,
  ClipId,
  Effect,
  MediaAsset,
  TimeRange,
  TimelineDoc,
  Track,
  TrackId,
  TrackKind,
  Transition,
  TransitionId,
  Transform,
} from './schema'
import {
  crossfadeWindowsOverlap,
  resolveCrossfade,
} from './selectors'
import { rangeEnd, rangeOverlap } from './time'

/** Which clip edge a trim moves. */
export type TrimEdge = 'start' | 'end'

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

/** Where a clip lives inside a doc. */
interface ClipLocation {
  trackIndex: number
  track: Track
  clipIndex: number
  clip: Clip
}

interface TransitionLocation {
  trackIndex: number
  track: Track
  transitionIndex: number
  transition: Transition
}

function locateClip(doc: TimelineDoc, clipId: ClipId): ClipLocation | null {
  for (let t = 0; t < doc.tracks.length; t++) {
    const track = doc.tracks[t]
    const c = track.clips.findIndex((cl) => cl.id === clipId)
    if (c !== -1) {
      return { trackIndex: t, track, clipIndex: c, clip: track.clips[c] }
    }
  }
  return null
}

/** Every occurrence on one owning track, so corrupt duplicate ids stay ambiguous. */
function locateTrackTransitions(
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
function reject(doc: TimelineDoc, op: string, why: string): TimelineDoc {
  console.warn(`[operations] ${op} rejected: ${why}`)
  return doc
}

function byStart(a: Clip, b: Clip): number {
  return a.timelineRange.startFrame - b.timelineRange.startFrame
}

/** Rebuild a clip with the optional link key genuinely absent. */
function withoutLinkGroupId(clip: Clip): Clip {
  if (clip.linkGroupId === undefined) return clip
  const { linkGroupId: _linkGroupId, ...rest } = clip
  return rest
}

/** True when `range` overlaps any clip in `clips` other than `excludeId`. */
function overlapsAny(
  clips: readonly Clip[],
  range: TimeRange,
  excludeId?: ClipId,
): boolean {
  return clips.some(
    (c) => c.id !== excludeId && rangeOverlap(c.timelineRange, range),
  )
}

/** New doc with one track replaced (structural sharing everywhere else). */
function withTrack(
  doc: TimelineDoc,
  trackIndex: number,
  track: Track,
): TimelineDoc {
  const tracks = doc.tracks.slice()
  tracks[trackIndex] = track
  return { ...doc, tracks }
}

/** Transition array positions whose definitions resolve without overlap. */
function validTransitionIndexes(track: Track): Set<number> {
  const resolved = track.transitions.map((transition) =>
    resolveCrossfade(track, transition),
  )
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

  for (let left = 0; left < resolved.length; left++) {
    const leftWindow = resolved[left]
    if (!leftWindow) continue
    for (let right = left + 1; right < resolved.length; right++) {
      const rightWindow = resolved[right]
      if (
        rightWindow &&
        crossfadeWindowsOverlap(leftWindow, rightWindow)
      ) {
        invalid.add(left)
        invalid.add(right)
      }
    }
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
function reconcileTransitions(before: Track, after: Track): Track {
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
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** Mint an id unique on the owning track (schema.ts's TransitionId scope). */
function newTransitionId(track: Track): TransitionId {
  const existing = new Set(
    track.transitions.map((transition) => transition.id),
  )
  let id = newId('transition')
  while (existing.has(id)) id = newId('transition')
  return id
}

/* ------------------------------------------------------------------ */
/* Operations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Add one centered visual crossfade at an existing touching video seam.
 * The transition id is minted internally; callers identify the seam by its
 * ordered outgoing/incoming clip ids. A crossfade is rejected unless the
 * canonical render geometry resolves and its half-open window is disjoint
 * from every other valid transition window on the track.
 */
export function addCrossfade(
  doc: TimelineDoc,
  fromClipId: ClipId,
  toClipId: ClipId,
  durationFrames: number,
): TimelineDoc {
  const op = 'addCrossfade'
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    return reject(
      doc,
      op,
      `durationFrames must be a safe integer >= 1, got ${durationFrames}`,
    )
  }
  if (fromClipId === toClipId) {
    return reject(doc, op, 'crossfade endpoints must be distinct clips')
  }

  const fromLoc = locateClip(doc, fromClipId)
  if (!fromLoc) return reject(doc, op, `clip ${fromClipId} not found`)
  const toLoc = locateClip(doc, toClipId)
  if (!toLoc) return reject(doc, op, `clip ${toClipId} not found`)
  if (fromLoc.trackIndex !== toLoc.trackIndex) {
    return reject(doc, op, 'crossfade endpoints must be on the same track')
  }

  const track = fromLoc.track
  if (track.locked) return reject(doc, op, `track ${track.id} is locked`)
  if (track.kind !== 'video') {
    return reject(doc, op, `track ${track.id} is not a video track`)
  }
  if (toLoc.clipIndex !== fromLoc.clipIndex + 1) {
    return reject(doc, op, 'crossfade endpoints must be ordered adjacent clips')
  }
  if (rangeEnd(fromLoc.clip.timelineRange) !== toLoc.clip.timelineRange.startFrame) {
    return reject(doc, op, 'crossfade endpoints must touch on the timeline')
  }
  if (
    track.transitions.some(
      (transition) =>
        transition.fromClipId === fromClipId &&
        transition.toClipId === toClipId,
    )
  ) {
    return reject(doc, op, 'the clip seam already has a transition')
  }

  const transition: Transition = {
    id: newTransitionId(track),
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
  }
  const nextTrack: Track = {
    ...track,
    transitions: [...track.transitions, transition],
  }
  if (!validTransitionIndexes(nextTrack).has(nextTrack.transitions.length - 1)) {
    return reject(
      doc,
      op,
      'crossfade window does not fit its clips or overlaps another transition',
    )
  }
  return withTrack(doc, fromLoc.trackIndex, nextTrack)
}

/**
 * Change one track-owned crossfade's duration without replacing its stable
 * id. A no-op duration is silent; malformed endpoints may be repaired only
 * when the new duration makes the complete canonical definition valid and
 * unambiguous.
 */
export function setCrossfadeDuration(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
  durationFrames: number,
): TimelineDoc {
  const op = 'setCrossfadeDuration'
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) {
    return reject(
      doc,
      op,
      `durationFrames must be a safe integer >= 1, got ${durationFrames}`,
    )
  }

  const locations = locateTrackTransitions(doc, trackId, transitionId)
  if (locations.length === 0) {
    return reject(doc, op, `transition ${transitionId} not found`)
  }
  if (locations.length > 1) {
    return reject(doc, op, `transition id ${transitionId} is ambiguous`)
  }
  const loc = locations[0]
  if (loc.track.locked) {
    return reject(doc, op, `track ${loc.track.id} is locked`)
  }
  if (loc.transition.durationFrames === durationFrames) return doc

  const transition: Transition = { ...loc.transition, durationFrames }
  const transitions = loc.track.transitions.slice()
  transitions[loc.transitionIndex] = transition
  const nextTrack: Track = { ...loc.track, transitions }
  if (!validTransitionIndexes(nextTrack).has(loc.transitionIndex)) {
    return reject(
      doc,
      op,
      'crossfade window does not fit its clips or overlaps another transition',
    )
  }
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Remove exactly one transition by owning track + id. Endpoint validity is
 * deliberately not required, so malformed/stale serialized transitions
 * remain removable.
 */
export function removeTransition(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
): TimelineDoc {
  const op = 'removeTransition'
  const locations = locateTrackTransitions(doc, trackId, transitionId)
  if (locations.length === 0) {
    return reject(doc, op, `transition ${transitionId} not found`)
  }
  if (locations.length > 1) {
    return reject(doc, op, `transition id ${transitionId} is ambiguous`)
  }
  const loc = locations[0]
  if (loc.track.locked) {
    return reject(doc, op, `track ${loc.track.id} is locked`)
  }

  const transitions = loc.track.transitions.slice()
  transitions.splice(loc.transitionIndex, 1)
  return withTrack(doc, loc.trackIndex, { ...loc.track, transitions })
}

/**
 * Build a default Clip that plays `asset` in full, starting at timeline
 * frame `startFrame`. Pure factory — it does NOT validate against a doc
 * (insertClip does that); it only fills in the schema defaults (identity
 * transform, full opacity/volume, empty effect chain). Per the MVP
 * conformance note in schema.ts, asset.durationFrames is already measured
 * in document-rate frames. Still images receive a canonical one-frame source
 * and an independently editable nominal timeline duration. When `linkGroupId`
 * is given (the A/V drop path, pairing a video clip with its audio clip), it is
 * stamped onto the clip; omitted, the key is left absent.
 */
export function clipFromAsset(
  asset: MediaAsset,
  startFrame: number,
  linkGroupId?: string,
): Clip {
  return {
    id: newId('clip'),
    assetId: asset.id,
    name: asset.fileName,
    sourceMode: asset.kind === 'image' ? 'still' : 'timed',
    sourceRange: {
      startFrame: 0,
      durationFrames: asset.kind === 'image' ? 1 : asset.durationFrames,
    },
    timelineRange: { startFrame, durationFrames: asset.durationFrames },
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
    effects: [],
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

/**
 * Insert a new clip onto a track. The clip is defensively deep-copied so
 * later mutation of the caller's object cannot reach into the doc. Rejected
 * on unknown/locked track, duplicate clip id, non-integer or negative
 * frames, duration < 1, invalid timed/still source geometry, or overlap with
 * an existing clip.
 *
 * Asset-kind vs track-kind compatibility is NOT checked here: assets live in
 * state/mediaStore and domain/ cannot see them (same boundary as the
 * source-length note in the file header). The UI gates that before calling.
 */
export function insertClip(
  doc: TimelineDoc,
  trackId: TrackId,
  clip: Clip,
): TimelineDoc {
  const op = 'insertClip'
  const tl = clip.timelineRange
  const src = clip.sourceRange

  if (!Number.isInteger(tl.startFrame) || tl.startFrame < 0) {
    return reject(doc, op, `timeline start must be an integer >= 0, got ${tl.startFrame}`)
  }
  if (!Number.isInteger(tl.durationFrames) || tl.durationFrames < 1) {
    return reject(doc, op, `duration must be an integer >= 1, got ${tl.durationFrames}`)
  }
  if (!Number.isInteger(src.startFrame) || src.startFrame < 0) {
    return reject(doc, op, `source start must be an integer >= 0, got ${src.startFrame}`)
  }
  if (clip.sourceMode !== 'timed' && clip.sourceMode !== 'still') {
    return reject(doc, op, `unknown source mode ${String(clip.sourceMode)}`)
  }
  if (
    clip.sourceMode === 'still'
    && (src.startFrame !== 0 || src.durationFrames !== 1)
  ) {
    return reject(
      doc,
      op,
      'still clips must use source frame 0 with duration 1',
    )
  }
  if (
    clip.sourceMode !== 'still'
    && src.durationFrames !== tl.durationFrames
  ) {
    return reject(
      doc,
      op,
      `sourceRange duration ${src.durationFrames} != timelineRange duration ${tl.durationFrames} (clips play at speed 1.0)`,
    )
  }

  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const track = doc.tracks[trackIndex]
  if (track.locked) return reject(doc, op, `track ${track.id} is locked`)

  if (locateClip(doc, clip.id)) {
    return reject(doc, op, `clip id ${clip.id} already exists in the document`)
  }
  if (overlapsAny(track.clips, tl)) {
    return reject(doc, op, 'insert would overlap a clip on the target track')
  }

  const copy: Clip = {
    ...clip,
    sourceRange: { ...src },
    timelineRange: { ...tl },
    transform: { ...clip.transform },
    effects: clip.effects.map((e) => ({ ...e, params: { ...e.params } })),
    ...(clip.text ? { text: { ...clip.text } } : {}),
  }

  const clips = [...track.clips, copy].sort(byStart)
  const nextTrack = reconcileTransitions(track, { ...track, clips })
  return withTrack(doc, trackIndex, nextTrack)
}

/**
 * Split a clip in two at a timeline frame strictly inside it. The left half
 * keeps the original clip id; the right half gets a new id and deep-copies
 * the effect chain (with fresh effect-instance ids). Timed halves partition
 * the source exactly; both still halves retain canonical source frame 0.
 */
export function splitClipAtFrame(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
): TimelineDoc {
  const op = 'splitClipAtFrame'
  if (!Number.isInteger(frame)) {
    return reject(doc, op, `frame must be an integer, got ${frame}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip } = loc
  const tl = clip.timelineRange
  if (frame <= tl.startFrame || frame >= rangeEnd(tl)) {
    return reject(
      doc,
      op,
      `frame ${frame} is not strictly inside clip [${tl.startFrame}, ${rangeEnd(tl)})`,
    )
  }

  const offset = frame - tl.startFrame
  const stillSource = clip.sourceMode === 'still'
  const left: Clip = {
    ...clip,
    sourceRange: stillSource
      ? { startFrame: 0, durationFrames: 1 }
      : {
          startFrame: clip.sourceRange.startFrame,
          durationFrames: offset,
        },
    timelineRange: { startFrame: tl.startFrame, durationFrames: offset },
  }
  const right: Clip = {
    ...clip,
    id: newId('clip'),
    sourceRange: stillSource
      ? { startFrame: 0, durationFrames: 1 }
      : {
          startFrame: clip.sourceRange.startFrame + offset,
          durationFrames: tl.durationFrames - offset,
        },
    timelineRange: { startFrame: frame, durationFrames: tl.durationFrames - offset },
    effects: clip.effects.map((e) => ({
      ...e,
      id: newId('fx'),
      params: { ...e.params },
    })),
    ...(clip.text ? { text: { ...clip.text } } : {}),
  }

  const clips = loc.track.clips.slice()
  clips.splice(loc.clipIndex, 1, left, right)
  // The original id stays on the left half, so an incoming transition keeps
  // pointing at it. An outgoing transition belongs at the original outer
  // edge and therefore follows the newly minted right half.
  const transitions = loc.track.transitions.map((transition) =>
    transition.fromClipId === clip.id
      ? { ...transition, fromClipId: right.id }
      : transition,
  )
  const nextTrack = reconcileTransitions(loc.track, {
    ...loc.track,
    clips,
    transitions,
  })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Move one edge of a clip by a signed frame delta ("move the edge right" is
 * positive). A timed start trim advances the source in-point so the remaining
 * material still lines up. A still trim changes only timeline geometry, so
 * either edge can extend without inventing source frames. Rejected when the
 * result would be shorter than 1 frame, start before frame 0, or overlap a
 * neighbor.
 */
export function trimClip(
  doc: TimelineDoc,
  clipId: ClipId,
  edge: TrimEdge,
  deltaFrames: number,
): TimelineDoc {
  const op = 'trimClip'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip } = loc
  const tl = clip.timelineRange
  const src = clip.sourceRange
  const stillSource = clip.sourceMode === 'still'

  let newTl: TimeRange
  let newSrc: TimeRange
  if (edge === 'start') {
    newTl = {
      startFrame: tl.startFrame + deltaFrames,
      durationFrames: tl.durationFrames - deltaFrames,
    }
    newSrc = stillSource
      ? src
      : {
          startFrame: src.startFrame + deltaFrames,
          durationFrames: src.durationFrames - deltaFrames,
        }
  } else {
    newTl = { startFrame: tl.startFrame, durationFrames: tl.durationFrames + deltaFrames }
    newSrc = stillSource
      ? src
      : {
          startFrame: src.startFrame,
          durationFrames: src.durationFrames + deltaFrames,
        }
  }

  if (newTl.durationFrames < 1) {
    return reject(doc, op, 'clip duration cannot shrink below 1 frame')
  }
  if (newTl.startFrame < 0) {
    return reject(doc, op, 'clip cannot start before timeline frame 0')
  }
  if (!stillSource && newSrc.startFrame < 0) {
    return reject(doc, op, 'no source material before the asset start')
  }
  if (overlapsAny(loc.track.clips, newTl, clipId)) {
    return reject(doc, op, 'trim would overlap a neighboring clip')
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...clip, timelineRange: newTl, sourceRange: newSrc }
  clips.sort(byStart)
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Move a clip to a new timeline position, optionally onto another track of
 * the same kind. Duration and source material are unchanged. Rejected on
 * overlap, unknown target, kind mismatch, or locked tracks.
 */
export function moveClip(
  doc: TimelineDoc,
  clipId: ClipId,
  toTrackId: TrackId,
  toFrame: number,
): TimelineDoc {
  const op = 'moveClip'
  if (!Number.isInteger(toFrame) || toFrame < 0) {
    return reject(doc, op, `toFrame must be an integer >= 0, got ${toFrame}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const targetIndex = doc.tracks.findIndex((t) => t.id === toTrackId)
  if (targetIndex === -1) return reject(doc, op, `track ${toTrackId} not found`)
  const target = doc.tracks[targetIndex]
  if (target.locked) return reject(doc, op, `track ${target.id} is locked`)
  if (target.kind !== loc.track.kind) {
    return reject(
      doc,
      op,
      `cannot move a ${loc.track.kind} clip onto ${target.kind} track ${target.id}`,
    )
  }

  const newRange: TimeRange = {
    startFrame: toFrame,
    durationFrames: loc.clip.timelineRange.durationFrames,
  }
  if (overlapsAny(target.clips, newRange, clipId)) {
    return reject(doc, op, 'move would overlap a clip on the target track')
  }

  const movedClip: Clip = { ...loc.clip, timelineRange: newRange }

  if (targetIndex === loc.trackIndex) {
    const clips = loc.track.clips.slice()
    clips[loc.clipIndex] = movedClip
    clips.sort(byStart)
    const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
    return withTrack(doc, loc.trackIndex, nextTrack)
  }

  // Cross-track: remove from source, insert into target, fix transitions.
  const sourceClips = loc.track.clips.filter((c) => c.id !== clipId)
  const targetClips = [...target.clips, movedClip].sort(byStart)
  const tracks = doc.tracks.slice()
  tracks[loc.trackIndex] = reconcileTransitions(loc.track, {
    ...loc.track,
    clips: sourceClips,
  })
  tracks[targetIndex] = reconcileTransitions(target, {
    ...target,
    clips: targetClips,
  })
  return { ...doc, tracks }
}

/**
 * Delete a clip and close the gap: every clip on the SAME track that starts
 * at/after the deleted clip's end shifts left by the deleted duration.
 * (MVP scope: single-track ripple; other tracks are untouched.)
 */
export function rippleDelete(doc: TimelineDoc, clipId: ClipId): TimelineDoc {
  const op = 'rippleDelete'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const removedEnd = rangeEnd(loc.clip.timelineRange)
  const removedDur = loc.clip.timelineRange.durationFrames

  const clips = loc.track.clips
    .filter((c) => c.id !== clipId)
    .map((c) =>
      c.timelineRange.startFrame >= removedEnd
        ? {
            ...c,
            timelineRange: {
              ...c.timelineRange,
              startFrame: c.timelineRange.startFrame - removedDur,
            },
          }
        : c,
    )

  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Slip: shift WHICH source material a timed clip shows without moving it on
 * the timeline. Positive delta shows later material (source in-point moves
 * forward). timelineRange is untouched, so neighbors can never be affected.
 * A still clip has no alternate source material, so slip is an intentional,
 * silent same-reference no-op.
 * Rejected when the source in-point would go below 0 or the resulting source
 * range would leave JavaScript's safe-integer frame domain. Slipping past the
 * END of the asset is validated at the store/UI layer, like trimClip
 * (domain/ cannot see assets — file-header note).
 */
export function slipClip(
  doc: TimelineDoc,
  clipId: ClipId,
  deltaFrames: number,
): TimelineDoc {
  const op = 'slipClip'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.clip.sourceMode === 'still') return doc
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const src = loc.clip.sourceRange
  const newSrcStart = src.startFrame + deltaFrames
  if (newSrcStart < 0) {
    return reject(doc, op, 'no source material before the asset start')
  }
  const newSrcEnd = newSrcStart + src.durationFrames - 1
  if (
    !Number.isSafeInteger(newSrcStart) ||
    !Number.isSafeInteger(newSrcEnd)
  ) {
    return reject(doc, op, 'source range must stay within safe integer frames')
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    sourceRange: { startFrame: newSrcStart, durationFrames: src.durationFrames },
  }
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Slide: move a clip along its track while its TOUCHING neighbors absorb
 * the change — the left neighbor's tail extends/shrinks and the right
 * neighbor's head trims, so the three clips stay glued and everything
 * beyond them keeps its position. The slid clip's duration and source are
 * unchanged. A side with a gap instead of a touching neighbor just slides
 * over the gap. Rejected when a touching neighbor would drop below 1
 * frame, the right neighbor's source would go below 0, the clip would
 * start before 0, or the result would overlap any other clip.
 */
export function slideClip(
  doc: TimelineDoc,
  clipId: ClipId,
  deltaFrames: number,
): TimelineDoc {
  const op = 'slideClip'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip, track, clipIndex } = loc
  const tl = clip.timelineRange
  const newStart = tl.startFrame + deltaFrames
  if (newStart < 0) {
    return reject(doc, op, 'clip cannot start before timeline frame 0')
  }

  const clips = track.clips.slice()
  const left = clipIndex > 0 ? clips[clipIndex - 1] : null
  const right = clipIndex < clips.length - 1 ? clips[clipIndex + 1] : null

  if (left && rangeEnd(left.timelineRange) === tl.startFrame) {
    // Touching left neighbor: its tail follows our head.
    const newDur = left.timelineRange.durationFrames + deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'left neighbor cannot shrink below 1 frame')
    }
    clips[clipIndex - 1] = {
      ...left,
      timelineRange: { ...left.timelineRange, durationFrames: newDur },
      sourceRange: left.sourceMode === 'still'
        ? left.sourceRange
        : { ...left.sourceRange, durationFrames: newDur },
    }
  }
  if (right && right.timelineRange.startFrame === rangeEnd(tl)) {
    // Touching right neighbor: its head follows our tail.
    const newDur = right.timelineRange.durationFrames - deltaFrames
    const rightIsStill = right.sourceMode === 'still'
    const newSrcStart = rightIsStill
      ? right.sourceRange.startFrame
      : right.sourceRange.startFrame + deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'right neighbor cannot shrink below 1 frame')
    }
    if (!rightIsStill && newSrcStart < 0) {
      return reject(doc, op, 'right neighbor has no source material before the asset start')
    }
    clips[clipIndex + 1] = {
      ...right,
      timelineRange: {
        startFrame: right.timelineRange.startFrame + deltaFrames,
        durationFrames: newDur,
      },
      sourceRange: rightIsStill
        ? right.sourceRange
        : { startFrame: newSrcStart, durationFrames: newDur },
    }
  }
  clips[clipIndex] = {
    ...clip,
    timelineRange: { startFrame: newStart, durationFrames: tl.durationFrames },
  }

  // Gap sides can slide into other clips: re-verify the whole-track
  // invariant. In a sorted-by-start list any overlap shows up between some
  // sort-adjacent pair.
  clips.sort(byStart)
  for (let i = 1; i < clips.length; i++) {
    if (rangeOverlap(clips[i - 1].timelineRange, clips[i].timelineRange)) {
      return reject(doc, op, 'slide would overlap another clip')
    }
  }

  const nextTrack = reconcileTransitions(track, { ...track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/**
 * Ripple trim: change a clip's length at one edge and shift every clip on
 * the SAME track that starts at/after the clip's OLD end by the same
 * amount, so downstream spacing is preserved (the timeline "breathes"
 * instead of leaving a gap). MVP scope: single-track ripple, matching
 * rippleDelete. For edge 'start' the clip's timeline start stays fixed —
 * material is cut from (delta > 0) or restored to (delta < 0) the head and
 * downstream closes/opens accordingly; for edge 'end' positive delta
 * lengthens the tail and pushes downstream right. Gap preservation means
 * a ripple trim can never create an overlap.
 */
export function rippleTrim(
  doc: TimelineDoc,
  clipId: ClipId,
  edge: TrimEdge,
  deltaFrames: number,
): TimelineDoc {
  const op = 'rippleTrim'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const { clip } = loc
  const tl = clip.timelineRange
  const src = clip.sourceRange
  const oldEnd = rangeEnd(tl)
  const stillSource = clip.sourceMode === 'still'

  let newClip: Clip
  let shiftBy: number
  if (edge === 'start') {
    const newDur = tl.durationFrames - deltaFrames
    const newSrcStart = stillSource
      ? src.startFrame
      : src.startFrame + deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    if (!stillSource && newSrcStart < 0) {
      return reject(doc, op, 'no source material before the asset start')
    }
    newClip = {
      ...clip,
      timelineRange: { startFrame: tl.startFrame, durationFrames: newDur },
      sourceRange: stillSource
        ? src
        : { startFrame: newSrcStart, durationFrames: newDur },
    }
    shiftBy = -deltaFrames
  } else {
    const newDur = tl.durationFrames + deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    newClip = {
      ...clip,
      timelineRange: { startFrame: tl.startFrame, durationFrames: newDur },
      sourceRange: stillSource
        ? src
        : { startFrame: src.startFrame, durationFrames: newDur },
    }
    shiftBy = deltaFrames
  }

  const clips = loc.track.clips.map((c) => {
    if (c.id === clipId) return newClip
    if (c.timelineRange.startFrame >= oldEnd) {
      return {
        ...c,
        timelineRange: {
          ...c.timelineRange,
          startFrame: c.timelineRange.startFrame + shiftBy,
        },
      }
    }
    return c
  })

  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

/** What updateClipTransform can change (the Inspector's surface, 4.3). */
export interface ClipTransformPatch {
  /** Transform fields to merge; omitted fields keep their current values. */
  transform?: Partial<Transform>
  /** New opacity. Clamped into [0, 1] (schema range). */
  opacity?: number
}

/**
 * Merge new visual properties into a clip: any subset of Transform fields
 * plus opacity. Purely presentational — ranges, neighbors and durations
 * cannot be affected. Rejected on an empty patch or any non-finite number
 * (NaN/Infinity from a parsed input must never enter the doc); opacity is
 * clamped rather than rejected, since 0..1 is a UI convention.
 */
export function updateClipTransform(
  doc: TimelineDoc,
  clipId: ClipId,
  patch: ClipTransformPatch,
): TimelineDoc {
  const op = 'updateClipTransform'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const transformPatch = patch.transform ?? {}
  for (const [key, value] of Object.entries(transformPatch)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return reject(doc, op, `transform.${key} must be a finite number, got ${value}`)
    }
  }
  const hasOpacity = patch.opacity !== undefined
  if (hasOpacity && !Number.isFinite(patch.opacity)) {
    return reject(doc, op, `opacity must be a finite number, got ${patch.opacity}`)
  }
  if (Object.keys(transformPatch).length === 0 && !hasOpacity) {
    return reject(doc, op, 'empty patch — nothing to change')
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    transform: { ...loc.clip.transform, ...transformPatch },
    opacity: hasOpacity
      ? Math.min(1, Math.max(0, patch.opacity as number))
      : loc.clip.opacity,
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/** Per-track toggle flags (timeline header buttons). */
export interface TrackFlagsPatch {
  hidden?: boolean
  muted?: boolean
  solo?: boolean
  locked?: boolean
}

/**
 * Add a new empty track of `kind`, named with the NLE convention V2/V3…
 * (video) or A2/A3… (audio) — the next free number for that kind, counting
 * both existing ids and names so a rename can never cause an id collision.
 *
 * Placement keeps the doc's [videos…, audios…] shape AND the compositing
 * convention (tracks[0] = bottom layer): a video track goes AFTER the last
 * video track, so it composites above the existing video stack; an audio
 * track goes after the last audio track (the end). Never rejects.
 */
export function addTrack(doc: TimelineDoc, kind: TrackKind): TimelineDoc {
  const prefix = kind === 'video' ? 'V' : 'A'
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  let max = 0
  for (const track of doc.tracks) {
    for (const label of [track.id, track.name]) {
      const m = pattern.exec(label)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  const label = `${prefix}${max + 1}`
  const track: Track = {
    id: label,
    kind,
    name: label,
    clips: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }

  let lastOfKind = -1
  for (let t = 0; t < doc.tracks.length; t++) {
    if (doc.tracks[t].kind === kind) lastOfKind = t
  }
  // No video track yet → index 0 (below any audio in the array); no audio
  // track yet → the end. Both keep videos grouped before audios.
  const insertAt =
    lastOfKind !== -1 ? lastOfKind + 1 : kind === 'video' ? 0 : doc.tracks.length
  const tracks = doc.tracks.slice()
  tracks.splice(insertAt, 0, track)
  return { ...doc, tracks }
}

/**
 * Set a track's toggle flags: hidden (video → skipped by the compositor),
 * muted (audio → excluded from the mix), locked (rejects clip edits).
 * DELIBERATE exception to the locked rule: flags may be changed on a locked
 * track — otherwise a track could never be unlocked. A patch that changes
 * nothing returns the same reference WITHOUT a warning (an idempotent
 * toggle is not an error, it just pushes no history entry).
 */
export function setTrackFlags(
  doc: TimelineDoc,
  trackId: TrackId,
  patch: TrackFlagsPatch,
): TimelineDoc {
  const op = 'setTrackFlags'
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const track = doc.tracks[trackIndex]

  const keys = (['hidden', 'muted', 'solo', 'locked'] as const).filter(
    (k) => patch[k] !== undefined,
  )
  if (keys.length === 0) return reject(doc, op, 'empty patch — nothing to change')
  if (keys.every((k) => patch[k] === track[k])) return doc

  const next = { ...track }
  for (const k of keys) next[k] = patch[k] as boolean
  return withTrack(doc, trackIndex, next)
}

/**
 * Rename a track (display name only — the id never changes, so clips,
 * undo snapshots and UI keys keep working). The name is trimmed; an empty
 * result is rejected. Renaming to the CURRENT name returns the same
 * reference silently (idempotent, no history entry), matching
 * setTrackFlags. Renaming a locked track is allowed — like its flags, a
 * track's label is metadata about the track, not an edit of its content.
 */
export function renameTrack(
  doc: TimelineDoc,
  trackId: TrackId,
  name: string,
): TimelineDoc {
  const op = 'renameTrack'
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const trimmed = name.trim()
  if (trimmed === '') return reject(doc, op, 'name must not be empty')
  const track = doc.tracks[trackIndex]
  if (trimmed === track.name) return doc
  return withTrack(doc, trackIndex, { ...track, name: trimmed })
}

/**
 * Delete a track AND everything on it (clips, transitions) — one op, so
 * one undo entry restores the lot. Any link group that would be left with
 * exactly one surviving member is dissolved in the same operation, keeping
 * the document portable and the schema's no-orphan contract intact. A locked
 * target or locked orphan survivor rejects atomically (the lock is exactly
 * the "don't touch this content" guard); unknown ids reject.
 * Deleting the last track of a kind is allowed — the add-track buttons
 * and undo are both one click away, and nothing in the engine requires a
 * lane of each kind to exist.
 */
export function removeTrack(doc: TimelineDoc, trackId: TrackId): TimelineDoc {
  const op = 'removeTrack'
  const trackIndex = doc.tracks.findIndex((t) => t.id === trackId)
  if (trackIndex === -1) return reject(doc, op, `track ${trackId} not found`)
  const removedTrack = doc.tracks[trackIndex]
  if (removedTrack.locked) {
    return reject(doc, op, `track ${trackId} is locked`)
  }

  const touchedGroups = new Set<string>()
  for (const clip of removedTrack.clips) {
    if (clip.linkGroupId !== undefined) touchedGroups.add(clip.linkGroupId)
  }

  const survivingCounts = new Map<string, number>()
  if (touchedGroups.size > 0) {
    for (let index = 0; index < doc.tracks.length; index++) {
      if (index === trackIndex) continue
      for (const clip of doc.tracks[index].clips) {
        if (clip.linkGroupId !== undefined && touchedGroups.has(clip.linkGroupId)) {
          survivingCounts.set(
            clip.linkGroupId,
            (survivingCounts.get(clip.linkGroupId) ?? 0) + 1,
          )
        }
      }
    }
  }

  const orphanedGroups = new Set<string>()
  for (const groupId of touchedGroups) {
    if (survivingCounts.get(groupId) === 1) orphanedGroups.add(groupId)
  }

  // Preflight every survivor before rebuilding anything. Dissolving its link
  // is still an edit to that clip, so a locked partner blocks the whole op.
  for (let index = 0; index < doc.tracks.length; index++) {
    if (index === trackIndex) continue
    const track = doc.tracks[index]
    if (
      track.locked &&
      track.clips.some(
        (clip) =>
          clip.linkGroupId !== undefined &&
          orphanedGroups.has(clip.linkGroupId),
      )
    ) {
      return reject(doc, op, `linked survivor on track ${track.id} is locked`)
    }
  }

  const tracks: Track[] = []
  for (let index = 0; index < doc.tracks.length; index++) {
    if (index === trackIndex) continue
    const track = doc.tracks[index]
    if (
      !track.clips.some(
        (clip) =>
          clip.linkGroupId !== undefined &&
          orphanedGroups.has(clip.linkGroupId),
      )
    ) {
      tracks.push(track)
      continue
    }
    tracks.push({
      ...track,
      clips: track.clips.map((clip) =>
        clip.linkGroupId !== undefined &&
        orphanedGroups.has(clip.linkGroupId)
          ? withoutLinkGroupId(clip)
          : clip,
      ),
    })
  }
  return { ...doc, tracks }
}

/** Upper clip-volume bound: 200% gain, the usual NLE headroom. */
export const MAX_CLIP_VOLUME = 2

/**
 * Set a clip's audio volume (linear gain, clamped to [0, MAX_CLIP_VOLUME]
 * like opacity's [0,1] — a UI convention, not an error). Meaningful for
 * clips on audio tracks; the mix (Phase 5 export, future playback) reads
 * it via clip.volume. Rejects non-finite values, unknown clips and locked
 * tracks; setting the current value returns the same reference silently.
 */
export function setClipVolume(
  doc: TimelineDoc,
  clipId: ClipId,
  volume: number,
): TimelineDoc {
  const op = 'setClipVolume'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (!Number.isFinite(volume)) {
    return reject(doc, op, `volume must be a finite number, got ${volume}`)
  }

  const clamped = Math.min(MAX_CLIP_VOLUME, Math.max(0, volume))
  if (clamped === loc.clip.volume) return doc

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...loc.clip, volume: clamped }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/**
 * Append an effect to a clip's chain. The effect is defensively copied so
 * later mutation of the caller's object cannot reach into the doc.
 */
export function addEffect(
  doc: TimelineDoc,
  clipId: ClipId,
  effect: Effect,
): TimelineDoc {
  const op = 'addEffect'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)
  if (loc.clip.effects.some((e) => e.id === effect.id)) {
    return reject(doc, op, `clip already has an effect with id ${effect.id}`)
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    effects: [...loc.clip.effects, { ...effect, params: { ...effect.params } }],
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}
