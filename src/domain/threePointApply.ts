/**
 * Apply an accepted sequence-edit plan to a TimelineDoc.
 *
 * Any rejected participant rolls back to the original document reference.
 * Clip ids are minted here so a replayed plan against a live doc stays
 * unique. This module is browser-free.
 */

import { clipAnimation, shiftClipAnimation } from './clipAnimation'
import {
  removeCaptionItem,
  shiftCaptionItems,
} from './captions'
import { createLinkGroupId, unlinkClip } from './linking'
import {
  clipFromAssetRange,
  deleteClip,
  insertClip,
  splitClipAtFrame,
} from './operations'
import {
  locateClip,
  reconcileTransitions,
  withClampedAudioFades,
  withTrack,
} from './operations/operationInternals'
import type { Clip, MediaAsset, TimeRange, TimelineDoc, TrackId } from './schema'
import { findClip } from './selectors'
import {
  clipSourceTimeMap,
  defaultSourceTimeMap,
  sourceRangeForMap,
  sourceTimeMapAtOffset,
  sourceTimeMapForTimelineDuration,
} from './sourceTimeMap'
import { rangeEnd, rangeOverlap } from './time'
import type {
  SequenceEditAcceptedPlan,
  SequenceInsertOverwritePlan,
  SequenceLiftExtractPlan,
  SequenceReplacePlan,
  SequenceRollPlan,
} from './threePointEdit'

const OP = 'applySequenceEdit'

function warn(why: string): void {
  console.warn(`[threePointEdit] ${OP} rejected: ${why}`)
}

function fail(original: TimelineDoc, why: string): TimelineDoc {
  warn(why)
  return original
}

function clipIdsOnTracks(
  doc: TimelineDoc,
  trackIds: readonly TrackId[],
  range: TimeRange,
): Clip[] {
  const wanted = new Set(trackIds)
  const clips: Clip[] = []
  for (const track of doc.tracks) {
    if (!wanted.has(track.id)) continue
    for (const clip of track.clips) {
      if (rangeOverlap(clip.timelineRange, range)) clips.push(clip)
    }
  }
  return clips
}

function splitStrictlyInside(
  doc: TimelineDoc,
  clipId: string,
  frame: number,
): TimelineDoc | null {
  const loc = locateClip(doc, clipId)
  if (!loc) return null
  const tl = loc.clip.timelineRange
  if (frame <= tl.startFrame || frame >= rangeEnd(tl)) return doc
  const next = splitClipAtFrame(doc, clipId, frame)
  return next === doc ? null : next
}

function punchTrackRange(
  doc: TimelineDoc,
  trackId: TrackId,
  range: TimeRange,
): TimelineDoc | null {
  const start = range.startFrame
  const end = rangeEnd(range)
  let current = doc
  const track = current.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return null
  if (track.locked) return null

  const startIds = track.clips
    .filter((clip) => start > clip.timelineRange.startFrame && start < rangeEnd(clip.timelineRange))
    .map((clip) => clip.id)
  for (const clipId of startIds) {
    const next = splitStrictlyInside(current, clipId, start)
    if (next === null) return null
    current = next
  }

  const afterStart = current.tracks.find((candidate) => candidate.id === trackId)
  if (!afterStart) return null
  const endIds = afterStart.clips
    .filter((clip) => end > clip.timelineRange.startFrame && end < rangeEnd(clip.timelineRange))
    .map((clip) => clip.id)
  for (const clipId of endIds) {
    const next = splitStrictlyInside(current, clipId, end)
    if (next === null) return null
    current = next
  }

  const afterSplits = current.tracks.find((candidate) => candidate.id === trackId)
  if (!afterSplits) return null
  const removeIds = afterSplits.clips
    .filter((clip) => (
      clip.timelineRange.startFrame >= start
      && rangeEnd(clip.timelineRange) <= end
    ))
    .map((clip) => clip.id)
  for (const clipId of removeIds) {
    const next = deleteClip(current, clipId)
    if (next === current) return null
    current = next
  }
  return current
}

function splitUnlockedAt(
  doc: TimelineDoc,
  original: TimelineDoc,
  frame: number,
): TimelineDoc | null {
  let current = doc
  for (const track of original.tracks) {
    if (track.locked) {
      const spanning = track.clips.some((clip) => (
        frame > clip.timelineRange.startFrame && frame < rangeEnd(clip.timelineRange)
      ))
      if (spanning) return null
      continue
    }
    const ids = track.clips
      .filter((clip) => (
        frame > clip.timelineRange.startFrame && frame < rangeEnd(clip.timelineRange)
      ))
      .map((clip) => clip.id)
    for (const clipId of ids) {
      const next = splitStrictlyInside(current, clipId, frame)
      if (next === null) return null
      current = next
    }
  }
  return current
}

function trackClipsOverlap(clips: readonly Clip[]): boolean {
  const sorted = clips.slice().sort(
    (left, right) => left.timelineRange.startFrame - right.timelineRange.startFrame,
  )
  for (let index = 1; index < sorted.length; index++) {
    if (rangeOverlap(sorted[index - 1]!.timelineRange, sorted[index]!.timelineRange)) {
      return true
    }
  }
  return false
}

function shiftTracksFrom(
  doc: TimelineDoc,
  fromFrame: number,
  deltaFrames: number,
  trackIds: ReadonlySet<TrackId> | null,
): TimelineDoc | null {
  if (deltaFrames === 0) return doc
  const tracks = []
  for (const track of doc.tracks) {
    if (track.locked || (trackIds !== null && !trackIds.has(track.id))) {
      tracks.push(track)
      continue
    }
    const clips = track.clips.map((clip) => {
      if (clip.timelineRange.startFrame < fromFrame) return clip
      return {
        ...clip,
        timelineRange: {
          ...clip.timelineRange,
          startFrame: clip.timelineRange.startFrame + deltaFrames,
        },
      }
    })
    if (clips.some((clip) => clip.timelineRange.startFrame < 0)) return null
    if (trackClipsOverlap(clips)) return null
    const changed = clips.some((clip, index) => clip !== track.clips[index])
    tracks.push(
      changed ? reconcileTransitions(track, { ...track, clips }) : track,
    )
  }
  const unchanged = tracks.every((track, index) => track === doc.tracks[index])
  return unchanged ? doc : { ...doc, tracks }
}

function lockedTrackBlocksRipple(
  doc: TimelineDoc,
  fromFrame: number,
): boolean {
  return doc.tracks.some((track) => (
    track.locked
    && track.clips.some((clip) => clip.timelineRange.startFrame >= fromFrame)
  ))
}

function shiftCaptionsFrom(
  doc: TimelineDoc,
  fromFrame: number,
  deltaFrames: number,
): TimelineDoc | null {
  if (deltaFrames === 0 || !doc.captionTracks || doc.captionTracks.length === 0) {
    return doc
  }
  let current = doc
  try {
    for (const track of current.captionTracks ?? []) {
      const first = track.items.find((item) => item.range.startFrame >= fromFrame)
      if (!first) continue
      current = shiftCaptionItems(current, track.id, first.id, deltaFrames)
    }
  } catch {
    return null
  }
  return current
}

function liftCaptionsInRange(
  doc: TimelineDoc,
  range: TimeRange,
): TimelineDoc | null {
  if (!doc.captionTracks || doc.captionTracks.length === 0) return doc
  let current = doc
  const end = rangeEnd(range)
  try {
    const trackIds = (doc.captionTracks ?? []).map((track) => track.id)
    for (const trackId of trackIds) {
      const track = current.captionTracks?.find((candidate) => candidate.id === trackId)
      if (!track) continue
      const removeIds = track.items
        .filter((item) => (
          item.range.startFrame >= range.startFrame
          && rangeEnd(item.range) <= end
        ))
        .map((item) => item.id)
      for (const itemId of removeIds) {
        current = removeCaptionItem(current, trackId, itemId)
      }
    }
  } catch {
    return null
  }
  return current
}

function unlinkOrphans(
  doc: TimelineDoc,
  removedGroups: ReadonlySet<string>,
): TimelineDoc | null {
  if (removedGroups.size === 0) return doc
  let current = doc
  for (const track of current.tracks) {
    for (const clip of track.clips) {
      if (!clip.linkGroupId || !removedGroups.has(clip.linkGroupId)) continue
      const next = unlinkClip(current, clip.id)
      if (next === current) return null
      current = next
    }
  }
  return current
}

function applyInsert(
  doc: TimelineDoc,
  plan: SequenceInsertOverwritePlan,
  asset: MediaAsset,
): TimelineDoc {
  const original = doc
  const start = plan.timelineRange.startFrame
  const duration = plan.timelineRange.durationFrames

  if (lockedTrackBlocksRipple(doc, start)) {
    return fail(original, 'a locked track would have to move')
  }

  const split = splitUnlockedAt(doc, original, start)
  if (split === null) return fail(original, 'could not split at the insert point')

  const shifted = shiftTracksFrom(split, start, duration, null)
  if (shifted === null) return fail(original, 'could not ripple later clips')

  const captions = shiftCaptionsFrom(shifted, start, duration)
  if (captions === null) return fail(original, 'could not shift captions')

  return placeSource(captions, original, plan, asset)
}

function applyOverwrite(
  doc: TimelineDoc,
  plan: SequenceInsertOverwritePlan,
  asset: MediaAsset,
): TimelineDoc {
  const original = doc
  let current = doc
  for (const placement of plan.placements) {
    const punched = punchTrackRange(current, placement.trackId, plan.timelineRange)
    if (punched === null) return fail(original, 'could not overwrite the targeted range')
    current = punched
  }
  return placeSource(current, original, plan, asset)
}

function placeSource(
  doc: TimelineDoc,
  original: TimelineDoc,
  plan: SequenceInsertOverwritePlan,
  asset: MediaAsset,
): TimelineDoc {
  if (asset.id !== plan.assetId) return fail(original, 'source asset does not match the plan')
  const linkGroupId = plan.linkPlacements ? createLinkGroupId(doc) : undefined
  let current = doc
  for (const placement of plan.placements) {
    const clip = clipFromAssetRange(
      asset,
      plan.timelineRange.startFrame,
      plan.still ? 0 : plan.sourceRange.startFrame,
      plan.timelineRange.durationFrames,
      linkGroupId,
    )
    const next = insertClip(current, placement.trackId, clip)
    if (next === current) return fail(original, 'insert collided on a targeted track')
    current = next
  }
  return current
}

function applyLiftExtract(
  doc: TimelineDoc,
  plan: SequenceLiftExtractPlan,
): TimelineDoc {
  const original = doc
  const groups = new Set<string>()
  for (const clip of clipIdsOnTracks(doc, plan.trackIds, plan.timelineRange)) {
    if (clip.linkGroupId) groups.add(clip.linkGroupId)
  }

  let current = doc
  for (const trackId of plan.trackIds) {
    const punched = punchTrackRange(current, trackId, plan.timelineRange)
    if (punched === null) return fail(original, 'could not lift the targeted range')
    current = punched
  }

  const captions = liftCaptionsInRange(current, plan.timelineRange)
  if (captions === null) return fail(original, 'could not update captions')
  current = captions

  const unlinked = unlinkOrphans(current, groups)
  if (unlinked === null) return fail(original, 'could not unlink leftover partners')
  current = unlinked

  if (plan.kind === 'extract') {
    const end = rangeEnd(plan.timelineRange)
    const shifted = shiftTracksFrom(
      current,
      end,
      -plan.timelineRange.durationFrames,
      new Set(plan.trackIds),
    )
    if (shifted === null) return fail(original, 'could not close the extract gap')
    const shiftedCaptions = shiftCaptionsFrom(
      shifted,
      end,
      -plan.timelineRange.durationFrames,
    )
    if (shiftedCaptions === null) return fail(original, 'could not shift captions')
    current = shiftedCaptions
  }
  return current
}

function replaceClipSource(
  doc: TimelineDoc,
  clipId: string,
  asset: MediaAsset,
  sourceStart: number,
  durationFrames: number,
  still: boolean,
): TimelineDoc | null {
  const loc = locateClip(doc, clipId)
  if (!loc) return null
  if (loc.track.locked) return null
  const clip = loc.clip
  if (clip.timelineRange.durationFrames !== durationFrames) return null
  const sourceDuration = still ? 1 : durationFrames
  const sourceRange = still
    ? { startFrame: 0, durationFrames: 1 }
    : { startFrame: sourceStart, durationFrames: sourceDuration }
  const sourceTimeMap = defaultSourceTimeMap(
    sourceRange.startFrame,
    sourceRange.durationFrames,
  )
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...clip,
    assetId: asset.id,
    name: asset.fileName,
    sourceMode: still ? 'still' : 'timed',
    sourceRange,
    sourceTimeMap,
  }
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

function applyReplace(
  doc: TimelineDoc,
  plan: SequenceReplacePlan,
  asset: MediaAsset,
): TimelineDoc {
  const original = doc
  if (asset.id !== plan.assetId) return fail(original, 'source asset does not match the plan')
  let current = doc
  for (const clipId of plan.clipIds) {
    const next = replaceClipSource(
      current,
      clipId,
      asset,
      plan.sourceRange.startFrame,
      plan.sourceRange.durationFrames,
      plan.still,
    )
    if (next === null) return fail(original, 'could not replace the targeted clip')
    current = next
  }
  if (plan.unlinkSurvivors) {
    for (const clipId of plan.clipIds) {
      const clip = findClip(current, clipId)
      if (!clip?.linkGroupId) continue
      const next = unlinkClip(current, clipId)
      if (next === current) return fail(original, 'could not unlink leftover partners')
      current = next
    }
  }
  return current
}

function rollPair(
  doc: TimelineDoc,
  leftId: string,
  rightId: string,
  deltaFrames: number,
): TimelineDoc | null {
  const leftLoc = locateClip(doc, leftId)
  const rightLoc = locateClip(doc, rightId)
  if (!leftLoc || !rightLoc) return null
  if (leftLoc.trackIndex !== rightLoc.trackIndex) return null
  if (leftLoc.track.locked) return null
  const left = leftLoc.clip
  const right = rightLoc.clip
  if (rangeEnd(left.timelineRange) !== right.timelineRange.startFrame) return null

  const leftNewDur = left.timelineRange.durationFrames + deltaFrames
  const rightNewDur = right.timelineRange.durationFrames - deltaFrames
  if (leftNewDur < 1 || rightNewDur < 1) return null

  const leftStill = left.sourceMode === 'still'
  const leftText = left.text !== undefined
  const rightStill = right.sourceMode === 'still'
  const rightText = right.text !== undefined

  let leftMap
  let rightMap
  try {
    leftMap = leftStill || leftText
      ? defaultSourceTimeMap(0, leftStill ? 1 : leftNewDur)
      : sourceTimeMapForTimelineDuration(clipSourceTimeMap(left), leftNewDur)
    rightMap = rightStill || rightText
      ? defaultSourceTimeMap(0, rightStill ? 1 : rightNewDur)
      : sourceTimeMapAtOffset(clipSourceTimeMap(right), deltaFrames)
  } catch {
    return null
  }
  if (!rightStill && !rightText && rightMap.sourceStartTicks < 0) return null

  let leftSource
  let rightSource
  try {
    leftSource = leftStill
      ? left.sourceRange
      : leftText
        ? { startFrame: 0, durationFrames: leftNewDur }
        : sourceRangeForMap(leftMap, leftNewDur)
    rightSource = rightStill
      ? right.sourceRange
      : rightText
        ? { startFrame: 0, durationFrames: rightNewDur }
        : sourceRangeForMap(rightMap, rightNewDur)
  } catch {
    return null
  }

  const rightAnimation = shiftClipAnimation(clipAnimation(right), -deltaFrames)
  if (!rightAnimation) return null

  const clips = leftLoc.track.clips.slice()
  clips[leftLoc.clipIndex] = withClampedAudioFades({
    ...left,
    timelineRange: { startFrame: left.timelineRange.startFrame, durationFrames: leftNewDur },
    sourceRange: leftSource,
    sourceTimeMap: leftMap,
  })
  clips[rightLoc.clipIndex] = withClampedAudioFades({
    ...right,
    timelineRange: {
      startFrame: right.timelineRange.startFrame + deltaFrames,
      durationFrames: rightNewDur,
    },
    sourceRange: rightSource,
    sourceTimeMap: rightMap,
    animation: rightAnimation,
  })
  const nextTrack = reconcileTransitions(leftLoc.track, { ...leftLoc.track, clips })
  return withTrack(doc, leftLoc.trackIndex, nextTrack)
}

function applyRoll(
  doc: TimelineDoc,
  plan: SequenceRollPlan,
): TimelineDoc {
  const original = doc
  let current = doc
  for (const [leftId, rightId] of plan.pairs) {
    const next = rollPair(current, leftId, rightId, plan.deltaFrames)
    if (next === null) return fail(original, 'could not roll the seam')
    current = next
  }
  return current
}

export function applySequenceEdit(
  doc: TimelineDoc,
  plan: SequenceEditAcceptedPlan,
  asset: MediaAsset | null,
): TimelineDoc {
  switch (plan.kind) {
    case 'insert':
      if (!asset) return fail(doc, 'insert needs a source asset')
      return applyInsert(doc, plan, asset)
    case 'overwrite':
      if (!asset) return fail(doc, 'overwrite needs a source asset')
      return applyOverwrite(doc, plan, asset)
    case 'lift':
    case 'extract':
      return applyLiftExtract(doc, plan)
    case 'replace':
      if (!asset) return fail(doc, 'replace needs a source asset')
      return applyReplace(doc, plan, asset)
    case 'roll':
      return applyRoll(doc, plan)
  }
}
