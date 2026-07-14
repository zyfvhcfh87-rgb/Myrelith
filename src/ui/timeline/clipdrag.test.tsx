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

function makeTrack(
  id: string,
  clips: Clip[],
  kind: TrackData['kind'] = 'video',
): TrackData {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
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

const trackById = (trackId: string): TrackData => {
  const track = doc().doc.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`missing track ${trackId}`)
  return track
}

function laneRect(top: number): DOMRect {
  return {
    x: 200,
    y: top,
    left: 200,
    right: 1200,
    top,
    bottom: top + 56,
    width: 1000,
    height: 56,
    toJSON: () => ({}),
  } as DOMRect
}

function mockLaneRect(trackId: string, top: number): void {
  vi.spyOn(screen.getByTestId(`track-${trackId}`), 'getBoundingClientRect')
    .mockReturnValue(laneRect(top))
}

describe('ClipView rendering', () => {
  test('positions by timelineRange at current zoom', () => {
    act(() => transport().setZoom(2))
    render(<ClipView clip={clipA()} trackId="V1" />)
    const el = screen.getByTestId('clip-clipA')
    expect(el).toHaveStyle({ transform: 'translateX(200px)', width: '100px' })
  })

  test('Track renders a lane with its clips (identity lives in TrackHeader)', () => {
    render(<Track track={doc().doc.tracks[0]} />)
    expect(screen.getByTestId('track-V1')).toBeInTheDocument()
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

describe('drag: same-kind track targeting', () => {
  test('video clip ghosts to a new lane, moves there and back, and undo restores each source lane', async () => {
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', [makeClip('clipA', 100, 50), makeClip('clipB', 300, 80)]),
        makeTrack('V2', []),
      ],
    })
    const view = render(
      <>
        <Track track={trackById('V2')} />
        <Track track={trackById('V1')} />
      </>,
    )
    mockLaneRect('V2', 0)
    mockLaneRect('V1', 56)

    const firstClip = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(firstClip, { pointerId: 1, clientX: 500, clientY: 84 })
    fireEvent.pointerMove(firstClip, { pointerId: 1, clientX: 560, clientY: 28 })

    await waitFor(() =>
      expect(transport().dragPreview).toMatchObject({
        clipId: 'clipA',
        startFrame: 160,
        targetTrackId: 'V2',
        trackOffsetY: -56,
      }),
    )
    expect(firstClip).toHaveStyle({ transform: 'translate(160px, -56px)' })
    expect(screen.getByTestId('track-V2')).toHaveClass('clip-drop-target')
    expect(trackById('V1').clips.some((clip) => clip.id === 'clipA')).toBe(true)
    expect(trackById('V2').clips).toHaveLength(0)

    fireEvent.pointerUp(firstClip, { pointerId: 1, clientX: 560, clientY: 28 })

    expect(trackById('V1').clips.some((clip) => clip.id === 'clipA')).toBe(false)
    expect(trackById('V2').clips.find((clip) => clip.id === 'clipA')?.timelineRange.startFrame).toBe(160)
    expect(doc().past).toHaveLength(1)
    expect(transport().dragPreview).toBeNull()

    doc().undo()
    expect(trackById('V1').clips.some((clip) => clip.id === 'clipA')).toBe(true)
    doc().redo()
    expect(trackById('V2').clips.some((clip) => clip.id === 'clipA')).toBe(true)

    view.rerender(
      <>
        <Track track={trackById('V2')} />
        <Track track={trackById('V1')} />
      </>,
    )
    mockLaneRect('V2', 0)
    mockLaneRect('V1', 56)

    const returningClip = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(returningClip, { pointerId: 2, clientX: 560, clientY: 28 })
    fireEvent.pointerMove(returningClip, { pointerId: 2, clientX: 560, clientY: 84 })
    await waitFor(() =>
      expect(transport().dragPreview).toMatchObject({
        clipId: 'clipA',
        startFrame: 160,
        targetTrackId: 'V1',
        trackOffsetY: 56,
      }),
    )
    fireEvent.pointerUp(returningClip, { pointerId: 2, clientX: 560, clientY: 84 })

    expect(trackById('V1').clips.some((clip) => clip.id === 'clipA')).toBe(true)
    expect(trackById('V2').clips.some((clip) => clip.id === 'clipA')).toBe(false)
    expect(doc().past).toHaveLength(2)
    doc().undo()
    expect(trackById('V2').clips.some((clip) => clip.id === 'clipA')).toBe(true)
  })

  test('audio clips use the same vertical targeting contract', async () => {
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('A1', [makeClip('audioA', 40, 40)], 'audio'),
        makeTrack('A2', [], 'audio'),
      ],
    })
    render(
      <>
        <Track track={trackById('A1')} />
        <Track track={trackById('A2')} />
      </>,
    )
    mockLaneRect('A1', 0)
    mockLaneRect('A2', 56)

    const audioClip = screen.getByTestId('clip-audioA')
    fireEvent.pointerDown(audioClip, { pointerId: 3, clientX: 500, clientY: 28 })
    fireEvent.pointerMove(audioClip, { pointerId: 3, clientX: 530, clientY: 84 })
    await waitFor(() =>
      expect(transport().dragPreview).toMatchObject({
        clipId: 'audioA',
        startFrame: 70,
        targetTrackId: 'A2',
        trackOffsetY: 56,
      }),
    )
    fireEvent.pointerUp(audioClip, { pointerId: 3, clientX: 530, clientY: 84 })

    expect(trackById('A1').clips).toHaveLength(0)
    expect(trackById('A2').clips.find((clip) => clip.id === 'audioA')?.timelineRange.startFrame).toBe(70)
    expect(doc().past).toHaveLength(1)
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

describe('linked clip gestures (A/V pairs)', () => {
  /** V1 has the video half 'vid' [100,50); A1 has the audio half 'aud' at
   * the SAME range, both sharing 'link_1' — a linked pair by construction. */
  function makeLinkedDoc(): TimelineDoc {
    return {
      schemaVersion: 1,
      id: 'doc-linked-drag',
      name: 'linked drag fixture',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          name: 'V1',
          clips: [{ ...makeClip('vid', 100, 50), linkGroupId: 'link_1' }],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
        {
          id: 'A1',
          kind: 'audio',
          name: 'A1',
          clips: [{ ...makeClip('aud', 100, 50), linkGroupId: 'link_1' }],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
      ],
    }
  }

  const v1 = () => doc().doc.tracks[0]
  const a1 = () => doc().doc.tracks[1]
  const vidClip = () => v1().clips.find((c) => c.id === 'vid') as Clip
  const audClip = () => a1().clips.find((c) => c.id === 'aud') as Clip

  test('dragging the video half live-previews the linked audio half; pointerup moves BOTH with ONE history entry', async () => {
    doc().setDoc(makeLinkedDoc())
    render(
      <>
        <Track track={v1()} />
        <Track track={a1()} />
      </>,
    )
    const videoEl = screen.getByTestId('clip-vid')
    const audioEl = screen.getByTestId('clip-aud')

    fireEvent.pointerDown(videoEl, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(videoEl, { pointerId: 1, clientX: 560 }) // +60px @ zoom 1
    await waitFor(() => expect(transport().dragPreview?.startFrame).toBe(160))

    // Both halves visually follow the SAME preview — partner ghosts the gesture.
    expect(videoEl).toHaveStyle({ transform: 'translateX(160px)' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(160px)' })
    // Still mid-drag: the document itself is untouched.
    expect(vidClip().timelineRange.startFrame).toBe(100)
    expect(audClip().timelineRange.startFrame).toBe(100)
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(videoEl, { pointerId: 1, clientX: 560 })

    expect(vidClip().timelineRange.startFrame).toBe(160)
    expect(audClip().timelineRange.startFrame).toBe(160)
    expect(doc().past).toHaveLength(1) // ONE entry for the whole linked move
  })

  test('cross-track video drag ghosts only the owner vertically while its linked audio partner stays on its lane', async () => {
    const linked = makeLinkedDoc()
    linked.tracks.splice(1, 0, makeTrack('V2', []))
    doc().setDoc(linked)
    render(
      <>
        <Track track={trackById('V2')} />
        <Track track={trackById('V1')} />
        <Track track={trackById('A1')} />
      </>,
    )
    mockLaneRect('V2', 0)
    mockLaneRect('V1', 56)
    mockLaneRect('A1', 112)

    const videoEl = screen.getByTestId('clip-vid')
    const audioEl = screen.getByTestId('clip-aud')
    fireEvent.pointerDown(videoEl, { pointerId: 4, clientX: 500, clientY: 84 })
    fireEvent.pointerMove(videoEl, { pointerId: 4, clientX: 560, clientY: 28 })
    await waitFor(() =>
      expect(transport().dragPreview).toMatchObject({
        clipId: 'vid',
        startFrame: 160,
        targetTrackId: 'V2',
        trackOffsetY: -56,
        linkGroupId: 'link_1',
      }),
    )

    expect(videoEl).toHaveStyle({ transform: 'translate(160px, -56px)' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(160px)' })
    fireEvent.pointerUp(videoEl, { pointerId: 4, clientX: 560, clientY: 28 })

    expect(trackById('V1').clips).toHaveLength(0)
    expect(trackById('V2').clips.find((clip) => clip.id === 'vid')?.timelineRange.startFrame).toBe(160)
    expect(trackById('A1').clips.find((clip) => clip.id === 'aud')?.timelineRange.startFrame).toBe(160)
    expect(doc().past).toHaveLength(1)
  })

  test('dragging an UNLINKED clip does not move a linked pair elsewhere (isolation)', async () => {
    const withExtra = makeLinkedDoc()
    withExtra.tracks[0].clips.push(makeClip('lone', 300, 40))
    doc().setDoc(withExtra)
    render(
      <>
        <Track track={v1()} />
        <Track track={a1()} />
      </>,
    )
    const loneEl = screen.getByTestId('clip-lone')

    fireEvent.pointerDown(loneEl, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(loneEl, { pointerId: 1, clientX: 560 }) // +60px @ zoom 1
    await waitFor(() => expect(transport().dragPreview?.startFrame).toBe(360))
    fireEvent.pointerUp(loneEl, { pointerId: 1, clientX: 560 })

    const lone = v1().clips.find((c) => c.id === 'lone') as Clip
    expect(lone.timelineRange.startFrame).toBe(360) // its own move went through
    expect(doc().past).toHaveLength(1) // one entry, for the lone clip only
    expect(vidClip().timelineRange.startFrame).toBe(100) // linked pair untouched
    expect(audClip().timelineRange.startFrame).toBe(100)
  })
})
