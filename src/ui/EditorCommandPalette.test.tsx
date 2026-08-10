import { useEffect } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useEditShortcuts } from '../app/useEditShortcuts'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { INITIAL_TRANSPORT_STATE, useTransportStore } from '../state/transportStore'
import EditorCommandPalette from './EditorCommandPalette'

function fixture(): TimelineDoc {
  const clip: Clip = {
    id: 'clip-command',
    assetId: 'asset-command',
    name: 'clip-command',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 60 },
    timelineRange: { startFrame: 0, durationFrames: 60 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
  const track: Track = {
    id: 'V1',
    kind: 'video',
    name: 'V1',
    clips: [clip],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
  return {
    schemaVersion: 11,
    id: 'palette-doc',
    name: 'Palette fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [track],
  }
}

function ShortcutHarness({ onClose }: { onClose: () => void }) {
  useEditShortcuts()
  useEffect(() => undefined, [])
  return <EditorCommandPalette onClose={onClose} />
}

beforeEach(() => {
  useDocumentStore.getState().setDoc(fixture())
  useTransportStore.setState({ ...INITIAL_TRANSPORT_STATE, playheadFrame: 10 })
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
})

describe('EditorCommandPalette', () => {
  test('focuses search, filters real commands, and exposes shortcut metadata', () => {
    render(<EditorCommandPalette onClose={vi.fn()} />)
    const search = screen.getByRole('searchbox', { name: 'Search commands' })
    expect(search).toHaveFocus()

    fireEvent.change(search, { target: { value: 'close gap' } })
    expect(screen.getByText('1 command')).toBeInTheDocument()
    const command = screen.getByRole('button', { name: /Ripple delete selected clip/ })
    expect(command).toHaveTextContent('Delete or Backspace')
    expect(command).toHaveAttribute('aria-disabled', 'true')
    expect(command).toHaveAttribute('aria-keyshortcuts', 'Delete Backspace')
    expect(command).not.toBeDisabled()
  })

  test('keeps disabled commands focusable and announces the live reason', () => {
    render(<EditorCommandPalette onClose={vi.fn()} />)
    const command = screen.getByRole('button', { name: /Ripple delete selected clip/ })
    fireEvent.click(command)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Select a clip before ripple deleting.',
    )
  })

  test('executes an enabled command and closes', () => {
    const onClose = vi.fn()
    render(<EditorCommandPalette onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Split at playhead/ }))
    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(2)
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('rechecks live disabled state instead of trusting the opened snapshot', () => {
    const onClose = vi.fn()
    render(<EditorCommandPalette onClose={onClose} />)
    useDocumentStore.getState().setDoc({
      ...fixture(),
      tracks: fixture().tracks.map((track) => ({ ...track, locked: true })),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Split at playhead' }))

    expect(useDocumentStore.getState().doc.tracks[0].clips).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Move the playhead inside an unlocked clip first.',
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  test('keeps transport names and availability stable while the playhead advances', () => {
    render(<EditorCommandPalette onClose={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: 'Play/Pause' })
    const previous = screen.getByRole('button', { name: 'Previous frame' })
    const next = screen.getByRole('button', { name: 'Next frame' })

    useTransportStore.setState({ playheadFrame: 59, isPlaying: true })

    expect(toggle).toHaveAttribute('aria-disabled', 'false')
    expect(previous).toHaveAttribute('aria-disabled', 'false')
    expect(next).toHaveAttribute('aria-disabled', 'false')
    expect(toggle).toHaveAccessibleDescription('Toggle timeline playback from the current frame.')
  })

  test('contains editing keys and traps focus at both modal boundaries', () => {
    const onClose = vi.fn()
    render(<ShortcutHarness onClose={onClose} />)
    const close = screen.getByRole('button', { name: 'Close command palette' })
    const commands = screen.getAllByRole('button').filter((button) => (
      button.hasAttribute('data-command-id')
    ))

    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(commands.at(-1)).toHaveFocus()
    fireEvent.keyDown(commands.at(-1)!, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(commands[0], { key: 'b' })
    expect(useTransportStore.getState().tool).toBe('select')
    fireEvent.keyDown(commands[0], { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
