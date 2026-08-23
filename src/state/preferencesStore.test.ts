import { beforeEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
} from '../domain/exportProfile'
import {
  INITIAL_EXPORT_SELECTION,
  INITIAL_MEDIA_POOL_VIEW_PREFERENCE,
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
    expect(usePreferencesStore.getState().exportSelection).toBe(
      INITIAL_EXPORT_SELECTION,
    )
    expect(usePreferencesStore.getState().exportSelection).toEqual({
      selectionId: 'compatibility',
      profile: null,
    })
    expect(usePreferencesStore.getState().snappingEnabled).toBe(true)
  })

  test('stores the accessible snapping preference idempotently', () => {
    const before = usePreferencesStore.getState()
    before.setSnappingEnabled(true)
    expect(usePreferencesStore.getState()).toBe(before)

    before.setSnappingEnabled(false)
    expect(usePreferencesStore.getState().snappingEnabled).toBe(false)
    const disabled = usePreferencesStore.getState()
    disabled.setSnappingEnabled(false)
    expect(usePreferencesStore.getState()).toBe(disabled)
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

  test.each([
    'auto',
    'compatibility',
    'web',
    'modern',
    'hevc',
  ] as const)('accepts and canonicalizes the %s catalog selection', (selectionId) => {
    usePreferencesStore.getState().setExportSelection({
      selectionId,
      profile: DEFAULT_EXPORT_PROFILE,
    })

    const selection = usePreferencesStore.getState().exportSelection
    expect(selection).toEqual({ selectionId, profile: null })
    expect(Object.isFrozen(selection)).toBe(true)
  })

  test('accepts a detached validated custom profile', () => {
    const input = {
      ...exportPresetById('web').profile,
      audioCodec: null,
      audioChannelLayout: 'off',
      audioBitrate: null,
      audioBitrateMode: null,
    } as const

    usePreferencesStore.getState().setExportSelection({
      selectionId: 'custom',
      profile: input,
    })

    const selection = usePreferencesStore.getState().exportSelection
    expect(selection.selectionId).toBe('custom')
    expect(selection.profile).toEqual(input)
    expect(selection.profile).not.toBe(input)
    expect(Object.isFrozen(selection)).toBe(true)
    expect(Object.isFrozen(selection.profile)).toBe(true)
  })

  test('starts with Details, Medium, project order, and ascending sort', () => {
    const view = usePreferencesStore.getState().mediaPoolView
    expect(view).toBe(INITIAL_MEDIA_POOL_VIEW_PREFERENCE)
    expect(view).toEqual({
      viewMode: 'details',
      thumbnailSize: 'medium',
      sortField: 'project-order',
      sortDirection: 'ascending',
    })
    expect(Object.isFrozen(view)).toBe(true)
  })

  test('stores a validated Media Pool view preference idempotently', () => {
    const next = {
      viewMode: 'thumbnail' as const,
      thumbnailSize: 'large' as const,
      sortField: 'name' as const,
      sortDirection: 'descending' as const,
    }
    usePreferencesStore.getState().setMediaPoolView(next)
    const stored = usePreferencesStore.getState().mediaPoolView
    expect(stored).toEqual(next)
    expect(stored).not.toBe(next)
    expect(Object.isFrozen(stored)).toBe(true)

    const before = usePreferencesStore.getState()
    before.setMediaPoolView({ ...next })
    expect(usePreferencesStore.getState()).toBe(before)
  })

  test('ignores an invalid Media Pool view preference without replacing the last valid value', () => {
    usePreferencesStore.getState().setMediaPoolView({
      viewMode: 'compact-list',
      thumbnailSize: 'small',
      sortField: 'duration',
      sortDirection: 'descending',
    })
    const previous = usePreferencesStore.getState().mediaPoolView

    usePreferencesStore.getState().setMediaPoolView({
      viewMode: 'gallery',
      thumbnailSize: 'medium',
      sortField: 'name',
      sortDirection: 'ascending',
    } as never)

    expect(usePreferencesStore.getState().mediaPoolView).toBe(previous)
  })

  test.each([
    { selectionId: 'mystery', profile: null },
    { selectionId: 'custom', profile: null },
    {
      selectionId: 'custom',
      profile: { ...DEFAULT_EXPORT_PROFILE, mimeType: 'video/webm' },
    },
  ])('ignores an invalid export selection without replacing the last valid value', (value) => {
    usePreferencesStore.getState().setExportSelection({
      selectionId: 'auto',
      profile: null,
    })
    const previous = usePreferencesStore.getState().exportSelection

    usePreferencesStore.getState().setExportSelection(value as never)

    expect(usePreferencesStore.getState().exportSelection).toBe(previous)
  })
})
