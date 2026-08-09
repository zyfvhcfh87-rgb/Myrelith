/** Local workspace presets and panel visibility controls. */

import { useWorkspaceLayoutStore } from '../state/workspaceLayoutStore'

export interface WorkspaceControlsProps {
  onAnnounce(message: string): void
}

export default function WorkspaceControls({
  onAnnounce,
}: WorkspaceControlsProps) {
  const preset = useWorkspaceLayoutStore((state) => state.preset)
  const mediaCollapsed = useWorkspaceLayoutStore(
    (state) => state.mediaCollapsed || state.inspectorFocused,
  )
  const inspectorCollapsed = useWorkspaceLayoutStore(
    (state) => state.inspectorCollapsed,
  )
  const timelineCollapsed = useWorkspaceLayoutStore(
    (state) => state.timelineCollapsed,
  )
  const inspectorFocused = useWorkspaceLayoutStore(
    (state) => state.inspectorFocused,
  )

  const togglePanel = (
    panel: 'media' | 'inspector' | 'timeline',
    collapsed: boolean,
    label: string,
  ): void => {
    useWorkspaceLayoutStore.getState().togglePanel(panel)
    onAnnounce(`${label} panel ${collapsed ? 'restored' : 'collapsed'}.`)
  }

  return (
    <div className="workspace-controls" role="group" aria-label="Workspace layout">
      <label className="workspace-preset-control">
        <span>Workspace</span>
        <select
          aria-label="Workspace preset"
          value={preset}
          onChange={(event) => {
            if (event.target.value === 'custom') return
            const next = event.target.value as 'edit' | 'inspect' | 'media'
            useWorkspaceLayoutStore.getState().applyPreset(next)
            onAnnounce(`${event.target.selectedOptions[0]?.text ?? next} workspace applied.`)
          }}
        >
          <option value="edit">Edit</option>
          <option value="inspect">Inspect</option>
          <option value="media">Media</option>
          <option value="custom" disabled>Custom</option>
        </select>
      </label>
      <span className="workspace-control-divider" aria-hidden="true" />
      <button
        type="button"
        className="workspace-panel-toggle"
        aria-controls="workspace-media-panel"
        aria-pressed={!mediaCollapsed}
        onClick={() => togglePanel('media', mediaCollapsed, 'Media')}
      >
        Media
      </button>
      <button
        type="button"
        className="workspace-panel-toggle"
        aria-controls="workspace-inspector-panel"
        aria-pressed={!inspectorCollapsed}
        onClick={() => togglePanel('inspector', inspectorCollapsed, 'Inspector')}
      >
        Inspector
      </button>
      <button
        type="button"
        className="workspace-panel-toggle"
        aria-controls="workspace-timeline-panel"
        aria-pressed={!timelineCollapsed}
        onClick={() => togglePanel('timeline', timelineCollapsed, 'Timeline')}
      >
        Timeline
      </button>
      <button
        type="button"
        className="workspace-focus-toggle"
        aria-controls="workspace-inspector-panel"
        aria-pressed={inspectorFocused}
        onClick={() => {
          useWorkspaceLayoutStore.getState().setInspectorFocused(!inspectorFocused)
          onAnnounce(
            inspectorFocused
              ? 'Inspector focus mode closed.'
              : 'Inspector focus mode opened. Media is temporarily hidden.',
          )
        }}
      >
        Focus Inspector
      </button>
    </div>
  )
}
