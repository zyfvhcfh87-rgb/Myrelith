import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useCommandPaletteShortcut } from './useCommandPaletteShortcut'

function Harness({ onOpen }: { onOpen: () => void }) {
  useCommandPaletteShortcut(onOpen)
  return null
}

beforeEach(() => {
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
})

describe('useCommandPaletteShortcut', () => {
  test('attaches one handler, invokes once, and detaches on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const onOpen = vi.fn()
    const view = render(<Harness onOpen={onOpen} />)

    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    expect(onOpen).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)

    view.rerender(<Harness onOpen={onOpen} />)
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
    view.unmount()
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  test('does not launch while project cleanup is closing', () => {
    const onOpen = vi.fn()
    render(<Harness onOpen={onOpen} />)
    useProjectSessionStore.setState({ phase: 'closing' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    expect(onOpen).not.toHaveBeenCalled()
  })
})
