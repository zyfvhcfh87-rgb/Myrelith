/**
 * ui/ToolButtons.tsx — The timeline tool switcher (Phase 4.2; moved from
 * the top toolbar into the transport strip at the user's request, docked
 * left of the play controls). Subscribes to transportStore.tool only —
 * a primitive that changes when the user switches tools, never during
 * scrubbing or playback.
 */

import { useRef, useState } from 'react'
import {
  ArrowsHorizontal,
  ArrowsInLineHorizontal,
  ArrowsLeftRight,
  CursorClick,
  Scissors,
  TextT,
} from '@phosphor-icons/react'
import { useProjectSessionStore } from '../state/projectSessionStore'
import type { TimelineTool } from '../state/transportStore'
import { useTransportStore } from '../state/transportStore'
import TextOverlayDialog from './TextOverlayDialog'

const TOOLS = [
  { id: 'select', icon: CursorClick, label: 'Select — move clips, drag edges to trim (A)' },
  { id: 'razor', icon: Scissors, label: 'Razor — click a clip to cut it (B)' },
  { id: 'trim', icon: ArrowsHorizontal, label: 'Ripple trim — drag edges, later clips follow (T)' },
  { id: 'slip', icon: ArrowsInLineHorizontal, label: 'Slip — drag to change WHICH material plays (Y)' },
  { id: 'slide', icon: ArrowsLeftRight, label: 'Slide — drag between neighbors, they absorb it (U)' },
] as const

export default function ToolButtons() {
  const [textOpen, setTextOpen] = useState(false)
  const textButtonRef = useRef<HTMLButtonElement | null>(null)
  const tool = useTransportStore((s) => s.tool)
  const setTool = useTransportStore((s) => s.setTool)
  const closing = useProjectSessionStore((state) => state.phase === 'closing')

  const closeText = (): void => {
    setTextOpen(false)
    requestAnimationFrame(() => textButtonRef.current?.focus())
  }

  return (
    <>
      <div className="transport-tools" role="group" aria-label="timeline tools">
        {TOOLS.map(({ id, icon: Icon, label }) => {
          const toolId: TimelineTool = id
          return (
            <button
              key={id}
              type="button"
              className={`tool-button${tool === id ? ' active' : ''}`}
              title={label}
              aria-label={label}
              aria-pressed={tool === id}
              onClick={() => setTool(toolId)}
            >
              <Icon aria-hidden="true" size={16} weight="bold" />
            </button>
          )
        })}
        <button
          ref={textButtonRef}
          type="button"
          className="tool-button tool-button-add-text"
          title="Add text"
          aria-label="Add text"
          aria-haspopup="dialog"
          aria-expanded={textOpen}
          disabled={closing}
          onClick={() => setTextOpen(true)}
        >
          <TextT aria-hidden="true" size={17} weight="bold" />
        </button>
      </div>
      {textOpen && <TextOverlayDialog onClose={closeText} />}
    </>
  )
}
