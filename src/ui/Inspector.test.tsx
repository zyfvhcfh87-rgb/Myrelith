/**
 * ui/Inspector.test.tsx — Phase 4.3.
 *
 * The commit model is the whole contract: drafts while typing, ONE
 * updateClipTransform per blur/Enter (one undo entry), no commit for
 * unchanged/junk/empty input, Escape reverts, and the fields resync when
 * the doc changes under them (undo, canvas gestures, clip switching).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import Inspector from './Inspector'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: `${id}.mp4`,
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, clips: Clip[]): Track {
  return { id, kind: 'video', name: id, clips, transitions: [], hidden: false, muted: false, locked: false }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc-inspector',
    name: 'inspector fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [makeTrack('V1', [makeClip('clipA', 0, 100), makeClip('clipB', 100, 50)])],
  }
}

const doc = () => useDocumentStore.getState()
const transport = () => useTransportStore.getState()
const clipA = () => doc().doc.tracks[0].clips.find((c) => c.id === 'clipA') as Clip

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
    editPreview: null,
  })
  doc().setDoc(makeDoc())
  warnSpy.mockClear()
})

describe('Inspector', () => {
  test('shows a hint without a selection, fields with one', () => {
    const { rerender } = render(<Inspector />)
    expect(screen.getByText('select a clip to edit it')).toBeInTheDocument()

    fireEvent.pointerDown(document.body) // no-op; just anchor the rerender
    transport().setSelectedClip('clipA')
    rerender(<Inspector />)

    expect(screen.getByText('clipA.mp4')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)
    expect(screen.getByTestId('inspector-scale-x')).toHaveValue(1)
    expect(screen.getByTestId('inspector-opacity')).toHaveValue(1)
  })

  test('Enter commits ONE updateClipTransform (one undo entry)', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const x = screen.getByTestId('inspector-x')

    fireEvent.change(x, { target: { value: '40' } })
    expect(clipA().transform.x).toBe(0) // drafting: doc untouched
    expect(doc().past).toHaveLength(0)

    fireEvent.keyDown(x, { key: 'Enter' })
    expect(clipA().transform.x).toBe(40)
    expect(doc().past).toHaveLength(1)

    // The field now shows the committed value; blurring commits nothing new.
    fireEvent.blur(x)
    expect(doc().past).toHaveLength(1)
  })

  test('blur commits too; an untouched field never commits', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const rotation = screen.getByTestId('inspector-rotation')

    fireEvent.change(rotation, { target: { value: '15' } })
    fireEvent.blur(rotation)
    expect(clipA().transform.rotation).toBe(15)
    expect(doc().past).toHaveLength(1)

    fireEvent.blur(screen.getByTestId('inspector-y')) // untouched
    expect(doc().past).toHaveLength(1)
  })

  test('junk and empty input revert without committing', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const scaleX = screen.getByTestId('inspector-scale-x')

    fireEvent.change(scaleX, { target: { value: '' } })
    fireEvent.blur(scaleX)
    expect(scaleX).toHaveValue(1) // reverted
    expect(doc().past).toHaveLength(0)
  })

  test('Escape reverts the draft to the committed value', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const y = screen.getByTestId('inspector-y')

    fireEvent.change(y, { target: { value: '99' } })
    fireEvent.keyDown(y, { key: 'Escape' })
    expect(y).toHaveValue(0)
    fireEvent.blur(y)
    expect(doc().past).toHaveLength(0)
  })

  test('typed opacity is clamped by the domain op before entering the doc', () => {
    transport().setSelectedClip('clipA')
    render(<Inspector />)
    const opacity = screen.getByTestId('inspector-opacity')

    fireEvent.change(opacity, { target: { value: '5' } })
    fireEvent.keyDown(opacity, { key: 'Enter' })
    expect(clipA().opacity).toBe(1) // clamped
    expect(doc().past).toHaveLength(1)
  })

  test('fields resync on undo and when switching clips', () => {
    transport().setSelectedClip('clipA')
    const { rerender } = render(<Inspector />)
    const x = screen.getByTestId('inspector-x')

    fireEvent.change(x, { target: { value: '40' } })
    fireEvent.keyDown(x, { key: 'Enter' })
    expect(x).toHaveValue(40)

    doc().undo()
    rerender(<Inspector />)
    expect(screen.getByTestId('inspector-x')).toHaveValue(0)

    transport().setSelectedClip('clipB')
    rerender(<Inspector />)
    expect(screen.getByText('clipB.mp4')).toBeInTheDocument()

    transport().setSelectedClip('gone')
    rerender(<Inspector />)
    expect(screen.getByText('select a clip to edit it')).toBeInTheDocument()
  })
})
