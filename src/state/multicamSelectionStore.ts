/** Session-only timeline selection for one linked multicam-item group. */

import { create } from 'zustand'

interface MulticamSelectionState {
  selectedInstanceId: string | null
  setSelectedInstanceId(instanceId: string | null): void
}

export const useMulticamSelectionStore = create<MulticamSelectionState>()(
  (set) => ({
    selectedInstanceId: null,
    setSelectedInstanceId: (selectedInstanceId) => set({ selectedInstanceId }),
  }),
)
