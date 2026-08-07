/** Session-only Program Monitor quality preference. */

import { create } from 'zustand'
import type { PresentationQualityMode } from '../domain/presentationProfile'

export interface PreviewQualityState {
  qualityMode: PresentationQualityMode
  setQualityMode(mode: PresentationQualityMode): void
}

export const usePreviewQualityStore = create<PreviewQualityState>()((set) => ({
  qualityMode: 'auto',
  setQualityMode: (qualityMode) =>
    set((state) => state.qualityMode === qualityMode ? state : { qualityMode }),
}))
