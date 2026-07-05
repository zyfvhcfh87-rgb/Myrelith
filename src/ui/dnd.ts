/**
 * ui/dnd.ts — Drag payload contract between MediaPool (drag source) and
 * timeline Track lanes (drop target). Phase 4.0.
 *
 * HTML5 DnD only exposes payload DATA on drop; during dragover a target may
 * read just the TYPE strings. So the asset id travels as data under
 * ASSET_DRAG_TYPE, and the asset's kind is additionally encoded as a marker
 * TYPE so lanes can accept/refuse (cursor feedback) mid-drag without seeing
 * the payload. Formats stay lowercase — setData() lowercases them anyway.
 *
 * Kind policy lives here, not in domain/: operations.ts cannot see assets
 * (they live in mediaStore), so which asset kinds may land on which track
 * kind is gated at the UI boundary before insertClip is ever called.
 */

import type { AssetKind, TrackKind } from '../domain/schema'

/** dataTransfer format whose payload is the dragged MediaAsset's id. */
export const ASSET_DRAG_TYPE = 'application/x-webcut-asset'

/** Marker format (empty payload) advertising the dragged asset's kind. */
export function assetKindDragType(kind: AssetKind): string {
  return `${ASSET_DRAG_TYPE}-kind-${kind}`
}

/** Asset kinds each track kind accepts (images composite on video lanes). */
const ACCEPTED: Record<TrackKind, readonly AssetKind[]> = {
  video: ['video', 'image'],
  audio: ['audio'],
}

/** True when an in-flight drag (its type list) may drop on `trackKind`. */
export function trackAcceptsAssetDrag(
  trackKind: TrackKind,
  types: readonly string[],
): boolean {
  return ACCEPTED[trackKind].some((kind) =>
    types.includes(assetKindDragType(kind)),
  )
}
