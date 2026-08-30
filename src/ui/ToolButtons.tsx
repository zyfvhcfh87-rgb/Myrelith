/**
 * ui/ToolButtons.tsx — The timeline tool switcher (Phase 4.2; moved from
 * the top toolbar into the transport strip at the user's request, docked
 * left of the play controls). Subscribes to transportStore.tool only —
 * a primitive that changes when the user switches tools, never during
 * scrubbing or playback.
 */

import { lazy, useRef, useState } from 'react'
import {
  ArrowsHorizontal,
  ArrowsInLineHorizontal,
  ArrowsLeftRight,
  CursorClick,
  Magnet,
  Scissors,
  StackSimple,
  TextT,
} from '@phosphor-icons/react'
import { useProjectSessionStore } from '../state/projectSessionStore'
import type { TimelineTool } from '../state/transportStore'
import { useTransportStore } from '../state/transportStore'
import { usePreferencesStore } from '../state/preferencesStore'
import { shortcutForCommand, type EditorCommandId } from '../app/editorCommands'
import LazySurfaceBoundary from './LazySurfaceBoundary'

const TextOverlayDialog = lazy(() => import('./TextOverlayDialog'))
const AdjustmentDialog = lazy(() => import('./AdjustmentDialog'))

const TOOLS = [
  { id: 'select', commandId: 'tool.select', icon: CursorClick, label: 'Select — move clips, drag edges to trim (A)' },
  { id: 'razor', commandId: 'tool.razor', icon: Scissors, label: 'Razor — click a clip to cut it (B)' },
  { id: 'trim', commandId: 'tool.trim', icon: ArrowsHorizontal, label: 'Ripple trim — drag edges, later clips follow (T)' },
  { id: 'slip', commandId: 'tool.slip', icon: ArrowsInLineHorizontal, label: 'Slip — drag to change WHICH material plays (Y)' },
  { id: 'slide', commandId: 'tool.slide', icon: ArrowsLeftRight, label: 'Slide — drag between neighbors, they absorb it (U)' },
] as const

export default function ToolButtons() {
  const [textOpen, setTextOpen] = useState(false)
  const [adjustmentOpen, setAdjustmentOpen] = useState(false)
  const textButtonRef = useRef<HTMLButtonElement | null>(null)
  const adjustmentButtonRef = useRef<HTMLButtonElement | null>(null)
  const tool = useTransportStore((s) => s.tool)
  const setTool = useTransportStore((s) => s.setTool)
  const snappingEnabled = usePreferencesStore((s) => s.snappingEnabled)
  const setSnappingEnabled = usePreferencesStore((s) => s.setSnappingEnabled)
  const closing = useProjectSessionStore((state) => state.phase === 'closing')

  const closeText = (): void => {
    setTextOpen(false)
    requestAnimationFrame(() => textButtonRef.current?.focus())
  }

  const closeAdjustment = (): void => {
    setAdjustmentOpen(false)
    requestAnimationFrame(() => adjustmentButtonRef.current?.focus())
  }

  return (
    <>
      <div className="transport-tools" role="group" aria-label="timeline tools">
        {TOOLS.map(({ id, commandId, icon: Icon, label }) => {
          const toolId: TimelineTool = id
          const shortcut = shortcutForCommand(commandId as EditorCommandId)
          return (
            <button
              key={id}
              type="button"
              className={`tool-button${tool === id ? ' active' : ''}`}
              title={label}
              aria-label={label}
              aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
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
        <button
          ref={adjustmentButtonRef}
          type="button"
          className="tool-button tool-button-add-adjustment"
          title="Add adjustment layer"
          aria-label="Add adjustment layer"
          aria-haspopup="dialog"
          aria-expanded={adjustmentOpen}
          disabled={closing}
          onClick={() => setAdjustmentOpen(true)}
        >
          <StackSimple aria-hidden="true" size={17} weight="bold" />
        </button>
        <button
          type="button"
          className={`tool-button tool-button-snap${snappingEnabled ? ' active' : ''}`}
          title={`${snappingEnabled ? 'Snapping on' : 'Snapping off'} — hold Alt to bypass while editing`}
          aria-label={`${snappingEnabled ? 'Snapping on' : 'Snapping off'} — hold Alt to temporarily bypass snapping`}
          aria-pressed={snappingEnabled}
          onClick={() => setSnappingEnabled(!snappingEnabled)}
        >
          <Magnet aria-hidden="true" size={17} weight="bold" />
        </button>
      </div>
      {textOpen && (
        <LazySurfaceBoundary
          variant="dialog"
          loadingLabel="Loading text tools…"
          failureTitle="Text tools could not load"
          onClose={closeText}
        >
          <TextOverlayDialog onClose={closeText} />
        </LazySurfaceBoundary>
      )}
      {adjustmentOpen && (
        <LazySurfaceBoundary
          variant="dialog"
          loadingLabel="Loading adjustment tools…"
          failureTitle="Adjustment tools could not load"
          onClose={closeAdjustment}
        >
          <AdjustmentDialog onClose={closeAdjustment} />
        </LazySurfaceBoundary>
      )}
    </>
  )
}
