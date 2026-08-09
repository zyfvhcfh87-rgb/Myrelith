/** Pure sizing policy for the local editor workspace. */

import {
  WORKSPACE_PANEL_LIMITS,
  type WorkspaceLayoutPreference,
} from '../state/workspaceLayoutStore'

export interface WorkspaceViewport {
  readonly width: number
  readonly height: number
}

export interface FittedWorkspaceLayout {
  readonly mediaWidth: number
  readonly inspectorWidth: number
  readonly timelineHeight: number
  readonly mediaMax: number
  readonly inspectorMax: number
  readonly timelineMax: number
}

export const WORKSPACE_CHROME = Object.freeze({
  rowGap: 4,
  columnGap: 0,
  sideHandle: 4,
  timelineHandle: 10,
  toolbarHeight: 56,
  controlsHeight: 36,
  transportHeight: 48,
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function fitSidePanels(
  preference: WorkspaceLayoutPreference,
  capacity: number,
): Readonly<{ mediaWidth: number; inspectorWidth: number }> {
  const mediaVisible = !preference.mediaCollapsed && !preference.inspectorFocused
  const inspectorVisible = !preference.inspectorCollapsed
  if (!mediaVisible && !inspectorVisible) {
    return { mediaWidth: 0, inspectorWidth: 0 }
  }
  if (!mediaVisible) {
    return {
      mediaWidth: 0,
      inspectorWidth: clamp(
        preference.inspectorWidth,
        Math.min(WORKSPACE_PANEL_LIMITS.inspector.min, capacity),
        Math.min(WORKSPACE_PANEL_LIMITS.inspector.max, capacity),
      ),
    }
  }
  if (!inspectorVisible) {
    return {
      mediaWidth: clamp(
        preference.mediaWidth,
        Math.min(WORKSPACE_PANEL_LIMITS.media.min, capacity),
        Math.min(WORKSPACE_PANEL_LIMITS.media.max, capacity),
      ),
      inspectorWidth: 0,
    }
  }

  const mediaMin = WORKSPACE_PANEL_LIMITS.media.min
  const inspectorMin = WORKSPACE_PANEL_LIMITS.inspector.min
  const usable = Math.max(mediaMin + inspectorMin, capacity)
  let mediaWidth = preference.mediaWidth
  let inspectorWidth = preference.inspectorWidth
  const overflow = mediaWidth + inspectorWidth - usable
  if (overflow <= 0) return { mediaWidth, inspectorWidth }

  const inspectorHasPriority =
    preference.inspectorFocused || preference.preset === 'inspect'
  if (inspectorHasPriority) {
    mediaWidth -= Math.min(overflow, mediaWidth - mediaMin)
    inspectorWidth = Math.min(inspectorWidth, usable - mediaWidth)
  } else {
    inspectorWidth -= Math.min(overflow, inspectorWidth - inspectorMin)
    mediaWidth = Math.min(mediaWidth, usable - inspectorWidth)
  }
  return { mediaWidth, inspectorWidth }
}

export function fitWorkspaceLayout(
  preference: WorkspaceLayoutPreference,
  viewport: WorkspaceViewport,
): FittedWorkspaceLayout {
  const horizontalChrome =
    WORKSPACE_CHROME.sideHandle * 2 + WORKSPACE_CHROME.columnGap * 4
  const sideCapacity = Math.max(
    0,
    Math.round(viewport.width)
      - WORKSPACE_PANEL_LIMITS.monitorMinWidth
      - horizontalChrome,
  )
  const { mediaWidth, inspectorWidth } = fitSidePanels(
    preference,
    sideCapacity,
  )

  const verticalChrome =
    WORKSPACE_CHROME.toolbarHeight
    + WORKSPACE_CHROME.controlsHeight
    + WORKSPACE_CHROME.transportHeight
    + WORKSPACE_CHROME.timelineHandle
    + WORKSPACE_CHROME.rowGap * 5
  const timelineCapacity = Math.max(
    0,
    Math.round(viewport.height)
      - WORKSPACE_PANEL_LIMITS.monitorMinHeight
      - verticalChrome,
  )
  const timelineMax = Math.min(
    WORKSPACE_PANEL_LIMITS.timeline.max,
    Math.max(WORKSPACE_PANEL_LIMITS.timeline.min, timelineCapacity),
  )
  const timelineHeight = preference.timelineCollapsed
    ? 0
    : clamp(
        preference.timelineHeight,
        Math.min(WORKSPACE_PANEL_LIMITS.timeline.min, timelineCapacity),
        Math.min(WORKSPACE_PANEL_LIMITS.timeline.max, timelineCapacity),
      )

  return {
    mediaWidth,
    inspectorWidth,
    timelineHeight,
    mediaMax: Math.min(
      WORKSPACE_PANEL_LIMITS.media.max,
      Math.max(
        WORKSPACE_PANEL_LIMITS.media.min,
        sideCapacity - inspectorWidth,
      ),
    ),
    inspectorMax: Math.min(
      WORKSPACE_PANEL_LIMITS.inspector.max,
      Math.max(
        WORKSPACE_PANEL_LIMITS.inspector.min,
        sideCapacity - mediaWidth,
      ),
    ),
    timelineMax,
  }
}
