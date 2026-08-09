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
import {
  INITIAL_WORKSPACE_LAYOUT,
  useWorkspaceLayoutStore,
  validateWorkspaceLayoutPreference,
  type WorkspaceLayoutPreference,
} from '../state/workspaceLayoutStore'

export const USER_PREFERENCES_STORAGE_KEY = 'myrelith.preferences:v1'
export const EXPORT_SELECTION_STORAGE_KEY = 'myrelith.export-selection:v1'
export const WORKSPACE_LAYOUT_STORAGE_KEY = 'myrelith.workspace:v1'
/** Local-storage keys written before the Myrelith rebrand. */
export const LEGACY_USER_PREFERENCES_STORAGE_KEY = 'webcut.preferences:v1'
export const LEGACY_EXPORT_SELECTION_STORAGE_KEY = 'webcut.export-selection:v1'
export const LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY = 'webcut.workspace:v1'

interface PersistedPreferencesV1 {
  version: 1
  defaultStillImageDurationMicroseconds: number
  snappingEnabled: boolean
}

interface PersistedExportSelectionV1 {
  version: 1
  selectionId: ExportPreferenceSelectionId
  profile?: ExportSelectionPreference['profile']
}

interface PersistedWorkspaceLayoutV1 extends WorkspaceLayoutPreference {
  version: 1
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
      || (record.snappingEnabled !== undefined
        && typeof record.snappingEnabled !== 'boolean')
    ) return null
    return {
      version: 1,
      defaultStillImageDurationMicroseconds:
        record.defaultStillImageDurationMicroseconds,
      // Existing v1 records predate snapping. Missing means the safe product
      // default, while an explicit false survives restarts and the rebrand.
      snappingEnabled: record.snappingEnabled ?? true,
    }
  } catch {
    return null
  }
}

function serializePreferences(
  durationMicroseconds: number,
  snappingEnabled: boolean,
): string {
  const value: PersistedPreferencesV1 = {
    version: 1,
    defaultStillImageDurationMicroseconds: durationMicroseconds,
    snappingEnabled,
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

function parsePersistedWorkspaceLayout(
  raw: string | null,
): Readonly<WorkspaceLayoutPreference> | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const { version, ...preference } = value as Record<string, unknown>
    if (version !== 1) return null
    return validateWorkspaceLayoutPreference(preference)
  } catch {
    return null
  }
}

function serializeWorkspaceLayout(
  preference: WorkspaceLayoutPreference,
): string {
  const value: PersistedWorkspaceLayoutV1 = {
    version: 1,
    preset: preference.preset,
    mediaWidth: preference.mediaWidth,
    inspectorWidth: preference.inspectorWidth,
    timelineHeight: preference.timelineHeight,
    mediaCollapsed: preference.mediaCollapsed,
    inspectorCollapsed: preference.inspectorCollapsed,
    timelineCollapsed: preference.timelineCollapsed,
    inspectorFocused: preference.inspectorFocused,
    inspectorRestoreWidth: preference.inspectorRestoreWidth,
  }
  return JSON.stringify(value)
}

let activeDisposer: (() => void) | null = null

export function initPreferencesPersistence(
  storage?: PreferencesStorage,
): () => void {
  if (activeDisposer) return activeDisposer

  usePreferencesStore.setState({ ...INITIAL_PREFERENCES_STATE })
  useWorkspaceLayoutStore.setState({ ...INITIAL_WORKSPACE_LAYOUT })
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
      ) ?? parsePersistedPreferences(
        persistenceStorage.getItem(LEGACY_USER_PREFERENCES_STORAGE_KEY),
      )
      if (persisted) {
        usePreferencesStore.setState({
          defaultStillImageDurationMicroseconds:
            persisted.defaultStillImageDurationMicroseconds,
          snappingEnabled: persisted.snappingEnabled,
        })
      }
    } catch {
      // Storage can be disabled or unavailable. The in-memory default remains.
    }
    try {
      const persisted = parsePersistedExportSelection(
        persistenceStorage.getItem(EXPORT_SELECTION_STORAGE_KEY),
      ) ?? parsePersistedExportSelection(
        persistenceStorage.getItem(LEGACY_EXPORT_SELECTION_STORAGE_KEY),
      )
      if (persisted) {
        usePreferencesStore.setState({ exportSelection: persisted })
      }
    } catch {
      // Export selection persistence is independent from other preferences.
    }
    try {
      const persisted = parsePersistedWorkspaceLayout(
        persistenceStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY),
      ) ?? parsePersistedWorkspaceLayout(
        persistenceStorage.getItem(LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY),
      )
      if (persisted) {
        useWorkspaceLayoutStore.getState().hydrateWorkspaceLayout(persisted)
      }
    } catch {
      // Workspace geometry remains usable in memory when storage rejects.
    }
  }

  const unsubscribe = usePreferencesStore.subscribe((state, previous) => {
    if (
      (
        state.defaultStillImageDurationMicroseconds
        !== previous.defaultStillImageDurationMicroseconds
        || state.snappingEnabled !== previous.snappingEnabled
      )
      && persistenceStorage !== null
    ) {
      try {
        persistenceStorage.setItem(
          USER_PREFERENCES_STORAGE_KEY,
          serializePreferences(
            state.defaultStillImageDurationMicroseconds,
            state.snappingEnabled,
          ),
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
  const unsubscribeWorkspace = useWorkspaceLayoutStore.subscribe(
    (state, previous) => {
      if (
        state.preset === previous.preset
        && state.mediaWidth === previous.mediaWidth
        && state.inspectorWidth === previous.inspectorWidth
        && state.timelineHeight === previous.timelineHeight
        && state.mediaCollapsed === previous.mediaCollapsed
        && state.inspectorCollapsed === previous.inspectorCollapsed
        && state.timelineCollapsed === previous.timelineCollapsed
        && state.inspectorFocused === previous.inspectorFocused
        && state.inspectorRestoreWidth === previous.inspectorRestoreWidth
      ) return
      if (persistenceStorage === null) return
      try {
        persistenceStorage.setItem(
          WORKSPACE_LAYOUT_STORAGE_KEY,
          serializeWorkspaceLayout(state),
        )
      } catch {
        // Resizing remains a session-only preference if storage is unavailable.
      }
    },
  )

  const dispose = (): void => {
    if (activeDisposer !== dispose) return
    activeDisposer = null
    unsubscribe()
    unsubscribeWorkspace()
  }
  activeDisposer = dispose
  return dispose
}
