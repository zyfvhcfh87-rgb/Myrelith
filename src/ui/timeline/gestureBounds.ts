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
import { rangeEnd } from '../../domain/time'
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
  const source = clip.sourceRange
  // Text clips have no media descriptor and intentionally remain extendable.
  // Unknown non-text sources fail closed at their current source end.
  const headroom = clip.text
    ? Number.POSITIVE_INFINITY
    : Math.max(0, assetDurationFrames - rangeEnd(source))

  switch (mode) {
    case 'move':
    case 'slide':
      return {
        minDelta: -timeline.startFrame,
        maxDelta: Number.POSITIVE_INFINITY,
      }
    case 'trim-start':
      return {
        minDelta: Math.max(-timeline.startFrame, -source.startFrame),
        maxDelta: timeline.durationFrames - 1,
      }
    case 'ripple-start':
      return {
        minDelta: -source.startFrame,
        maxDelta: timeline.durationFrames - 1,
      }
    case 'trim-end':
    case 'ripple-end':
      return {
        minDelta: -(timeline.durationFrames - 1),
        maxDelta: headroom,
      }
    case 'slip':
      return {
        minDelta: -source.startFrame,
        maxDelta: headroom,
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
