/** App-owned projection from the real preview renderer into UI-readable state. */

import {
  CANVAS_FILTER_EFFECT_CAPABILITY,
  resolveEffectStack,
  type EffectCapability,
} from '../domain/effectStack'
import type { EffectId, TimelineDoc } from '../domain/schema'
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
  return resolved
}

function previewDetail(
  status: PreviewEffectStatus['status'],
  detail: string,
  capabilities: RenderWorkerCapabilities | null,
): string {
  if (
    status !== 'unsupported'
    || !detail.includes(CANVAS_FILTER_EFFECT_CAPABILITY)
  ) return detail
  if (capabilities === null) {
    return 'Preview renderer capability is still being detected; the effect is preserved and bypassed for now.'
  }
  return 'The Program Monitor preview renderer does not provide Canvas filters; the effect is preserved and bypassed in preview.'
}

/**
 * Resolve status once in the composition root, using the same domain registry
 * as rendering. The Inspector consumes this projection without assuming or
 * evaluating any Canvas capability.
 */
export function projectPreviewEffectStatuses(
  doc: TimelineDoc,
  capabilities: RenderWorkerCapabilities | null,
): ReadonlyMap<EffectId, PreviewEffectStatus> {
  const projected = new Map<EffectId, PreviewEffectStatus>()
  const available = previewCapabilities(capabilities)
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      for (const resolution of resolveEffectStack(clip.effects, available)) {
        projected.set(resolution.effect.id, {
          label: resolution.label,
          status: resolution.status,
          detail: previewDetail(resolution.status, resolution.detail, capabilities),
        })
      }
    }
  }
  return projected
}
