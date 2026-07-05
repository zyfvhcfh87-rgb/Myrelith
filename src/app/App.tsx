/**
 * app/App.tsx — The editor shell. Phase 3.1.
 *
 * Pure layout: a CSS grid (layout.css) with one named area per panel.
 * Every panel is its own component from ui/; the shell holds NO state and
 * subscribes to NO stores — re-renders here would cascade everywhere, and
 * the Phase 3 gate requires scrubbing to re-render Playhead/Preview only.
 */

import './layout.css'
import Toolbar from '../ui/Toolbar'
import MediaPool from '../ui/MediaPool'
import Preview from '../ui/Preview'
import Inspector from '../ui/Inspector'
import TransportBar from '../ui/TransportBar'
import Timeline from '../ui/timeline/Timeline'

export default function App() {
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
        <TransportBar />
      </section>
      <section className="area-timeline">
        <Timeline />
      </section>
    </div>
  )
}
