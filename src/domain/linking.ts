/**
 * domain/linking.ts — Linked A/V clip pairs: pure functions over a
 * TimelineDoc. Phase 4.3.8.
 *
 * A "link group" is a set of clips sharing `Clip.linkGroupId` (see
 * schema.ts). By construction every group has exactly two members — one
 * video clip and one audio clip, whether linked manually or created together
 * from one A/V drop — but the functions below handle any group size
 * defensively rather than assuming pairs everywhere.
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
  clearClipSpeedRamp,
  moveClip,
  moveClipsByDelta,
  removeClipSpeedPoint,
  rippleDelete,
  rippleTrim,
  retimeClip,
  setClipSpeedPoint,
  slideClip,
  slipClip,
  splitClipAtFrame,
  trimClip,
} from './operations'
import type { TrimEdge } from './operations'
import type {
  Clip,
  ClipId,
  SourceTimeRate,
  SourceTimeSpeedEasing,
  TimeRange,
  TimelineDoc,
  Track,
  TrackId,
  TrackKind,
} from './schema'
import { findClip, trackOfClip } from './selectors'
import {
  clipSourceTimeMap,
  sourceTimeMapUsesSpeedCurve,
  sourceTimeMapWithSpeedPoint,
  sourceTimeMapWithoutSpeedCurve,
  sourceTimeRateValidationError,
  sourceTimeSpeedPointsAtClip,
  timelineFramesWithinSourceMap,
} from './sourceTimeMap'
import { rangeEnd, rangeOverlap } from './time'
import { shiftLaterAdjustments } from './operations/operationInternals'

/** Rejection path: warn and hand back the SAME doc reference. */
function reject(doc: TimelineDoc, op: string, why: string): TimelineDoc {
  console.warn(`[linking] ${op} rejected: ${why}`)
  return doc
}

function tracksOfKind(doc: TimelineDoc, kind: TrackKind): Track[] {
  return doc.tracks.filter((track) => track.kind === kind)
}

function indexWithinKind(doc: TimelineDoc, trackId: TrackId): number {
  const track = doc.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return -1
  return tracksOfKind(doc, track.kind).findIndex((candidate) => candidate.id === trackId)
}

function trackAtKindIndex(
  doc: TimelineDoc,
  kind: TrackKind,
  index: number,
): Track | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return undefined
  return tracksOfKind(doc, kind)[index]
}

/**
 * Lane a linked partner should occupy after the owner moves from
 * sourceTrackId to destTrackId. Uses the same kind-local index delta so
 * V1→V2 takes A1→A2. If that lane does not exist, the partner stays put.
 */
export function linkedPartnerTrackAfterMove(
  doc: TimelineDoc,
  sourceTrackId: TrackId,
  destTrackId: TrackId,
  partnerTrackId: TrackId,
): Track | undefined {
  const partner = doc.tracks.find((track) => track.id === partnerTrackId)
  if (!partner) return undefined
  if (sourceTrackId === destTrackId) return partner
  const sourceIdx = indexWithinKind(doc, sourceTrackId)
  const destIdx = indexWithinKind(doc, destTrackId)
  const partnerIdx = indexWithinKind(doc, partner.id)
  if (sourceIdx < 0 || destIdx < 0 || partnerIdx < 0) return partner
  return trackAtKindIndex(doc, partner.kind, partnerIdx + (destIdx - sourceIdx))
    ?? partner
}

/* ------------------------------------------------------------------ */
/* Group id / membership reads                                          */
/* ------------------------------------------------------------------ */

/** Stable reasons why two selected clips cannot form a new A/V link. */
export type LinkClipsRejectionReason =
  | 'same-clip'
  | 'video-clip-missing'
  | 'audio-clip-missing'
  | 'first-clip-not-video'
  | 'second-clip-not-audio'
  | 'video-track-locked'
  | 'audio-track-locked'
  | 'video-clip-already-linked'
  | 'audio-clip-already-linked'

/** Result shared by the domain operation and UI availability checks. */
export type LinkClipsEligibility =
  | { eligible: true }
  | { eligible: false; reason: LinkClipsRejectionReason }

/**
 * Check whether `videoClipId` and `audioClipId` can form a new link pair.
 * Validation order is deliberate so callers always receive one stable,
 * actionable reason for the same document state.
 */
export function getLinkClipsEligibility(
  doc: TimelineDoc,
  videoClipId: ClipId,
  audioClipId: ClipId,
): LinkClipsEligibility {
  if (videoClipId === audioClipId) return { eligible: false, reason: 'same-clip' }

  const videoClip = findClip(doc, videoClipId)
  const audioClip = findClip(doc, audioClipId)
  if (!videoClip) return { eligible: false, reason: 'video-clip-missing' }
  if (!audioClip) return { eligible: false, reason: 'audio-clip-missing' }

  const videoTrack = trackOfClip(doc, videoClipId)
  const audioTrack = trackOfClip(doc, audioClipId)
  if (videoTrack?.kind !== 'video') {
    return { eligible: false, reason: 'first-clip-not-video' }
  }
  if (audioTrack?.kind !== 'audio') {
    return { eligible: false, reason: 'second-clip-not-audio' }
  }

  if (videoTrack.locked) return { eligible: false, reason: 'video-track-locked' }
  if (audioTrack.locked) return { eligible: false, reason: 'audio-track-locked' }

  if (videoClip.linkGroupId !== undefined) {
    return { eligible: false, reason: 'video-clip-already-linked' }
  }
  if (audioClip.linkGroupId !== undefined) {
    return { eligible: false, reason: 'audio-clip-already-linked' }
  }

  return { eligible: true }
}

/**
 * Mint a link-group id absent from every current group in `doc`.
 * crypto.randomUUID is a standard global in Node and workers too, so
 * domain/ stays runnable outside the browser. If the UUID base already
 * exists, a bounded scan chooses the first free numeric suffix.
 */
export function createLinkGroupId(doc: TimelineDoc): string {
  const existing = new Set<string>()
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.linkGroupId !== undefined) existing.add(clip.linkGroupId)
    }
  }

  const base = `link_${crypto.randomUUID()}`
  if (!existing.has(base)) return base

  for (let suffix = 2; suffix <= existing.size + 1; suffix++) {
    const candidate = `${base}_${suffix}`
    if (!existing.has(candidate)) return candidate
  }

  // Unreachable by the pigeonhole principle, but keeps the return total:
  // the finite set cannot occupy base plus every suffix checked above.
  return `${base}_${existing.size + 2}`
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

function durationAfterConstantRetime(
  clip: Clip,
  rate: SourceTimeRate,
): number | null {
  if (sourceTimeRateValidationError(rate)) return null
  const nextMap = sourceTimeMapWithoutSpeedCurve(clipSourceTimeMap(clip))
  nextMap.rate = { ...rate }
  const durationFrames = timelineFramesWithinSourceMap(nextMap)
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) return null
  return durationFrames
}

/**
 * Push later timeline items, and each later clip's link group, just far enough
 * that newRange can sit on clipId's track. Touching is allowed. A locked or
 * blocked partner aborts with null so the caller can roll back.
 */
function makeRoomForTimelineRange(
  doc: TimelineDoc,
  clipId: ClipId,
  newRange: TimeRange,
): TimelineDoc | null {
  const track = trackOfClip(doc, clipId)
  if (!track) return null
  const clipBlockers = track.clips.filter((candidate) => (
    candidate.id !== clipId
    && rangeOverlap(candidate.timelineRange, newRange)
  ))
  const adjustmentBlockers = (track.adjustments ?? []).filter((candidate) => (
    rangeOverlap(candidate.timelineRange, newRange)
  ))
  const firstBlockerFrame = Math.min(
    ...clipBlockers.map((candidate) => candidate.timelineRange.startFrame),
    ...adjustmentBlockers.map((candidate) => candidate.timelineRange.startFrame),
  )
  if (!Number.isFinite(firstBlockerFrame)) return doc

  const shiftFrames = rangeEnd(newRange) - firstBlockerFrame
  if (shiftFrames <= 0) return doc

  const movingIds: ClipId[] = []
  const seen = new Set<ClipId>()
  for (const candidate of track.clips) {
    if (candidate.id === clipId) continue
    if (candidate.timelineRange.startFrame < firstBlockerFrame) {
      continue
    }
    for (const member of groupMembers(doc, candidate.id)) {
      if (seen.has(member.id)) continue
      seen.add(member.id)
      movingIds.push(member.id)
    }
  }
  const shiftedAdjustments = shiftLaterAdjustments(
    track.adjustments,
    firstBlockerFrame,
    shiftFrames,
  )
  if (shiftedAdjustments === null) return null
  const staged = shiftedAdjustments === track.adjustments
    ? doc
    : {
        ...doc,
        tracks: doc.tracks.map((candidate) => (
          candidate.id === track.id
            ? { ...candidate, adjustments: shiftedAdjustments }
            : candidate
        )),
      }
  if (movingIds.length === 0) return staged === doc ? null : staged
  const moved = moveClipsByDelta(staged, movingIds, shiftFrames)
  return moved === staged ? null : moved
}

function applyConstantRetimeWithRoom(
  doc: TimelineDoc,
  members: readonly Clip[],
  rate: SourceTimeRate,
  op: string,
): TimelineDoc {
  const ordered = [...members].sort((left, right) => (
    left.timelineRange.startFrame - right.timelineRange.startFrame
    || left.id.localeCompare(right.id)
  ))
  let next = doc
  let changed = false
  for (const member of ordered) {
    const latest = findClip(next, member.id)
    if (!latest) return reject(doc, op, 'partner could not follow')
    const currentMap = clipSourceTimeMap(latest)
    if (
      !sourceTimeMapUsesSpeedCurve(currentMap)
      && currentMap.rate.numerator === rate.numerator
      && currentMap.rate.denominator === rate.denominator
    ) continue
    const newDurationFrames = durationAfterConstantRetime(latest, rate)
    if (newDurationFrames === null) return reject(doc, op, 'partner could not follow')
    const room = makeRoomForTimelineRange(next, latest.id, {
      startFrame: latest.timelineRange.startFrame,
      durationFrames: newDurationFrames,
    })
    if (room === null) return reject(doc, op, 'later clip could not make room')
    next = room
    const applied = retimeClip(next, latest.id, rate)
    if (applied === next) return reject(doc, op, 'partner could not follow')
    next = applied
    changed = true
  }
  return changed ? next : doc
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
 * Link one unlinked video clip to one unlinked audio clip without changing
 * either clip's asset, geometry, or metadata. Invalid calls warn and return
 * the exact input reference; successful calls rebuild only the two owning
 * tracks and clips.
 */
export function linkClips(
  doc: TimelineDoc,
  videoClipId: ClipId,
  audioClipId: ClipId,
): TimelineDoc {
  const eligibility = getLinkClipsEligibility(doc, videoClipId, audioClipId)
  if (!eligibility.eligible) return reject(doc, 'linkClips', eligibility.reason)

  return setLinkGroupIdOnClips(
    doc,
    [videoClipId, audioClipId],
    createLinkGroupId(doc),
  )
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
 * Move the TARGET clip to (toTrackId, toFrame). Partners take the same
 * frame delta and the same kind-local track-index delta (V1→V2 moves
 * A1→A2). A missing destination lane leaves that partner on its current
 * track. Delta is computed against the target's PRE-EDIT timeline
 * position. Degrades to a plain moveClip when clipId is unknown or
 * unlinked; rolls back to the original doc if any member cannot move.
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
  const targetTrack = trackOfClip(doc, clipId)
  if (!targetTrack) return moveClip(doc, clipId, toTrackId, toFrame)
  const delta = toFrame - target.timelineRange.startFrame

  let next = moveClip(doc, clipId, toTrackId, toFrame)
  if (next === doc) return reject(doc, op, 'partner could not follow')

  for (const partner of members.slice(1)) {
    const partnerTrack = trackOfClip(doc, partner.id)
    if (!partnerTrack) return reject(doc, op, 'partner could not follow') // defensive: unreachable — partner came from doc's own tracks
    const destTrack = linkedPartnerTrackAfterMove(
      doc,
      targetTrack.id,
      toTrackId,
      partnerTrack.id,
    )
    if (!destTrack) return reject(doc, op, 'partner could not follow')
    const partnerToFrame = partner.timelineRange.startFrame + delta
    const applied = moveClip(next, partner.id, destTrack.id, partnerToFrame)
    if (applied === next) return reject(doc, op, 'partner could not follow')
    next = applied
  }
  return next
}

/**
 * Move an arbitrary clip selection horizontally as one atomic edit. Every
 * selected root expands to its complete link group, duplicate members are
 * collapsed, and the staged geometry operation validates the full closure
 * before publishing anything.
 */
export function linkedMoveClips(
  doc: TimelineDoc,
  clipIds: readonly ClipId[],
  deltaFrames: number,
): TimelineDoc {
  const op = 'linkedMoveClips'
  if (clipIds.length === 0 || deltaFrames === 0) return doc

  const memberIds: ClipId[] = []
  const seen = new Set<ClipId>()
  for (const clipId of clipIds) {
    const members = groupMembers(doc, clipId)
    if (members.length === 0) return reject(doc, op, `clip ${clipId} not found`)
    for (const member of members) {
      if (seen.has(member.id)) continue
      seen.add(member.id)
      memberIds.push(member.id)
    }
  }
  return moveClipsByDelta(doc, memberIds, deltaFrames)
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

/** Apply one constant rate to every linked member as one atomic edit. Growing clips push later neighbors. */
export function linkedRetimeClip(
  doc: TimelineDoc,
  clipId: ClipId,
  rate: SourceTimeRate,
): TimelineDoc {
  const members = groupMembers(doc, clipId)
  if (members.length === 0) return retimeClip(doc, clipId, rate)
  if (
    members.some(
      (member) => member.sourceMode === 'still' || member.text !== undefined,
    )
  ) return doc
  return applyConstantRetimeWithRoom(doc, members, rate, 'linkedRetimeClip')
}

/**
 * Apply one constant rate to every selected clip and each clip's link
 * group as one atomic edit. Still/text roots are skipped. An empty
 * selection or an already-matching set returns the same doc reference.
 */
export function linkedRetimeClips(
  doc: TimelineDoc,
  clipIds: readonly ClipId[],
  rate: SourceTimeRate,
): TimelineDoc {
  const op = 'linkedRetimeClips'
  if (clipIds.length === 0) return doc

  const memberIds: ClipId[] = []
  const seen = new Set<ClipId>()
  for (const clipId of clipIds) {
    const members = groupMembers(doc, clipId)
    if (members.length === 0) return reject(doc, op, `clip ${clipId} not found`)
    if (
      members.some(
        (member) => member.sourceMode === 'still' || member.text !== undefined,
      )
    ) continue
    for (const member of members) {
      if (seen.has(member.id)) continue
      seen.add(member.id)
      memberIds.push(member.id)
    }
  }
  if (memberIds.length === 0) return doc

  const members: Clip[] = []
  for (const memberId of memberIds) {
    const member = findClip(doc, memberId)
    if (!member) return reject(doc, op, 'partner could not follow')
    members.push(member)
  }
  return applyConstantRetimeWithRoom(doc, members, rate, op)
}

/** Add/replace the same local speed handle on every linked member atomically. */
export function linkedSetClipSpeedPoint(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
  rate: SourceTimeRate,
  easing: SourceTimeSpeedEasing,
): TimelineDoc {
  const members = groupMembers(doc, clipId)
  if (
    members.some(
      (member) => member.sourceMode === 'still' || member.text !== undefined,
    )
  ) return doc
  let next = doc
  let changed = false
  for (const member of members) {
    const existing = sourceTimeSpeedPointsAtClip(clipSourceTimeMap(member))
      .find((point) => point.frame === frame)
    if (
      existing
      && existing.rate.numerator === rate.numerator
      && existing.rate.denominator === rate.denominator
      && existing.easing === easing
    ) continue
    const latest = findClip(next, member.id)
    if (!latest) return reject(doc, 'linkedSetClipSpeedPoint', 'partner could not follow')
    let newDurationFrames: number
    try {
      newDurationFrames = timelineFramesWithinSourceMap(
        sourceTimeMapWithSpeedPoint(
          clipSourceTimeMap(latest),
          frame,
          rate,
          easing,
        ),
      )
    } catch {
      return reject(doc, 'linkedSetClipSpeedPoint', 'partner could not follow')
    }
    const room = makeRoomForTimelineRange(next, latest.id, {
      startFrame: latest.timelineRange.startFrame,
      durationFrames: newDurationFrames,
    })
    if (room === null) {
      return reject(doc, 'linkedSetClipSpeedPoint', 'later clip could not make room')
    }
    next = room
    const applied = setClipSpeedPoint(next, member.id, frame, rate, easing)
    if (applied === next) {
      return reject(doc, 'linkedSetClipSpeedPoint', 'partner could not follow')
    }
    next = applied
    changed = true
  }
  return changed ? next : doc
}

/** Remove a matching local speed handle from every member that carries it. */
export function linkedRemoveClipSpeedPoint(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
): TimelineDoc {
  const members = groupMembers(doc, clipId)
  const owner = members.find((member) => member.id === clipId)
  if (
    !owner
    || !sourceTimeSpeedPointsAtClip(clipSourceTimeMap(owner))
      .some((point) => point.frame === frame)
  ) return removeClipSpeedPoint(doc, clipId, frame)
  let next = doc
  for (const member of members) {
    if (
      !sourceTimeSpeedPointsAtClip(clipSourceTimeMap(member))
        .some((point) => point.frame === frame)
    ) continue
    const applied = removeClipSpeedPoint(next, member.id, frame)
    if (applied === next) {
      return reject(doc, 'linkedRemoveClipSpeedPoint', 'partner could not follow')
    }
    next = applied
  }
  return next
}

/** Clear every linked member's ramp while retaining its constant fallback. */
export function linkedClearClipSpeedRamp(
  doc: TimelineDoc,
  clipId: ClipId,
): TimelineDoc {
  const members = groupMembers(doc, clipId)
  let next = doc
  let changed = false
  for (const member of members) {
    if (!sourceTimeMapUsesSpeedCurve(clipSourceTimeMap(member))) continue
    const applied = clearClipSpeedRamp(next, member.id)
    if (applied === next) {
      return reject(doc, 'linkedClearClipSpeedRamp', 'partner could not follow')
    }
    next = applied
    changed = true
  }
  return changed ? next : doc
}

/** Slip every member of clipId's group by the same source delta. See
 * applyToGroup. */
export function linkedSlipClip(
  doc: TimelineDoc,
  clipId: ClipId,
  deltaFrames: number,
): TimelineDoc {
  // One still member makes source-time movement meaningless for the whole
  // linked gesture. Keep it an intentional, warning-free no-op instead of
  // letting applyToGroup misclassify the still member's same-reference return
  // as an atomicity failure.
  if (
    groupMembers(doc, clipId).some(
      (member) => member.sourceMode === 'still' || member.text !== undefined,
    )
  ) {
    return doc
  }
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
 * timelineRange strictly contains `frame` (skipped when a member does not;
 * manually linked members may have unequal ranges). Rejected exactly like
 * splitClipAtFrame
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
    working = setLinkGroupIdOnClips(working, newRightHalfIds, createLinkGroupId(working))
  } else if (newRightHalfIds.length === 1) {
    working = removeLinkGroupIdFromClips(working, newRightHalfIds)
  }
  return working
}
