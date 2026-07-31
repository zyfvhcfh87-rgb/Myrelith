/** Small serializable projection published by previewController. */

import { create } from 'zustand'
import type { AssetId } from '../domain/schema'

export interface PreviewStatusState {
  /** Durable offline visual sources needed by the displayed timeline frame. */
  offlineVisualAssetIds: readonly AssetId[]
  setOfflineVisualAssetIds(ids: readonly AssetId[]): void
  resetPreviewStatus(): void
}

const EMPTY_OFFLINE_IDS: readonly AssetId[] = Object.freeze([])

function idsMatch(left: readonly AssetId[], right: readonly AssetId[]): boolean {
  return left.length === right.length
    && left.every((id, index) => id === right[index])
}

export const usePreviewStatusStore = create<PreviewStatusState>()((set) => ({
  offlineVisualAssetIds: EMPTY_OFFLINE_IDS,
  setOfflineVisualAssetIds: (ids) =>
    set((state) => {
      if (idsMatch(state.offlineVisualAssetIds, ids)) return state
      return { offlineVisualAssetIds: [...ids] }
    }),
  resetPreviewStatus: () =>
    set((state) => (
      state.offlineVisualAssetIds.length === 0
        ? state
        : { offlineVisualAssetIds: EMPTY_OFFLINE_IDS }
    )),
}))
