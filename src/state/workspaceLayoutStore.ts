/**
 * Local-only editor workspace preferences.
 *
 * These values shape the browser UI and deliberately never enter TimelineDoc,
 * project serialization, undo history, or portable recovery snapshots.
 */

import { create } from 'zustand'

export type WorkspacePresetId = 'edit' | 'inspect' | 'media' | 'custom'
export type WorkspacePanelId = 'media' | 'inspector' | 'timeline'

export interface WorkspaceLayoutPreference {
  readonly preset: WorkspacePresetId
  readonly mediaWidth: number
  readonly inspectorWidth: number
  readonly timelineHeight: number
  readonly mediaCollapsed: boolean
  readonly inspectorCollapsed: boolean
  readonly timelineCollapsed: boolean
  readonly inspectorFocused: boolean
  readonly inspectorRestoreWidth: number | null
}

export interface WorkspaceLayoutState extends WorkspaceLayoutPreference {
  applyPreset(preset: Exclude<WorkspacePresetId, 'custom'>): void
  setPanelSize(panel: WorkspacePanelId, size: number): void
  togglePanel(panel: WorkspacePanelId): void
  setInspectorFocused(focused: boolean): void
  hydrateWorkspaceLayout(preference: WorkspaceLayoutPreference): void
}

export const WORKSPACE_PANEL_LIMITS = Object.freeze({
  media: Object.freeze({ min: 180, max: 520 }),
  inspector: Object.freeze({ min: 180, max: 640 }),
  timeline: Object.freeze({ min: 180, max: 520 }),
  monitorMinWidth: 352,
  monitorMinHeight: 220,
  inspectorFocusedWidth: 520,
})

export const WORKSPACE_PRESETS = Object.freeze({
  edit: Object.freeze({
    mediaWidth: 340,
    inspectorWidth: 300,
    timelineHeight: 360,
  }),
  inspect: Object.freeze({
    mediaWidth: 240,
    inspectorWidth: 500,
    timelineHeight: 340,
  }),
  media: Object.freeze({
    mediaWidth: 460,
    inspectorWidth: 240,
    timelineHeight: 300,
  }),
}) satisfies Readonly<Record<Exclude<WorkspacePresetId, 'custom'>, {
  readonly mediaWidth: number
  readonly inspectorWidth: number
  readonly timelineHeight: number
}>>

export const INITIAL_WORKSPACE_LAYOUT = Object.freeze({
  preset: 'edit',
  ...WORKSPACE_PRESETS.edit,
  mediaCollapsed: false,
  inspectorCollapsed: false,
  timelineCollapsed: false,
  inspectorFocused: false,
  inspectorRestoreWidth: null,
}) satisfies Readonly<WorkspaceLayoutPreference>

const PRESET_IDS: readonly WorkspacePresetId[] = Object.freeze([
  'edit',
  'inspect',
  'media',
  'custom',
])

function boundedInteger(
  value: number,
  limits: Readonly<{ min: number; max: number }>,
): number | null {
  if (!Number.isFinite(value)) return null
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)))
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function validateWorkspaceLayoutPreference(
  value: unknown,
): Readonly<WorkspaceLayoutPreference> {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Workspace preference must be an object')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.preset !== 'string'
    || !PRESET_IDS.some((preset) => preset === record.preset)
  ) {
    throw new TypeError('Unknown workspace preset')
  }
  const mediaWidth = boundedInteger(
    record.mediaWidth as number,
    WORKSPACE_PANEL_LIMITS.media,
  )
  const inspectorWidth = boundedInteger(
    record.inspectorWidth as number,
    WORKSPACE_PANEL_LIMITS.inspector,
  )
  const timelineHeight = boundedInteger(
    record.timelineHeight as number,
    WORKSPACE_PANEL_LIMITS.timeline,
  )
  if (
    mediaWidth === null
    || inspectorWidth === null
    || timelineHeight === null
    || !isBoolean(record.mediaCollapsed)
    || !isBoolean(record.inspectorCollapsed)
    || !isBoolean(record.timelineCollapsed)
    || !isBoolean(record.inspectorFocused)
  ) {
    throw new TypeError('Invalid workspace panel preference')
  }
  const restoreWidth = record.inspectorRestoreWidth === null
    ? null
    : boundedInteger(
        record.inspectorRestoreWidth as number,
        WORKSPACE_PANEL_LIMITS.inspector,
      )
  if (restoreWidth === null && record.inspectorRestoreWidth !== null) {
    throw new TypeError('Invalid Inspector restore width')
  }
  if (record.inspectorFocused !== (restoreWidth !== null)) {
    throw new TypeError('Inspector focus restore state is inconsistent')
  }
  return Object.freeze({
    preset: record.preset as WorkspacePresetId,
    mediaWidth,
    inspectorWidth,
    timelineHeight,
    mediaCollapsed: record.mediaCollapsed,
    inspectorCollapsed: record.inspectorCollapsed,
    timelineCollapsed: record.timelineCollapsed,
    inspectorFocused: record.inspectorFocused,
    inspectorRestoreWidth: restoreWidth,
  })
}

function presetPreference(
  preset: Exclude<WorkspacePresetId, 'custom'>,
): WorkspaceLayoutPreference {
  return {
    preset,
    ...WORKSPACE_PRESETS[preset],
    mediaCollapsed: false,
    inspectorCollapsed: false,
    timelineCollapsed: false,
    inspectorFocused: false,
    inspectorRestoreWidth: null,
  }
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>()((set) => ({
  ...INITIAL_WORKSPACE_LAYOUT,
  applyPreset: (preset) => set(presetPreference(preset)),
  setPanelSize: (panel, size) => set((state) => {
    const bounded = boundedInteger(size, WORKSPACE_PANEL_LIMITS[panel])
    if (bounded === null) return state
    if (panel === 'media') {
      return {
        preset: 'custom',
        mediaWidth: bounded,
        mediaCollapsed: false,
        inspectorFocused: false,
        inspectorWidth:
          state.inspectorRestoreWidth ?? state.inspectorWidth,
        inspectorRestoreWidth: null,
      }
    }
    if (panel === 'inspector') {
      return {
        preset: 'custom',
        inspectorWidth: bounded,
        inspectorCollapsed: false,
      }
    }
    return {
      preset: 'custom',
      timelineHeight: bounded,
      timelineCollapsed: false,
    }
  }),
  togglePanel: (panel) => set((state) => {
    if (panel === 'media') {
      if (state.inspectorFocused) {
        return {
          preset: 'custom',
          mediaCollapsed: false,
          inspectorFocused: false,
          inspectorWidth:
            state.inspectorRestoreWidth ?? state.inspectorWidth,
          inspectorRestoreWidth: null,
        }
      }
      return { preset: 'custom', mediaCollapsed: !state.mediaCollapsed }
    }
    if (panel === 'inspector') {
      return {
        preset: 'custom',
        inspectorCollapsed: state.inspectorFocused
          ? true
          : !state.inspectorCollapsed,
        inspectorFocused: false,
        inspectorWidth:
          state.inspectorRestoreWidth ?? state.inspectorWidth,
        inspectorRestoreWidth: null,
      }
    }
    return { preset: 'custom', timelineCollapsed: !state.timelineCollapsed }
  }),
  setInspectorFocused: (focused) => set((state) => {
    if (focused === state.inspectorFocused) return state
    if (focused) {
      return {
        preset: 'custom',
        inspectorCollapsed: false,
        inspectorFocused: true,
        inspectorRestoreWidth: state.inspectorWidth,
        inspectorWidth: Math.max(
          state.inspectorWidth,
          WORKSPACE_PANEL_LIMITS.inspectorFocusedWidth,
        ),
      }
    }
    return {
      preset: 'custom',
      inspectorFocused: false,
      inspectorWidth: state.inspectorRestoreWidth ?? state.inspectorWidth,
      inspectorRestoreWidth: null,
    }
  }),
  hydrateWorkspaceLayout: (preference) => set(
    validateWorkspaceLayoutPreference(preference),
  ),
}))
