import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
} from '../domain/projectSettings'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import { editorContextMenuIdentity } from '../app/editorContextMenuCommands'
import { EditorContextMenuHost } from './EditorContextMenu'
import {
  openEditorContextMenuFromEvent,
  useEditorContextMenu,
} from './editorContextMenuController'

function Harness() {
  const contextMenu = useEditorContextMenu()
  return (
    <div
      data-testid="ruler"
      role="region"
      aria-label="Test ruler"
      tabIndex={0}
      onContextMenu={(event) => {
        openEditorContextMenuFromEvent(contextMenu, event, {
          target: {
            ...editorContextMenuIdentity(),
            kind: 'ruler',
            frame: 12,
          },
          anchorElement: event.currentTarget,
          restoreFocusTo: event.currentTarget,
        })
      }}
    >
      <input aria-label="Native input" />
    </div>
  )
}

function renderHarness() {
  return render(
    <EditorContextMenuHost>
      <Harness />
    </EditorContextMenuHost>,
  )
}

beforeEach(() => {
  useDocumentStore.getState().setDoc(createTimelineDoc(
    'Context menu',
    DEFAULT_PROJECT_SETTINGS,
    'doc-context-menu-host',
  ))
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
})

describe('EditorContextMenuHost', () => {
  test('preserves native menus for editable descendants and recognizes its surface', () => {
    renderHarness()
    const input = screen.getByRole('textbox', { name: 'Native input' })
    const nativeEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    })

    fireEvent(input, nativeEvent)
    expect(nativeEvent.defaultPrevented).toBe(false)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    const ruler = screen.getByTestId('ruler')
    const supportedEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    })
    fireEvent(ruler, supportedEvent)
    expect(supportedEvent.defaultPrevented).toBe(true)
    expect(screen.getByRole('menu', { name: 'Timeline ruler at frame 12' }))
      .toBeInTheDocument()
  })

  test('keeps disabled rows focusable and supports wrapping, typeahead, and Escape', async () => {
    renderHarness()
    const ruler = screen.getByTestId('ruler')
    ruler.focus()
    fireEvent.contextMenu(ruler, { clientX: 30, clientY: 40 })

    const items = screen.getAllByRole('menuitem')
    await waitFor(() => expect(items[0]).toHaveFocus())
    expect(items.at(-1)).toHaveAttribute('aria-disabled', 'true')

    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' })
    expect(items.at(-1)).toHaveFocus()
    fireEvent.keyDown(items.at(-1)!, { key: 'Home' })
    expect(items[0]).toHaveFocus()
    fireEvent.keyDown(items[0]!, { key: 's' })
    const disabledSplit = screen.getByRole('menuitem', {
      name: /Split eligible clips here/,
    })
    expect(disabledSplit).toHaveFocus()
    fireEvent.keyDown(disabledSplit, { key: 'Enter' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'No editable clip crosses this frame.',
    )

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await waitFor(() => expect(ruler).toHaveFocus())
  })

  test('dismisses on Tab, outside pointer, scroll, resize, and a second invocation', () => {
    renderHarness()
    const ruler = screen.getByTestId('ruler')
    const open = () => fireEvent.contextMenu(ruler, { clientX: 30, clientY: 40 })

    open()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    fireEvent.scroll(document)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    fireEvent.resize(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    open()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })

  test('anchors keyboard invocation to the focused target rectangle', () => {
    renderHarness()
    const ruler = screen.getByTestId('ruler')
    ruler.getBoundingClientRect = () => ({
      x: 100,
      y: 150,
      left: 100,
      top: 150,
      right: 300,
      bottom: 220,
      width: 200,
      height: 70,
      toJSON: () => ({}),
    })

    fireEvent.contextMenu(ruler, { clientX: 0, clientY: 0 })
    const menu = screen.getByRole('menu')
    expect(menu).toHaveStyle({ left: '100px', top: '220px' })
  })

  test('executes against fresh state and closes when the project is replaced', () => {
    renderHarness()
    const ruler = screen.getByTestId('ruler')
    fireEvent.contextMenu(ruler, { clientX: 30, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move playhead here' }))
    expect(useTransportStore.getState().playheadFrame).toBe(12)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(ruler, { clientX: 30, clientY: 40 })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    act(() => {
      useDocumentStore.getState().setDoc(createTimelineDoc(
        'Replacement',
        DEFAULT_PROJECT_SETTINGS,
        'replacement-document',
      ))
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
