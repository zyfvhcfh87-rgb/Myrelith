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
 *   - sourceRange.durationFrames === timelineRange.durationFrames (speed 1.0),
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
  TimeRange,
  TimelineDoc,
  Track,
  TrackId,
} from './schema'
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

/** Rejection path: warn and hand back the SAME doc reference. */
function reject(doc: TimelineDoc, op: string, why: string): TimelineDoc {
  console.warn(`[operations] ${op} rejected: ${why}`)
  return doc
}

function byStart(a: Clip, b: Clip): number {
  return a.timelineRange.startFrame - b.timelineRange.startFrame
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

/** Drop transitions whose endpoints no longer both exist on the track. */
function pruneTransitions(track: Track): Track {
  const ids = new Set(track.clips.map((c) => c.id))
  const transitions = track.transitions.filter(
    (tr) => ids.has(tr.fromClipId) && ids.has(tr.toClipId),
  )
  return transitions.length === track.transitions.length
    ? track
    : { ...track, transitions }
}

/**
 * Unique id for entities created by operations (split's right half, copied
 * effects). crypto.randomUUID is a standard global in Node and workers too,
 * so domain/ stays runnable outside the browser.
 */
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/* ------------------------------------------------------------------ */
/* Operations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Split a clip in two at a timeline frame strictly inside it. The left half
 * keeps the original clip id; the right half gets a new id, continues the
 * source material exactly where the left half stops, and deep-copies the
 * effect chain (with fresh effect-instance ids).
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
  const left: Clip = {
    ...clip,
    sourceRange: {
      startFrame: clip.sourceRange.startFrame,
      durationFrames: offset,
    },
    timelineRange: { startFrame: tl.startFrame, durationFrames: offset },
  }
  const right: Clip = {
    ...clip,
    id: newId('clip'),
    sourceRange: {
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
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

/**
 * Move one edge of a clip by a signed frame delta ("move the edge right" is
 * positive). Trimming the start also advances the source in-point so the
 * remaining material still lines up. Rejected when the result would be
 * shorter than 1 frame, start before frame 0 (timeline or source), or
 * overlap a neighbor.
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

  let newTl: TimeRange
  let newSrc: TimeRange
  if (edge === 'start') {
    newTl = {
      startFrame: tl.startFrame + deltaFrames,
      durationFrames: tl.durationFrames - deltaFrames,
    }
    newSrc = {
      startFrame: src.startFrame + deltaFrames,
      durationFrames: src.durationFrames - deltaFrames,
    }
  } else {
    newTl = { startFrame: tl.startFrame, durationFrames: tl.durationFrames + deltaFrames }
    newSrc = { startFrame: src.startFrame, durationFrames: src.durationFrames + deltaFrames }
  }

  if (newTl.durationFrames < 1) {
    return reject(doc, op, 'clip duration cannot shrink below 1 frame')
  }
  if (newTl.startFrame < 0) {
    return reject(doc, op, 'clip cannot start before timeline frame 0')
  }
  if (newSrc.startFrame < 0) {
    return reject(doc, op, 'no source material before the asset start')
  }
  if (overlapsAny(loc.track.clips, newTl, clipId)) {
    return reject(doc, op, 'trim would overlap a neighboring clip')
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = { ...clip, timelineRange: newTl, sourceRange: newSrc }
  clips.sort(byStart)
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
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
    return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
  }

  // Cross-track: remove from source, insert into target, fix transitions.
  const sourceClips = loc.track.clips.filter((c) => c.id !== clipId)
  const targetClips = [...target.clips, movedClip].sort(byStart)
  const tracks = doc.tracks.slice()
  tracks[loc.trackIndex] = pruneTransitions({ ...loc.track, clips: sourceClips })
  tracks[targetIndex] = { ...target, clips: targetClips }
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

  return withTrack(
    doc,
    loc.trackIndex,
    pruneTransitions({ ...loc.track, clips }),
  )
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
