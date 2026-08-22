/**
 * Browser-free media-placement facts for Media Pool asset drops and OS
 * file drops onto a timeline lane.
 *
 * Kind policy, overlap, and linked A/V pairing live here so the Track UI
 * and the app placement controller cannot drift. This module never sees a
 * File, handle, blob, or object URL.
 */

import type {
  AssetKind,
  MediaAsset,
  TimeRange,
  TimelineDoc,
  TrackId,
  TrackKind,
} from './schema'
import { overlapsAny } from './operations/operationInternals'

export const TIMELINE_MULTI_FILE_DROP_MESSAGE =
  'Drop one file on the timeline; drop multiple files into Media.'

export type TimelineFileDropPolicy =
  | { status: 'accept' }
  | { status: 'refuse'; message: string }

export type MediaPlacementRejection =
  | 'missing-asset'
  | 'missing-track'
  | 'locked-track'
  | 'wrong-kind'
  | 'incompatible'
  | 'invalid-duration'
  | 'overlap'
  | 'stale-document'
  | 'commit-rejected'

export type MediaPlacementPlan =
  | {
      status: 'place-single'
      trackId: TrackId
      startFrame: number
    }
  | {
      status: 'place-linked'
      videoTrackId: TrackId
      audioTrackId: TrackId
      startFrame: number
    }
  | {
      status: 'reject'
      reason: MediaPlacementRejection
    }

export interface MediaPlacementPreviewRange {
  startFrame: number
  durationFrames: number
}

/** Asset kinds each track kind accepts (images composite on video lanes). */
export function trackKindAcceptsAssetKind(
  trackKind: TrackKind,
  assetKind: AssetKind,
): boolean {
  if (trackKind === 'video') return assetKind === 'video' || assetKind === 'image'
  return assetKind === 'audio'
}

/**
 * Integer global frame under a pointer in a bounded timeline lane. Matches
 * the existing asset-drop mapping: origin plus rounded local pixels / zoom.
 */
export function timelineFrameFromPointer(
  originFrame: number,
  localPx: number,
  zoom: number,
): number {
  const origin = Number.isFinite(originFrame)
    ? Math.max(0, Math.round(originFrame))
    : 0
  if (!Number.isFinite(localPx) || !Number.isFinite(zoom) || zoom <= 0) {
    return origin
  }
  return Math.max(0, origin + Math.round(localPx / zoom))
}

/** First-slice timeline drops accept exactly one OS file. */
export function resolveTimelineFileDropPolicy(
  fileCount: number,
): TimelineFileDropPolicy {
  if (fileCount === 1) return { status: 'accept' }
  return {
    status: 'refuse',
    message: TIMELINE_MULTI_FILE_DROP_MESSAGE,
  }
}

export function planMediaAssetPlacement(input: {
  doc: TimelineDoc
  asset: Pick<MediaAsset, 'kind' | 'durationFrames' | 'hasAudio'> | null
  trackId: TrackId
  startFrame: number
  timelineCompatible: boolean
}): MediaPlacementPlan {
  const startFrame = timelineFrameFromPointer(input.startFrame, 0, 1)
  if (!input.asset) return { status: 'reject', reason: 'missing-asset' }
  if (!input.timelineCompatible) {
    return { status: 'reject', reason: 'incompatible' }
  }
  if (
    !Number.isInteger(input.asset.durationFrames)
    || input.asset.durationFrames < 1
  ) {
    return { status: 'reject', reason: 'invalid-duration' }
  }

  const track = input.doc.tracks.find((candidate) => candidate.id === input.trackId)
  if (!track) return { status: 'reject', reason: 'missing-track' }
  if (track.locked) return { status: 'reject', reason: 'locked-track' }
  if (!trackKindAcceptsAssetKind(track.kind, input.asset.kind)) {
    return { status: 'reject', reason: 'wrong-kind' }
  }

  const range: TimeRange = {
    startFrame,
    durationFrames: input.asset.durationFrames,
  }
  if (overlapsAny(track.clips, range)) {
    return { status: 'reject', reason: 'overlap' }
  }

  const audioLane =
    input.asset.kind === 'video' && input.asset.hasAudio
      ? input.doc.tracks.find((candidate) => (
        candidate.kind === 'audio' && !candidate.locked
      ))
      : undefined
  if (audioLane) {
    if (overlapsAny(audioLane.clips, range)) {
      return { status: 'reject', reason: 'overlap' }
    }
    return {
      status: 'place-linked',
      videoTrackId: track.id,
      audioTrackId: audioLane.id,
      startFrame,
    }
  }

  return {
    status: 'place-single',
    trackId: track.id,
    startFrame,
  }
}

/**
 * Intersect a placement ghost with the bounded physical timeline window.
 * A null duration is a one-frame insertion marker — duration is unknowable
 * for an OS file until drop analysis finishes.
 */
export function visiblePlacementPreviewRange(
  startFrame: number,
  durationFrames: number | null,
  originFrame: number,
  windowEndFrame: number,
): MediaPlacementPreviewRange | null {
  const extent = durationFrames === null || durationFrames < 1
    ? 1
    : durationFrames
  const start = Number.isFinite(startFrame) ? Math.round(startFrame) : 0
  const origin = Number.isFinite(originFrame) ? Math.round(originFrame) : 0
  const windowEnd = Number.isFinite(windowEndFrame)
    ? Math.round(windowEndFrame)
    : Number.MAX_SAFE_INTEGER
  const end = start + extent
  const visibleStart = Math.max(start, origin)
  const visibleEnd = Math.min(end, windowEnd)
  if (visibleEnd <= visibleStart) return null
  return {
    startFrame: visibleStart,
    durationFrames: visibleEnd - visibleStart,
  }
}
