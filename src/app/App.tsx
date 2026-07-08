/**
 * app/App.tsx — The editor shell. Phase 3.1.
 *
 * Pure layout: a CSS grid (layout.css) with one named area per panel.
 * Every panel is its own component from ui/; the shell holds NO state and
 * subscribes to NO stores — re-renders here would cascade everywhere, and
 * the Phase 3 gate requires scrubbing to re-render Playhead/Preview only.
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
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts'
import { useEditShortcuts } from './useEditShortcuts'
import { initMediaVisuals } from './mediaVisualsController'

export default function App() {
  useUndoRedoShortcuts()
  useEditShortcuts()
  // Filmstrip/waveform generation for imported assets — idempotent init,
  // no subscriptions in App itself (render-inertness preserved).
  useEffect(() => {
    initMediaVisuals()
  }, [])
  return (
    <div className="app-shell">
      <header className="area-toolbar">
        <Toolbar />
      </header>
      <aside className="area-media-pool">
        <MediaPool />
      </aside>
      <main className="area-preview">
        <Preview />
      </main>
      <aside className="area-inspector">
        <Inspector />
      </aside>
      <section className="area-transport">
        <ToolButtons />
        <TransportBar />
      </section>
      {/* data-timeline-scroll: the Ruler virtualizes its ticks against
          this scroll container (see ui/timeline/Ruler.tsx). */}
      <section className="area-timeline" data-timeline-scroll>
        <Timeline />
      </section>
    </div>
  )
}
