/**
 * Edit-shortcut target guards: dialogs and fields keep native keys,
 * and Media Pool Home/End stay list navigation.
 */

import { afterEach, describe, expect, test } from 'vitest'
import { shouldHandleEditShortcut } from './useEditShortcuts'

function keydownFrom(target: EventTarget, key: string): KeyboardEvent {
  let captured: KeyboardEvent | null = null
  const listener = (event: Event) => {
    captured = event as KeyboardEvent
  }
  target.addEventListener('keydown', listener)
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  target.removeEventListener('keydown', listener)
  if (!captured) throw new Error('keydown did not reach the target')
  return captured
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('shouldHandleEditShortcut', () => {
  test('lets Home and End reach the Media Pool list', () => {
    const list = document.createElement('ul')
    list.id = 'media-pool-list'
    list.setAttribute('role', 'grid')
    const row = document.createElement('button')
    list.append(row)
    document.body.append(list)

    expect(shouldHandleEditShortcut(keydownFrom(row, 'Home'))).toBe(false)
    expect(shouldHandleEditShortcut(keydownFrom(row, 'End'))).toBe(false)
    expect(shouldHandleEditShortcut(keydownFrom(row, 'l'))).toBe(true)
    expect(shouldHandleEditShortcut(new KeyboardEvent('keydown', { key: 'Home' })))
      .toBe(true)
  })

  test('suppresses editor shortcuts inside dialogs and editable fields', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const dialogButton = document.createElement('button')
    dialog.append(dialogButton)
    const field = document.createElement('input')
    document.body.append(dialog, field)

    expect(shouldHandleEditShortcut(keydownFrom(dialogButton, 'j'))).toBe(false)
    expect(shouldHandleEditShortcut(keydownFrom(field, 'Home'))).toBe(false)
    expect(shouldHandleEditShortcut(new KeyboardEvent('keydown', { key: 'j' })))
      .toBe(true)
  })
})
