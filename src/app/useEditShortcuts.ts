/**
 * app/useEditShortcuts.ts — global keyboard shortcuts for the Phase 4.2
 * editing toolset. Same architecture as useUndoRedoShortcuts: one window
 * keydown listener, no store subscriptions, handlers read stores with
 * getState() — App stays render-inert.
 *
 * Keys (no modifier):
 *   A/B/T/Y/U        → select / razor / trim / slip / slide tool
 *   S                → split every clip under the playhead
 *   Delete/Backspace → ripple-delete the selected clip
 *   ←/→              → step the playhead one frame (Phase 4 gate item)
 *
 * Guards match the undo hook: editable targets keep their native typing,
 * modifier combos pass through (Ctrl+A must stay select-all), and IME
 * composition keystrokes are ignored.
 */

import { useEffect } from 'react'
import { useDocumentStore } from '../state/documentStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import { stepFrame } from './transportController'
import { isEditableTarget } from './useUndoRedoShortcuts'

export function useEditShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (useProjectSessionStore.getState().phase === 'closing') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      if (isEditableTarget(e.target)) return

      const transport = useTransportStore.getState()
      switch (e.key.toLowerCase()) {
        case 'a':
          transport.setTool('select')
          break
        case 'b':
          transport.setTool('razor')
          break
        case 't':
          transport.setTool('trim')
          break
        case 'y':
          transport.setTool('slip')
          break
        case 'u':
          transport.setTool('slide')
          break
        case 's':
          useDocumentStore.getState().splitClipAtPlayhead(transport.playheadFrame)
          break
        case 'arrowleft':
          stepFrame(-1)
          break
        case 'arrowright':
          stepFrame(1)
          break
        case 'delete':
        case 'backspace': {
          const selected = transport.selectedClipId
          if (!selected) return
          const store = useDocumentStore.getState()
          const before = store.doc
          store.rippleDelete(selected)
          // Clear the selection only if the clip actually went away
          // (a locked track rejects and keeps the clip).
          if (useDocumentStore.getState().doc !== before) {
            transport.setSelectedClip(null)
          }
          break
        }
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
