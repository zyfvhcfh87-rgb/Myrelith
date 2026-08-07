/**
 * app/EditorShell.tsx — Lazy editor-only composition root.
 *
 * The launcher never imports this module eagerly. Every editor panel, runtime
 * lifecycle, shortcut, and editor stylesheet therefore begins loading only
 * when a project entry action explicitly prepares the editor boundary.
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
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts'
import { useEditShortcuts } from './useEditShortcuts'
import { initMediaVisuals } from './mediaVisualsController'
import { initMediaCapabilityLifecycle } from './mediaCapabilityController'
import { initSelectionReconciliation } from './selectionReconciliationController'

export interface EditorShellProps {
  closing: boolean
}

export default function EditorShell({ closing }: EditorShellProps) {
  useUndoRedoShortcuts()
  useEditShortcuts()
  useEffect(() => initMediaCapabilityLifecycle(), [])
  useEffect(() => initSelectionReconciliation(), [])
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
      <aside
        className="area-media-pool"
        data-media-pool-scroll
        inert={closing}
      >
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
