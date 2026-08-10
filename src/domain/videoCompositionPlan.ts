/** Pure, explicit visual composition planning for preview and export. */

import type { CaptionTrackId, Clip, TimelineDoc, TrackId } from './schema'
import {
  activeCaptionItemsAtFrame,
  captionPaintFor,
  type CaptionPaint,
} from './captions'
import {
  crossfadeFrameGroupAt,
  resolveCrossfadePlan,
  type CrossfadePlan,
  type CrossfadeFrameGroup,
  type SourceBoundsCatalog,
  type VideoFrameRequest,
} from './crossfadePlan'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import { createFrameIndex, type FrameIndex } from './frameIndex'
import {
  clipBlendModeIntent,
  resolveBlendMode,
  resolveTransitionGroupBlendMode,
  type BlendModeResolution,
} from './blendModes'
import { sourceFrameAtTimelineFrame } from './sourceTimeMap'

export interface OrdinaryVideoPlanItem {
  kind: 'clip'
  trackId: TrackId
  frame: number
  request: VideoFrameRequest
  blendMode: BlendModeResolution
}

export interface TextOverlayPlanItem {
  kind: 'text'
  trackId: TrackId
  frame: number
  clip: Clip
  opacity: number
  blendMode: BlendModeResolution
}

export interface CrossfadeCompositionItem extends CrossfadeFrameGroup {
  blendMode: BlendModeResolution
}

/** Semantic caption paint. It remains identifiable as a caption end-to-end. */
export interface CaptionPlanItem {
  kind: 'caption'
  trackId: CaptionTrackId
  frame: number
  paint: CaptionPaint
}

export type VideoCompositionItem =
  | OrdinaryVideoPlanItem
  | TextOverlayPlanItem
  | CaptionPlanItem
  | CrossfadeCompositionItem

/** One transferable, paint-ordered plan for one exact document frame. */
export interface VideoCompositionPlan {
  frame: number
  items: VideoCompositionItem[]
}

export interface VideoCompositionPlanner {
  planFrame(frame: number): VideoCompositionPlan
}

function clipOpacity(clip: Clip): number {
  if (!Number.isFinite(clip.opacity) || clip.opacity <= 0) return 0
  return Math.min(1, clip.opacity)
}

function ordinaryItem(
  trackId: TrackId,
  clip: Clip | null,
  frame: number,
): OrdinaryVideoPlanItem | TextOverlayPlanItem | null {
  if (!clip) return null
  const resolvedClip = resolveClipAnimationAtFrame(clip, frame)
  const opacity = clipOpacity(resolvedClip)
  if (opacity <= 0) return null
  if (resolvedClip.text !== undefined) {
    return {
      kind: 'text',
      trackId,
      frame,
      clip: resolvedClip,
      opacity,
      blendMode: resolveBlendMode(clipBlendModeIntent(resolvedClip)),
    }
  }
  return {
    kind: 'clip',
    trackId,
    frame,
    blendMode: resolveBlendMode(clipBlendModeIntent(resolvedClip)),
    request: {
      clip: resolvedClip,
      sourceFrame: resolvedClip.sourceMode === 'still'
        ? 0
        : sourceFrameAtTimelineFrame(resolvedClip, frame),
      opacity,
    },
  }
}

function resolveCrossfadeGroupAnimation(
  group: CrossfadeFrameGroup,
): CrossfadeCompositionItem {
  const resolveRequest = (
    request: CrossfadeFrameGroup['requests'][number],
  ): CrossfadeFrameGroup['requests'][number] => {
    const clip = resolveClipAnimationAtFrame(request.clip, group.frame)
    return { ...request, clip, opacity: clipOpacity(clip) }
  }
  const requests: CrossfadeFrameGroup['requests'] = [
    resolveRequest(group.requests[0]),
    resolveRequest(group.requests[1]),
  ]
  return {
    ...group,
    requests,
    blendMode: resolveTransitionGroupBlendMode(requests[0].clip, requests[1].clip),
  }
}

/**
 * Resolve every authored transition once for this immutable doc/catalog pair.
 * Unavailable or malformed records stay in the document but contribute no
 * plan, leaving each frame on the deterministic ordinary hard-cut path.
 */
export function createVideoCompositionPlanner(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): VideoCompositionPlanner {
  const tracks: Array<{
    readonly id: TrackId
    readonly clips: FrameIndex<Clip>
    readonly transitions: FrameIndex<CrossfadePlan>
  }> = []

  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    const trackPlans: CrossfadePlan[] = []
    for (const transition of track.transitions) {
      const resolution = resolveCrossfadePlan(
        doc,
        track.id,
        transition.id,
        catalog,
      )
      if (resolution.status !== 'available') continue
      trackPlans.push(resolution.plan)
    }
    const sortedTrackPlans = trackPlans.toSorted((left, right) =>
      left.startFrame - right.startFrame
      || left.endFrame - right.endFrame
      || left.transition.id.localeCompare(right.transition.id),
    )
    tracks.push({
      id: track.id,
      clips: createFrameIndex(track.clips, (clip) => ({
        startFrame: clip.timelineRange.startFrame,
        endFrame:
          clip.timelineRange.startFrame + clip.timelineRange.durationFrames,
      })),
      transitions: createFrameIndex(sortedTrackPlans, (plan) => ({
        startFrame: plan.startFrame,
        endFrame: plan.endFrame,
      })),
    })
  }

  return {
    planFrame(frame: number): VideoCompositionPlan {
      const items: VideoCompositionItem[] = []
      for (const track of tracks) {
        const activeTransition = track.transitions.activeAt(frame)
        if (activeTransition) {
          const rawGroup = crossfadeFrameGroupAt(activeTransition, frame)
          const group = rawGroup ? resolveCrossfadeGroupAnimation(rawGroup) : null
          if (group) {
            items.push(group)
            continue
          }
        }
        const ordinary = ordinaryItem(track.id, track.clips.activeAt(frame), frame)
        if (ordinary) items.push(ordinary)
      }
      const captions = activeCaptionItemsAtFrame(doc, frame)
      for (let index = 0; index < captions.length; index++) {
        const caption = captions[index]!
        items.push({
          kind: 'caption',
          trackId: caption.track.id,
          frame,
          paint: captionPaintFor(doc, caption.track, caption.item, index, captions.length),
        })
      }
      return { frame, items }
    },
  }
}

/** One-shot adapter for UI/status reads that do not retain a planner. */
export function videoCompositionPlanAtFrame(
  doc: TimelineDoc,
  frame: number,
  catalog: SourceBoundsCatalog,
): VideoCompositionPlan {
  return createVideoCompositionPlanner(doc, catalog).planFrame(frame)
}

/** Exact decode requests in compositor call order; invisible legs need none. */
export function videoCompositionRequests(
  plan: VideoCompositionPlan,
): VideoFrameRequest[] {
  const requests: VideoFrameRequest[] = []
  for (const item of plan.items) {
    if (item.kind === 'clip') {
      requests.push(item.request)
      continue
    }
    if (item.kind === 'text' || item.kind === 'caption') continue
    for (const request of item.requests) {
      if (request.opacity > 0 && request.weight > 0) requests.push(request)
    }
  }
  return requests
}
