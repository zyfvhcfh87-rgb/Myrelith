/**
 * Versioned browser persistence for the deliberately small preference state.
 */

import { isValidStillImageDurationMicroseconds } from '../domain/staticImage'
import {
  INITIAL_PREFERENCES_STATE,
  usePreferencesStore,
  validateExportSelectionPreference,
  type ExportPreferenceSelectionId,
  type ExportSelectionPreference,
} from '../state/preferencesStore'

export const USER_PREFERENCES_STORAGE_KEY = 'webcut.preferences:v1'
export const EXPORT_SELECTION_STORAGE_KEY = 'webcut.export-selection:v1'

interface PersistedPreferencesV1 {
  version: 1
  defaultStillImageDurationMicroseconds: number
}

interface PersistedExportSelectionV1 {
  version: 1
  selectionId: ExportPreferenceSelectionId
  profile?: ExportSelectionPreference['profile']
}

export interface PreferencesStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function parsePersistedPreferences(raw: string | null): PersistedPreferencesV1 | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (
      record.version !== 1
      || !isValidStillImageDurationMicroseconds(
        record.defaultStillImageDurationMicroseconds,
      )
    ) return null
    return {
      version: 1,
      defaultStillImageDurationMicroseconds:
        record.defaultStillImageDurationMicroseconds,
    }
  } catch {
    return null
  }
}

function serializePreferences(durationMicroseconds: number): string {
  const value: PersistedPreferencesV1 = {
    version: 1,
    defaultStillImageDurationMicroseconds: durationMicroseconds,
  }
  return JSON.stringify(value)
}

function parsePersistedExportSelection(
  raw: string | null,
): Readonly<ExportSelectionPreference> | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (record.version !== 1 || typeof record.selectionId !== 'string') {
      return null
    }
    return validateExportSelectionPreference({
      selectionId: record.selectionId as ExportPreferenceSelectionId,
      profile: (record.profile ?? null) as ExportSelectionPreference['profile'],
    })
  } catch {
    return null
  }
}

function serializeExportSelection(
  preference: Readonly<ExportSelectionPreference>,
): string {
  const value: PersistedExportSelectionV1 = preference.selectionId === 'custom'
    ? {
        version: 1,
        selectionId: 'custom',
        profile: preference.profile,
      }
    : { version: 1, selectionId: preference.selectionId }
  return JSON.stringify(value)
}

let activeDisposer: (() => void) | null = null

export function initPreferencesPersistence(
  storage?: PreferencesStorage,
): () => void {
  if (activeDisposer) return activeDisposer

  usePreferencesStore.setState({ ...INITIAL_PREFERENCES_STATE })
  let persistenceStorage = storage ?? null
  if (persistenceStorage === null) {
    try {
      // Accessing the localStorage getter itself can throw for opaque or
      // storage-disabled origins, before getItem ever has a chance to run.
      persistenceStorage = window.localStorage
    } catch {
      // The in-memory preference remains fully usable for this session.
    }
  }
  if (persistenceStorage !== null) {
    try {
      const persisted = parsePersistedPreferences(
        persistenceStorage.getItem(USER_PREFERENCES_STORAGE_KEY),
      )
      if (persisted) {
        usePreferencesStore.setState({
          defaultStillImageDurationMicroseconds:
            persisted.defaultStillImageDurationMicroseconds,
        })
      }
    } catch {
      // Storage can be disabled or unavailable. The in-memory default remains.
    }
    try {
      const persisted = parsePersistedExportSelection(
        persistenceStorage.getItem(EXPORT_SELECTION_STORAGE_KEY),
      )
      if (persisted) {
        usePreferencesStore.setState({ exportSelection: persisted })
      }
    } catch {
      // Export selection persistence is independent from other preferences.
    }
  }

  const unsubscribe = usePreferencesStore.subscribe((state, previous) => {
    if (
      state.defaultStillImageDurationMicroseconds
      !== previous.defaultStillImageDurationMicroseconds
      && persistenceStorage !== null
    ) {
      try {
        persistenceStorage.setItem(
          USER_PREFERENCES_STORAGE_KEY,
          serializePreferences(state.defaultStillImageDurationMicroseconds),
        )
      } catch {
        // Preference changes still work for this session when storage rejects.
      }
    }
    if (state.exportSelection === previous.exportSelection) return
    if (persistenceStorage === null) return
    try {
      persistenceStorage.setItem(
        EXPORT_SELECTION_STORAGE_KEY,
        serializeExportSelection(state.exportSelection),
      )
    } catch {
      // Export selection changes remain usable for this session.
    }
  })

  const dispose = (): void => {
    if (activeDisposer !== dispose) return
    activeDisposer = null
    unsubscribe()
  }
  activeDisposer = dispose
  return dispose
}
