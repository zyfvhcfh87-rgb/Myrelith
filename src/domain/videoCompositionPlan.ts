/** Pure, explicit visual composition planning for preview and export. */

import type { Clip, TimelineDoc, Track, TrackId } from './schema'
import {
  crossfadeFrameGroupAt,
  resolveCrossfadePlan,
  type CrossfadeFrameGroup,
  type SourceBoundsCatalog,
  type VideoFrameRequest,
} from './crossfadePlan'
import { rangeContains } from './time'
import { resolveClipAnimationAtFrame } from './clipAnimation'

export interface OrdinaryVideoPlanItem {
  kind: 'clip'
  trackId: TrackId
  frame: number
  request: VideoFrameRequest
}

export interface TextOverlayPlanItem {
  kind: 'text'
  trackId: TrackId
  frame: number
  clip: Clip
  opacity: number
}

export type VideoCompositionItem =
  | OrdinaryVideoPlanItem
  | TextOverlayPlanItem
  | CrossfadeFrameGroup

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
  track: Track,
  frame: number,
): OrdinaryVideoPlanItem | TextOverlayPlanItem | null {
  for (const clip of track.clips) {
    if (clip.timelineRange.startFrame > frame) break
    if (!rangeContains(clip.timelineRange, frame)) continue
    const resolvedClip = resolveClipAnimationAtFrame(clip, frame)
    const opacity = clipOpacity(resolvedClip)
    if (opacity <= 0) return null
    if (resolvedClip.text !== undefined) {
      return {
        kind: 'text',
        trackId: track.id,
        frame,
        clip: resolvedClip,
        opacity,
      }
    }
    return {
      kind: 'clip',
      trackId: track.id,
      frame,
      request: {
        clip: resolvedClip,
        sourceFrame: resolvedClip.sourceMode === 'still'
          ? 0
          : resolvedClip.sourceRange.startFrame
            + (frame - resolvedClip.timelineRange.startFrame),
        opacity,
      },
    }
  }
  return null
}

function resolveCrossfadeGroupAnimation(
  group: CrossfadeFrameGroup,
): CrossfadeFrameGroup {
  const resolveRequest = (
    request: CrossfadeFrameGroup['requests'][number],
  ): CrossfadeFrameGroup['requests'][number] => {
    const clip = resolveClipAnimationAtFrame(request.clip, group.frame)
    return { ...request, clip, opacity: clipOpacity(clip) }
  }
  return {
    ...group,
    requests: [
      resolveRequest(group.requests[0]),
      resolveRequest(group.requests[1]),
    ],
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
  const plans = new Map<TrackId, Array<{
    startFrame: number
    endFrame: number
    groupAt(frame: number): CrossfadeFrameGroup | null
  }>>()

  for (const track of doc.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    const trackPlans = []
    for (const transition of track.transitions) {
      const resolution = resolveCrossfadePlan(
        doc,
        track.id,
        transition.id,
        catalog,
      )
      if (resolution.status !== 'available') continue
      const plan = resolution.plan
      trackPlans.push({
        startFrame: plan.startFrame,
        endFrame: plan.endFrame,
        groupAt: (frame: number) => crossfadeFrameGroupAt(plan, frame),
      })
    }
    if (trackPlans.length > 0) plans.set(track.id, trackPlans)
  }

  return {
    planFrame(frame: number): VideoCompositionPlan {
      const items: VideoCompositionItem[] = []
      for (const track of doc.tracks) {
        if (track.kind !== 'video' || track.hidden) continue
        const active = (plans.get(track.id) ?? []).filter(
          (plan) => frame >= plan.startFrame && frame < plan.endFrame,
        )
        if (active.length === 1) {
          const rawGroup = active[0].groupAt(frame)
          const group = rawGroup ? resolveCrossfadeGroupAnimation(rawGroup) : null
          if (group) {
            items.push(group)
            continue
          }
        }
        const ordinary = ordinaryItem(track, frame)
        if (ordinary) items.push(ordinary)
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
    if (item.kind === 'text') continue
    for (const request of item.requests) {
      if (request.opacity > 0 && request.weight > 0) requests.push(request)
    }
  }
  return requests
}
