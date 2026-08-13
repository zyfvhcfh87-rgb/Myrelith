/** Session-only Program Monitor selection for motion tracking. */

import { create } from 'zustand'
import type { MotionTrackingKind, MotionTrackingSelection } from '../domain/motionTracking'

interface MotionTrackingSelectionState {
  sourceClipId: string | null
  pickingKind: MotionTrackingKind | null
  selection: MotionTrackingSelection | null
  selectionGlobalFrame: number | null
  beginPicking: (sourceClipId: string, kind: MotionTrackingKind) => void
  setSelection: (
    sourceClipId: string,
    selection: MotionTrackingSelection,
    selectionGlobalFrame: number,
  ) => void
  clear: () => void
}

export const useMotionTrackingSelectionStore = create<MotionTrackingSelectionState>()((set) => ({
  sourceClipId: null,
  pickingKind: null,
  selection: null,
  selectionGlobalFrame: null,
  beginPicking: (sourceClipId, pickingKind) => set({
    sourceClipId,
    pickingKind,
    selection: null,
    selectionGlobalFrame: null,
  }),
  setSelection: (sourceClipId, selection, selectionGlobalFrame) => set({
    sourceClipId,
    pickingKind: null,
    selection,
    selectionGlobalFrame,
  }),
  clear: () => set({
    sourceClipId: null,
    pickingKind: null,
    selection: null,
    selectionGlobalFrame: null,
  }),
}))
