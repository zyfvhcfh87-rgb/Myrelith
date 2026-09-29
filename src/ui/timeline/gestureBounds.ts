/**
 * Pure live-gesture bounds for one clip or an entire linked group.
 *
 * Linked edits share one signed delta, so the legal preview interval is the
 * intersection of every member's own timeline/source interval. Asset length
 * stays an injected UI concern: domain operations deliberately cannot read the
 * media catalog.
 */

import { linkedPartners } from '../../domain/linking'
import type { Clip, ClipId, FrameRate, TimelineDoc } from '../../domain/schema'
import { findClip } from '../../domain/selectors'
import {
  clipSourceTimeMap,
  sourceTicksAtTimelineOffset,
  timelineFramesWithinMappedSourceTicks,
  SOURCE_TIME_TICKS_PER_FRAME,
} from '../../domain/sourceTimeMap'
import { microsecondsDurationToFrames } from '../../domain/time'
import type { MediaState } from '../../state/mediaStore'
import type { EditPreviewKind } from '../../state/transportStore'

export type GestureMode = 'move' | EditPreviewKind

export interface GestureBounds {
  minDelta: number
  maxDelta: number
}

export type AssetDurationFramesForClip = (clip: Clip) => number

/** Legal signed-delta interval for one clip. Every valid interval contains 0. */
export function gestureBoundsForClip(
  clip: Clip,
  mode: GestureMode,
  assetDurationFrames: number,
): GestureBounds {
  const timeline = clip.timelineRange
  const stillSource = clip.sourceMode === 'still'
  const textSource = clip.text !== undefined
  const sourceTimeMap = clipSourceTimeMap(clip)
  const sourceEndTicks = sourceTicksAtTimelineOffset(
    sourceTimeMap,
    timeline.durationFrames,
  )
  const sourceHeadroomFrames = stillSource || textSource
    ? Number.POSITIVE_INFINITY
    : timelineFramesWithinMappedSourceTicks(
        sourceTimeMap,
        0,
        Math.max(0, sourceTimeMap.sourceStartTicks),
        -1,
      )
  // Text clips have no media descriptor and intentionally remain extendable.
  // A still repeats its single source frame for any legal timeline duration.
  // Unknown timed sources fail closed at their current source end.
  const headroom = textSource || stillSource
    ? Number.POSITIVE_INFINITY
    : timelineFramesWithinMappedSourceTicks(
        sourceTimeMap,
        timeline.durationFrames,
        Math.max(
          0,
          assetDurationFrames * SOURCE_TIME_TICKS_PER_FRAME - sourceEndTicks,
        ),
        1,
      )

  switch (mode) {
    case 'move':
    case 'slide':
      return {
        minDelta: -timeline.startFrame,
        maxDelta: Number.POSITIVE_INFINITY,
      }
    case 'trim-start':
      return {
        minDelta: stillSource || textSource
          ? -timeline.startFrame
          : Math.max(-timeline.startFrame, -sourceHeadroomFrames),
        maxDelta: timeline.durationFrames - 1,
      }
    case 'ripple-start':
      return {
        minDelta: stillSource || textSource
          ? Number.NEGATIVE_INFINITY
          : -sourceHeadroomFrames,
        maxDelta: timeline.durationFrames - 1,
      }
    case 'trim-end':
    case 'ripple-end':
      return {
        minDelta: -(timeline.durationFrames - 1),
        maxDelta: headroom,
      }
    case 'slip':
      if (stillSource || textSource) return { minDelta: 0, maxDelta: 0 }
      return {
        minDelta: -Math.floor(
          sourceTimeMap.sourceStartTicks / SOURCE_TIME_TICKS_PER_FRAME,
        ),
        maxDelta: Math.floor(
          Math.max(
            0,
            assetDurationFrames * SOURCE_TIME_TICKS_PER_FRAME - sourceEndTicks,
          ) / SOURCE_TIME_TICKS_PER_FRAME,
        ),
      }
  }
}

/**
 * Exact owner/link closure of every gesture root, deduplicated in root order.
 * Bounds, snapping, and the live preview all share this one member list.
 */
export function gestureMembers(
  doc: TimelineDoc,
  rootClipIds: readonly ClipId[],
): readonly Clip[] {
  const members: Clip[] = []
  const seen = new Set<ClipId>()
  for (const rootClipId of rootClipIds) {
    const owner = findClip(doc, rootClipId)
    if (!owner) continue
    for (const member of [owner, ...linkedPartners(doc, rootClipId)]) {
      if (seen.has(member.id)) continue
      seen.add(member.id)
      members.push(member)
    }
  }
  return members
}

/**
 * Intersect every gesture member's own interval, using a fresh document/media
 * snapshot captured by the caller at gesture start.
 */
export function gestureMembersBounds(
  members: readonly Clip[],
  mode: GestureMode,
  assetDurationFramesForClip: AssetDurationFramesForClip,
): GestureBounds {
  if (members.length === 0) return { minDelta: 0, maxDelta: 0 }

  let minDelta = Number.NEGATIVE_INFINITY
  let maxDelta = Number.POSITIVE_INFINITY
  for (const member of members) {
    const bounds = gestureBoundsForClip(
      member,
      mode,
      assetDurationFramesForClip(member),
    )
    minDelta = Math.max(minDelta, bounds.minDelta)
    maxDelta = Math.min(maxDelta, bounds.maxDelta)
  }

  // A valid document makes every member interval contain zero. Fail closed if
  // malformed external state somehow violates that premise.
  return minDelta <= maxDelta
    ? { minDelta, maxDelta }
    : { minDelta: 0, maxDelta: 0 }
}

/**
 * Timeline-frame length of an asset: the connected media when present, else
 * its offline descriptor. Unknown assets report 0 so timed edits fail closed.
 */
export function timelineAssetDurationFrames(
  media: Pick<MediaState, 'assets' | 'descriptors'>,
  assetId: string,
  frameRate: FrameRate,
): number {
  const connected = media.assets.get(assetId)
  if (connected) return connected.durationFrames
  const descriptor = media.descriptors.get(assetId)
  return descriptor
    ? microsecondsDurationToFrames(descriptor.durationMicroseconds, frameRate)
    : 0
}
