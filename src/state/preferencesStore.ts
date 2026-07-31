/**
 * Small serializable user preferences read by UI and app controllers.
 *
 * Browser persistence stays in app/preferencesController.ts so this state
 * module remains browser-free and keeps the architecture dependency one-way.
 */

import { create } from 'zustand'
import {
  DEFAULT_EXPORT_PRESET_ID,
  validateExportProfile,
  type ExportProfile,
  type ExportSelectionId,
} from '../domain/exportProfile'
import {
  DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
  isValidStillImageDurationMicroseconds,
} from '../domain/staticImage'

export interface PreferencesState {
  defaultStillImageDurationMicroseconds: number
  exportSelection: Readonly<ExportSelectionPreference>
  setDefaultStillImageDurationMicroseconds(value: number): void
  setExportSelection(value: ExportSelectionPreference): void
}

export type ExportPreferenceSelectionId = ExportSelectionId | 'custom'

export interface ExportSelectionPreference {
  readonly selectionId: ExportPreferenceSelectionId
  readonly profile: Readonly<ExportProfile> | null
}

export const INITIAL_EXPORT_SELECTION = Object.freeze({
  selectionId: DEFAULT_EXPORT_PRESET_ID,
  profile: null,
}) satisfies Readonly<ExportSelectionPreference>

const EXPORT_SELECTION_IDS: readonly ExportPreferenceSelectionId[] =
  Object.freeze([
    'auto',
    'compatibility',
    'web',
    'modern',
    'hevc',
    'custom',
  ])

export const INITIAL_PREFERENCES_STATE = Object.freeze({
  defaultStillImageDurationMicroseconds:
    DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
  exportSelection: INITIAL_EXPORT_SELECTION,
})

export function validateExportSelectionPreference(
  value: ExportSelectionPreference,
): Readonly<ExportSelectionPreference> {
  if (!EXPORT_SELECTION_IDS.some((candidate) => candidate === value.selectionId)) {
    throw new TypeError('Unknown export preference selection')
  }
  if (value.selectionId === 'custom') {
    return Object.freeze({
      selectionId: 'custom',
      profile: validateExportProfile(value.profile),
    })
  }
  return Object.freeze({ selectionId: value.selectionId, profile: null })
}

export const usePreferencesStore = create<PreferencesState>()((set) => ({
  ...INITIAL_PREFERENCES_STATE,
  setDefaultStillImageDurationMicroseconds: (value) => {
    if (!isValidStillImageDurationMicroseconds(value)) return
    set((state) => state.defaultStillImageDurationMicroseconds === value
      ? state
      : { defaultStillImageDurationMicroseconds: value })
  },
  setExportSelection: (value) => {
    let exportSelection: Readonly<ExportSelectionPreference>
    try {
      exportSelection = validateExportSelectionPreference(value)
    } catch {
      return
    }
    set({ exportSelection })
  },
}))
