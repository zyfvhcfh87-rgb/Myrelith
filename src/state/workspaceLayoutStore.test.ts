import { beforeEach, describe, expect, test } from 'vitest'
import {
  INITIAL_WORKSPACE_LAYOUT,
  WORKSPACE_PANEL_LIMITS,
  WORKSPACE_PRESETS,
  useWorkspaceLayoutStore,
  validateWorkspaceLayoutPreference,
} from './workspaceLayoutStore'

beforeEach(() => {
  useWorkspaceLayoutStore.setState({ ...INITIAL_WORKSPACE_LAYOUT })
})

describe('workspace layout store', () => {
  test.each(['edit', 'inspect', 'media'] as const)(
    'applies the deterministic %s preset and expands every panel',
    (preset) => {
      useWorkspaceLayoutStore.getState().togglePanel('timeline')
      useWorkspaceLayoutStore.getState().applyPreset(preset)

      expect(useWorkspaceLayoutStore.getState()).toMatchObject({
        preset,
        ...WORKSPACE_PRESETS[preset],
        mediaCollapsed: false,
        inspectorCollapsed: false,
        timelineCollapsed: false,
        inspectorFocused: false,
        inspectorRestoreWidth: null,
      })
    },
  )

  test('preserves sizes while panels collapse and restores Inspector focus', () => {
    const store = useWorkspaceLayoutStore.getState()
    store.setPanelSize('media', 410)
    store.setPanelSize('inspector', 360)
    store.togglePanel('media')
    expect(useWorkspaceLayoutStore.getState()).toMatchObject({
      mediaWidth: 410,
      mediaCollapsed: true,
    })

    useWorkspaceLayoutStore.getState().togglePanel('media')
    useWorkspaceLayoutStore.getState().setInspectorFocused(true)
    expect(useWorkspaceLayoutStore.getState()).toMatchObject({
      inspectorWidth: WORKSPACE_PANEL_LIMITS.inspectorFocusedWidth,
      inspectorRestoreWidth: 360,
      inspectorFocused: true,
    })

    useWorkspaceLayoutStore.getState().setInspectorFocused(false)
    expect(useWorkspaceLayoutStore.getState()).toMatchObject({
      inspectorWidth: 360,
      inspectorRestoreWidth: null,
      inspectorFocused: false,
      mediaWidth: 410,
      mediaCollapsed: false,
    })
  })

  test('bounds stored dimensions and rejects inconsistent persisted focus state', () => {
    const validated = validateWorkspaceLayoutPreference({
      ...INITIAL_WORKSPACE_LAYOUT,
      preset: 'custom',
      mediaWidth: -900,
      inspectorWidth: 20_000,
      timelineHeight: 333.6,
    })
    expect(validated).toMatchObject({
      mediaWidth: WORKSPACE_PANEL_LIMITS.media.min,
      inspectorWidth: WORKSPACE_PANEL_LIMITS.inspector.max,
      timelineHeight: 334,
    })
    expect(Object.isFrozen(validated)).toBe(true)

    expect(() => validateWorkspaceLayoutPreference({
      ...INITIAL_WORKSPACE_LAYOUT,
      inspectorFocused: true,
      inspectorRestoreWidth: null,
    })).toThrow('inconsistent')
  })
})
