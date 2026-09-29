/** Session-only timeline selection for one linked instance group. */

import { create } from 'zustand'

interface InstanceSelectionState {
  selectedInstanceId: string | null
  setSelectedInstanceId(instanceId: string | null): void
}

/** Each instance kind owns an independent store built from this shape. */
export function createInstanceSelectionStore() {
  return create<InstanceSelectionState>()((set) => ({
    selectedInstanceId: null,
    setSelectedInstanceId: (selectedInstanceId) => set({ selectedInstanceId }),
  }))
}
