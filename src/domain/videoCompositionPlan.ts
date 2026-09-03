/** Pure, explicit visual composition planning for preview and export. */

import type {
  AdjustmentItem,
  CaptionTrackId,
  Clip,
  TimelineDoc,
  TrackId,
  SequenceInstanceId,
} from './schema'
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
  type CrossfadeFrameRequest,
  type SourceBoundsCatalog,
  type VideoFrameRequest,
} from './crossfadePlan'
import { resolveClipAnimationAtFrame } from './clipAnimation'
import {
  createVideoEffectStagePlanner,
  type PluginVideoEffectContributionSnapshot,
  type VideoEffectStagePlan,
  type VideoEffectStagePlanner,
} from './pluginVideoEffectStagePlan'
import { createFrameIndex, type FrameIndex } from './frameIndex'
import {
  clipBlendModeIntent,
  resolveBlendMode,
  resolveTransitionGroupBlendMode,
  type BlendModeResolution,
} from './blendModes'
import { sourceFrameAtTimelineFrame } from './sourceTimeMap'
import { adjustmentItems, resolveAdjustmentAtFrame } from './adjustmentItems'

export interface OrdinaryVideoPlanItem {
  kind: 'clip'
  trackId: TrackId
  frame: number
  request: PlannedVideoFrameRequest
  blendMode: BlendModeResolution
}

export interface PlannedVideoFrameRequest extends VideoFrameRequest {
  /** Plan-local identity when one durable clip is reached through multiple instances. */
  requestKey?: string
  /** Present only for authored stacks containing a plugin-prefixed descriptor. */
  effectStagePlan?: VideoEffectStagePlan
}

export interface PlannedCrossfadeFrameRequest extends CrossfadeFrameRequest {
  /** Plan-local identity when one durable clip is reached through multiple instances. */
  requestKey?: string
  /** Planned independently after resolving this exact transition leg's animation. */
  effectStagePlan?: VideoEffectStagePlan
}

export type PlannedVideoDecodeRequest = VideoFrameRequest & {
  readonly requestKey?: string
}

export function videoCompositionRequestKey(
  request: PlannedVideoDecodeRequest,
): string {
  return request.requestKey ?? request.clip.id
}

export interface TextOverlayPlanItem {
  kind: 'text'
  trackId: TrackId
  frame: number
  clip: Clip
  opacity: number
  blendMode: BlendModeResolution
  /** Present only for authored stacks containing a plugin-prefixed descriptor. */
  effectStagePlan?: VideoEffectStagePlan
}

/** A full-frame post-composite operation at one exact track boundary. */
export interface AdjustmentCompositionItem {
  kind: 'adjustment'
  trackId: TrackId
  frame: number
  adjustment: AdjustmentItem
}

export interface CrossfadeCompositionItem extends Omit<CrossfadeFrameGroup, 'requests'> {
  requests: readonly [PlannedCrossfadeFrameRequest, PlannedCrossfadeFrameRequest]
  blendMode: BlendModeResolution
}

/** Semantic caption paint. It remains identifiable as a caption end-to-end. */
export interface CaptionPlanItem {
  kind: 'caption'
  trackId: CaptionTrackId
  frame: number
  paint: CaptionPaint
}

/** Opaque black base of one live nested-sequence video instance. */
export interface SequenceBackgroundCompositionItem {
  kind: 'sequence-background'
  trackId: TrackId
  /** Frame in the immediate parent sequence. */
  frame: number
  instanceId: SequenceInstanceId
  sequenceId: string
  instancePath: readonly SequenceInstanceId[]
}

export type VideoCompositionItem =
  | OrdinaryVideoPlanItem
  | TextOverlayPlanItem
  | AdjustmentCompositionItem
  | CaptionPlanItem
  | SequenceBackgroundCompositionItem
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
  effectStagePlanner: VideoEffectStagePlanner,
): OrdinaryVideoPlanItem | TextOverlayPlanItem | null {
  if (!clip) return null
  const resolvedClip = resolveClipAnimationAtFrame(clip, frame)
  const opacity = clipOpacity(resolvedClip)
  if (opacity <= 0) return null
  const effectStagePlan = effectStagePlanner.planClip(resolvedClip, frame)
  if (resolvedClip.text !== undefined) {
    return {
      kind: 'text',
      trackId,
      frame,
      clip: resolvedClip,
      opacity,
      blendMode: resolveBlendMode(clipBlendModeIntent(resolvedClip)),
      ...(effectStagePlan === null ? {} : { effectStagePlan }),
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
      ...(effectStagePlan === null ? {} : { effectStagePlan }),
    },
  }
}

function resolveCrossfadeGroupAnimation(
  group: CrossfadeFrameGroup,
  effectStagePlanner: VideoEffectStagePlanner,
): CrossfadeCompositionItem {
  const resolveRequest = (
    request: CrossfadeFrameGroup['requests'][number],
  ): PlannedCrossfadeFrameRequest => {
    const clip = resolveClipAnimationAtFrame(request.clip, group.frame)
    const effectStagePlan = effectStagePlanner.planClip(clip, group.frame)
    return {
      ...request,
      clip,
      opacity: clipOpacity(clip),
      ...(effectStagePlan === null ? {} : { effectStagePlan }),
    }
  }
  const requests: CrossfadeCompositionItem['requests'] = [
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
  pluginContributions?: PluginVideoEffectContributionSnapshot,
): VideoCompositionPlanner {
  const effectStagePlanner = createVideoEffectStagePlanner(pluginContributions)
  const tracks: Array<{
    readonly id: TrackId
    readonly clips: FrameIndex<Clip>
    readonly adjustments: FrameIndex<AdjustmentItem>
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
      adjustments: createFrameIndex(adjustmentItems(track), (adjustment) => ({
        startFrame: adjustment.timelineRange.startFrame,
        endFrame:
          adjustment.timelineRange.startFrame + adjustment.timelineRange.durationFrames,
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
        const adjustment = track.adjustments.activeAt(frame)
        if (adjustment) {
          const resolved = resolveAdjustmentAtFrame(adjustment, frame)
          if (resolved.enabled && resolved.opacity > 0) {
            items.push({
              kind: 'adjustment',
              trackId: track.id,
              frame,
              adjustment: resolved,
            })
          }
          continue
        }
        const activeTransition = track.transitions.activeAt(frame)
        if (activeTransition) {
          const rawGroup = crossfadeFrameGroupAt(activeTransition, frame)
          const group = rawGroup
            ? resolveCrossfadeGroupAnimation(rawGroup, effectStagePlanner)
            : null
          if (group) {
            items.push(group)
            continue
          }
        }
        const ordinary = ordinaryItem(
          track.id,
          track.clips.activeAt(frame),
          frame,
          effectStagePlanner,
        )
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
  pluginContributions?: PluginVideoEffectContributionSnapshot,
): VideoCompositionPlan {
  return createVideoCompositionPlanner(doc, catalog, pluginContributions).planFrame(frame)
}

/** Exact decode requests in compositor call order; invisible legs need none. */
export function videoCompositionRequests(
  plan: VideoCompositionPlan,
): PlannedVideoDecodeRequest[] {
  const requests: PlannedVideoDecodeRequest[] = []
  for (const item of plan.items) {
    if (item.kind === 'clip') {
      if (!Object.prototype.hasOwnProperty.call(item.request, 'effectStagePlan')) {
        requests.push(item.request)
      } else {
        const request = { ...item.request }
        delete request.effectStagePlan
        requests.push(request)
      }
      continue
    }
    if (
      item.kind === 'text'
      || item.kind === 'caption'
      || item.kind === 'adjustment'
      || item.kind === 'sequence-background'
    ) continue
    for (const request of item.requests) {
      if (request.opacity <= 0 || request.weight <= 0) continue
      if (!Object.prototype.hasOwnProperty.call(request, 'effectStagePlan')) {
        requests.push(request)
      } else {
        const decodeRequest = { ...request }
        delete decodeRequest.effectStagePlan
        requests.push(decodeRequest)
      }
    }
  }
  return requests
}
