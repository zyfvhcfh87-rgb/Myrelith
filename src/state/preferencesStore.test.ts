import { beforeEach, describe, expect, test } from 'vitest'
import {
  INITIAL_PREFERENCES_STATE,
  usePreferencesStore,
} from './preferencesStore'

beforeEach(() => {
  usePreferencesStore.setState({ ...INITIAL_PREFERENCES_STATE })
})

describe('preferencesStore', () => {
  test('starts with the canonical five-second image duration', () => {
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(5_000_000)
  })

  test('accepts bounded integer microseconds and ignores invalid values', () => {
    const preferences = usePreferencesStore.getState()
    preferences.setDefaultStillImageDurationMicroseconds(2_500_000)
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(2_500_000)

    for (const invalid of [99_999, 3_600_000_001, 2.5, Number.NaN]) {
      usePreferencesStore.getState()
        .setDefaultStillImageDurationMicroseconds(invalid)
    }
    expect(usePreferencesStore.getState()
      .defaultStillImageDurationMicroseconds).toBe(2_500_000)
  })
})
