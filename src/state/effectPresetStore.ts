import { create } from 'zustand'
import type { EffectPresetLibraryView } from '../domain/effectPresets'
export const useEffectPresetStore = create<EffectPresetLibraryView & { busy: boolean; loaded: boolean; message: string; error: string | null }>(() => ({
  presets: [], unavailable: [], readOnlyReason: null, busy: false, loaded: false, message: '', error: null,
}))
