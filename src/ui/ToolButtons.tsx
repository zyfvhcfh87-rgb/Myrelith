/**
 * ui/ToolButtons.tsx — The timeline tool switcher (Phase 4.2; moved from
 * the top toolbar into the transport strip at the user's request, docked
 * left of the play controls). Subscribes to transportStore.tool only —
 * a primitive that changes when the user switches tools, never during
 * scrubbing or playback.
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

export default function ToolButtons() {
  const tool = useTransportStore((s) => s.tool)
  const setTool = useTransportStore((s) => s.setTool)

  return (
    <div className="transport-tools" role="group" aria-label="timeline tools">
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
  )
}
