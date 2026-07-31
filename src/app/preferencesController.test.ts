import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
  updateExportProfile,
} from '../domain/exportProfile'
import {
  INITIAL_PREFERENCES_STATE,
  usePreferencesStore,
} from '../state/preferencesStore'
import {
  EXPORT_SELECTION_STORAGE_KEY,
  initPreferencesPersistence,
  USER_PREFERENCES_STORAGE_KEY,
  type PreferencesStorage,
} from './preferencesController'

type StorageSeed = Readonly<Record<string, string | null>>

function storage(
  initial: string | StorageSeed | null = null,
): PreferencesStorage & {
  getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>
  setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
} {
  const values: StorageSeed = typeof initial === 'string'
    ? { [USER_PREFERENCES_STORAGE_KEY]: initial }
    : initial ?? {}
  return {
    getItem: vi.fn<(key: string) => string | null>(
      (key) => values[key] ?? null,
    ),
    setItem: vi.fn<(key: string, value: string) => void>(),
  }
}

let dispose: (() => void) | null = null

beforeEach(() => {
  dispose?.()
  dispose = null
  usePreferencesStore.setState({ ...INITIAL_PREFERENCES_STATE })
})

afterEach(() => {
  dispose?.()
  dispose = null
})

describe('preferences persistence', () => {
  test('loads the minimal versioned preference and persists later changes', () => {
    const backing = storage(JSON.stringify({
      version: 1,
      defaultStillImageDurationMicroseconds: 2_500_000,
    }))
    dispose = initPreferencesPersistence(backing)

    expect(backing.getItem).toHaveBeenCalledWith(USER_PREFERENCES_STORAGE_KEY)
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(2_500_000)

    usePreferencesStore.getState()
      .setDefaultStillImageDurationMicroseconds(8_000_000)
    expect(backing.setItem).toHaveBeenCalledWith(
      USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        defaultStillImageDurationMicroseconds: 8_000_000,
      }),
    )
  })

  test.each([
    '{broken',
    JSON.stringify({ version: 2, defaultStillImageDurationMicroseconds: 1_000_000 }),
    JSON.stringify({ version: 1, defaultStillImageDurationMicroseconds: 10 }),
  ])('falls back safely for invalid persisted data', (raw) => {
    dispose = initPreferencesPersistence(storage(raw))
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(5_000_000)
  })

  test.each([
    'auto',
    'compatibility',
    'web',
    'modern',
    'hevc',
  ] as const)('loads the independent versioned %s export selection', (selectionId) => {
    const backing = storage({
      [EXPORT_SELECTION_STORAGE_KEY]: JSON.stringify({
        version: 1,
        selectionId,
      }),
    })

    dispose = initPreferencesPersistence(backing)

    expect(backing.getItem).toHaveBeenCalledWith(EXPORT_SELECTION_STORAGE_KEY)
    expect(usePreferencesStore.getState().exportSelection).toEqual({
      selectionId,
      profile: null,
    })
  })

  test('loads, validates, and persists a custom export profile', () => {
    const custom = updateExportProfile(exportPresetById('web').profile, {
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
      videoBitrate: 12_000_000,
    })
    const backing = storage({
      [EXPORT_SELECTION_STORAGE_KEY]: JSON.stringify({
        version: 1,
        selectionId: 'custom',
        profile: custom,
      }),
    })

    dispose = initPreferencesPersistence(backing)

    const loaded = usePreferencesStore.getState().exportSelection
    expect(loaded).toEqual({ selectionId: 'custom', profile: custom })
    expect(loaded.profile).not.toBe(custom)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.profile)).toBe(true)

    usePreferencesStore.getState().setExportSelection({
      selectionId: 'custom',
      profile: DEFAULT_EXPORT_PROFILE,
    })
    expect(backing.setItem).toHaveBeenCalledWith(
      EXPORT_SELECTION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectionId: 'custom',
        profile: DEFAULT_EXPORT_PROFILE,
      }),
    )
  })

  test('persists a recommended selection without stale custom profile data', () => {
    const backing = storage()
    dispose = initPreferencesPersistence(backing)

    usePreferencesStore.getState().setExportSelection({
      selectionId: 'auto',
      profile: DEFAULT_EXPORT_PROFILE,
    })

    expect(backing.setItem).toHaveBeenCalledWith(
      EXPORT_SELECTION_STORAGE_KEY,
      JSON.stringify({ version: 1, selectionId: 'auto' }),
    )
  })

  test.each([
    '{broken',
    JSON.stringify({ version: 2, selectionId: 'auto' }),
    JSON.stringify({ version: 1, selectionId: 'mystery' }),
    JSON.stringify({ version: 1, selectionId: 'custom' }),
    JSON.stringify({
      version: 1,
      selectionId: 'custom',
      profile: { ...DEFAULT_EXPORT_PROFILE, fileExtension: 'webm' },
    }),
  ])('falls back to Compatibility for invalid export selection data', (raw) => {
    dispose = initPreferencesPersistence(storage({
      [USER_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        version: 1,
        defaultStillImageDurationMicroseconds: 2_500_000,
      }),
      [EXPORT_SELECTION_STORAGE_KEY]: raw,
    }))

    expect(usePreferencesStore.getState().exportSelection).toEqual({
      selectionId: 'compatibility',
      profile: null,
    })
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(2_500_000)
  })

  test('loads a valid export selection when the unrelated preference is invalid', () => {
    dispose = initPreferencesPersistence(storage({
      [USER_PREFERENCES_STORAGE_KEY]: '{broken',
      [EXPORT_SELECTION_STORAGE_KEY]: JSON.stringify({
        version: 1,
        selectionId: 'auto',
      }),
    }))

    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(5_000_000)
    expect(usePreferencesStore.getState().exportSelection).toEqual({
      selectionId: 'auto',
      profile: null,
    })
  })

  test('keeps the in-memory preference usable when storage throws', () => {
    const backing = storage()
    backing.getItem.mockImplementation(() => {
      throw new DOMException('disabled')
    })
    backing.setItem.mockImplementation(() => {
      throw new DOMException('quota')
    })
    dispose = initPreferencesPersistence(backing)

    expect(() => usePreferencesStore.getState()
      .setDefaultStillImageDurationMicroseconds(3_000_000)).not.toThrow()
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(3_000_000)
    expect(() => usePreferencesStore.getState().setExportSelection({
      selectionId: 'auto',
      profile: null,
    })).not.toThrow()
    expect(usePreferencesStore.getState().exportSelection.selectionId).toBe('auto')
  })

  test('keeps the in-memory preference usable when localStorage access throws', () => {
    const localStorageGetter = vi.spyOn(window, 'localStorage', 'get')
      .mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError')
      })
    try {
      expect(() => {
        dispose = initPreferencesPersistence()
      }).not.toThrow()
    } finally {
      localStorageGetter.mockRestore()
    }

    usePreferencesStore.getState()
      .setDefaultStillImageDurationMicroseconds(3_000_000)
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(3_000_000)
    usePreferencesStore.getState().setExportSelection({
      selectionId: 'auto',
      profile: null,
    })
    expect(usePreferencesStore.getState().exportSelection.selectionId).toBe('auto')
  })
})
