/** Small serializable projection published by previewController. */

import { create } from 'zustand'
import type { EffectResolutionStatus } from '../domain/effectStack'
import type { LensRemapAvailability } from '../domain/lensCorrection'
import type { AssetId, EffectId } from '../domain/schema'

export interface PreviewEffectStatus {
  readonly label: string
  readonly status: EffectResolutionStatus
  readonly detail: string
}

export interface PreviewRendererCapabilities {
  readonly canvasFilter: boolean
  readonly canvasPixelAccess: boolean
  readonly lensRemap?: LensRemapAvailability
}

export interface PreviewStatusState {
  /** Durable offline visual sources needed by the displayed timeline frame. */
  offlineVisualAssetIds: readonly AssetId[]
  /** Null until the worker reports its actual preview compositor context. */
  rendererCapabilities: PreviewRendererCapabilities | null
  /** App-owned projection; the Inspector reads but never evaluates effects. */
  effectStatuses: ReadonlyMap<EffectId, PreviewEffectStatus>
  setOfflineVisualAssetIds(ids: readonly AssetId[]): void
  setEffectProjection(
    capabilities: PreviewRendererCapabilities | null,
    statuses: ReadonlyMap<EffectId, PreviewEffectStatus>,
  ): void
  resetPreviewStatus(): void
}

const EMPTY_OFFLINE_IDS: readonly AssetId[] = Object.freeze([])
const EMPTY_EFFECT_STATUSES: ReadonlyMap<EffectId, PreviewEffectStatus> = new Map()

function idsMatch(left: readonly AssetId[], right: readonly AssetId[]): boolean {
  return left.length === right.length
    && left.every((id, index) => id === right[index])
}

export const usePreviewStatusStore = create<PreviewStatusState>()((set) => ({
  offlineVisualAssetIds: EMPTY_OFFLINE_IDS,
  rendererCapabilities: null,
  effectStatuses: EMPTY_EFFECT_STATUSES,
  setOfflineVisualAssetIds: (ids) =>
    set((state) => {
      if (idsMatch(state.offlineVisualAssetIds, ids)) return state
      return { offlineVisualAssetIds: [...ids] }
    }),
  setEffectProjection: (rendererCapabilities, effectStatuses) =>
    set({ rendererCapabilities, effectStatuses: new Map(effectStatuses) }),
  resetPreviewStatus: () =>
    set({
      offlineVisualAssetIds: EMPTY_OFFLINE_IDS,
      rendererCapabilities: null,
      effectStatuses: EMPTY_EFFECT_STATUSES,
    }),
}))
