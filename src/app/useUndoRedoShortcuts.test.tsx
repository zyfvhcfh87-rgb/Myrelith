/**
 * app/useUndoRedoShortcuts.test.tsx — Phase 3 gate item.
 *
 * Keyboard undo/redo end to end against the real documentStore: commit a
 * move, then drive window keydown events. Also proves the guards — no
 * hijacking of editable targets, Alt/AltGr combos, or bare keys — and
 * that unmount detaches the listener.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useUndoRedoShortcuts } from './useUndoRedoShortcuts'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, clips: Clip[]): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 20,
    id: 'doc-shortcuts',
    name: 'shortcut fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [makeTrack('V1', [makeClip('clipA', 100, 50)])],
  }
}

/** Hook host plus an input to prove the editable-target guard. */
function Harness() {
  useUndoRedoShortcuts()
  return <input data-testid="text-input" />
}

const doc = () => useDocumentStore.getState()
const clipStart = () =>
  doc().doc.tracks[0].clips[0].timelineRange.startFrame

beforeEach(() => {
  doc().setDoc(makeDoc())
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
})

/** One committed edit to have something on the undo stack. */
function commitMove(): void {
  doc().moveClip('clipA', 'V1', 300)
  expect(clipStart()).toBe(300)
  expect(doc().past).toHaveLength(1)
}

describe('useUndoRedoShortcuts', () => {
  test('Ctrl+Z undoes, Ctrl+Shift+Z redoes, Ctrl+Y redoes', () => {
    render(<Harness />)
    commitMove()

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(clipStart()).toBe(100)

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(clipStart()).toBe(300)

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(clipStart()).toBe(100)
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    expect(clipStart()).toBe(300)
  })

  test('Cmd+Z works for mac (metaKey)', () => {
    render(<Harness />)
    commitMove()
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(clipStart()).toBe(100)
  })

  test('Shift produces an uppercase key on real keyboards — still redo', () => {
    render(<Harness />)
    commitMove()
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true })
    expect(clipStart()).toBe(300)
  })

  test('bare z and Ctrl+Alt+Z (AltGr layouts) are ignored', () => {
    render(<Harness />)
    commitMove()
    fireEvent.keyDown(window, { key: 'z' })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, altKey: true })
    expect(clipStart()).toBe(300) // untouched
  })

  test('Ctrl+Z inside an editable field never touches the timeline', () => {
    render(<Harness />)
    commitMove()
    fireEvent.keyDown(screen.getByTestId('text-input'), {
      key: 'z',
      ctrlKey: true,
    })
    expect(clipStart()).toBe(300) // text fields keep their own undo
  })

  test('closing the editor blocks undo and redo mutations', () => {
    render(<Harness />)
    commitMove()
    useProjectSessionStore.setState({ phase: 'closing' })

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(clipStart()).toBe(300)
  })

  test('unmount detaches the listener', () => {
    const { unmount } = render(<Harness />)
    commitMove()
    unmount()
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(clipStart()).toBe(300)
  })
})
