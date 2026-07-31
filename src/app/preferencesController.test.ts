import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  INITIAL_PREFERENCES_STATE,
  usePreferencesStore,
} from '../state/preferencesStore'
import {
  initPreferencesPersistence,
  USER_PREFERENCES_STORAGE_KEY,
  type PreferencesStorage,
} from './preferencesController'

function storage(initial: string | null = null): PreferencesStorage & {
  getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>
  setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
} {
  return {
    getItem: vi.fn<(key: string) => string | null>(() => initial),
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
  })
})
