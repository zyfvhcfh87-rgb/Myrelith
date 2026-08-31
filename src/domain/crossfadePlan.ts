/**
 * Canonical, browser-free crossfade planning.
 *
 * One resolver owns structural validity, exact source-handle capacity,
 * grouped visual requests, and linked-audio partner discovery. Preview,
 * playback, and export consume these plans instead of reconstructing overlap
 * rules independently.
 */

import type {
  AssetId,
  Clip,
  ClipId,
  FrameRate,
  MediaSourceBounds,
  TimelineDoc,
  Track,
  TrackId,
  Transition,
  TransitionAudioCurve,
  TransitionId,
} from './schema'
import { cloneMediaSourceBounds } from './sourceBounds'
import {
  microsecondsTimestampToFrameCeil,
  rangeEnd,
} from './time'
import {
  clipSourceTimeMap,
  sourceFrameAtTimelineFrame,
  sourceFrameAtTimelineOffset,
  sourceRangeForMap,
  sourceTicksAtTimelineOffset,
  sourceTimeAudioPolicy,
  sourceTimeMapValidationError,
  timelineFramesWithinMappedSourceTicks,
  SOURCE_TIME_TICKS_PER_FRAME,
} from './sourceTimeMap'

export type SourceBoundsCatalog = ReadonlyMap<AssetId, MediaSourceBounds>
export interface SourceBoundsCatalogEntry {
  id: AssetId
  sourceBounds: MediaSourceBounds
}
export type CrossfadeLegRole = 'from' | 'to'

/** Snapshot durable bounds so one planning run cannot observe later mutation. */
export function createSourceBoundsCatalog(
  entries: Iterable<SourceBoundsCatalogEntry>,
): SourceBoundsCatalog {
  return new Map(
    [...entries].map((entry) => [
      entry.id,
      cloneMediaSourceBounds(entry.sourceBounds),
    ]),
  )
}

export type CrossfadeInvalidReason =
  | 'track-not-found'
  | 'transition-not-found'
  | 'ambiguous-transition-id'
  | 'not-video-track'
  | 'invalid-duration'
  | 'endpoint-missing-or-ambiguous'
  | 'endpoints-not-ordered-adjacent'
  | 'text-endpoint'
  | 'invalid-source-range'
  | 'invalid-timeline-range'
  | 'clips-do-not-touch'
  | 'unsafe-window'
  | 'overlapping-transition'
  | 'seam-already-has-transition'

export type CrossfadeUnavailableReason =
  | 'source-catalog-missing'
  | 'source-stream-absent'
  | 'source-bounds-unknown'
  | 'source-boundary-unsafe'
  | 'duration-exceeds-video-capacity'

export type CrossfadeAudioUnavailableReason =
  | 'linked-audio-partner-missing'
  | 'linked-audio-partner-ambiguous'
  | 'linked-audio-partners-not-distinct'
  | 'linked-audio-partner-misaligned'
  | 'linked-audio-source-range-invalid'
  | 'audio-source-catalog-missing'
  | 'audio-source-stream-absent'
  | 'audio-source-bounds-unknown'
  | 'audio-source-boundary-unsafe'
  | 'retimed-audio-unsupported'
  | 'duration-exceeds-audio-capacity'

export interface CrossfadeVideoLeg {
  role: CrossfadeLegRole
  clip: Clip
  /** Timed source frame at the cut; stills always retain frame zero. */
  sourceFrameAtCut: number
}

export interface CrossfadeAudioLeg {
  role: CrossfadeLegRole
  trackId: TrackId
  clip: Clip
  sourceFrameAtCut: number
}

export type CrossfadeAudioPlan =
  | { status: 'disabled' }
  | {
      status: 'unavailable'
      reason: CrossfadeAudioUnavailableReason
      leg: CrossfadeLegRole | null
      maximumDurationFrames: number | null
    }
  | {
      status: 'available'
      curve: TransitionAudioCurve
      from: CrossfadeAudioLeg
      to: CrossfadeAudioLeg
      maximumDurationFrames: number
    }

export interface CrossfadePlan {
  trackId: TrackId
  transition: Transition
  cutFrame: number
  startFrame: number
  endFrame: number
  durationFrames: number
  maximumDurationFrames: number
  from: CrossfadeVideoLeg
  to: CrossfadeVideoLeg
  audio: CrossfadeAudioPlan
}

export type CrossfadePlanResolution =
  | { status: 'invalid'; reason: CrossfadeInvalidReason }
  | {
      status: 'unavailable'
      reason: CrossfadeUnavailableReason
      leg: CrossfadeLegRole | null
      maximumDurationFrames: number | null
    }
  | { status: 'available'; plan: CrossfadePlan }

export interface VideoFrameRequest {
  clip: Clip
  sourceFrame: number
  opacity: number
}

export interface CrossfadeFrameRequest extends VideoFrameRequest {
  role: CrossfadeLegRole
  weight: number
}

/** One isolated plus-group at one document frame. */
export interface CrossfadeFrameGroup {
  kind: 'crossfade'
  trackId: TrackId
  transitionId: TransitionId
  frame: number
  requests: readonly [CrossfadeFrameRequest, CrossfadeFrameRequest]
}

interface CrossfadeSeam {
  track: Track
  transition: Transition
  from: Clip
  to: Clip
  cutFrame: number
}

export interface CrossfadeGeometry {
  transition: Transition
  from: Clip
  to: Clip
  startFrame: number
  endFrame: number
  durationFrames: number
}

interface Capacities {
  left: number
  right: number
}

type CapacityResolution =
  | { status: 'available'; capacities: Capacities }
  | {
      status: 'unavailable'
      reason:
        | 'catalog-missing'
        | 'stream-absent'
        | 'bounds-unknown'
        | 'boundary-unsafe'
      leg: CrossfadeLegRole
    }

function validSourceRange(clip: Clip): boolean {
  const { startFrame, durationFrames } = clip.sourceRange
  if (clip.sourceMode === 'still') {
    return startFrame === 0 && durationFrames === 1
  }
  if (!(Number.isSafeInteger(startFrame)
    && startFrame >= 0
    && Number.isSafeInteger(durationFrames)
    && durationFrames >= 1
    && Number.isSafeInteger(startFrame + durationFrames))) return false
  if (clip.sourceTimeMap === undefined) return true
  const map = clipSourceTimeMap(clip)
  if (sourceTimeMapValidationError(map)) return false
  try {
    const envelope = sourceRangeForMap(map, clip.timelineRange.durationFrames)
    return envelope.startFrame === startFrame
      && envelope.durationFrames === durationFrames
  } catch {
    return false
  }
}

function validTimelineRange(clip: Clip): boolean {
  const { startFrame, durationFrames } = clip.timelineRange
  return Number.isSafeInteger(startFrame)
    && startFrame >= 0
    && Number.isSafeInteger(durationFrames)
    && durationFrames >= 1
    && Number.isSafeInteger(startFrame + durationFrames)
}

function resolveSeam(
  track: Track,
  transition: Transition,
): CrossfadeSeam | CrossfadeInvalidReason {
  if (track.kind !== 'video') return 'not-video-track'
  if (
    transition.type !== 'crossfade'
    || !Number.isSafeInteger(transition.durationFrames)
    || transition.durationFrames < 1
  ) return 'invalid-duration'

  let fromIndex = -1
  let toIndex = -1
  let fromCount = 0
  let toCount = 0
  for (let index = 0; index < track.clips.length; index++) {
    const clip = track.clips[index]
    if (clip.id === transition.fromClipId) {
      fromIndex = index
      fromCount += 1
    }
    if (clip.id === transition.toClipId) {
      toIndex = index
      toCount += 1
    }
  }
  if (fromCount !== 1 || toCount !== 1) {
    return 'endpoint-missing-or-ambiguous'
  }
  return finishResolvedSeam(
    track,
    transition,
    track.clips[fromIndex],
    fromIndex,
    track.clips[toIndex],
    toIndex,
  )
}

interface IndexedTrackClip {
  clip: Clip
  index: number
  count: number
}

type TrackClipIndex = ReadonlyMap<ClipId, IndexedTrackClip>

function finishResolvedSeam(
  track: Track,
  transition: Transition,
  from: Clip,
  fromIndex: number,
  to: Clip,
  toIndex: number,
): CrossfadeSeam | CrossfadeInvalidReason {
  if (toIndex !== fromIndex + 1 || fromIndex === toIndex) {
    return 'endpoints-not-ordered-adjacent'
  }
  if (from.text !== undefined || to.text !== undefined) return 'text-endpoint'
  if (!validSourceRange(from) || !validSourceRange(to)) {
    return 'invalid-source-range'
  }
  if (!validTimelineRange(from) || !validTimelineRange(to)) {
    return 'invalid-timeline-range'
  }
  const cutFrame = rangeEnd(from.timelineRange)
  if (cutFrame !== to.timelineRange.startFrame) return 'clips-do-not-touch'
  return { track, transition, from, to, cutFrame }
}

function createTrackClipIndex(track: Track): TrackClipIndex {
  const clips = new Map<ClipId, IndexedTrackClip>()
  for (let index = 0; index < track.clips.length; index++) {
    const clip = track.clips[index]
    const existing = clips.get(clip.id)
    if (existing) {
      existing.count += 1
    } else {
      clips.set(clip.id, { clip, index, count: 1 })
    }
  }
  return clips
}

/** Same seam contract as resolveSeam(), using one prebuilt per-track index. */
function resolveIndexedSeam(
  track: Track,
  transition: Transition,
  clips: TrackClipIndex,
): CrossfadeSeam | CrossfadeInvalidReason {
  if (track.kind !== 'video') return 'not-video-track'
  if (
    transition.type !== 'crossfade'
    || !Number.isSafeInteger(transition.durationFrames)
    || transition.durationFrames < 1
  ) return 'invalid-duration'

  const fromEntry = clips.get(transition.fromClipId)
  const toEntry = clips.get(transition.toClipId)
  if (
    !fromEntry
    || !toEntry
    || fromEntry.count !== 1
    || toEntry.count !== 1
  ) return 'endpoint-missing-or-ambiguous'
  return finishResolvedSeam(
    track,
    transition,
    fromEntry.clip,
    fromEntry.index,
    toEntry.clip,
    toEntry.index,
  )
}

function maximumDuration(capacities: Capacities): number {
  const left = Math.max(0, capacities.left)
  const right = Math.max(0, capacities.right)
  const even = 2 * Math.min(left, right)
  const odd = right >= 1 ? 2 * Math.min(left, right - 1) + 1 : 0
  return Math.max(even, odd)
}

function timelineCapacities(from: Clip, to: Clip): Capacities {
  return {
    left: from.timelineRange.durationFrames,
    right: to.timelineRange.durationFrames,
  }
}

/**
 * Timeline frames a clip can still grow at `edge` from real source handles.
 * Stills and text are unbounded. Missing/unknown bounds return null.
 */
export function sourceHandleHeadroomFrames(input: {
  readonly clip: Clip
  readonly edge: 'start' | 'end'
  readonly stream: 'video' | 'audio'
  readonly rate: FrameRate
  readonly catalog: SourceBoundsCatalog
}): number | null {
  const { clip, edge, stream, rate, catalog } = input
  if (clip.text !== undefined || clip.sourceMode === 'still') {
    return Number.POSITIVE_INFINITY
  }
  const role: CrossfadeLegRole = edge === 'end' ? 'from' : 'to'
  const resolved = sourceCapacities(clip, role, stream, rate, catalog)
  if (resolved.status === 'unavailable') return null
  return edge === 'end' ? resolved.capacities.right : resolved.capacities.left
}

function sourceCapacities(
  clip: Clip,
  role: CrossfadeLegRole,
  stream: 'video' | 'audio',
  rate: FrameRate,
  catalog: SourceBoundsCatalog,
): CapacityResolution {
  if (stream === 'video' && clip.sourceMode === 'still') {
    return {
      status: 'available',
      capacities: {
        left: Number.POSITIVE_INFINITY,
        right: Number.POSITIVE_INFINITY,
      },
    }
  }

  const assetBounds = catalog.get(clip.assetId)
  if (!assetBounds) {
    return { status: 'unavailable', reason: 'catalog-missing', leg: role }
  }
  const streamBounds = assetBounds[stream]
  if (streamBounds === null) {
    return { status: 'unavailable', reason: 'stream-absent', leg: role }
  }
  if (streamBounds.status === 'unknown') {
    return { status: 'unavailable', reason: 'bounds-unknown', leg: role }
  }

  try {
    const firstUs = Math.max(0, streamBounds.firstTimestampUs)
    const firstFrame = microsecondsTimestampToFrameCeil(firstUs, rate)
    const endFrame = microsecondsTimestampToFrameCeil(
      streamBounds.endTimestampUs,
      rate,
    )
    const map = clipSourceTimeMap(clip)
    const cutOffset = role === 'from' ? clip.timelineRange.durationFrames : 0
    const sourceTicksAtCut = sourceTicksAtTimelineOffset(
      map,
      cutOffset,
    )
    const firstTicks = firstFrame * SOURCE_TIME_TICKS_PER_FRAME
    const endTicks = endFrame * SOURCE_TIME_TICKS_PER_FRAME
    if (
      !Number.isSafeInteger(sourceTicksAtCut)
      || !Number.isSafeInteger(firstTicks)
      || !Number.isSafeInteger(endTicks)
      || sourceTicksAtCut < firstTicks
      || sourceTicksAtCut > endTicks
    ) {
      return { status: 'unavailable', reason: 'boundary-unsafe', leg: role }
    }
    return {
      status: 'available',
      capacities: {
        left: timelineFramesWithinMappedSourceTicks(
          map,
          cutOffset,
          sourceTicksAtCut - firstTicks,
          -1,
        ),
        right: timelineFramesWithinMappedSourceTicks(
          map,
          cutOffset,
          endTicks - sourceTicksAtCut,
          1,
        ),
      },
    }
  } catch {
    return { status: 'unavailable', reason: 'boundary-unsafe', leg: role }
  }
}

function pairCapacities(
  from: Clip,
  to: Clip,
  stream: 'video' | 'audio',
  rate: FrameRate,
  catalog: SourceBoundsCatalog,
): CapacityResolution {
  const fromSource = sourceCapacities(from, 'from', stream, rate, catalog)
  if (fromSource.status === 'unavailable') return fromSource
  const toSource = sourceCapacities(to, 'to', stream, rate, catalog)
  if (toSource.status === 'unavailable') return toSource
  const timeline = timelineCapacities(from, to)
  return {
    status: 'available',
    capacities: {
      left: Math.min(
        timeline.left,
        fromSource.capacities.left,
        toSource.capacities.left,
      ),
      right: Math.min(
        timeline.right,
        fromSource.capacities.right,
        toSource.capacities.right,
      ),
    },
  }
}

function transitionWindow(
  seam: CrossfadeSeam,
): { startFrame: number; endFrame: number } | null {
  const startFrame = seam.cutFrame
    - Math.floor(seam.transition.durationFrames / 2)
  const endFrame = startFrame + seam.transition.durationFrames
  return Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame)
    ? { startFrame, endFrame }
    : null
}

/** Geometry-only adapter retained for edit reconciliation and hard-cut fallback. */
export function resolveCrossfadeGeometry(
  track: Track,
  transition: Transition,
): CrossfadeGeometry | null {
  const seam = resolveSeam(track, transition)
  if (typeof seam === 'string') return null
  if (
    transition.durationFrames
    > maximumDuration(timelineCapacities(seam.from, seam.to))
  ) return null
  const window = transitionWindow(seam)
  if (!window) return null
  return {
    transition,
    from: seam.from,
    to: seam.to,
    startFrame: window.startFrame,
    endFrame: window.endFrame,
    durationFrames: transition.durationFrames,
  }
}

function windowsOverlap(
  left: { startFrame: number; endFrame: number },
  right: { startFrame: number; endFrame: number },
): boolean {
  return left.startFrame < right.endFrame && right.startFrame < left.endFrame
}

function overlapsAnotherTransition(
  seam: CrossfadeSeam,
  window: { startFrame: number; endFrame: number },
): boolean {
  const idCounts = new Map<TransitionId, number>()
  for (const transition of seam.track.transitions) {
    idCounts.set(transition.id, (idCounts.get(transition.id) ?? 0) + 1)
  }
  for (const transition of seam.track.transitions) {
    if (transition === seam.transition || idCounts.get(transition.id) !== 1) {
      continue
    }
    const other = resolveSeam(seam.track, transition)
    if (typeof other === 'string') continue
    const otherTimelineMaximum = maximumDuration(
      timelineCapacities(other.from, other.to),
    )
    if (transition.durationFrames > otherTimelineMaximum) continue
    const otherWindow = transitionWindow(other)
    if (otherWindow && windowsOverlap(window, otherWindow)) return true
  }
  return false
}

interface CrossfadeAudioPartner {
  clip: Clip
  track: Track
}

type CrossfadeAudioPartnerIndex = ReadonlyMap<
  string,
  readonly CrossfadeAudioPartner[]
>

type CrossfadeAudioStructure =
  | { status: 'disabled' }
  | {
      status: 'unavailable'
      reason: CrossfadeAudioUnavailableReason
      leg: CrossfadeLegRole | null
      maximumDurationFrames: number | null
    }
  | {
      status: 'available'
      curve: TransitionAudioCurve
      from: CrossfadeAudioPartner
      to: CrossfadeAudioPartner
      maximumDurationFrames: number
    }

function audioPartner(
  partners: CrossfadeAudioPartnerIndex,
  clip: Clip,
  role: CrossfadeLegRole,
):
  | ({ status: 'available' } & CrossfadeAudioPartner)
  | {
      status: 'unavailable'
      reason: 'linked-audio-partner-missing' | 'linked-audio-partner-ambiguous'
      leg: CrossfadeLegRole
    } {
  if (!clip.linkGroupId) {
    return {
      status: 'unavailable',
      reason: 'linked-audio-partner-missing',
      leg: role,
    }
  }
  let match: CrossfadeAudioPartner | null = null
  for (const candidate of partners.get(clip.linkGroupId) ?? []) {
    if (candidate.clip.id === clip.id) continue
    if (match !== null) {
      return {
        status: 'unavailable',
        reason: 'linked-audio-partner-ambiguous',
        leg: role,
      }
    }
    match = candidate
  }
  if (match === null) {
    return {
      status: 'unavailable',
      reason: 'linked-audio-partner-missing',
      leg: role,
    }
  }
  return { status: 'available', ...match }
}

function createCrossfadeAudioPartnerIndex(
  doc: TimelineDoc,
): CrossfadeAudioPartnerIndex {
  const partners = new Map<string, CrossfadeAudioPartner[]>()
  for (const track of doc.tracks) {
    if (track.kind !== 'audio') continue
    for (const clip of track.clips) {
      if (clip.linkGroupId === undefined) continue
      const entries = partners.get(clip.linkGroupId) ?? []
      entries.push({ clip, track })
      partners.set(clip.linkGroupId, entries)
    }
  }
  return partners
}

function crossfadeAudioStructure(
  seam: CrossfadeSeam,
  partners: CrossfadeAudioPartnerIndex,
): CrossfadeAudioStructure {
  if (!seam.transition.audio.enabled) return { status: 'disabled' }
  const fromPartner = audioPartner(partners, seam.from, 'from')
  if (fromPartner.status === 'unavailable') {
    return { ...fromPartner, maximumDurationFrames: null }
  }
  const toPartner = audioPartner(partners, seam.to, 'to')
  if (toPartner.status === 'unavailable') {
    return { ...toPartner, maximumDurationFrames: null }
  }
  if (fromPartner.clip.id === toPartner.clip.id) {
    return {
      status: 'unavailable',
      reason: 'linked-audio-partners-not-distinct',
      leg: null,
      maximumDurationFrames: null,
    }
  }
  if (
    rangeEnd(fromPartner.clip.timelineRange) !== seam.cutFrame
    || toPartner.clip.timelineRange.startFrame !== seam.cutFrame
  ) {
    return {
      status: 'unavailable',
      reason: 'linked-audio-partner-misaligned',
      leg: null,
      maximumDurationFrames: null,
    }
  }
  const fromPolicy = sourceTimeAudioPolicy(fromPartner.clip)
  const toPolicy = sourceTimeAudioPolicy(toPartner.clip)
  if (
    fromPolicy.status === 'muted'
    || toPolicy.status === 'muted'
  ) {
    return {
      status: 'unavailable',
      reason: 'retimed-audio-unsupported',
      leg: null,
      maximumDurationFrames: null,
    }
  }
  if (
    fromPartner.clip.sourceMode !== 'timed'
    || toPartner.clip.sourceMode !== 'timed'
    || fromPartner.clip.text !== undefined
    || toPartner.clip.text !== undefined
    || !validSourceRange(fromPartner.clip)
    || !validSourceRange(toPartner.clip)
    || !validTimelineRange(fromPartner.clip)
    || !validTimelineRange(toPartner.clip)
  ) {
    return {
      status: 'unavailable',
      reason: 'linked-audio-source-range-invalid',
      leg: null,
      maximumDurationFrames: null,
    }
  }

  const audioTimelineMaximum = maximumDuration(
    timelineCapacities(fromPartner.clip, toPartner.clip),
  )
  if (seam.transition.durationFrames > audioTimelineMaximum) {
    return {
      status: 'unavailable',
      reason: 'duration-exceeds-audio-capacity',
      leg: null,
      maximumDurationFrames: audioTimelineMaximum,
    }
  }

  return {
    status: 'available',
    curve: seam.transition.audio.curve,
    from: fromPartner,
    to: toPartner,
    maximumDurationFrames: audioTimelineMaximum,
  }
}

function audioPlan(
  doc: TimelineDoc,
  seam: CrossfadeSeam,
  rate: FrameRate,
  catalog: SourceBoundsCatalog,
): CrossfadeAudioPlan {
  const structure = crossfadeAudioStructure(
    seam,
    createCrossfadeAudioPartnerIndex(doc),
  )
  if (structure.status !== 'available') return structure
  const fromPartner = structure.from
  const toPartner = structure.to

  const capacity = pairCapacities(
    fromPartner.clip,
    toPartner.clip,
    'audio',
    rate,
    catalog,
  )
  if (capacity.status === 'unavailable') {
    const reasonBySource = {
      'catalog-missing': 'audio-source-catalog-missing',
      'stream-absent': 'audio-source-stream-absent',
      'bounds-unknown': 'audio-source-bounds-unknown',
      'boundary-unsafe': 'audio-source-boundary-unsafe',
    } as const
    return {
      status: 'unavailable',
      reason: reasonBySource[capacity.reason],
      leg: capacity.leg,
      maximumDurationFrames: null,
    }
  }
  const audioMaximum = maximumDuration(capacity.capacities)
  if (seam.transition.durationFrames > audioMaximum) {
    return {
      status: 'unavailable',
      reason: 'duration-exceeds-audio-capacity',
      leg: null,
      maximumDurationFrames: audioMaximum,
    }
  }
  return {
    status: 'available',
    curve: structure.curve,
    from: {
      role: 'from',
      trackId: fromPartner.track.id,
      clip: fromPartner.clip,
      sourceFrameAtCut:
        sourceFrameAtTimelineOffset(
          clipSourceTimeMap(fromPartner.clip),
          fromPartner.clip.timelineRange.durationFrames,
        ),
    },
    to: {
      role: 'to',
      trackId: toPartner.track.id,
      clip: toPartner.clip,
      sourceFrameAtCut: sourceFrameAtTimelineOffset(
        clipSourceTimeMap(toPartner.clip),
        0,
      ),
    },
    maximumDurationFrames: audioMaximum,
  }
}

function resolveOwnedTransition(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
): CrossfadeSeam | CrossfadeInvalidReason {
  const track = doc.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return 'track-not-found'
  const transitions = track.transitions.filter(
    (transition) => transition.id === transitionId,
  )
  if (transitions.length === 0) return 'transition-not-found'
  if (transitions.length !== 1) return 'ambiguous-transition-id'
  return resolveSeam(track, transitions[0])
}

export interface CrossfadeAudioClipWindow {
  startFrame: number
  endFrame: number
}

export type CrossfadeAudioWindowIndex = ReadonlyMap<
  ClipId,
  CrossfadeAudioClipWindow
>

interface StructuralCrossfadeCandidate {
  seam: CrossfadeSeam
  window: CrossfadeAudioClipWindow
}

interface StructuralCrossfadeAudioCandidate
  extends StructuralCrossfadeCandidate {
  audio: Extract<CrossfadeAudioStructure, { status: 'available' }>
}

function markOverlappingCandidates<T>(
  entries: readonly T[],
  windowOf: (entry: T) => CrossfadeAudioClipWindow,
  conflicts: Set<T>,
): void {
  const sorted = [...entries].sort((left, right) => {
    const leftWindow = windowOf(left)
    const rightWindow = windowOf(right)
    return leftWindow.startFrame - rightWindow.startFrame
      || leftWindow.endFrame - rightWindow.endFrame
  })
  let furthest: T | null = null
  for (const entry of sorted) {
    if (furthest !== null) {
      const furthestWindow = windowOf(furthest)
      const entryWindow = windowOf(entry)
      if (entryWindow.startFrame < furthestWindow.endFrame) {
        conflicts.add(furthest)
        conflicts.add(entry)
      }
      if (entryWindow.endFrame > furthestWindow.endFrame) furthest = entry
    } else {
      furthest = entry
    }
  }
}

/**
 * One O(n log n) index for linked-audio handle windows. With a source catalog,
 * it applies the same capacity-before-cross-track-conflict order as the final
 * mix. Without one, unresolved cross-track candidates stay conservative so a
 * later source-aware plan cannot require an asset this index omitted.
 */
export function createCrossfadeAudioWindowIndex(
  doc: TimelineDoc,
  catalog?: SourceBoundsCatalog,
): CrossfadeAudioWindowIndex {
  const partners = createCrossfadeAudioPartnerIndex(doc)
  const audioCandidates: StructuralCrossfadeAudioCandidate[] = []
  for (const track of doc.tracks) {
    if (track.kind !== 'video') continue
    const clips = createTrackClipIndex(track)
    const idCounts = new Map<TransitionId, number>()
    for (const transition of track.transitions) {
      idCounts.set(transition.id, (idCounts.get(transition.id) ?? 0) + 1)
    }
    const structural: StructuralCrossfadeCandidate[] = []
    for (const transition of track.transitions) {
      if (idCounts.get(transition.id) !== 1) continue
      const seam = resolveIndexedSeam(track, transition, clips)
      if (typeof seam === 'string') continue
      const window = transitionWindow(seam)
      if (
        !window
        || transition.durationFrames > maximumDuration(
          timelineCapacities(seam.from, seam.to),
        )
      ) continue
      structural.push({ seam, window })
    }
    const conflicts = new Set<StructuralCrossfadeCandidate>()
    markOverlappingCandidates(structural, (candidate) => candidate.window, conflicts)
    for (const candidate of structural) {
      if (conflicts.has(candidate)) continue
      if (catalog !== undefined) {
        const videoCapacity = pairCapacities(
          candidate.seam.from,
          candidate.seam.to,
          'video',
          doc.frameRate,
          catalog,
        )
        if (
          videoCapacity.status === 'unavailable'
          || candidate.seam.transition.durationFrames
            > maximumDuration(videoCapacity.capacities)
        ) continue
      }
      const audio = crossfadeAudioStructure(candidate.seam, partners)
      if (audio.status === 'available') {
        if (catalog !== undefined) {
          const audioCapacity = pairCapacities(
            audio.from.clip,
            audio.to.clip,
            'audio',
            doc.frameRate,
            catalog,
          )
          if (
            audioCapacity.status === 'unavailable'
            || candidate.seam.transition.durationFrames
              > maximumDuration(audioCapacity.capacities)
          ) continue
        }
        audioCandidates.push({ ...candidate, audio })
      }
    }
  }

  const byClip = new Map<ClipId, StructuralCrossfadeAudioCandidate[]>()
  for (const candidate of audioCandidates) {
    for (const clipId of [candidate.audio.from.clip.id, candidate.audio.to.clip.id]) {
      const entries = byClip.get(clipId) ?? []
      entries.push(candidate)
      byClip.set(clipId, entries)
    }
  }
  const conflicts = new Set<StructuralCrossfadeAudioCandidate>()
  if (catalog !== undefined) {
    for (const entries of byClip.values()) {
      markOverlappingCandidates(entries, (candidate) => candidate.window, conflicts)
    }
  }

  const windows = new Map<ClipId, CrossfadeAudioClipWindow>()
  for (const candidate of audioCandidates) {
    if (conflicts.has(candidate)) continue
    for (const clipId of [candidate.audio.from.clip.id, candidate.audio.to.clip.id]) {
      const previous = windows.get(clipId)
      windows.set(clipId, {
        startFrame: Math.min(
          previous?.startFrame ?? candidate.window.startFrame,
          candidate.window.startFrame,
        ),
        endFrame: Math.max(
          previous?.endFrame ?? candidate.window.endFrame,
          candidate.window.endFrame,
        ),
      })
    }
  }
  return windows
}

export function resolveCrossfadePlan(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
  catalog: SourceBoundsCatalog,
): CrossfadePlanResolution {
  const resolved = resolveOwnedTransition(doc, trackId, transitionId)
  if (typeof resolved === 'string') {
    return { status: 'invalid', reason: resolved }
  }
  const window = transitionWindow(resolved)
  if (!window) return { status: 'invalid', reason: 'unsafe-window' }

  const timelineMaximum = maximumDuration(
    timelineCapacities(resolved.from, resolved.to),
  )
  if (resolved.transition.durationFrames > timelineMaximum) {
    return {
      status: 'unavailable',
      reason: 'duration-exceeds-video-capacity',
      leg: null,
      maximumDurationFrames: timelineMaximum,
    }
  }
  if (overlapsAnotherTransition(resolved, window)) {
    return { status: 'invalid', reason: 'overlapping-transition' }
  }

  const videoCapacity = pairCapacities(
    resolved.from,
    resolved.to,
    'video',
    doc.frameRate,
    catalog,
  )
  if (videoCapacity.status === 'unavailable') {
    const reasonBySource = {
      'catalog-missing': 'source-catalog-missing',
      'stream-absent': 'source-stream-absent',
      'bounds-unknown': 'source-bounds-unknown',
      'boundary-unsafe': 'source-boundary-unsafe',
    } as const
    return {
      status: 'unavailable',
      reason: reasonBySource[videoCapacity.reason],
      leg: videoCapacity.leg,
      maximumDurationFrames: null,
    }
  }
  const videoMaximum = maximumDuration(videoCapacity.capacities)
  if (resolved.transition.durationFrames > videoMaximum) {
    return {
      status: 'unavailable',
      reason: 'duration-exceeds-video-capacity',
      leg: null,
      maximumDurationFrames: videoMaximum,
    }
  }
  const plan: CrossfadePlan = {
    trackId,
    transition: resolved.transition,
    cutFrame: resolved.cutFrame,
    startFrame: window.startFrame,
    endFrame: window.endFrame,
    durationFrames: resolved.transition.durationFrames,
    maximumDurationFrames: videoMaximum,
    from: {
      role: 'from',
      clip: resolved.from,
      sourceFrameAtCut: resolved.from.sourceMode === 'still'
        ? 0
        : sourceFrameAtTimelineOffset(
            clipSourceTimeMap(resolved.from),
            resolved.from.timelineRange.durationFrames,
          ),
    },
    to: {
      role: 'to',
      clip: resolved.to,
      sourceFrameAtCut: resolved.to.sourceMode === 'still'
        ? 0
        : sourceFrameAtTimelineOffset(clipSourceTimeMap(resolved.to), 0),
    },
    audio: audioPlan(doc, resolved, doc.frameRate, catalog),
  }
  return { status: 'available', plan }
}

/** Evaluate a proposed seam without mutating the document. */
export function evaluateCrossfadeDraft(
  doc: TimelineDoc,
  trackId: TrackId,
  fromClipId: ClipId,
  toClipId: ClipId,
  durationFrames: number,
  catalog: SourceBoundsCatalog,
  audio: Transition['audio'] = { enabled: true, curve: 'equal-power' },
): CrossfadePlanResolution {
  const trackIndex = doc.tracks.findIndex((track) => track.id === trackId)
  if (trackIndex < 0) return { status: 'invalid', reason: 'track-not-found' }
  const track = doc.tracks[trackIndex]
  if (track.transitions.some(
    (transition) => transition.fromClipId === fromClipId
      && transition.toClipId === toClipId,
  )) {
    return { status: 'invalid', reason: 'seam-already-has-transition' }
  }
  let suffix = 1
  let id = '__crossfade_draft__'
  const existingIds = new Set(track.transitions.map((transition) => transition.id))
  while (existingIds.has(id)) id = `__crossfade_draft_${++suffix}__`
  const transition: Transition = {
    id,
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { ...audio },
  }
  const tracks = doc.tracks.slice()
  tracks[trackIndex] = {
    ...track,
    transitions: [...track.transitions, transition],
  }
  return resolveCrossfadePlan({ ...doc, tracks }, trackId, id, catalog)
}

/** Evaluate one complete replacement without mutating the document. */
export function evaluateCrossfadeUpdate(
  doc: TimelineDoc,
  trackId: TrackId,
  transitionId: TransitionId,
  durationFrames: number,
  catalog: SourceBoundsCatalog,
  audio: Transition['audio'],
): CrossfadePlanResolution {
  const trackIndex = doc.tracks.findIndex((track) => track.id === trackId)
  if (trackIndex < 0) return { status: 'invalid', reason: 'track-not-found' }
  const track = doc.tracks[trackIndex]
  const matches = track.transitions.flatMap((transition, index) =>
    transition.id === transitionId ? [index] : [],
  )
  if (matches.length !== 1) {
    return resolveCrossfadePlan(doc, trackId, transitionId, catalog)
  }
  const transitionIndex = matches[0]
  const transitions = track.transitions.slice()
  transitions[transitionIndex] = {
    ...transitions[transitionIndex],
    durationFrames,
    audio: { ...audio },
  }
  const tracks = doc.tracks.slice()
  tracks[trackIndex] = { ...track, transitions }
  return resolveCrossfadePlan({ ...doc, tracks }, trackId, transitionId, catalog)
}

function clipOpacity(clip: Clip): number {
  if (!Number.isFinite(clip.opacity) || clip.opacity <= 0) return 0
  return Math.min(1, clip.opacity)
}

/** Materialize the two exact visual requests for one frame of a plan. */
export function crossfadeFrameGroupAt(
  plan: CrossfadePlan,
  frame: number,
): CrossfadeFrameGroup | null {
  if (
    !Number.isSafeInteger(frame)
    || frame < plan.startFrame
    || frame >= plan.endFrame
  ) return null
  const index = frame - plan.startFrame
  const progress = (index + 1) / (plan.durationFrames + 1)
  const request = (
    leg: CrossfadeVideoLeg,
    weight: number,
  ): CrossfadeFrameRequest => ({
    role: leg.role,
    clip: leg.clip,
    sourceFrame: leg.clip.sourceMode === 'still'
      ? 0
      : sourceFrameAtTimelineFrame(leg.clip, frame),
    opacity: clipOpacity(leg.clip),
    weight,
  })
  return {
    kind: 'crossfade',
    trackId: plan.trackId,
    transitionId: plan.transition.id,
    frame,
    requests: [request(plan.from, 1 - progress), request(plan.to, progress)],
  }
}
