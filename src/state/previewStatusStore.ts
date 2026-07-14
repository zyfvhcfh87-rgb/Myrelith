/** Small serializable projection published by previewController. */

import { create } from 'zustand'
import type { AssetId } from '../domain/schema'

export interface PreviewStatusState {
  /** Durable offline sources needed by the currently displayed video frame. */
  offlineVideoAssetIds: readonly AssetId[]
  setOfflineVideoAssetIds(ids: readonly AssetId[]): void
  resetPreviewStatus(): void
}

const EMPTY_OFFLINE_IDS: readonly AssetId[] = Object.freeze([])

function idsMatch(left: readonly AssetId[], right: readonly AssetId[]): boolean {
  return left.length === right.length
    && left.every((id, index) => id === right[index])
}

export const usePreviewStatusStore = create<PreviewStatusState>()((set) => ({
  offlineVideoAssetIds: EMPTY_OFFLINE_IDS,
  setOfflineVideoAssetIds: (ids) =>
    set((state) => {
      if (idsMatch(state.offlineVideoAssetIds, ids)) return state
      return { offlineVideoAssetIds: [...ids] }
    }),
  resetPreviewStatus: () =>
    set((state) => (
      state.offlineVideoAssetIds.length === 0
        ? state
        : { offlineVideoAssetIds: EMPTY_OFFLINE_IDS }
    )),
}))
