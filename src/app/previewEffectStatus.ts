import { videoBusStacks, resolveVideoBusEffects } from '../domain/videoBusStage'
/** App-owned projection from the real preview renderer into UI-readable state. */

import {
  CANVAS_FILTER_EFFECT_CAPABILITY,
  CANVAS_PIXEL_EFFECT_CAPABILITY,
  resolveEffectStack,
  type EffectCapability,
} from '../domain/effectStack'
import {
  clipAnimation,
  effectAnimationTracks,
  resolveClipAnimationAtFrame,
} from '../domain/clipAnimation'
import type { Clip, EffectDescriptor, EffectId, TimelineDoc } from '../domain/schema'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import type {
  PreviewEffectStatus,
} from '../state/previewStatusStore'
import type { RenderWorkerCapabilities } from '../workers/render-protocol'

function previewCapabilities(
  capabilities: RenderWorkerCapabilities | null,
): ReadonlySet<EffectCapability> {
  const resolved = new Set<EffectCapability>()
  if (capabilities?.canvasFilter) {
    resolved.add(CANVAS_FILTER_EFFECT_CAPABILITY)
  }
  if (capabilities?.canvasPixelAccess) {
    resolved.add(CANVAS_PIXEL_EFFECT_CAPABILITY)
  }
  return resolved
}

function previewDetail(
  status: PreviewEffectStatus['status'],
  detail: string,
  capabilities: RenderWorkerCapabilities | null,
): string {
  if (
    status !== 'unsupported'
    || (
      !detail.includes(CANVAS_FILTER_EFFECT_CAPABILITY)
      && !detail.includes(CANVAS_PIXEL_EFFECT_CAPABILITY)
    )
  ) return detail
  if (capabilities === null) {
    return 'Preview renderer capability is still being detected; the effect is preserved and bypassed for now.'
  }
  return detail.includes(CANVAS_PIXEL_EFFECT_CAPABILITY)
    ? 'The Program Monitor preview renderer cannot read and write Canvas pixels; the effect settings are preserved and the effect is bypassed in preview.'
    : 'The Program Monitor preview renderer does not provide Canvas filters; the effect is preserved and bypassed in preview.'
}

export interface PreviewEffectStatusIndex {
  readonly busEffects: readonly EffectDescriptor[]
  readonly effectClips: readonly Clip[]
  readonly animatedEffectClips: readonly Clip[]
}

export interface PreviewEffectStatusWork {
  clipsResolved: number
}

/** Scan the document only when its snapshot changes, never on each preview frame. */
export function createPreviewEffectStatusIndex(
  doc: TimelineDoc,
): PreviewEffectStatusIndex {
  const effectClips: Clip[] = []
  const animatedEffectClips: Clip[] = []
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.effects.length === 0) continue
      effectClips.push(clip)
      if (effectAnimationTracks(clipAnimation(clip)).length > 0) {
        animatedEffectClips.push(clip)
      }
    }
  }
  return { effectClips, animatedEffectClips, busEffects: videoBusStacks(doc).flat() }
}

function projectClips(
  clips: readonly Clip[],
  capabilities: RenderWorkerCapabilities | null,
  timelineFrame: number,
  projected: Map<EffectId, PreviewEffectStatus>,
  work?: PreviewEffectStatusWork,
): void {
  const available = previewCapabilities(capabilities)
  for (const clip of clips) {
    if (work) work.clipsResolved++
    const resolvedClip = resolveClipAnimationAtFrame(clip, timelineFrame)
    for (const resolution of resolveEffectStack(resolvedClip.effects, available)) {
      projected.set(resolution.effect.id, {
        label: resolution.label,
        status: resolution.status,
        detail: previewDetail(resolution.status, resolution.detail, capabilities),
      })
    }
  }
}

export function projectIndexedPreviewEffectStatuses(
  index: PreviewEffectStatusIndex,
  capabilities: RenderWorkerCapabilities | null,
  timelineFrame: number,
): ReadonlyMap<EffectId, PreviewEffectStatus> {
  const projected = new Map<EffectId, PreviewEffectStatus>()
  projectClips(index.effectClips, capabilities, timelineFrame, projected)
  for (const resolution of resolveVideoBusEffects(index.busEffects, capabilities?.canvasPixelAccess === true).effects) {
    projected.set(resolution.effect.id, { label: resolution.label, status: resolution.status, detail: resolution.detail })
  }
  return projected
}

const STATUS_PRIORITY: Record<PreviewEffectStatus['status'], number> = {
  ready: 0,
  disabled: 1,
  unsupported: 2,
  invalid: 3,
}

/** Nested leaves already carry animation resolved at their exact child frame. */
export function projectPlannedPreviewEffectStatuses(
  plan: VideoCompositionPlan,
  capabilities: RenderWorkerCapabilities | null,
  current: ReadonlyMap<EffectId, PreviewEffectStatus>,
): ReadonlyMap<EffectId, PreviewEffectStatus> {
  if (!plan.items.some((item) => item.kind === 'sequence-background')) return current
  const available = previewCapabilities(capabilities)
  const planned = new Map<EffectId, PreviewEffectStatus>()
  for (const item of plan.items) {
    const clips = item.kind === 'clip' ? [item.request.clip]
      : item.kind === 'text' ? [item.clip]
        : item.kind === 'crossfade' ? item.requests.map((request) => request.clip)
          : []
    for (const clip of clips) {
      for (const resolution of resolveEffectStack(clip.effects, available)) {
        const previous = planned.get(resolution.effect.id)
        // One durable effect can be active at different times in two instances.
        // Report an unavailable instance even if another instance is ready.
        if (previous && STATUS_PRIORITY[previous.status] >= STATUS_PRIORITY[resolution.status]) {
          continue
        }
        planned.set(resolution.effect.id, {
          label: resolution.label,
          status: resolution.status,
          detail: previewDetail(resolution.status, resolution.detail, capabilities),
        })
      }
    }
  }
  let projected: Map<EffectId, PreviewEffectStatus> | null = null
  for (const [id, next] of planned) {
    const previous = current.get(id)
    if (
      previous?.label === next.label
      && previous.status === next.status
      && previous.detail === next.detail
    ) continue
    projected ??= new Map(current)
    projected.set(id, next)
  }
  return projected ?? current
}

/** Refresh only effect owners whose scalar parameters can change at the playhead. */
export function refreshAnimatedPreviewEffectStatuses(
  index: PreviewEffectStatusIndex,
  capabilities: RenderWorkerCapabilities | null,
  timelineFrame: number,
  current: ReadonlyMap<EffectId, PreviewEffectStatus>,
  work?: PreviewEffectStatusWork,
): ReadonlyMap<EffectId, PreviewEffectStatus> {
  if (index.animatedEffectClips.length === 0) return current
  const available = previewCapabilities(capabilities)
  let projected: Map<EffectId, PreviewEffectStatus> | null = null
  for (const clip of index.animatedEffectClips) {
    if (work) work.clipsResolved++
    const resolvedClip = resolveClipAnimationAtFrame(clip, timelineFrame)
    for (const resolution of resolveEffectStack(resolvedClip.effects, available)) {
      const next = {
        label: resolution.label,
        status: resolution.status,
        detail: previewDetail(resolution.status, resolution.detail, capabilities),
      }
      const previous = current.get(resolution.effect.id)
      if (
        previous?.label === next.label
        && previous.status === next.status
        && previous.detail === next.detail
      ) continue
      projected ??= new Map(current)
      projected.set(resolution.effect.id, next)
    }
  }
  return projected ?? current
}

/**
 * Resolve status once in the composition root, using the same domain registry
 * as rendering. The Inspector consumes this projection without assuming or
 * evaluating any Canvas capability.
 */
export function projectPreviewEffectStatuses(
  doc: TimelineDoc,
  capabilities: RenderWorkerCapabilities | null,
  timelineFrame: number,
): ReadonlyMap<EffectId, PreviewEffectStatus> {
  return projectIndexedPreviewEffectStatuses(
    createPreviewEffectStatusIndex(doc),
    capabilities,
    timelineFrame,
  )
}
