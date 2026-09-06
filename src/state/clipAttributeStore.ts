import { create } from 'zustand'
import type { ClipAttributeGroup } from '../domain/clipAttributes'

/** Clipboard status only. The app controller owns the copied values. */
export const useClipAttributeStore = create<{
  sourceName: string | null
  groups: readonly ClipAttributeGroup[]
  message: string
}>(() => ({ sourceName: null, groups: [], message: '' }))
