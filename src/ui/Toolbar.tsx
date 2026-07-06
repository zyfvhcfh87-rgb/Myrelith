/**
 * ui/Toolbar.tsx — Top toolbar: brand + the Phase 4.2 timeline tools.
 * Export lands in Phase 5.2. Layering: ui/ imports state/ only.
 *
 * Subscribes to transportStore.tool only (a primitive that changes when
 * the user switches tools — never during scrubbing or playback).
 */

import type { TimelineTool } from '../state/transportStore'
import { useTransportStore } from '../state/transportStore'

const TOOLS: Array<{ id: TimelineTool; glyph: string; label: string }> = [
  { id: 'select', glyph: '↖', label: 'Select — move clips, drag edges to trim (A)' },
  { id: 'razor', glyph: '✂', label: 'Razor — click a clip to cut it (B)' },
  { id: 'trim', glyph: '↔', label: 'Ripple trim — drag edges, later clips follow (T)' },
  { id: 'slip', glyph: '⇆', label: 'Slip — drag to change WHICH material plays (Y)' },
  { id: 'slide', glyph: '⇄', label: 'Slide — drag between neighbors, they absorb it (U)' },
]

export default function Toolbar() {
  const tool = useTransportStore((s) => s.tool)
  const setTool = useTransportStore((s) => s.setTool)

  return (
    <div className="toolbar">
      <strong>WebCut</strong>
      <div className="toolbar-tools" role="group" aria-label="timeline tools">
        {TOOLS.map(({ id, glyph, label }) => (
          <button
            key={id}
            type="button"
            className={`tool-button${tool === id ? ' active' : ''}`}
            title={label}
            aria-label={label}
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
          >
            {glyph}
          </button>
        ))}
      </div>
      <span className="placeholder-note">S splits at playhead · Del ripple-deletes</span>
    </div>
  )
}
