/**
 * app/useEditShortcuts.test.tsx — Phase 4.2 keyboard layer.
 * Same harness style as useUndoRedoShortcuts.test.tsx: mount a component
 * that installs the hook, fire window keydowns, assert store effects.
 */

import { useEffect } from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_MEDIA_IMPORT_STATE,
  useMediaImportStore,
} from '../state/mediaImportStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import { initSelectionReconciliation } from './selectionReconciliationController'
import { useEditShortcuts } from './useEditShortcuts'

function Host() {
  useEditShortcuts()
  useEffect(() => initSelectionReconciliation(), [])
  return <input data-testid="field" />
}

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

function makeTrack(id: string, clips: Clip[], locked = false): Track {
  return { id, kind: 'video', name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked }
}

/** V1: clipA [100,50), clipB [200,40). VL (locked): clipE [0,30). */
function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 20,
    id: 'doc-keys',
    name: 'keys fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', [makeClip('clipA', 100, 50), makeClip('clipB', 200, 40)]),
      makeTrack('VL', [makeClip('clipE', 0, 30)], true),
    ],
    markers: [],
  }
}

const doc = () => useDocumentStore.getState()
const transport = () => useTransportStore.getState()

const key = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
    tool: 'select',
    selectedClipId: null,
    selectedClipIds: [],
    selectedMarkerId: null,
    editingMarkerId: null,
    editPreview: null,
  })
  doc().setDoc(makeDoc())
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
  })
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
})

describe('tool keys', () => {
  test('A/B/T/Y/U switch tools (case-insensitive, no modifier)', () => {
    render(<Host />)
    key({ key: 'b' })
    expect(transport().tool).toBe('razor')
    key({ key: 'T' })
    expect(transport().tool).toBe('trim')
    key({ key: 'y' })
    expect(transport().tool).toBe('slip')
    key({ key: 'u' })
    expect(transport().tool).toBe('slide')
    key({ key: 'a' })
    expect(transport().tool).toBe('select')
  })

  test('modifier combos pass through (Ctrl+A stays select-all)', () => {
    render(<Host />)
    key({ key: 'b' })
    key({ key: 'a', ctrlKey: true })
    expect(transport().tool).toBe('razor') // unchanged
  })

  test('typing in a field never switches tools', () => {
    const { getByTestId } = render(<Host />)
    getByTestId('field').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', bubbles: true }),
    )
    expect(transport().tool).toBe('select')
  })

  test('closing the editor blocks every global edit shortcut', () => {
    render(<Host />)
    transport().setPlayheadFrame(120)
    transport().setSelectedClip('clipA')
    useProjectSessionStore.setState({ phase: 'closing' })

    key({ key: 'b' })
    key({ key: 's' })
    key({ key: 'ArrowRight' })
    key({ key: 'Delete' })

    expect(transport().tool).toBe('select')
    expect(transport().playheadFrame).toBe(120)
    expect(transport().selectedClipId).toBe('clipA')
    expect(doc().doc.tracks[0].clips).toHaveLength(2)
    expect(doc().past).toHaveLength(0)
  })

  test('an open media import dialog blocks every global edit shortcut', () => {
    render(<Host />)
    transport().setPlayheadFrame(120)
    transport().setSelectedClip('clipA')
    useMediaImportStore.setState({
      phase: 'awaiting-decision',
      fileName: 'cinema.mp4',
      prompt: {
        fileName: 'cinema.mp4',
        projectRate: { num: 30, den: 1 },
        sourceRate: { num: 60, den: 1 },
        canMatchSource: true,
        matchUnavailableReason: null,
      },
      error: null,
    })

    key({ key: 't' })
    key({ key: 's' })
    key({ key: 'Delete' })

    expect(transport().tool).toBe('select')
    expect(transport().playheadFrame).toBe(120)
    expect(transport().selectedClipId).toBe('clipA')
    expect(doc().doc.tracks[0].clips).toHaveLength(2)
    expect(doc().past).toHaveLength(0)
  })
})

describe('S — split at playhead', () => {
  test('splits every unlocked clip under the playhead, one undo entry', () => {
    render(<Host />)
    transport().setPlayheadFrame(120)
    key({ key: 's' })

    const v1 = doc().doc.tracks[0]
    expect(v1.clips).toHaveLength(3) // clipA split; clipB untouched
    expect(v1.clips[0].timelineRange).toEqual({ startFrame: 100, durationFrames: 20 })
    expect(v1.clips[1].timelineRange).toEqual({ startFrame: 120, durationFrames: 30 })
    expect(doc().past).toHaveLength(1)
  })

  test('a playhead over nothing splits nothing and pushes no history', () => {
    render(<Host />)
    transport().setPlayheadFrame(50) // gap
    key({ key: 's' })
    expect(doc().doc.tracks[0].clips).toHaveLength(2)
    expect(doc().past).toHaveLength(0)
  })
})

describe('M — sequence markers', () => {
  test('adds at the integer playhead and navigates exact/equal boundaries', () => {
    render(<Host />)
    transport().setPlayheadFrame(15)
    key({ key: 'm' })
    expect(doc().doc.markers).toHaveLength(1)
    expect(doc().doc.markers?.[0]).toMatchObject({ frame: 15, label: 'Marker 1' })

    doc().setDoc({
      ...makeDoc(),
      markers: [
        { id: 'first', frame: 10, label: 'First', color: 'yellow' },
        { id: 'second', frame: 20, label: 'Second', color: 'blue' },
      ],
    })
    transport().setSelectedMarker(null)
    transport().setPlayheadFrame(10)
    key({ key: 'M', shiftKey: true })
    expect(transport()).toMatchObject({ selectedMarkerId: 'first', playheadFrame: 10 })
    key({ key: 'M', shiftKey: true })
    expect(transport()).toMatchObject({ selectedMarkerId: 'second', playheadFrame: 20 })
    key({ key: 'M', ctrlKey: true, shiftKey: true })
    expect(transport()).toMatchObject({ selectedMarkerId: 'first', playheadFrame: 10 })
  })

  test('marker shortcuts leave editable fields untouched', () => {
    const { getByTestId } = render(<Host />)
    getByTestId('field').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', bubbles: true }),
    )
    expect(doc().doc.markers).toEqual([])
  })
})

describe('arrow keys — frame stepping (Phase 4 gate item)', () => {
  test('ArrowRight/ArrowLeft step exactly one frame, clamped at 0', () => {
    render(<Host />)
    transport().setPlayheadFrame(100)
    key({ key: 'ArrowRight' })
    expect(transport().playheadFrame).toBe(101)
    key({ key: 'ArrowLeft' })
    key({ key: 'ArrowLeft' })
    expect(transport().playheadFrame).toBe(99)

    transport().setPlayheadFrame(0)
    key({ key: 'ArrowLeft' })
    expect(transport().playheadFrame).toBe(0) // floor clamp
  })

  test('arrows inside an editable field keep their native caret behavior', () => {
    const { getByTestId } = render(<Host />)
    transport().setPlayheadFrame(100)
    getByTestId('field').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    )
    expect(transport().playheadFrame).toBe(100) // untouched
  })
})

describe('Delete — ripple delete the selection', () => {
  test('deletes the selected clip, closes the gap, and prunes its selection', () => {
    render(<Host />)
    transport().setSelectedClip('clipA')
    key({ key: 'Delete' })

    const v1 = doc().doc.tracks[0]
    expect(v1.clips).toHaveLength(1)
    expect(v1.clips[0].id).toBe('clipB')
    expect(v1.clips[0].timelineRange.startFrame).toBe(150) // rippled left by 50
    expect(transport().selectedClipId).toBeNull()
    expect(transport().selectedClipIds).toEqual([])
    expect(doc().past).toHaveLength(1)
  })

  test('deleting the primary preserves other selections through undo and redo', () => {
    render(<Host />)
    transport().setSelectedClip('clipB')
    transport().toggleClipSelection('clipA')
    expect(transport()).toMatchObject({
      selectedClipIds: ['clipB', 'clipA'],
      selectedClipId: 'clipA',
    })

    key({ key: 'Delete' })

    expect(doc().doc.tracks[0].clips.map((clip) => clip.id)).toEqual(['clipB'])
    expect(transport()).toMatchObject({
      selectedClipIds: ['clipB'],
      selectedClipId: 'clipB',
    })
    expect(doc().past).toHaveLength(1)

    doc().undo()
    expect(doc().doc.tracks[0].clips.map((clip) => clip.id)).toEqual([
      'clipA',
      'clipB',
    ])
    expect(transport()).toMatchObject({
      selectedClipIds: ['clipB'],
      selectedClipId: 'clipB',
    })

    doc().redo()
    expect(transport()).toMatchObject({
      selectedClipIds: ['clipB'],
      selectedClipId: 'clipB',
    })
  })

  test('Backspace works too; no selection is a no-op', () => {
    render(<Host />)
    key({ key: 'Backspace' })
    expect(doc().doc.tracks[0].clips).toHaveLength(2)
    expect(doc().past).toHaveLength(0)

    transport().setSelectedClip('clipB')
    key({ key: 'Backspace' })
    expect(doc().doc.tracks[0].clips).toHaveLength(1)
    expect(doc().past).toHaveLength(1)
  })

  test('a clip on a locked track stays selected without invoking a rejected edit', () => {
    render(<Host />)
    transport().setSelectedClip('clipA')
    transport().toggleClipSelection('clipE')
    key({ key: 'Delete' })
    expect(doc().doc.tracks[1].clips).toHaveLength(1)
    expect(transport()).toMatchObject({
      selectedClipIds: ['clipA', 'clipE'],
      selectedClipId: 'clipE',
    }) // rejection kept the exact selection
    expect(doc().past).toHaveLength(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
