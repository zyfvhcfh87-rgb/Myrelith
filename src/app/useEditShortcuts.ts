/**
 * app/useEditShortcuts.ts — global keyboard shortcuts for the Phase 4.2
 * editing toolset. Same architecture as useUndoRedoShortcuts: one window
 * keydown listener, no store subscriptions, handlers read stores with
 * getState() — App stays render-inert.
 *
 * Keys (no modifier):
 *   A/B/T/Y/U        → select / razor / trim / slip / slide tool
 *   S                → split every clip under the playhead
 *   M / Shift+M      → add / navigate to the next sequence marker
 *   Ctrl/⌘+Shift+M   → navigate to the previous sequence marker
 *   Delete/Backspace → ripple-delete the selected clip
 *   ←/→              → step the playhead one frame (Phase 4 gate item)
 *
 * Guards match the undo hook: editable targets keep their native typing,
 * dialogs keep their own keys, Media Pool Home/End stay list navigation,
 * modifier combos pass through (Ctrl+A must stay select-all), and IME
 * composition keystrokes are ignored.
 */

import { useEffect } from 'react'
import { executeEditorCommand, matchEditorCommandShortcut } from './editorCommands'
import { isEditableTarget } from './useUndoRedoShortcuts'

function isElementTarget(target: EventTarget | null): target is Element {
  return target instanceof Element
}

export function shouldHandleEditShortcut(event: KeyboardEvent): boolean {
  if (isEditableTarget(event.target)) return false
  if (isElementTarget(event.target) && event.target.closest('[role="dialog"]')) {
    return false
  }
  if (
    isElementTarget(event.target)
    && event.target.closest('#media-pool-list')
    && (event.key === 'Home' || event.key === 'End')
  ) {
    return false
  }
  return true
}

export function useEditShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!shouldHandleEditShortcut(e)) return
      const commandId = matchEditorCommandShortcut(e, 'edit')
      if (!commandId) return
      if (executeEditorCommand(commandId).executed) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
