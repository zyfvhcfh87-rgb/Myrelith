import { describe, expect, test } from 'vitest'
import {
  INITIAL_WORKSPACE_LAYOUT,
  WORKSPACE_PANEL_LIMITS,
  type WorkspaceLayoutPreference,
} from '../state/workspaceLayoutStore'
import { fitWorkspaceLayout } from './workspaceLayout'

function preference(
  update: Partial<WorkspaceLayoutPreference> = {},
): WorkspaceLayoutPreference {
  return { ...INITIAL_WORKSPACE_LAYOUT, ...update }
}

describe('workspace layout sizing', () => {
  test('retains requested sizes when the monitor has enough room', () => {
    expect(fitWorkspaceLayout(preference(), { width: 1440, height: 900 }))
      .toMatchObject({
        mediaWidth: 340,
        inspectorWidth: 300,
        timelineHeight: 360,
      })
  })

  test('protects the monitor and visible panel minima at supported shell bounds', () => {
    const fitted = fitWorkspaceLayout(preference(), {
      width: 720,
      height: 570,
    })
    expect(fitted.mediaWidth).toBeGreaterThanOrEqual(
      WORKSPACE_PANEL_LIMITS.media.min,
    )
    expect(fitted.inspectorWidth).toBeGreaterThanOrEqual(
      WORKSPACE_PANEL_LIMITS.inspector.min,
    )
    expect(fitted.mediaWidth + fitted.inspectorWidth).toBe(360)
    expect(fitted.timelineHeight).toBe(180)
  })

  test('gives the active preset priority while fitting narrow workspaces', () => {
    const inspect = fitWorkspaceLayout(preference({
      preset: 'inspect',
      mediaWidth: 240,
      inspectorWidth: 500,
    }), { width: 1040, height: 720 })
    const media = fitWorkspaceLayout(preference({
      preset: 'media',
      mediaWidth: 460,
      inspectorWidth: 240,
    }), { width: 1040, height: 720 })

    expect(inspect).toMatchObject({ mediaWidth: 180, inspectorWidth: 500 })
    expect(media).toMatchObject({ mediaWidth: 460, inspectorWidth: 220 })
  })

  test('collapses panels without losing their preferred stored dimensions', () => {
    expect(fitWorkspaceLayout(preference({
      mediaWidth: 420,
      inspectorWidth: 380,
      timelineHeight: 410,
      mediaCollapsed: true,
      timelineCollapsed: true,
    }), { width: 1440, height: 900 })).toMatchObject({
      mediaWidth: 0,
      inspectorWidth: 380,
      timelineHeight: 0,
    })
  })
})
