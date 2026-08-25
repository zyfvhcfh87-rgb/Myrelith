/**
 * Browser-free three-point and sequence-edit planner.
 *
 * One command resolves one immutable plan. Apply (threePointApply.ts) turns
 * an accepted plan into at most one TimelineDoc mutation. Rejected plans
 * never guess: four-point duration mismatches, incomplete lift/extract
 * ranges, and locked/out-of-bounds participants fail closed.
 *
 * Duration rule
 * -------------
 * Source In/Out live on the Source Monitor clock (native video rate, or
 * the 30/1 fallback). Timeline In/Out and the playhead live on the
 * document clock. Mapped source ranges use integer microseconds so a
 * 60 fps source in a 30 fps project stays the same duration.
 *
 * Marks are independent. Unset source In defaults to 0; unset source Out
 * defaults to the source end — but those defaults do not count as
 * explicit marks.
 *
 * 1. Source-driven (default): the mapped source range supplies duration.
 *    Timeline start is Timeline In, else playhead, else Timeline Out minus
 *    duration when only Timeline Out is set.
 * 2. Timeline-driven: both timeline marks are set and the source does not
 *    have both In and Out. Duration is the timeline range. Source start is
 *    Source In (or 0), or Source Out minus duration.
 * 3. Four-point: all four marks are explicit. Durations must match exactly
 *    after mapping. A mismatch is rejected — never retimed to fit.
 *
 * Lift/extract ignore source marks and require both timeline marks.
 * Replace keeps the target clip's timeline duration and refuses a marked
 * source range of a different length.
 * Roll moves a touching seam by a signed frame delta without changing
 * sequence duration.
 */

import { compatibilityAllowsTimelineUse } from './mediaCompatibility'
import type { MediaCompatibilityItem } from './mediaCompatibility'
import { trackKindAcceptsAssetKind } from './mediaPlacement'
import type { SourceMonitorSession } from './sourceMonitor'
import type {
  AssetId,
  ClipId,
  FrameRate,
  MediaAsset,
  TimeRange,
  TimelineDoc,
  TrackId,
} from './schema'
import { findClip, trackOfClip } from './selectors'
import {
  framesToMicroseconds,
  microsecondsDurationToFrames,
  microsecondsToFrames,
  rangeEnd,
  rateEquals,
} from './time'
import { applySequenceEdit as applyAcceptedSequenceEdit } from './threePointApply'

export type SequenceEditKind =
  | 'insert'
  | 'overwrite'
  | 'lift'
  | 'extract'
  | 'replace'
  | 'roll'

export type ThreePointDurationRule =
  | 'source-driven'
  | 'timeline-driven'
  | 'four-point-match'

export type SequenceEditRejection =
  | 'missing-source'
  | 'offline'
  | 'incompatible'
  | 'invalid-duration'
  | 'empty-range'
  | 'duration-mismatch'
  | 'ambiguous-marks'
  | 'timeline-range-incomplete'
  | 'timeline-start-negative'
  | 'source-range-out-of-bounds'
  | 'missing-video-target'
  | 'missing-audio-target'
  | 'no-patch'
  | 'missing-track'
  | 'locked-track'
  | 'wrong-kind'
  | 'replace-target-missing'
  | 'replace-text-clip'
  | 'roll-seam-invalid'
  | 'roll-delta-invalid'
  | 'insufficient-source-handle'
  | 'linked-participant-locked'

export const SEQUENCE_EDIT_REJECTION_MESSAGES: Readonly<
  Record<SequenceEditRejection, string>
> = Object.freeze({
  'missing-source': 'Open a source in the Source Monitor first.',
  offline: 'This source is offline. Relink it before editing.',
  incompatible: 'This source is not usable on the timeline.',
  'invalid-duration': 'This source has no usable duration.',
  'empty-range': 'The marked range is empty after mapping to the project rate.',
  'duration-mismatch':
    'Source and timeline ranges have different durations. Mark three points, or make the four-point durations match. Replace never retimes to fit.',
  'ambiguous-marks': 'This In/Out combination is ambiguous, so the edit was not guessed.',
  'timeline-range-incomplete': 'Mark both timeline In and Out first.',
  'timeline-start-negative': 'This edit would start before frame 0.',
  'source-range-out-of-bounds': 'The source range is outside this media.',
  'missing-video-target': 'Target a video track first.',
  'missing-audio-target': 'Target an audio track first.',
  'no-patch': 'Enable the video or audio source patch first.',
  'missing-track': 'The targeted track is no longer in this project.',
  'locked-track': 'Unlock the targeted track first.',
  'wrong-kind': 'That track cannot hold this source.',
  'replace-target-missing':
    'Select a clip, or park the playhead on a clip on a targeted track.',
  'replace-text-clip': 'Text clips cannot be replaced from the Source Monitor.',
  'roll-seam-invalid':
    'Park the playhead on a touching clip seam on a targeted track.',
  'roll-delta-invalid': 'A roll edit needs a non-zero integer frame delta.',
  'insufficient-source-handle':
    'The roll needs more source handle than this media has.',
  'linked-participant-locked':
    'A linked partner sits on a locked track, so the whole edit was rejected.',
})

export function sequenceEditRejectionMessage(
  reason: SequenceEditRejection,
): string {
  return SEQUENCE_EDIT_REJECTION_MESSAGES[reason]
}

export interface SequencePlacement {
  readonly trackId: TrackId
  readonly role: 'video' | 'audio'
}

export interface SequenceInsertOverwritePlan {
  readonly status: 'ok'
  readonly kind: 'insert' | 'overwrite'
  readonly assetId: AssetId
  readonly timelineRange: TimeRange
  readonly sourceRange: TimeRange
  readonly durationRule: ThreePointDurationRule
  readonly still: boolean
  readonly placements: readonly SequencePlacement[]
  readonly linkPlacements: boolean
}

export interface SequenceLiftExtractPlan {
  readonly status: 'ok'
  readonly kind: 'lift' | 'extract'
  readonly timelineRange: TimeRange
  readonly trackIds: readonly TrackId[]
}

export interface SequenceReplacePlan {
  readonly status: 'ok'
  readonly kind: 'replace'
  readonly assetId: AssetId
  readonly sourceRange: TimeRange
  readonly still: boolean
  readonly clipIds: readonly ClipId[]
  readonly unlinkSurvivors: boolean
}

export interface SequenceRollPlan {
  readonly status: 'ok'
  readonly kind: 'roll'
  readonly pairs: readonly (readonly [ClipId, ClipId])[]
  readonly deltaFrames: number
}

export type SequenceEditAcceptedPlan =
  | SequenceInsertOverwritePlan
  | SequenceLiftExtractPlan
  | SequenceReplacePlan
  | SequenceRollPlan

export type SequenceEditPlan =
  | { readonly status: 'reject'; readonly reason: SequenceEditRejection }
  | SequenceEditAcceptedPlan

export interface SequenceEditInput {
  readonly kind: SequenceEditKind
  readonly doc: TimelineDoc
  readonly asset: MediaAsset | null
  readonly compatibility?: MediaCompatibilityItem
  readonly sourceSession: SourceMonitorSession | null
  readonly playheadFrame: number
  readonly timelineInFrame: number | null
  readonly timelineOutExclusive: number | null
  readonly videoTargetTrackId: TrackId | null
  readonly audioTargetTrackId: TrackId | null
  readonly patchVideo: boolean
  readonly patchAudio: boolean
  readonly selectedClipId: ClipId | null
  readonly rollDeltaFrames?: number
}

export interface TrackTargets {
  readonly videoTrackId: TrackId | null
  readonly audioTrackId: TrackId | null
}

export interface SourcePatch {
  readonly video: boolean
  readonly audio: boolean
}

export interface ThreePointDurationInput {
  readonly sourceInFrame: number | null
  readonly sourceOutExclusive: number | null
  readonly sourceDurationFrames: number
  readonly sourceRate: FrameRate
  readonly documentRate: FrameRate
  readonly assetDurationFrames: number
  readonly timelineInFrame: number | null
  readonly timelineOutExclusive: number | null
  readonly playheadFrame: number
}

export type ThreePointDurationResult =
  | {
      readonly status: 'ok'
      readonly rule: ThreePointDurationRule
      readonly timelineRange: TimeRange
      readonly sourceRange: TimeRange
    }
  | { readonly status: 'reject'; readonly reason: SequenceEditRejection }

function rejectPlan(reason: SequenceEditRejection): SequenceEditPlan {
  return { status: 'reject', reason }
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function firstUnlockedTrackId(
  doc: TimelineDoc,
  kind: 'video' | 'audio',
): TrackId | null {
  const track = doc.tracks.find((candidate) => (
    candidate.kind === kind && !candidate.locked
  ))
  return track?.id ?? null
}

/** First unlocked video and audio lanes, used to seed session targeting. */
export function defaultTrackTargets(doc: TimelineDoc): TrackTargets {
  return {
    videoTrackId: firstUnlockedTrackId(doc, 'video'),
    audioTrackId: firstUnlockedTrackId(doc, 'audio'),
  }
}

/**
 * Drop stale/wrong-kind/locked ids. `null` stays none — it is not refilled
 * with a default, so an explicit detarget remains a detarget.
 */
export function reconcileTrackTargets(
  doc: TimelineDoc,
  current: TrackTargets,
): TrackTargets {
  return {
    videoTrackId: usableTarget(doc, current.videoTrackId, 'video'),
    audioTrackId: usableTarget(doc, current.audioTrackId, 'audio'),
  }
}

function usableTarget(
  doc: TimelineDoc,
  trackId: TrackId | null,
  kind: 'video' | 'audio',
): TrackId | null {
  if (trackId === null) return null
  const track = doc.tracks.find((candidate) => candidate.id === trackId)
  if (!track || track.kind !== kind || track.locked) return null
  return track.id
}

export function defaultSourcePatch(asset: Pick<MediaAsset, 'kind' | 'hasAudio'>): SourcePatch {
  return {
    video: asset.kind === 'video' || asset.kind === 'image',
    audio: asset.hasAudio,
  }
}

export function mapSourceClockToDocumentFrame(
  frame: number,
  sourceRate: FrameRate,
  documentRate: FrameRate,
): number {
  if (rateEquals(sourceRate, documentRate)) return frame
  return microsecondsToFrames(
    framesToMicroseconds(frame, sourceRate),
    documentRate,
  )
}

export function mapSourceClockRangeToDocument(input: {
  readonly startFrame: number
  readonly exclusiveEndFrame: number
  readonly sourceDurationFrames: number
  readonly sourceRate: FrameRate
  readonly documentRate: FrameRate
  readonly assetDurationFrames: number
}): TimeRange | null {
  const {
    startFrame,
    exclusiveEndFrame,
    sourceDurationFrames,
    sourceRate,
    documentRate,
    assetDurationFrames,
  } = input
  if (
    !isNonNegativeSafeInteger(startFrame)
    || !isPositiveSafeInteger(exclusiveEndFrame)
    || exclusiveEndFrame <= startFrame
    || exclusiveEndFrame > sourceDurationFrames
    || startFrame >= sourceDurationFrames
  ) return null

  if (startFrame === 0 && exclusiveEndFrame === sourceDurationFrames) {
    if (!isPositiveSafeInteger(assetDurationFrames)) return null
    return { startFrame: 0, durationFrames: assetDurationFrames }
  }

  const start = mapSourceClockToDocumentFrame(startFrame, sourceRate, documentRate)
  const mappedEnd = mapSourceClockToDocumentFrame(
    exclusiveEndFrame,
    sourceRate,
    documentRate,
  )
  let duration = mappedEnd - start
  if (duration < 1) {
    const startUs = framesToMicroseconds(startFrame, sourceRate)
    const endUs = framesToMicroseconds(exclusiveEndFrame, sourceRate)
    const durationUs = endUs - startUs
    if (durationUs <= 0) return null
    duration = microsecondsDurationToFrames(durationUs, documentRate)
  }
  if (!isPositiveSafeInteger(duration)) return null
  return { startFrame: start, durationFrames: duration }
}

function resolvedSourceClockRange(
  sourceInFrame: number | null,
  sourceOutExclusive: number | null,
  sourceDurationFrames: number,
): TimeRange | null {
  const start = sourceInFrame ?? 0
  const exclusiveEnd = sourceOutExclusive ?? sourceDurationFrames
  if (
    !isNonNegativeSafeInteger(start)
    || !isPositiveSafeInteger(exclusiveEnd)
    || exclusiveEnd <= start
  ) return null
  return { startFrame: start, durationFrames: exclusiveEnd - start }
}

/**
 * Resolve the three-point duration rule. Lift/extract do not use this —
 * they require an explicit timeline range of their own.
 */
export function resolveThreePointDuration(
  input: ThreePointDurationInput,
): ThreePointDurationResult {
  if (!isPositiveSafeInteger(input.sourceDurationFrames)) {
    return { status: 'reject', reason: 'invalid-duration' }
  }
  if (!isPositiveSafeInteger(input.assetDurationFrames)) {
    return { status: 'reject', reason: 'invalid-duration' }
  }
  if (!isNonNegativeSafeInteger(input.playheadFrame)) {
    return { status: 'reject', reason: 'timeline-start-negative' }
  }

  const sourceExplicitIn = input.sourceInFrame !== null
  const sourceExplicitOut = input.sourceOutExclusive !== null
  const sourceExplicitBoth = sourceExplicitIn && sourceExplicitOut
  const timelineIn = input.timelineInFrame
  const timelineOut = input.timelineOutExclusive
  const timelineExplicitBoth = timelineIn !== null && timelineOut !== null

  const clockRange = resolvedSourceClockRange(
    input.sourceInFrame,
    input.sourceOutExclusive,
    input.sourceDurationFrames,
  )
  if (!clockRange) return { status: 'reject', reason: 'empty-range' }

  const mappedSource = mapSourceClockRangeToDocument({
    startFrame: clockRange.startFrame,
    exclusiveEndFrame: rangeEnd(clockRange),
    sourceDurationFrames: input.sourceDurationFrames,
    sourceRate: input.sourceRate,
    documentRate: input.documentRate,
    assetDurationFrames: input.assetDurationFrames,
  })
  if (!mappedSource) return { status: 'reject', reason: 'empty-range' }

  if (timelineExplicitBoth && sourceExplicitBoth) {
    const timelineDuration = timelineOut - timelineIn
    if (!isPositiveSafeInteger(timelineDuration)) {
      return { status: 'reject', reason: 'empty-range' }
    }
    if (timelineIn < 0) {
      return { status: 'reject', reason: 'timeline-start-negative' }
    }
    if (timelineDuration !== mappedSource.durationFrames) {
      return { status: 'reject', reason: 'duration-mismatch' }
    }
    return {
      status: 'ok',
      rule: 'four-point-match',
      timelineRange: { startFrame: timelineIn, durationFrames: timelineDuration },
      sourceRange: mappedSource,
    }
  }

  if (timelineExplicitBoth) {
    const timelineDuration = timelineOut - timelineIn
    if (!isPositiveSafeInteger(timelineDuration)) {
      return { status: 'reject', reason: 'empty-range' }
    }
    if (timelineIn < 0) {
      return { status: 'reject', reason: 'timeline-start-negative' }
    }
    let sourceStart = mappedSource.startFrame
    if (sourceExplicitOut && !sourceExplicitIn) {
      sourceStart = rangeEnd(mappedSource) - timelineDuration
    }
    if (sourceStart < 0) {
      return { status: 'reject', reason: 'source-range-out-of-bounds' }
    }
    if (sourceStart + timelineDuration > input.assetDurationFrames) {
      return { status: 'reject', reason: 'source-range-out-of-bounds' }
    }
    return {
      status: 'ok',
      rule: 'timeline-driven',
      timelineRange: { startFrame: timelineIn, durationFrames: timelineDuration },
      sourceRange: { startFrame: sourceStart, durationFrames: timelineDuration },
    }
  }

  const duration = mappedSource.durationFrames
  let start: number
  if (timelineIn !== null) {
    start = timelineIn
  } else if (timelineOut !== null) {
    start = timelineOut - duration
  } else {
    start = input.playheadFrame
  }
  if (!Number.isSafeInteger(start) || start < 0) {
    return { status: 'reject', reason: 'timeline-start-negative' }
  }
  if (mappedSource.startFrame + duration > input.assetDurationFrames) {
    return { status: 'reject', reason: 'source-range-out-of-bounds' }
  }
  return {
    status: 'ok',
    rule: 'source-driven',
    timelineRange: { startFrame: start, durationFrames: duration },
    sourceRange: mappedSource,
  }
}

function resolvedTimelineRange(
  timelineInFrame: number | null,
  timelineOutExclusive: number | null,
): TimeRange | null {
  if (timelineInFrame === null || timelineOutExclusive === null) return null
  if (
    !isNonNegativeSafeInteger(timelineInFrame)
    || !isPositiveSafeInteger(timelineOutExclusive)
    || timelineOutExclusive <= timelineInFrame
  ) return null
  return {
    startFrame: timelineInFrame,
    durationFrames: timelineOutExclusive - timelineInFrame,
  }
}

function sourceReady(
  asset: MediaAsset | null,
  compatibility: MediaCompatibilityItem | undefined,
  session: SourceMonitorSession | null,
): SequenceEditRejection | null {
  if (session === null) return 'missing-source'
  if (!compatibilityAllowsTimelineUse(compatibility)) return 'incompatible'
  if (asset === null) return 'offline'
  if (!isPositiveSafeInteger(asset.durationMicroseconds)) return 'invalid-duration'
  if (!isPositiveSafeInteger(asset.durationFrames)) return 'invalid-duration'
  if (session.source.assetId !== asset.id) return 'offline'
  return null
}

function validateTarget(
  doc: TimelineDoc,
  trackId: TrackId,
  role: 'video' | 'audio',
): SequenceEditRejection | null {
  const track = doc.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return 'missing-track'
  if (track.kind !== role) return 'wrong-kind'
  if (track.locked) return 'locked-track'
  return null
}

function planInsertOrOverwrite(input: SequenceEditInput): SequenceEditPlan {
  const sourceError = sourceReady(
    input.asset,
    input.compatibility,
    input.sourceSession,
  )
  if (sourceError) return rejectPlan(sourceError)
  const asset = input.asset!
  const session = input.sourceSession
  if (!input.patchVideo && !input.patchAudio) return rejectPlan('no-patch')

  const wantsVideo = input.patchVideo && (
    asset.kind === 'video' || asset.kind === 'image'
  )
  const wantsAudio = input.patchAudio && asset.hasAudio
  if (!wantsVideo && !wantsAudio) return rejectPlan('no-patch')

  const placements: SequencePlacement[] = []
  if (wantsVideo) {
    if (input.videoTargetTrackId === null) return rejectPlan('missing-video-target')
    const targetError = validateTarget(input.doc, input.videoTargetTrackId, 'video')
    if (targetError) return rejectPlan(targetError)
    if (!trackKindAcceptsAssetKind('video', asset.kind)) return rejectPlan('wrong-kind')
    placements.push({ trackId: input.videoTargetTrackId, role: 'video' })
  }
  if (wantsAudio) {
    if (input.audioTargetTrackId === null) return rejectPlan('missing-audio-target')
    const targetError = validateTarget(input.doc, input.audioTargetTrackId, 'audio')
    if (targetError) return rejectPlan(targetError)
    placements.push({ trackId: input.audioTargetTrackId, role: 'audio' })
  }

  const duration = resolveThreePointDuration({
    sourceInFrame: session?.inFrame ?? null,
    sourceOutExclusive: session?.outFrameExclusive ?? null,
    sourceDurationFrames: session?.source.durationFrames ?? asset.durationFrames,
    sourceRate: session?.source.rate ?? input.doc.frameRate,
    documentRate: input.doc.frameRate,
    assetDurationFrames: asset.durationFrames,
    timelineInFrame: input.timelineInFrame,
    timelineOutExclusive: input.timelineOutExclusive,
    playheadFrame: input.playheadFrame,
  })
  if (duration.status === 'reject') return rejectPlan(duration.reason)

  return {
    status: 'ok',
    kind: input.kind === 'overwrite' ? 'overwrite' : 'insert',
    assetId: asset.id,
    timelineRange: duration.timelineRange,
    sourceRange: duration.sourceRange,
    durationRule: duration.rule,
    still: asset.kind === 'image',
    placements,
    linkPlacements: placements.length === 2,
  }
}

function planLiftOrExtract(input: SequenceEditInput): SequenceEditPlan {
  const range = resolvedTimelineRange(
    input.timelineInFrame,
    input.timelineOutExclusive,
  )
  if (!range) return rejectPlan('timeline-range-incomplete')

  const trackIds: TrackId[] = []
  if (input.videoTargetTrackId !== null) {
    const error = validateTarget(input.doc, input.videoTargetTrackId, 'video')
    if (error) return rejectPlan(error)
    trackIds.push(input.videoTargetTrackId)
  }
  if (input.audioTargetTrackId !== null) {
    const error = validateTarget(input.doc, input.audioTargetTrackId, 'audio')
    if (error) return rejectPlan(error)
    trackIds.push(input.audioTargetTrackId)
  }
  if (trackIds.length === 0) {
    return rejectPlan(
      input.kind === 'lift' || input.kind === 'extract'
        ? 'missing-video-target'
        : 'no-patch',
    )
  }

  for (const trackId of trackIds) {
    const track = input.doc.tracks.find((candidate) => candidate.id === trackId)
    if (!track) return rejectPlan('missing-track')
    for (const clip of track.clips) {
      if (!clip.linkGroupId) continue
      const partners = input.doc.tracks.flatMap((candidate) => (
        candidate.clips.filter((member) => (
          member.linkGroupId === clip.linkGroupId && member.id !== clip.id
        )).map((member) => ({
          clip: member,
          track: candidate,
        }))
      ))
      for (const partner of partners) {
        if (partner.track.locked) return rejectPlan('linked-participant-locked')
      }
    }
  }

  return {
    status: 'ok',
    kind: input.kind === 'extract' ? 'extract' : 'lift',
    timelineRange: range,
    trackIds,
  }
}

function replaceTargets(input: SequenceEditInput): ClipId[] | SequenceEditRejection {
  const selected = input.selectedClipId
    ? findClip(input.doc, input.selectedClipId)
    : null
  if (selected && input.selectedClipId) {
    const track = trackOfClip(input.doc, input.selectedClipId)
    if (!track) return 'replace-target-missing'
    if (track.locked) return 'locked-track'
    const targeted = (
      (track.kind === 'video' && track.id === input.videoTargetTrackId)
      || (track.kind === 'audio' && track.id === input.audioTargetTrackId)
    )
    if (!targeted) return 'replace-target-missing'
    if (selected.text !== undefined) return 'replace-text-clip'
    return [input.selectedClipId]
  }

  const targetedTracks = [input.videoTargetTrackId, input.audioTargetTrackId]
    .filter((trackId): trackId is TrackId => trackId !== null)
  for (const trackId of targetedTracks) {
    const track = input.doc.tracks.find((candidate) => candidate.id === trackId)
    if (!track || track.locked) continue
    const clip = track.clips.find((candidate) => (
      input.playheadFrame >= candidate.timelineRange.startFrame
      && input.playheadFrame < rangeEnd(candidate.timelineRange)
    ))
    if (clip) {
      if (clip.text !== undefined) return 'replace-text-clip'
      return [clip.id]
    }
  }
  return 'replace-target-missing'
}

function planReplace(input: SequenceEditInput): SequenceEditPlan {
  const sourceError = sourceReady(
    input.asset,
    input.compatibility,
    input.sourceSession,
  )
  if (sourceError) return rejectPlan(sourceError)
  const asset = input.asset!
  const session = input.sourceSession
  if (!input.patchVideo && !input.patchAudio) return rejectPlan('no-patch')

  const target = replaceTargets(input)
  if (!Array.isArray(target)) return rejectPlan(target)
  const primaryId = target[0]
  if (!primaryId) return rejectPlan('replace-target-missing')
  const primary = findClip(input.doc, primaryId)
  const primaryTrack = trackOfClip(input.doc, primaryId)
  if (!primary || !primaryTrack) return rejectPlan('replace-target-missing')
  if (!trackKindAcceptsAssetKind(primaryTrack.kind, asset.kind)
    && !(primaryTrack.kind === 'audio' && asset.hasAudio)
  ) {
    return rejectPlan('wrong-kind')
  }

  const duration = resolveThreePointDuration({
    sourceInFrame: session?.inFrame ?? null,
    sourceOutExclusive: session?.outFrameExclusive ?? null,
    sourceDurationFrames: session?.source.durationFrames ?? asset.durationFrames,
    sourceRate: session?.source.rate ?? input.doc.frameRate,
    documentRate: input.doc.frameRate,
    assetDurationFrames: asset.durationFrames,
    timelineInFrame: null,
    timelineOutExclusive: null,
    playheadFrame: primary.timelineRange.startFrame,
  })
  if (duration.status === 'reject') return rejectPlan(duration.reason)

  const clipDuration = primary.timelineRange.durationFrames
  const sourceExplicitBoth = session?.inFrame !== null
    && session?.outFrameExclusive !== null
  if (sourceExplicitBoth && duration.sourceRange.durationFrames !== clipDuration) {
    return rejectPlan('duration-mismatch')
  }
  const sourceStart = duration.sourceRange.startFrame
  if (asset.kind !== 'image' && sourceStart + clipDuration > asset.durationFrames) {
    return rejectPlan('source-range-out-of-bounds')
  }

  const clipIds = [primaryId]
  let unlinkSurvivors = false
  if (primary.linkGroupId && input.patchVideo && input.patchAudio && asset.hasAudio) {
    const partner = input.doc.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.linkGroupId === primary.linkGroupId && clip.id !== primaryId)
    if (partner) {
      const partnerTrack = trackOfClip(input.doc, partner.id)
      if (partnerTrack?.locked) return rejectPlan('linked-participant-locked')
      if (partner.timelineRange.durationFrames !== clipDuration) {
        return rejectPlan('duration-mismatch')
      }
      clipIds.push(partner.id)
    }
  } else if (primary.linkGroupId) {
    unlinkSurvivors = true
    const partner = input.doc.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.linkGroupId === primary.linkGroupId && clip.id !== primaryId)
    if (partner) {
      const partnerTrack = trackOfClip(input.doc, partner.id)
      if (partnerTrack?.locked) return rejectPlan('linked-participant-locked')
    }
  }

  return {
    status: 'ok',
    kind: 'replace',
    assetId: asset.id,
    sourceRange: {
      startFrame: sourceStart,
      durationFrames: clipDuration,
    },
    still: asset.kind === 'image',
    clipIds,
    unlinkSurvivors,
  }
}

function touchingNeighbor(
  doc: TimelineDoc,
  clipId: ClipId,
  playheadFrame: number,
): [ClipId, ClipId] | null {
  const track = trackOfClip(doc, clipId)
  const clip = findClip(doc, clipId)
  if (!track || !clip) return null
  const end = rangeEnd(clip.timelineRange)
  if (playheadFrame === clip.timelineRange.startFrame) {
    const left = track.clips.find((candidate) => rangeEnd(candidate.timelineRange) === playheadFrame)
    return left ? [left.id, clip.id] : null
  }
  if (playheadFrame === end) {
    const right = track.clips.find((candidate) => candidate.timelineRange.startFrame === playheadFrame)
    return right ? [clip.id, right.id] : null
  }
  return null
}

function planRoll(input: SequenceEditInput): SequenceEditPlan {
  const delta = input.rollDeltaFrames ?? 0
  if (!Number.isSafeInteger(delta) || delta === 0) {
    return rejectPlan('roll-delta-invalid')
  }

  const targeted = [input.videoTargetTrackId, input.audioTargetTrackId]
    .filter((trackId): trackId is TrackId => trackId !== null)
  if (targeted.length === 0) return rejectPlan('missing-video-target')

  let pair: [ClipId, ClipId] | null = null
  if (input.selectedClipId) {
    pair = touchingNeighbor(input.doc, input.selectedClipId, input.playheadFrame)
  }
  if (!pair) {
    for (const trackId of targeted) {
      const error = validateTarget(input.doc, trackId, (
        input.doc.tracks.find((track) => track.id === trackId)?.kind ?? 'video'
      ))
      if (error) return rejectPlan(error)
      const track = input.doc.tracks.find((candidate) => candidate.id === trackId)
      if (!track) continue
      for (let index = 0; index < track.clips.length - 1; index++) {
        const left = track.clips[index]!
        const right = track.clips[index + 1]!
        if (rangeEnd(left.timelineRange) === right.timelineRange.startFrame
          && rangeEnd(left.timelineRange) === input.playheadFrame
        ) {
          pair = [left.id, right.id]
          break
        }
      }
      if (pair) break
    }
  }
  if (!pair) return rejectPlan('roll-seam-invalid')

  const left = findClip(input.doc, pair[0])
  const right = findClip(input.doc, pair[1])
  const leftTrack = trackOfClip(input.doc, pair[0])
  const rightTrack = trackOfClip(input.doc, pair[1])
  if (!left || !right || !leftTrack || !rightTrack) return rejectPlan('roll-seam-invalid')
  if (leftTrack.locked || rightTrack.locked) return rejectPlan('locked-track')
  if (left.timelineRange.durationFrames + delta < 1
    || right.timelineRange.durationFrames - delta < 1
  ) {
    return rejectPlan('insufficient-source-handle')
  }

  const pairs: (readonly [ClipId, ClipId])[] = [pair]
  if (left.linkGroupId && right.linkGroupId) {
    const leftPartner = input.doc.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.linkGroupId === left.linkGroupId && clip.id !== left.id)
    const rightPartner = input.doc.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.linkGroupId === right.linkGroupId && clip.id !== right.id)
    if (leftPartner && rightPartner) {
      const partnerTrack = trackOfClip(input.doc, leftPartner.id)
      const otherTrack = trackOfClip(input.doc, rightPartner.id)
      if (partnerTrack?.locked || otherTrack?.locked) {
        return rejectPlan('linked-participant-locked')
      }
      if (rangeEnd(leftPartner.timelineRange) !== rightPartner.timelineRange.startFrame
        || rangeEnd(leftPartner.timelineRange) !== input.playheadFrame
      ) {
        return rejectPlan('roll-seam-invalid')
      }
      pairs.push([leftPartner.id, rightPartner.id])
    } else if (leftPartner || rightPartner) {
      return rejectPlan('roll-seam-invalid')
    }
  } else if (left.linkGroupId || right.linkGroupId) {
    return rejectPlan('roll-seam-invalid')
  }

  return {
    status: 'ok',
    kind: 'roll',
    pairs,
    deltaFrames: delta,
  }
}

/** Resolve one sequence-edit command to an immutable plan. */
export function planSequenceEdit(input: SequenceEditInput): SequenceEditPlan {
  switch (input.kind) {
    case 'insert':
    case 'overwrite':
      return planInsertOrOverwrite(input)
    case 'lift':
    case 'extract':
      return planLiftOrExtract(input)
    case 'replace':
      return planReplace(input)
    case 'roll':
      return planRoll(input)
  }
}

export function applySequenceEdit(
  doc: TimelineDoc,
  plan: SequenceEditPlan,
  asset: MediaAsset | null = null,
): TimelineDoc {
  if (plan.status === 'reject') return doc
  return applyAcceptedSequenceEdit(doc, plan, asset)
}
