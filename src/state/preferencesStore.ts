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

export type MediaPoolViewMode = 'thumbnail' | 'details' | 'compact-list'
export type MediaPoolThumbnailSize = 'small' | 'medium' | 'large'
export type MediaPoolSortField =
  | 'project-order'
  | 'name'
  | 'kind'
  | 'duration'
  | 'last-modified'
  | 'size'
export type MediaPoolSortDirection = 'ascending' | 'descending'

export interface MediaPoolViewPreference {
  readonly viewMode: MediaPoolViewMode
  readonly thumbnailSize: MediaPoolThumbnailSize
  readonly sortField: MediaPoolSortField
  readonly sortDirection: MediaPoolSortDirection
}

export interface PreferencesState {
  defaultStillImageDurationMicroseconds: number
  /** Persistent user intent; Alt temporarily bypasses it during an edit. */
  snappingEnabled: boolean
  exportSelection: Readonly<ExportSelectionPreference>
  mediaPoolView: Readonly<MediaPoolViewPreference>
  setDefaultStillImageDurationMicroseconds(value: number): void
  setSnappingEnabled(value: boolean): void
  setExportSelection(value: ExportSelectionPreference): void
  setMediaPoolView(value: MediaPoolViewPreference): void
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

const MEDIA_POOL_VIEW_MODES: readonly MediaPoolViewMode[] = Object.freeze([
  'thumbnail',
  'details',
  'compact-list',
])
const MEDIA_POOL_THUMBNAIL_SIZES: readonly MediaPoolThumbnailSize[] = Object.freeze([
  'small',
  'medium',
  'large',
])
const MEDIA_POOL_SORT_FIELDS: readonly MediaPoolSortField[] = Object.freeze([
  'project-order',
  'name',
  'kind',
  'duration',
  'last-modified',
  'size',
])
const MEDIA_POOL_SORT_DIRECTIONS: readonly MediaPoolSortDirection[] = Object.freeze([
  'ascending',
  'descending',
])

export const INITIAL_MEDIA_POOL_VIEW_PREFERENCE = Object.freeze({
  viewMode: 'details',
  thumbnailSize: 'medium',
  sortField: 'project-order',
  sortDirection: 'ascending',
}) satisfies Readonly<MediaPoolViewPreference>

export const INITIAL_PREFERENCES_STATE = Object.freeze({
  defaultStillImageDurationMicroseconds:
    DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
  snappingEnabled: true,
  exportSelection: INITIAL_EXPORT_SELECTION,
  mediaPoolView: INITIAL_MEDIA_POOL_VIEW_PREFERENCE,
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

export function validateMediaPoolViewPreference(
  value: MediaPoolViewPreference,
): Readonly<MediaPoolViewPreference> {
  if (!MEDIA_POOL_VIEW_MODES.some((candidate) => candidate === value.viewMode)) {
    throw new TypeError('Unknown Media Pool view mode')
  }
  if (!MEDIA_POOL_THUMBNAIL_SIZES.some((candidate) => candidate === value.thumbnailSize)) {
    throw new TypeError('Unknown Media Pool thumbnail size')
  }
  if (!MEDIA_POOL_SORT_FIELDS.some((candidate) => candidate === value.sortField)) {
    throw new TypeError('Unknown Media Pool sort field')
  }
  if (!MEDIA_POOL_SORT_DIRECTIONS.some((candidate) => candidate === value.sortDirection)) {
    throw new TypeError('Unknown Media Pool sort direction')
  }
  return Object.freeze({
    viewMode: value.viewMode,
    thumbnailSize: value.thumbnailSize,
    sortField: value.sortField,
    sortDirection: value.sortDirection,
  })
}

export const usePreferencesStore = create<PreferencesState>()((set) => ({
  ...INITIAL_PREFERENCES_STATE,
  setDefaultStillImageDurationMicroseconds: (value) => {
    if (!isValidStillImageDurationMicroseconds(value)) return
    set((state) => state.defaultStillImageDurationMicroseconds === value
      ? state
      : { defaultStillImageDurationMicroseconds: value })
  },
  setSnappingEnabled: (value) => {
    if (typeof value !== 'boolean') return
    set((state) => state.snappingEnabled === value
      ? state
      : { snappingEnabled: value })
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
  setMediaPoolView: (value) => {
    let mediaPoolView: Readonly<MediaPoolViewPreference>
    try {
      mediaPoolView = validateMediaPoolViewPreference(value)
    } catch {
      return
    }
    set((state) => (
      state.mediaPoolView.viewMode === mediaPoolView.viewMode
      && state.mediaPoolView.thumbnailSize === mediaPoolView.thumbnailSize
      && state.mediaPoolView.sortField === mediaPoolView.sortField
      && state.mediaPoolView.sortDirection === mediaPoolView.sortDirection
        ? state
        : { mediaPoolView }
    ))
  },
}))
