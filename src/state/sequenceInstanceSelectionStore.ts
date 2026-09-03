/** Session-only timeline selection for one linked sequence-instance group. */

import { create } from 'zustand'

interface SequenceInstanceSelectionState {
  selectedInstanceId: string | null
  setSelectedInstanceId(instanceId: string | null): void
}

export const useSequenceInstanceSelectionStore = create<SequenceInstanceSelectionState>()(
  (set) => ({
    selectedInstanceId: null,
    setSelectedInstanceId: (selectedInstanceId) => set({ selectedInstanceId }),
  }),
)
