import type { Clip, ClipId, EffectId, SourceTimeRate, SourceTimeMap, SourceTimeSpeedEasing, TimeRange, TimelineDoc, TrackId } from '../schema';
import { clipAnimation, clipAnimationKeyframeCount, cloneClipAnimation, documentAnimationKeyframeGrowthAllowed, shiftClipAnimation, remapEffectAnimationIds } from '../clipAnimation';
import { rangeEnd, rangeOverlap } from '../time';
import { effectCollectionAppendBudgetError } from '../effectBounds';
import { audioEffectCollectionAppendBudgetError, clipAudioEffects } from '../audioEffectBounds';
import { cloneAudioEffectDescriptor } from '../audioEffectStack';
import { clipSourceTimeMap, cloneSourceTimeMap, defaultSourceTimeMap, retimeClipAnimation, shiftClipAnimationSourceTimeIntent, sourceRangeForMap, sourceTimeMapAtOffset, sourceTimeMapForTimelineDuration, sourceTimeMapUsesSpeedCurve, sourceTimeMapValidationError, sourceTimeMapWithSpeedPoint, sourceTimeMapWithoutSpeedCurve, sourceTimeMapWithoutSpeedPoint, sourceTimeRateValidationError, timelineFramesWithinSourceMap, SOURCE_TIME_TICKS_PER_FRAME } from '../sourceTimeMap';
import { byStart, clipsOverlapAdjustments, locateClip, newId, overlapsAny, reconcileTransitions, reject, shiftLaterAdjustments, withClampedAudioFades, withTrack, type ClipLocation } from './operationInternals';
import type { TrimEdge } from './operationTypes';

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
  const effectBudgetError = effectCollectionAppendBudgetError(doc, clip.effects)
  if (effectBudgetError) return reject(doc, op, effectBudgetError)
  const audioEffects = clipAudioEffects(clip)
  const audioEffectBudgetError = audioEffectCollectionAppendBudgetError(doc, audioEffects)
  if (audioEffectBudgetError) return reject(doc, op, audioEffectBudgetError)
  if (!documentAnimationKeyframeGrowthAllowed(
    doc,
    clipAnimationKeyframeCount(clipAnimation(clip)),
  )) return reject(doc, op, 'split would exceed the document keyframe budget')

  const offset = frame - tl.startFrame
  const stillSource = clip.sourceMode === 'still'
  const textSource = clip.text !== undefined
  const sourceTimeMap = clipSourceTimeMap(clip)
  const leftSourceTimeMap = textSource || stillSource
    ? defaultSourceTimeMap(0, stillSource ? 1 : offset)
    : sourceTimeMapForTimelineDuration(sourceTimeMap, offset)
  const rightSourceTimeMap = textSource || stillSource
    ? defaultSourceTimeMap(
        0,
        stillSource ? 1 : tl.durationFrames - offset,
      )
    : sourceTimeMapAtOffset(sourceTimeMap, offset)
  const shiftedRightAnimation = shiftClipAnimation(clipAnimation(clip), -offset)
  if (!shiftedRightAnimation) return reject(doc, op, 'split would exceed keyframe frame bounds')
  const effectIdMap = new Map<EffectId, EffectId>()
  const rightEffects = clip.effects.map((effect) => {
    const id = newId('fx')
    effectIdMap.set(effect.id, id)
    return { ...effect, id, params: { ...effect.params } }
  })
  const rightAudioEffects = audioEffects.map((effect) => ({
    ...cloneAudioEffectDescriptor(effect),
    id: newId('afx'),
  }))
  const rightAnimation = remapEffectAnimationIds(shiftedRightAnimation, effectIdMap)
  const left: Clip = withClampedAudioFades({
    ...clip,
    sourceRange: stillSource
      ? { startFrame: 0, durationFrames: 1 }
      : textSource
        ? { startFrame: 0, durationFrames: offset }
        : sourceRangeForMap(leftSourceTimeMap, offset),
    sourceTimeMap: leftSourceTimeMap,
    timelineRange: { startFrame: tl.startFrame, durationFrames: offset },
  })
  const right: Clip = withClampedAudioFades({
    ...clip,
    id: newId('clip'),
    sourceRange: stillSource
      ? { startFrame: 0, durationFrames: 1 }
      : textSource
        ? { startFrame: 0, durationFrames: tl.durationFrames - offset }
        : sourceRangeForMap(rightSourceTimeMap, tl.durationFrames - offset),
    sourceTimeMap: rightSourceTimeMap,
    timelineRange: { startFrame: frame, durationFrames: tl.durationFrames - offset },
    animation: rightAnimation,
    effects: rightEffects,
    audioEffects: rightAudioEffects,
    ...(clip.text === undefined ? {} : { text: { ...clip.text } }),
  })

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
  const textSource = clip.text !== undefined
  const sourceTimeMap = clipSourceTimeMap(clip)

  let newTl: TimeRange
  let newSrc: TimeRange
  let newSourceTimeMap = cloneSourceTimeMap(sourceTimeMap)
  if (edge === 'start') {
    newTl = {
      startFrame: tl.startFrame + deltaFrames,
      durationFrames: tl.durationFrames - deltaFrames,
    }
    if (newTl.durationFrames < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newTl.durationFrames)
      : sourceTimeMapAtOffset(sourceTimeMap, deltaFrames)
    if (!stillSource && !textSource && newSourceTimeMap.sourceStartTicks < 0) {
      return reject(doc, op, 'no source material before the asset start')
    }
    newSrc = stillSource
      ? src
      : textSource
        ? { startFrame: 0, durationFrames: newTl.durationFrames }
        : sourceRangeForMap(newSourceTimeMap, newTl.durationFrames)
  } else {
    newTl = { startFrame: tl.startFrame, durationFrames: tl.durationFrames + deltaFrames }
    if (newTl.durationFrames < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newTl.durationFrames)
      : sourceTimeMapForTimelineDuration(sourceTimeMap, newTl.durationFrames)
    newSrc = stillSource
      ? src
      : textSource
        ? { startFrame: 0, durationFrames: newTl.durationFrames }
        : sourceRangeForMap(newSourceTimeMap, newTl.durationFrames)
  }

  if (newTl.startFrame < 0) {
    return reject(doc, op, 'clip cannot start before timeline frame 0')
  }
  if (overlapsAny(loc.track, newTl, clipId)) {
    return reject(doc, op, 'trim would overlap a neighboring clip')
  }

  const nextAnimation = edge === 'start'
    ? shiftClipAnimation(clipAnimation(clip), -deltaFrames)
    : cloneClipAnimation(clipAnimation(clip))
  if (!nextAnimation) return reject(doc, op, 'trim would exceed keyframe frame bounds')

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = withClampedAudioFades({
    ...clip,
    timelineRange: newTl,
    sourceRange: newSrc,
    sourceTimeMap: newSourceTimeMap,
    animation: nextAnimation,
  })
  clips.sort(byStart)
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

function sameSourceTimeMap(left: SourceTimeMap, right: SourceTimeMap): boolean {
  const leftCurve = left.speedCurve
  const rightCurve = right.speedCurve
  if (
    left.sourceStartTicks !== right.sourceStartTicks
    || left.sourceDurationTicks !== right.sourceDurationTicks
    || left.rate.numerator !== right.rate.numerator
    || left.rate.denominator !== right.rate.denominator
    || (leftCurve?.originFrame ?? 0) !== (rightCurve?.originFrame ?? 0)
    || (leftCurve?.points.length ?? 0) !== (rightCurve?.points.length ?? 0)
  ) return false
  const leftPoints = leftCurve?.points ?? []
  const rightPoints = rightCurve?.points ?? []
  return leftPoints.every((point, index) => {
    const other = rightPoints[index]
    return other !== undefined
      && point.frame === other.frame
      && point.rate.numerator === other.rate.numerator
      && point.rate.denominator === other.rate.denominator
      && point.easing === other.easing
  })
}

function replaceTimedClipSourceTimeMap(
  doc: TimelineDoc,
  loc: ClipLocation,
  newMap: SourceTimeMap,
  op: string,
): TimelineDoc {
  const mapError = sourceTimeMapValidationError(newMap)
  if (mapError) return reject(doc, op, mapError)
  const newDurationFrames = timelineFramesWithinSourceMap(newMap)
  if (!Number.isFinite(newDurationFrames) || newDurationFrames < 1) {
    return reject(doc, op, 'retimed clip must have a finite duration of at least one frame')
  }
  const startFrame = loc.clip.timelineRange.startFrame
  const endFrame = startFrame + newDurationFrames
  if (
    !Number.isSafeInteger(startFrame)
    || startFrame < 0
    || !Number.isSafeInteger(endFrame)
    || endFrame <= startFrame
  ) {
    return reject(doc, op, 'retimed timeline range must stay within safe integer frames')
  }
  const newTimelineRange = { startFrame, durationFrames: newDurationFrames }
  if (overlapsAny(loc.track, newTimelineRange, loc.clip.id)) {
    return reject(doc, op, 'retime would overlap a neighboring clip')
  }
  const oldMap = clipSourceTimeMap(loc.clip)
  const animation = retimeClipAnimation(
    clipAnimation(loc.clip),
    oldMap,
    newMap,
    newDurationFrames,
  )
  if (!animation) {
    return reject(doc, op, 'retime would collapse or exceed keyframe frame bounds')
  }
  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = withClampedAudioFades({
    ...loc.clip,
    timelineRange: newTimelineRange,
    sourceRange: sourceRangeForMap(newMap, newDurationFrames),
    sourceTimeMap: cloneSourceTimeMap(newMap),
    animation,
  })
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
}

function speedEditLocation(
  doc: TimelineDoc,
  clipId: ClipId,
  op: string,
): ClipLocation | null {
  const loc = locateClip(doc, clipId)
  if (!loc) {
    reject(doc, op, `clip ${clipId} not found`)
    return null
  }
  if (loc.track.locked) {
    reject(doc, op, `track ${loc.track.id} is locked`)
    return null
  }
  if (loc.clip.sourceMode === 'still' || loc.clip.text !== undefined) {
    reject(doc, op, 'only timed media clips can be retimed')
    return null
  }
  return loc
}

/** Replace any ramp with one bounded constant rational speed. */
export function retimeClip(
  doc: TimelineDoc,
  clipId: ClipId,
  rate: SourceTimeRate,
): TimelineDoc {
  const op = 'retimeClip'
  const rateError = sourceTimeRateValidationError(rate)
  if (rateError) return reject(doc, op, rateError)
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  const oldMap = clipSourceTimeMap(loc.clip)
  if (
    !sourceTimeMapUsesSpeedCurve(oldMap)
    && oldMap.rate.numerator === rate.numerator
    && oldMap.rate.denominator === rate.denominator
  ) return doc
  const newMap = sourceTimeMapWithoutSpeedCurve(oldMap)
  newMap.rate = { ...rate }
  return replaceTimedClipSourceTimeMap(doc, loc, newMap, op)
}

/** Add or replace one clip-local speed handle; duplicate time is replace. */
export function setClipSpeedPoint(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
  rate: SourceTimeRate,
  easing: SourceTimeSpeedEasing,
): TimelineDoc {
  const op = 'setClipSpeedPoint'
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  if (
    !Number.isSafeInteger(frame)
    || frame < 0
    || frame >= loc.clip.timelineRange.durationFrames
  ) return reject(doc, op, 'speed point must be inside the clip timeline bounds')
  let newMap: SourceTimeMap
  try {
    newMap = sourceTimeMapWithSpeedPoint(
      clipSourceTimeMap(loc.clip),
      frame,
      rate,
      easing,
    )
  } catch (error) {
    return reject(doc, op, error instanceof Error ? error.message : 'invalid speed point')
  }
  if (sameSourceTimeMap(clipSourceTimeMap(loc.clip), newMap)) return doc
  return replaceTimedClipSourceTimeMap(doc, loc, newMap, op)
}

export function removeClipSpeedPoint(
  doc: TimelineDoc,
  clipId: ClipId,
  frame: number,
): TimelineDoc {
  const op = 'removeClipSpeedPoint'
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  let newMap: SourceTimeMap
  try {
    newMap = sourceTimeMapWithoutSpeedPoint(clipSourceTimeMap(loc.clip), frame)
  } catch (error) {
    return reject(doc, op, error instanceof Error ? error.message : 'invalid speed point')
  }
  if (sameSourceTimeMap(clipSourceTimeMap(loc.clip), newMap)) {
    return reject(doc, op, `speed point at frame ${frame} not found`)
  }
  return replaceTimedClipSourceTimeMap(doc, loc, newMap, op)
}

export function clearClipSpeedRamp(
  doc: TimelineDoc,
  clipId: ClipId,
): TimelineDoc {
  const op = 'clearClipSpeedRamp'
  const loc = speedEditLocation(doc, clipId, op)
  if (!loc) return doc
  const oldMap = clipSourceTimeMap(loc.clip)
  if (!sourceTimeMapUsesSpeedCurve(oldMap)) return doc
  return replaceTimedClipSourceTimeMap(
    doc,
    loc,
    sourceTimeMapWithoutSpeedCurve(oldMap),
    op,
  )
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
  if (overlapsAny(target, newRange, clipId)) {
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
 * Move several clips by one signed integer-frame delta while keeping every
 * clip on its current track. Validation is performed against the complete
 * staged result, so selected neighbors may move through their old positions
 * without colliding with one another. Any stale id, locked track, unsafe
 * range, or overlap rejects the whole edit with the original document.
 */
export function moveClipsByDelta(
  doc: TimelineDoc,
  clipIds: readonly ClipId[],
  deltaFrames: number,
): TimelineDoc {
  const op = 'moveClipsByDelta'
  if (!Number.isInteger(deltaFrames)) {
    return reject(doc, op, `deltaFrames must be an integer, got ${deltaFrames}`)
  }
  if (clipIds.length === 0 || deltaFrames === 0) return doc

  const movingIds = new Set<ClipId>()
  const affectedTrackIndexes = new Set<number>()
  for (const clipId of clipIds) {
    if (movingIds.has(clipId)) continue
    const loc = locateClip(doc, clipId)
    if (!loc) return reject(doc, op, `clip ${clipId} not found`)
    if (loc.track.locked) {
      return reject(doc, op, `track ${loc.track.id} is locked`)
    }
    const startFrame = loc.clip.timelineRange.startFrame + deltaFrames
    const endFrame = startFrame + loc.clip.timelineRange.durationFrames
    if (
      !Number.isSafeInteger(startFrame)
      || !Number.isSafeInteger(endFrame)
      || startFrame < 0
    ) {
      return reject(doc, op, `clip ${clipId} would leave safe timeline bounds`)
    }
    movingIds.add(clipId)
    affectedTrackIndexes.add(loc.trackIndex)
  }

  const tracks = doc.tracks.slice()
  for (const trackIndex of affectedTrackIndexes) {
    const before = doc.tracks[trackIndex]
    const clips = before.clips.map((candidate) => (
      movingIds.has(candidate.id)
        ? {
            ...candidate,
            timelineRange: {
              ...candidate.timelineRange,
              startFrame: candidate.timelineRange.startFrame + deltaFrames,
            },
          }
        : candidate
    )).sort(byStart)

    for (let index = 1; index < clips.length; index += 1) {
      if (rangeOverlap(clips[index - 1].timelineRange, clips[index].timelineRange)) {
        return reject(doc, op, 'move would overlap a clip on an affected track')
      }
    }
    if (clipsOverlapAdjustments(clips, before.adjustments)) {
      return reject(doc, op, 'move would overlap a clip on an affected track')
    }
    tracks[trackIndex] = reconcileTransitions(before, { ...before, clips })
  }

  return { ...doc, tracks }
}

/**
 * Remove one clip and leave a gap. Transitions that used it are dropped by
 * reconcile. Linked partners are not followed — range lift/extract owns
 * that policy. Rejected on a missing clip or a locked track.
 */
export function deleteClip(doc: TimelineDoc, clipId: ClipId): TimelineDoc {
  const op = 'deleteClip'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const clips = loc.track.clips.filter((clip) => clip.id !== clipId)
  const nextTrack = reconcileTransitions(loc.track, { ...loc.track, clips })
  return withTrack(doc, loc.trackIndex, nextTrack)
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
  const adjustments = shiftLaterAdjustments(
    loc.track.adjustments,
    removedEnd,
    -removedDur,
  )
  if (adjustments === null) {
    return reject(doc, op, 'ripple would move an adjustment outside safe timeline bounds')
  }
  if (clipsOverlapAdjustments(clips, adjustments)) {
    return reject(doc, op, 'ripple would overlap an adjustment on the track')
  }

  const nextTrack = reconcileTransitions(loc.track, {
    ...loc.track,
    clips,
    ...(adjustments === undefined ? {} : { adjustments }),
  })
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
  if (loc.clip.sourceMode === 'still' || loc.clip.text !== undefined) return doc
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  // Historical pure fixtures can still omit the schema-11 map. Preserve the
  // exact old 1x safe-integer repair path until they cross persistence.
  if (loc.clip.sourceTimeMap === undefined) {
    const sourceRange = loc.clip.sourceRange
    const startFrame = sourceRange.startFrame + deltaFrames
    const endFrame = startFrame + sourceRange.durationFrames - 1
    if (startFrame < 0) {
      return reject(doc, op, 'no source material before the asset start')
    }
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)) {
      return reject(doc, op, 'source range must stay within safe integer frames')
    }
    const clips = loc.track.clips.slice()
    clips[loc.clipIndex] = {
      ...loc.clip,
      sourceRange: { startFrame, durationFrames: sourceRange.durationFrames },
    }
    return withTrack(
      doc,
      loc.trackIndex,
      reconcileTransitions(loc.track, { ...loc.track, clips }),
    )
  }

  let sourceTimeMap: SourceTimeMap
  try {
    sourceTimeMap = clipSourceTimeMap(loc.clip)
  } catch {
    return reject(doc, op, 'source range must stay within safe integer frames')
  }
  const sourceStartTicks = sourceTimeMap.sourceStartTicks
    + deltaFrames * SOURCE_TIME_TICKS_PER_FRAME
  if (!Number.isSafeInteger(sourceStartTicks) || sourceStartTicks < 0) {
    return reject(doc, op, 'no source material before the asset start')
  }
  const newSourceTimeMap = { ...sourceTimeMap, sourceStartTicks }
  const animation = shiftClipAnimationSourceTimeIntent(
    clipAnimation(loc.clip),
    sourceTimeMap,
    sourceStartTicks - sourceTimeMap.sourceStartTicks,
  )
  if (!animation) {
    return reject(doc, op, 'slip would exceed keyframe source-time bounds')
  }
  let sourceRange: TimeRange
  try {
    sourceRange = sourceRangeForMap(
      newSourceTimeMap,
      loc.clip.timelineRange.durationFrames,
    )
  } catch {
    return reject(doc, op, 'source range must stay within safe integer frames')
  }

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    sourceRange,
    sourceTimeMap: newSourceTimeMap,
    animation,
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
    const leftIsText = left.text !== undefined
    const leftSourceTimeMap = leftIsText || left.sourceMode === 'still'
      ? defaultSourceTimeMap(0, left.sourceMode === 'still' ? 1 : newDur)
      : sourceTimeMapForTimelineDuration(clipSourceTimeMap(left), newDur)
    clips[clipIndex - 1] = withClampedAudioFades({
      ...left,
      timelineRange: { ...left.timelineRange, durationFrames: newDur },
      sourceRange: left.sourceMode === 'still'
        ? left.sourceRange
        : leftIsText
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(leftSourceTimeMap, newDur),
      sourceTimeMap: leftSourceTimeMap,
    })
  }
  if (right && right.timelineRange.startFrame === rangeEnd(tl)) {
    // Touching right neighbor: its head follows our tail.
    const newDur = right.timelineRange.durationFrames - deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'right neighbor cannot shrink below 1 frame')
    }
    const rightIsStill = right.sourceMode === 'still'
    const rightIsText = right.text !== undefined
    const rightSourceTimeMap = rightIsStill || rightIsText
      ? defaultSourceTimeMap(0, rightIsStill ? 1 : newDur)
      : sourceTimeMapAtOffset(clipSourceTimeMap(right), deltaFrames)
    if (!rightIsStill && !rightIsText && rightSourceTimeMap.sourceStartTicks < 0) {
      return reject(doc, op, 'right neighbor has no source material before the asset start')
    }
    const rightAnimation = shiftClipAnimation(clipAnimation(right), -deltaFrames)
    if (!rightAnimation) {
      return reject(doc, op, 'slide would exceed right-neighbor keyframe frame bounds')
    }
    clips[clipIndex + 1] = withClampedAudioFades({
      ...right,
      timelineRange: {
        startFrame: right.timelineRange.startFrame + deltaFrames,
        durationFrames: newDur,
      },
      sourceRange: rightIsStill
        ? right.sourceRange
        : rightIsText
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(rightSourceTimeMap, newDur),
      sourceTimeMap: rightSourceTimeMap,
      animation: rightAnimation,
    })
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
  if (clipsOverlapAdjustments(clips, track.adjustments)) {
    return reject(doc, op, 'slide would overlap another clip')
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
  const textSource = clip.text !== undefined
  const sourceTimeMap = clipSourceTimeMap(clip)

  let newClip: Clip
  let shiftBy: number
  if (edge === 'start') {
    const newDur = tl.durationFrames - deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    const newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newDur)
      : sourceTimeMapAtOffset(sourceTimeMap, deltaFrames)
    if (!stillSource && !textSource && newSourceTimeMap.sourceStartTicks < 0) {
      return reject(doc, op, 'no source material before the asset start')
    }
    newClip = withClampedAudioFades({
      ...clip,
      timelineRange: { startFrame: tl.startFrame, durationFrames: newDur },
      sourceRange: stillSource
        ? src
        : textSource
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(newSourceTimeMap, newDur),
      sourceTimeMap: newSourceTimeMap,
    })
    shiftBy = -deltaFrames
  } else {
    const newDur = tl.durationFrames + deltaFrames
    if (newDur < 1) {
      return reject(doc, op, 'clip duration cannot shrink below 1 frame')
    }
    const newSourceTimeMap = stillSource || textSource
      ? defaultSourceTimeMap(0, stillSource ? 1 : newDur)
      : sourceTimeMapForTimelineDuration(sourceTimeMap, newDur)
    newClip = withClampedAudioFades({
      ...clip,
      timelineRange: { startFrame: tl.startFrame, durationFrames: newDur },
      sourceRange: stillSource
        ? src
        : textSource
          ? { startFrame: 0, durationFrames: newDur }
        : sourceRangeForMap(newSourceTimeMap, newDur),
      sourceTimeMap: newSourceTimeMap,
    })
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
  const adjustments = shiftLaterAdjustments(loc.track.adjustments, oldEnd, shiftBy)
  if (adjustments === null) {
    return reject(doc, op, 'ripple would move an adjustment outside safe timeline bounds')
  }
  if (clipsOverlapAdjustments(clips, adjustments)) {
    return reject(doc, op, 'ripple would overlap an adjustment on the track')
  }

  const nextTrack = reconcileTransitions(loc.track, {
    ...loc.track,
    clips,
    ...(adjustments === undefined ? {} : { adjustments }),
  })
  return withTrack(doc, loc.trackIndex, nextTrack)
}
