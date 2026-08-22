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
 * Kind policy is owned by domain/mediaPlacement.ts and exposed through
 * the app placement facade. This module only maps HTML5 type strings
 * onto that policy so lanes can refuse mid-drag without seeing the payload.
 * An in-flight asset session carries duration for the hover ghost because
 * getData() is unavailable until drop.
 */

import { trackKindAcceptsAssetKind } from '../app/mediaPlacementController'
import type { AssetKind, TrackKind } from '../domain/schema'

/** dataTransfer format whose payload is the dragged MediaAsset's id. */
export const ASSET_DRAG_TYPE = 'application/x-myrelith-asset'

/** Marker format (empty payload) advertising the dragged asset's kind. */
export function assetKindDragType(kind: AssetKind): string {
  return `${ASSET_DRAG_TYPE}-kind-${kind}`
}

const ASSET_KINDS: readonly AssetKind[] = ['video', 'audio', 'image']

/** Serializable payload published on Media Pool dragstart for hover ghosts. */
export interface ActiveAssetDrag {
  assetId: string
  kind: AssetKind
  durationFrames: number
}

let activeAssetDrag: ActiveAssetDrag | null = null

export function beginAssetDrag(payload: ActiveAssetDrag): void {
  activeAssetDrag = payload
}

export function endAssetDrag(): void {
  activeAssetDrag = null
}

export function getActiveAssetDrag(): ActiveAssetDrag | null {
  return activeAssetDrag
}

/** True when an in-flight drag (its type list) may drop on `trackKind`. */
export function trackAcceptsAssetDrag(
  trackKind: TrackKind,
  types: readonly string[],
): boolean {
  return ASSET_KINDS.some((kind) =>
    trackKindAcceptsAssetKind(trackKind, kind)
    && types.includes(assetKindDragType(kind)),
  )
}
