/**
 * ui/timeline/clipdrag.test.tsx — Phase 3.3.
 *
 * Proves the scrubbing-vs-committed pattern end to end:
 *   mid-drag   → only transportStore.dragPreview changes, doc untouched
 *   pointerup  → exactly ONE documentStore commit (one undo entry)
 *   rejected   → no history entry, clip snaps back
 * plus Profiler isolation: dragging clip A never re-renders clip B.
 */

import { Profiler } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, TimelineDoc, Track as TrackData } from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useTransportStore } from '../../state/transportStore'
import ClipView from './ClipView'
import Track from './Track'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: 0, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, clips: Clip[]): TrackData {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    locked: false,
  }
}

/** V1: clipA [100,50), clipB [300,80) — room to move, room to collide. */
function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc-drag',
    name: 'drag fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [makeTrack('V1', [makeClip('clipA', 100, 50), makeClip('clipB', 300, 80)])],
  }
}

const doc = () => useDocumentStore.getState()
const transport = () => useTransportStore.getState()

beforeEach(() => {
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
  })
  doc().setDoc(makeDoc())
})

const clipA = () => doc().doc.tracks[0].clips.find((c) => c.id === 'clipA') as Clip

describe('ClipView rendering', () => {
  test('positions by timelineRange at current zoom', () => {
    act(() => transport().setZoom(2))
    render(<ClipView clip={clipA()} trackId="V1" />)
    const el = screen.getByTestId('clip-clipA')
    expect(el).toHaveStyle({ transform: 'translateX(200px)', width: '100px' })
  })

  test('Track renders a lane with its clips and label', () => {
    render(<Track track={doc().doc.tracks[0]} />)
    expect(screen.getByTestId('track-V1')).toBeInTheDocument()
    expect(screen.getByText('V1')).toBeInTheDocument()
    expect(screen.getByTestId('clip-clipA')).toBeInTheDocument()
    expect(screen.getByTestId('clip-clipB')).toBeInTheDocument()
  })
})

describe('drag: scrub-preview then commit', () => {
  test('mid-drag updates ONLY the preview; pointerup commits one undo entry', async () => {
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(el, { pointerId: 1, clientX: 500 })
    expect(transport().dragPreview).toEqual({ clipId: 'clipA', startFrame: 100 })

    fireEvent.pointerMove(el, { pointerId: 1, clientX: 560 }) // +60px @ zoom 1
    await waitFor(() =>
      expect(transport().dragPreview?.startFrame).toBe(160),
    )
    // The DOCUMENT is untouched mid-drag — the whole point of the pattern.
    expect(clipA().timelineRange.startFrame).toBe(100)
    expect(doc().past).toHaveLength(0)
    // The block visually follows the preview.
    expect(el).toHaveStyle({ transform: 'translateX(160px)' })

    fireEvent.pointerUp(el, { pointerId: 1, clientX: 560 })
    expect(clipA().timelineRange.startFrame).toBe(160)
    expect(doc().past).toHaveLength(1) // exactly ONE undo entry
    expect(transport().dragPreview).toBeNull()

    doc().undo()
    expect(clipA().timelineRange.startFrame).toBe(100)
  })

  test('rejected drop (overlap) pushes no history and snaps back', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    // Drag clipA onto clipB's territory: 100 → 310.
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 710 })
    await waitFor(() =>
      expect(transport().dragPreview?.startFrame).toBe(310),
    )
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 710 })

    expect(clipA().timelineRange.startFrame).toBe(100) // unchanged
    expect(doc().past).toHaveLength(0) // no undo entry
    expect(transport().dragPreview).toBeNull() // preview cleared → snap back
    expect(warnSpy).toHaveBeenCalled() // domain logged the rejection
    warnSpy.mockRestore()
  })

  test('click without movement commits nothing', () => {
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 500 })
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 500 })
    expect(doc().past).toHaveLength(0)
    expect(transport().dragPreview).toBeNull()
  })

  test('drag left clamps at frame 0', async () => {
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 0 }) // -500px, way past 0
    await waitFor(() =>
      expect(transport().dragPreview?.startFrame).toBe(0),
    )
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 0 })
    expect(clipA().timelineRange.startFrame).toBe(0)
  })

  test('pointercancel reverts without committing', async () => {
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 620 })
    await waitFor(() =>
      expect(transport().dragPreview?.startFrame).toBe(220),
    )
    fireEvent.pointerCancel(el, { pointerId: 1 })
    expect(transport().dragPreview).toBeNull()
    expect(doc().past).toHaveLength(0)
    expect(clipA().timelineRange.startFrame).toBe(100)
  })
})

describe('drag isolation', () => {
  test('GATE: dragging clip A never re-renders clip B', async () => {
    const rendersA = vi.fn()
    const rendersB = vi.fn()
    const [a, b] = doc().doc.tracks[0].clips
    render(
      <>
        <Profiler id="a" onRender={rendersA}>
          <ClipView clip={a} trackId="V1" />
        </Profiler>
        <Profiler id="b" onRender={rendersB}>
          <ClipView clip={b} trackId="V1" />
        </Profiler>
      </>,
    )
    const elA = screen.getByTestId('clip-clipA')
    const before = rendersB.mock.calls.length

    fireEvent.pointerDown(elA, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(elA, { pointerId: 1, clientX: 540 })
    await waitFor(() =>
      expect(transport().dragPreview?.startFrame).toBe(140),
    )
    fireEvent.pointerMove(elA, { pointerId: 1, clientX: 580 })
    await waitFor(() =>
      expect(transport().dragPreview?.startFrame).toBe(180),
    )

    expect(rendersA.mock.calls.length).toBeGreaterThan(0)
    expect(rendersB.mock.calls.length).toBe(before) // B untouched
  })
})
