/**
 * Small serializable user preferences read by UI and app controllers.
 *
 * Browser persistence stays in app/preferencesController.ts so this state
 * module remains browser-free and keeps the architecture dependency one-way.
 */

import { create } from 'zustand'
import {
  DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
  isValidStillImageDurationMicroseconds,
} from '../domain/staticImage'

export interface PreferencesState {
  defaultStillImageDurationMicroseconds: number
  setDefaultStillImageDurationMicroseconds(value: number): void
}

export const INITIAL_PREFERENCES_STATE = Object.freeze({
  defaultStillImageDurationMicroseconds:
    DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
})

export const usePreferencesStore = create<PreferencesState>()((set) => ({
  ...INITIAL_PREFERENCES_STATE,
  setDefaultStillImageDurationMicroseconds: (value) => {
    if (!isValidStillImageDurationMicroseconds(value)) return
    set((state) => state.defaultStillImageDurationMicroseconds === value
      ? state
      : { defaultStillImageDurationMicroseconds: value })
  },
}))
