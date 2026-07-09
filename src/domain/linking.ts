/**
 * domain/linking.ts — Linked A/V clip pairs: pure functions over a
 * TimelineDoc. Phase 4.3.8.
 *
 * A "link group" is a set of clips sharing `Clip.linkGroupId` (see
 * schema.ts). By construction every group has exactly two members — the
 * video half and audio half created together from one A/V drop — but the
 * functions below handle any group size defensively rather than assuming
 * pairs everywhere.
 *
 * Contract (matches operations.ts):
 * - Every function returns a NEW TimelineDoc; the input is never mutated.
 * - Invalid calls return the ORIGINAL doc unchanged (same reference, so
 *   callers detect rejection with `result === doc`) and log a
 *   console.warn, prefixed `[linking]` instead of `[operations]`.
 *
 * The "linked*" functions wrap an existing operations.ts edit and apply it
 * to every member of the target clip's group, sequentially, on the
 * evolving doc (target first, then partners). If any member's application
 * is rejected, the WHOLE edit rolls back to the original doc — linked
 * clips must never be left half-edited, or the V/A pair would fall out of
 * sync. A clip with no linkGroupId (or no partners) degrades to exactly
 * the plain op (single application, same result reference on reject).
 */

import {
  moveClip,
  rippleDelete,
  rippleTrim,
  slideClip,
  slipClip,
  splitClipAtFrame,
  trimClip,
} from './operations'
import type { TrimEdge } from './operations'
import type { Clip, ClipId, TimelineDoc, TrackId } from './schema'
import { findClip, trackOfClip } from './selectors'
import { rangeEnd } from './time'

/** Rejection path: warn and hand back the SAME doc reference. */
function reject(doc: TimelineDoc, op: string, why: string): TimelineDoc {
  console.warn(`[linking] ${op} rejected: ${why}`)
  return doc
}

/* ------------------------------------------------------------------ */
/* Group id / membership reads                                          */
/* ------------------------------------------------------------------ */

/**
 * Mint a fresh, unique link-group id. crypto.randomUUID is a standard
 * global in Node and workers too, so domain/ stays runnable outside the
 * browser (same rationale as operations.ts's internal newId).
 */
export function createLinkGroupId(): string {
  return `link_${crypto.randomUUID()}`
}

/**
 * All OTHER clips in the doc sharing `clipId`'s linkGroupId. Empty when
 * the clip is not found, has no linkGroupId (unlinked), or — pathologically
 * — its group turns out to have no other members.
 */
export function linkedPartners(doc: TimelineDoc, clipId: ClipId): Clip[] {
  const clip = findClip(doc, clipId)
  if (!clip || !clip.linkGroupId) return []
  const groupId = clip.linkGroupId
  const partners: Clip[] = []
  for (const track of doc.tracks) {
    for (const c of track.clips) {
      if (c.id !== clipId && c.linkGroupId === groupId) partners.push(c)
    }
  }
  return partners
}

/**
 * clipId's own clip first, then its partners — the "who does this edit
 * touch" set shared by the linked wrappers below. Empty when clipId is not
 * found in the doc.
 */
function groupMembers(doc: TimelineDoc, clipId: ClipId): Clip[] {
  const clip = findClip(doc, clipId)
  if (!clip) return []
  return [clip, ...linkedPartners(doc, clipId)]
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Rebuild `clip` with its linkGroupId property removed (absent, not set to
 * undefined — an `undefined`-valued key does not survive JSON.stringify
 * anyway, and schema.ts requires lossless round-trips). No-op reference
 * return when the clip has no linkGroupId to begin with.
 */
function withoutLinkGroupId(clip: Clip): Clip {
  if (!clip.linkGroupId) return clip
  const { linkGroupId: _linkGroupId, ...rest } = clip
  return rest
}

/**
 * Rebuild only the tracks that hold one of `ids`, setting `linkGroupId` on
 * each matching clip. Structural sharing: a track with no matching clip
 * keeps its existing reference; the whole doc is returned unchanged if no
 * track needed rebuilding.
 */
function setLinkGroupIdOnClips(
  doc: TimelineDoc,
  ids: readonly ClipId[],
  linkGroupId: string,
): TimelineDoc {
  const idSet = new Set(ids)
  let changed = false
  const tracks = doc.tracks.map((track) => {
    if (!track.clips.some((c) => idSet.has(c.id))) return track
    changed = true
    const clips = track.clips.map((c) => (idSet.has(c.id) ? { ...c, linkGroupId } : c))
    return { ...track, clips }
  })
  return changed ? { ...doc, tracks } : doc
}

/**
 * Rebuild only the tracks that hold one of `ids`, stripping `linkGroupId`
 * from each matching clip. Structural sharing, mirroring
 * setLinkGroupIdOnClips.
 */
function removeLinkGroupIdFromClips(doc: TimelineDoc, ids: readonly ClipId[]): TimelineDoc {
  const idSet = new Set(ids)
  let changed = false
  const tracks = doc.tracks.map((track) => {
    if (!track.clips.some((c) => idSet.has(c.id) && c.linkGroupId)) return track
    changed = true
    const clips = track.clips.map((c) => (idSet.has(c.id) ? withoutLinkGroupId(c) : c))
    return { ...track, clips }
  })
  return changed ? { ...doc, tracks } : doc
}

/** Every clip id anywhere in the doc (used to spot exactly which ids a
 * split introduced — see linkedSplitClipAtFrame). */
function allClipIds(doc: TimelineDoc): Set<ClipId> {
  const ids = new Set<ClipId>()
  for (const track of doc.tracks) {
    for (const clip of track.clips) ids.add(clip.id)
  }
  return ids
}

/** Clip ids present in `after` but not in `before`. */
function newIdsAfterSplit(before: TimelineDoc, after: TimelineDoc): ClipId[] {
  const beforeIds = allClipIds(before)
  const added: ClipId[] = []
  for (const track of after.tracks) {
    for (const clip of track.clips) {
      if (!beforeIds.has(clip.id)) added.push(clip.id)
    }
  }
  return added
}

/**
 * Apply `apply` — a base operations.ts edit closed over its own extra
 * arguments, `(doc, memberId) => TimelineDoc` — to every member of
 * clipId's group, in order (target first, then partners), each on the doc
 * produced by the previous member. A clip with no linkGroupId or no
 * partners degrades to a single application (byte-identical to calling the
 * base op directly). If any application is rejected (`result === input`,
 * operations.ts's own rejection signal), the whole edit is rolled back to
 * the ORIGINAL doc and a `[linking]` warning is logged — the base op
 * already warned the specific reason.
 */
function applyToGroup(
  doc: TimelineDoc,
  clipId: ClipId,
  op: string,
  apply: (d: TimelineDoc, memberId: ClipId) => TimelineDoc,
): TimelineDoc {
  const members = groupMembers(doc, clipId)
  if (members.length <= 1) return apply(doc, clipId)

  let next = doc
  for (const member of members) {
    const applied = apply(next, member.id)
    if (applied === next) return reject(doc, op, 'partner could not follow')
    next = applied
  }
  return next
}

/* ------------------------------------------------------------------ */
/* Linked operations                                                    */
/* ------------------------------------------------------------------ */

/**
 * Dissolve clipId's entire link group: every member loses its linkGroupId.
 * Rejected when the clip is not found, has no linkGroupId (nothing to
 * dissolve), or any group member sits on a locked track (project
 * convention: locked tracks reject all edits, and dissolving a link is an
 * edit to every member it touches). Structural sharing: only tracks
 * holding a group member are rebuilt.
 */
export function unlinkClip(doc: TimelineDoc, clipId: ClipId): TimelineDoc {
  const op = 'unlinkClip'
  const clip = findClip(doc, clipId)
  if (!clip) return reject(doc, op, `clip ${clipId} not found`)
  if (!clip.linkGroupId) return reject(doc, op, `clip ${clipId} has no linkGroupId`)

  const members = groupMembers(doc, clipId)
  for (const member of members) {
    const track = trackOfClip(doc, member.id)
    if (track?.locked) return reject(doc, op, `track ${track.id} is locked`)
  }

  return removeLinkGroupIdFromClips(
    doc,
    members.map((m) => m.id),
  )
}

/**
 * Move the TARGET clip to (toTrackId, toFrame); every partner moves by the
 * same frame delta on ITS OWN current track — partners never change
 * tracks, even when the target does. Delta is computed against the
 * target's PRE-EDIT timeline position, before any member moves. Degrades
 * to a plain moveClip when clipId is unknown or unlinked; rolls back to
 * the original doc if any member (the target included) cannot make the
 * move.
 */
export function linkedMoveClip(
  doc: TimelineDoc,
  clipId: ClipId,
  toTrackId: TrackId,
  toFrame: number,
): TimelineDoc {
  const op = 'linkedMoveClip'
  const members = groupMembers(doc, clipId)
  if (members.length <= 1) return moveClip(doc, clipId, toTrackId, toFrame)

  const target = members[0]
  const delta = toFrame - target.timelineRange.startFrame

  let next = moveClip(doc, clipId, toTrackId, toFrame)
  if (next === doc) return reject(doc, op, 'partner could not follow')

  for (const partner of members.slice(1)) {
    const partnerTrack = trackOfClip(doc, partner.id)
    if (!partnerTrack) return reject(doc, op, 'partner could not follow') // defensive: unreachable — partner came from doc's own tracks
    const partnerToFrame = partner.timelineRange.startFrame + delta
    const applied = moveClip(next, partner.id, partnerTrack.id, partnerToFrame)
    if (applied === next) return reject(doc, op, 'partner could not follow')
    next = applied
  }
  return next
}

/**
 * Trim the same edge of every member of clipId's group by the same delta.
 * See applyToGroup for the shared degrade/atomicity contract.
 */
export function linkedTrimClip(
  doc: TimelineDoc,
  clipId: ClipId,
  edge: TrimEdge,
  deltaFrames: number,
): TimelineDoc {
  return applyToGroup(doc, clipId, 'linkedTrimClip', (d, id) =>
    trimClip(d, id, edge, deltaFrames),
  )
}

/**
 * Ripple-trim the same edge of every member of clipId's group by the same
 * delta (each ripples its OWN track's downstream clips). See
 * applyToGroup.
 */
export function linkedRippleTrim(
  doc: TimelineDoc,
  clipId: ClipId,
  edge: TrimEdge,
  deltaFrames: number,
): TimelineDoc {
  return applyToGroup(doc, clipId, 'linkedRippleTrim', (d, id) =>
    rippleTrim(d, id, edge, deltaFrames),
  )
}

/** Slip every member of clipId's group by the same source delta. See
 * applyToGroup. */
export function linkedSlipClip(
  doc: TimelineDoc,
  clipId: ClipId,
  deltaFrames: number,
): TimelineDoc {
  return applyToGroup(doc, clipId, 'linkedSlipClip', (d, id) => slipClip(d, id, deltaFrames))
}

/**
 * Slide every member of clipId's group by the same delta (each among its
 * own track's neighbors). See applyToGroup.
 */
export function linkedSlideClip(
  doc: TimelineDoc,
  clipId: ClipId,
  deltaFrames: number,
): TimelineDoc {
  return applyToGroup(doc, clipId, 'linkedSlideClip', (d, id) => slideClip(d, id, deltaFrames))
}

/**
 * Ripple-delete every member of clipId's group. Each member is relocated
 * by id on the evolving doc, so same-track members are still found
 * correctly after an earlier deletion shifts them, and deletion order
 * cannot matter for cross-track groups. See applyToGroup.
 */
export function linkedRippleDelete(doc: TimelineDoc, clipId: ClipId): TimelineDoc {
  return applyToGroup(doc, clipId, 'linkedRippleDelete', (d, id) => rippleDelete(d, id))
}

/**
 * Split the TARGET at `frame`, and every OTHER group member whose
 * timelineRange strictly contains `frame` (skipped defensively when a
 * member does not — by construction all members share the target's range,
 * so this is normally everyone). Rejected exactly like splitClipAtFrame
 * would reject the target alone (unknown clip, non-integer frame, locked
 * track, frame not strictly inside) — that rejection (and its warning) is
 * reused as-is, with no extra `[linking]` warning stacked on top.
 *
 * splitClipAtFrame's right half inherits the parent's linkGroupId via
 * spread (see its own doc comment) — fine for a lone split, but wrong
 * here: splitting a 2-member group would otherwise put all 4 resulting
 * clips in one group. This is fixed up afterwards by diffing the clip ids
 * introduced by each split (never guessed from position): once every
 * member has been split, if 2+ new right halves exist they are reassigned
 * ONE fresh linkGroupId (a new group, distinct from the left halves'
 * original one); if exactly 1 exists, its linkGroupId is removed (it has
 * no partner at its new position). Left halves are never touched, so they
 * keep the original group untouched. A partner that strictly contains
 * `frame` but fails to split (e.g. its track is locked) rolls back the
 * WHOLE edit, so the V/A pair can never end up half split.
 */
export function linkedSplitClipAtFrame(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
): TimelineDoc {
  const op = 'linkedSplitClipAtFrame'

  const afterTarget = splitClipAtFrame(doc, clipId, frame)
  if (afterTarget === doc) return afterTarget // reuse splitClipAtFrame's own rejection + warning

  const newRightHalfIds = newIdsAfterSplit(doc, afterTarget)
  let working = afterTarget

  for (const partner of linkedPartners(doc, clipId)) {
    const tl = partner.timelineRange
    if (frame <= tl.startFrame || frame >= rangeEnd(tl)) continue // doesn't strictly contain frame

    const before = working
    working = splitClipAtFrame(before, partner.id, frame)
    if (working === before) return reject(doc, op, 'partner could not follow')
    newRightHalfIds.push(...newIdsAfterSplit(before, working))
  }

  if (newRightHalfIds.length >= 2) {
    working = setLinkGroupIdOnClips(working, newRightHalfIds, createLinkGroupId())
  } else if (newRightHalfIds.length === 1) {
    working = removeLinkGroupIdFromClips(working, newRightHalfIds)
  }
  return working
}
