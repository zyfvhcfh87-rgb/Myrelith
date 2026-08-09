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
import { executeEditorCommand, matchEditorCommandShortcut } from './editorCommands'
import { isEditableTarget } from './useUndoRedoShortcuts'

export function useEditShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const commandId = matchEditorCommandShortcut(e, 'edit')
      if (!commandId) return
      if (executeEditorCommand(commandId).executed) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
