/**
 * Pure live-gesture bounds for one clip or an entire linked group.
 *
 * Linked edits share one signed delta, so the legal preview interval is the
 * intersection of every member's own timeline/source interval. Asset length
 * stays an injected UI concern: domain operations deliberately cannot read the
 * media catalog.
 */

import { linkedPartners } from '../../domain/linking'
import type { Clip, ClipId, TimelineDoc } from '../../domain/schema'
import { findClip } from '../../domain/selectors'
import {
  clipSourceTimeMap,
  sourceTicksAtTimelineOffset,
  timelineFramesWithinSourceTicks,
  SOURCE_TIME_TICKS_PER_FRAME,
} from '../../domain/sourceTimeMap'
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
    : timelineFramesWithinSourceTicks(
        Math.max(0, sourceTimeMap.sourceStartTicks),
        sourceTimeMap.rate,
      )
  // Text clips have no media descriptor and intentionally remain extendable.
  // A still repeats its single source frame for any legal timeline duration.
  // Unknown timed sources fail closed at their current source end.
  const headroom = textSource || stillSource
    ? Number.POSITIVE_INFINITY
    : timelineFramesWithinSourceTicks(
        Math.max(
          0,
          assetDurationFrames * SOURCE_TIME_TICKS_PER_FRAME - sourceEndTicks,
        ),
        sourceTimeMap.rate,
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
 * Intersect the owner and every linked partner using a fresh document/media
 * snapshot captured by the caller at pointer-down.
 */
export function linkedGestureBounds(
  doc: TimelineDoc,
  ownerClipId: ClipId,
  mode: GestureMode,
  assetDurationFramesForClip: AssetDurationFramesForClip,
): GestureBounds {
  const owner = findClip(doc, ownerClipId)
  if (!owner) return { minDelta: 0, maxDelta: 0 }

  let minDelta = Number.NEGATIVE_INFINITY
  let maxDelta = Number.POSITIVE_INFINITY
  for (const member of [owner, ...linkedPartners(doc, ownerClipId)]) {
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
