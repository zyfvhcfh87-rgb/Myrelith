/** One disjoint global handler for the command palette launcher. */

import { useEffect } from 'react'
import { useProjectSessionStore } from '../state/projectSessionStore'

export const COMMAND_PALETTE_SHORTCUT = Object.freeze({
  label: 'Ctrl/⌘+K',
  ariaKeyShortcuts: 'Control+K Meta+K',
  signature: 'primary:no-shift:k',
})

export function isCommandPaletteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey
    && !event.isComposing
    && event.key.toLowerCase() === 'k'
}

export function useCommandPaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isCommandPaletteShortcut(event)) return
      if (useProjectSessionStore.getState().phase === 'closing') return
      event.preventDefault()
      onOpen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpen])
}
