/**
 * app/App.tsx — The editor shell. Phase 3.1.
 *
 * Pure layout: a CSS grid (layout.css) with one named area per panel.
 * Every panel is its own component from ui/; the shell holds no editing or
 * playhead subscriptions. It receives only the project-closing barrier, so
 * ordinary scrubbing still re-renders Playhead/Preview only.
 * (useUndoRedoShortcuts only attaches a window listener — no subscription,
 * no state, no re-renders.)
 */

import { useEffect } from 'react'
import './layout.css'
import Toolbar from '../ui/Toolbar'
import ToolButtons from '../ui/ToolButtons'
import MediaPool from '../ui/MediaPool'
import Preview from '../ui/Preview'
import Inspector from '../ui/Inspector'
import TransportBar from '../ui/TransportBar'
import Timeline from '../ui/timeline/Timeline'
import TimelineZoomControls from '../ui/timeline/TimelineZoomControls'
import ProjectLaunch from '../ui/ProjectLaunch'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts'
import { useEditShortcuts } from './useEditShortcuts'
import { initMediaVisuals } from './mediaVisualsController'

interface EditorShellProps {
  closing: boolean
}

function EditorShell({ closing }: EditorShellProps) {
  useUndoRedoShortcuts()
  useEditShortcuts()
  // Filmstrip/waveform generation for imported assets — idempotent init,
  // no media-store subscriptions in the shell (render-inertness preserved).
  useEffect(() => {
    initMediaVisuals()
  }, [])
  return (
    <div
      className="app-shell"
      data-closing={closing ? 'true' : undefined}
      aria-busy={closing}
    >
      <header className="area-toolbar">
        <Toolbar />
      </header>
      <aside className="area-media-pool" inert={closing}>
        <MediaPool />
      </aside>
      <main className="area-preview" inert={closing}>
        <Preview />
      </main>
      <aside className="area-inspector" inert={closing}>
        <Inspector />
      </aside>
      <section className="area-transport" inert={closing}>
        <ToolButtons />
        <TransportBar />
        <TimelineZoomControls />
      </section>
      {/* data-timeline-scroll: the Ruler virtualizes its ticks against
          this scroll container (see ui/timeline/Ruler.tsx). */}
      <section
        className="area-timeline"
        data-timeline-scroll
        inert={closing}
      >
        <Timeline />
      </section>
    </div>
  )
}

export default function App() {
  const editorActive = useProjectSessionStore(
    (state) => state.screen === 'editor',
  )
  const closing = useProjectSessionStore((state) => state.phase === 'closing')
  return editorActive ? <EditorShell closing={closing} /> : <ProjectLaunch />
}
