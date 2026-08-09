/**
 * Browser-free timeline snapping authority.
 *
 * Candidates are derived from one immutable document snapshot. Callers supply
 * the integer moving points produced by their own edit semantics, then apply
 * the returned signed correction to the same raw delta. Pixel tolerance is
 * converted once through the authoritative timeline zoom.
 */

import type {
  ClipId,
  TimelineDoc,
  TrackId,
  TrackKind,
} from './schema'
import { resolveCrossfade } from './selectors'
import { rangeEnd } from './time'
import { timelineMarkers } from './timelineMarkers'

export const DEFAULT_TIMELINE_SNAP_THRESHOLD_PX = 8

export type TimelineSnapCandidateKind =
  | 'marker'
  | 'playhead'
  | 'transition-start'
  | 'transition-end'
  | 'clip-start'
  | 'clip-end'

export interface TimelineSnapCandidate {
  readonly id: string
  readonly kind: TimelineSnapCandidateKind
  readonly frame: number
  readonly label: string
  /** Null candidates are sequence-wide and may align any track kind. */
  readonly trackId: TrackId | null
  readonly trackKind: TrackKind | null
  /** Persisted document order, used only for portable deterministic ties. */
  readonly trackIndex: number
}

export type TimelineSnapMovingPointKind = 'cursor' | 'start' | 'end'

export interface TimelineSnapMovingPoint {
  readonly id: string
  readonly kind: TimelineSnapMovingPointKind
  readonly frame: number
  /** How this point moves when the owning edit delta increases by one frame. */
  readonly deltaDirection: 1 | -1
  readonly trackKind: TrackKind | null
  readonly trackIndex: number
}

export interface TimelineSnapGuide {
  readonly frame: number
  readonly candidateKind: TimelineSnapCandidateKind
  readonly candidateId: string
  readonly label: string
  readonly trackId: TrackId | null
}

export interface TimelineSnapResolution {
  /** Raw edit delta plus the chosen candidate correction. */
  readonly deltaFrames: number
  readonly correctionFrames: number
  readonly thresholdFrames: number
  readonly guide: TimelineSnapGuide | null
}

export interface TimelineSnapCandidateOptions {
  readonly playheadFrame?: number | null
  readonly excludedClipIds?: ReadonlySet<ClipId>
}

const KIND_PRIORITY: Readonly<Record<TimelineSnapCandidateKind, number>> = {
  marker: 0,
  playhead: 1,
  'transition-start': 2,
  'transition-end': 3,
  'clip-start': 4,
  'clip-end': 5,
}

const MOVING_POINT_PRIORITY: Readonly<Record<TimelineSnapMovingPointKind, number>> = {
  start: 0,
  end: 1,
  cursor: 2,
}

function eligibleTrack(locked: boolean, hidden: boolean): boolean {
  return !locked && !hidden
}

/** Locked/hidden tracks and excluded gesture members never become targets. */
export function timelineSnapCandidates(
  doc: TimelineDoc,
  options: TimelineSnapCandidateOptions = {},
): readonly TimelineSnapCandidate[] {
  const excluded = options.excludedClipIds ?? new Set<ClipId>()
  const candidates: TimelineSnapCandidate[] = []

  const playheadFrame = options.playheadFrame
  if (
    playheadFrame !== undefined
    && playheadFrame !== null
    && Number.isSafeInteger(playheadFrame)
    && playheadFrame >= 0
  ) {
    candidates.push({
      id: 'playhead',
      kind: 'playhead',
      frame: playheadFrame,
      label: 'Playhead',
      trackId: null,
      trackKind: null,
      trackIndex: -1,
    })
  }

  for (const marker of timelineMarkers(doc)) {
    candidates.push({
      id: `marker:${marker.id}`,
      kind: 'marker',
      frame: marker.frame,
      label: `Marker: ${marker.label}`,
      trackId: null,
      trackKind: null,
      trackIndex: -1,
    })
  }

  doc.tracks.forEach((track, trackIndex) => {
    if (!eligibleTrack(track.locked, track.hidden)) return

    for (const clip of track.clips) {
      if (excluded.has(clip.id)) continue
      candidates.push(
        {
          id: `clip-start:${track.id}:${clip.id}`,
          kind: 'clip-start',
          frame: clip.timelineRange.startFrame,
          label: `${clip.name} start on ${track.name}`,
          trackId: track.id,
          trackKind: track.kind,
          trackIndex,
        },
        {
          id: `clip-end:${track.id}:${clip.id}`,
          kind: 'clip-end',
          frame: rangeEnd(clip.timelineRange),
          label: `${clip.name} end on ${track.name}`,
          trackId: track.id,
          trackKind: track.kind,
          trackIndex,
        },
      )
    }

    for (const transition of track.transitions) {
      if (
        excluded.has(transition.fromClipId)
        || excluded.has(transition.toClipId)
      ) continue
      const resolved = resolveCrossfade(track, transition)
      if (!resolved) continue
      candidates.push(
        {
          id: `transition-start:${track.id}:${transition.id}`,
          kind: 'transition-start',
          frame: resolved.startFrame,
          label: `Transition ${transition.id} start on ${track.name}`,
          trackId: track.id,
          trackKind: track.kind,
          trackIndex,
        },
        {
          id: `transition-end:${track.id}:${transition.id}`,
          kind: 'transition-end',
          frame: resolved.endFrame,
          label: `Transition ${transition.id} end on ${track.name}`,
          trackId: track.id,
          trackKind: track.kind,
          trackIndex,
        },
      )
    }
  })

  return candidates
}

export function timelineSnapThresholdFrames(
  zoom: number,
  thresholdPx = DEFAULT_TIMELINE_SNAP_THRESHOLD_PX,
): number {
  if (
    !Number.isFinite(zoom)
    || zoom <= 0
    || !Number.isFinite(thresholdPx)
    || thresholdPx < 0
  ) return 0
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(thresholdPx / zoom),
  )
}

interface RankedSnap {
  readonly candidate: TimelineSnapCandidate
  readonly point: TimelineSnapMovingPoint
  readonly correctionFrames: number
  readonly distanceFrames: number
}

function compatible(
  point: TimelineSnapMovingPoint,
  candidate: TimelineSnapCandidate,
): boolean {
  return point.trackKind === null
    || candidate.trackKind === null
    || point.trackKind === candidate.trackKind
}

function compareRanked(left: RankedSnap, right: RankedSnap): number {
  if (left.distanceFrames !== right.distanceFrames) {
    return left.distanceFrames - right.distanceFrames
  }
  const kind = KIND_PRIORITY[left.candidate.kind]
    - KIND_PRIORITY[right.candidate.kind]
  if (kind !== 0) return kind
  if (left.candidate.frame !== right.candidate.frame) {
    return left.candidate.frame - right.candidate.frame
  }
  if (left.candidate.trackIndex !== right.candidate.trackIndex) {
    return left.candidate.trackIndex - right.candidate.trackIndex
  }
  if (left.candidate.id !== right.candidate.id) {
    return left.candidate.id < right.candidate.id ? -1 : 1
  }
  const pointKind = MOVING_POINT_PRIORITY[left.point.kind]
    - MOVING_POINT_PRIORITY[right.point.kind]
  if (pointKind !== 0) return pointKind
  if (left.point.trackIndex !== right.point.trackIndex) {
    return left.point.trackIndex - right.point.trackIndex
  }
  if (left.point.id === right.point.id) return 0
  return left.point.id < right.point.id ? -1 : 1
}

export interface ResolveTimelineSnapOptions {
  readonly candidates: readonly TimelineSnapCandidate[]
  /** Points after applying rawDeltaFrames, before snap correction. */
  readonly movingPoints: readonly TimelineSnapMovingPoint[]
  readonly rawDeltaFrames: number
  readonly minDeltaFrames?: number
  readonly maxDeltaFrames?: number
  readonly zoom: number
  readonly thresholdPx?: number
}

/** Resolve one deterministic correction without mutating the supplied facts. */
export function resolveTimelineSnap({
  candidates,
  movingPoints,
  rawDeltaFrames,
  minDeltaFrames = Number.NEGATIVE_INFINITY,
  maxDeltaFrames = Number.POSITIVE_INFINITY,
  zoom,
  thresholdPx = DEFAULT_TIMELINE_SNAP_THRESHOLD_PX,
}: ResolveTimelineSnapOptions): TimelineSnapResolution {
  const thresholdFrames = timelineSnapThresholdFrames(zoom, thresholdPx)
  const unsnapped: TimelineSnapResolution = {
    deltaFrames: rawDeltaFrames,
    correctionFrames: 0,
    thresholdFrames,
    guide: null,
  }
  if (!Number.isSafeInteger(rawDeltaFrames) || movingPoints.length === 0) {
    return unsnapped
  }

  let best: RankedSnap | null = null
  for (const point of movingPoints) {
    if (!Number.isSafeInteger(point.frame)) continue
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate.frame) || !compatible(point, candidate)) {
        continue
      }
      const distanceFrames = Math.abs(candidate.frame - point.frame)
      if (distanceFrames > thresholdFrames) continue
      const correctionFrames = (candidate.frame - point.frame)
        * point.deltaDirection
      const deltaFrames = rawDeltaFrames + correctionFrames
      if (
        !Number.isSafeInteger(deltaFrames)
        || deltaFrames < minDeltaFrames
        || deltaFrames > maxDeltaFrames
      ) continue
      const ranked = { candidate, point, correctionFrames, distanceFrames }
      if (best === null || compareRanked(ranked, best) < 0) best = ranked
    }
  }

  if (best === null) return unsnapped
  return {
    deltaFrames: rawDeltaFrames + best.correctionFrames,
    correctionFrames: best.correctionFrames,
    thresholdFrames,
    guide: {
      frame: best.candidate.frame,
      candidateKind: best.candidate.kind,
      candidateId: best.candidate.id,
      label: best.candidate.label,
      trackId: best.candidate.trackId,
    },
  }
}
