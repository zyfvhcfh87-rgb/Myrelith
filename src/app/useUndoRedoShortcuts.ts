/**
 * app/useUndoRedoShortcuts.ts — global keyboard undo/redo. Phase 3 gate.
 *
 * Ctrl+Z → undo · Ctrl+Shift+Z / Ctrl+Y → redo (Cmd on mac via metaKey).
 * One window keydown listener attached by App. No store subscription and
 * no component state — App stays render-inert; the handler reads the
 * store with getState(), the same pattern every gesture commit uses.
 *
 * Guards:
 * - editable targets (input/textarea/select/contentEditable) keep their
 *   native text undo — vital once the Inspector (4.3) adds fields;
 * - Alt/AltGr combos pass through so international layouts can type;
 * - IME composition keystrokes are ignored.
 */

import { useEffect } from 'react'
import { executeEditorCommand, matchEditorCommandShortcut } from './editorCommands'

/** Shared by all app/ keyboard hooks: native text editing wins in fields. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

export function useUndoRedoShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const commandId = matchEditorCommandShortcut(e, 'history')
      if (!commandId) return
      if (executeEditorCommand(commandId).executed) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
