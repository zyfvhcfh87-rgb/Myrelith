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
import { usePreferencesStore } from '../../state/preferencesStore'
import { useTransportStore } from '../../state/transportStore'
import ClipView from './ClipView'
import Track from './Track'

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
    schemaVersion: 15,
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
    zoomMode: 'custom',
    customZoom: 1,
    timelineOriginFrame: 0,
    inOut: null,
    dragPreview: null,
    snapGuide: null,
  })
  usePreferencesStore.getState().setSnappingEnabled(true)
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
    expect(transport().dragPreview).toEqual({ clipId: 'clipA', deltaFrames: 0 })

    fireEvent.pointerMove(el, { pointerId: 1, clientX: 560 }) // +60px @ zoom 1
    await waitFor(() =>
      expect(transport().dragPreview?.deltaFrames).toBe(60),
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

  test('snaps a moving edge to the playhead in preview, then commits exactly once', async () => {
    act(() => transport().setPlayheadFrame(213))
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(el, { pointerId: 21, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 21, clientX: 560 })

    await waitFor(() => {
      expect(transport().dragPreview?.deltaFrames).toBe(63)
      expect(transport().snapGuide).toMatchObject({
        frame: 213,
        candidateKind: 'playhead',
      })
    })
    expect(clipA().timelineRange.startFrame).toBe(100)
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(el, { pointerId: 21, clientX: 560 })

    expect(clipA().timelineRange.startFrame).toBe(163)
    expect(doc().past).toHaveLength(1)
    expect(transport().dragPreview).toBeNull()
    expect(transport().snapGuide).toBeNull()
  })

  test('Alt temporarily bypasses snapping without changing the preference', async () => {
    act(() => transport().setPlayheadFrame(213))
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(el, { pointerId: 22, clientX: 500 })
    fireEvent.pointerMove(el, {
      pointerId: 22,
      clientX: 560,
      altKey: true,
    })
    await waitFor(() => {
      expect(transport().dragPreview?.deltaFrames).toBe(60)
    })
    expect(transport().snapGuide).toBeNull()

    fireEvent.pointerUp(el, {
      pointerId: 22,
      clientX: 560,
      altKey: true,
    })
    expect(clipA().timelineRange.startFrame).toBe(160)
    expect(doc().past).toHaveLength(1)
    expect(usePreferencesStore.getState().snappingEnabled).toBe(true)
  })

  test('the persistent preference disables snapping for pointer moves', async () => {
    act(() => {
      transport().setPlayheadFrame(213)
      usePreferencesStore.getState().setSnappingEnabled(false)
    })
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(el, { pointerId: 23, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 23, clientX: 560 })
    await waitFor(() => {
      expect(transport().dragPreview?.deltaFrames).toBe(60)
    })
    expect(transport().snapGuide).toBeNull()
    fireEvent.pointerUp(el, { pointerId: 23, clientX: 560 })

    expect(clipA().timelineRange.startFrame).toBe(160)
    expect(doc().past).toHaveLength(1)
  })

  test('Ctrl or Command arrows use the same resolver and one commit', () => {
    act(() => transport().setPlayheadFrame(107))
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    fireEvent.keyDown(el, { key: 'ArrowRight', ctrlKey: true })

    expect(clipA().timelineRange.startFrame).toBe(107)
    expect(doc().past).toHaveLength(1)
    expect(transport().snapGuide).toMatchObject({
      frame: 107,
      candidateKind: 'playhead',
    })

    fireEvent.keyDown(el, { key: 'ArrowRight', ctrlKey: true })
    expect(clipA().timelineRange.startFrame).toBe(107)
    expect(doc().past).toHaveLength(1)
  })

  test('rejected drop (overlap) pushes no history and snaps back', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    // Drag clipA onto clipB's territory: 100 → 310.
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 710 })
    await waitFor(() =>
      expect(transport().dragPreview?.deltaFrames).toBe(210),
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
      expect(transport().dragPreview?.deltaFrames).toBe(-100),
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
      expect(transport().dragPreview?.deltaFrames).toBe(120),
    )
    fireEvent.pointerCancel(el, { pointerId: 1 })
    expect(transport().dragPreview).toBeNull()
    expect(doc().past).toHaveLength(0)
    expect(clipA().timelineRange.startFrame).toBe(100)
  })

  test('capture failure still permits move events and one pointerup commit', async () => {
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')
    const captureSpy = vi
      .spyOn(el, 'setPointerCapture')
      .mockImplementation(() => {
        throw new DOMException('inactive pointer')
      })

    try {
      fireEvent.pointerDown(el, { pointerId: 2, clientX: 500 })
      fireEvent.pointerMove(el, { pointerId: 2, clientX: 560 })
      await waitFor(() =>
        expect(transport().dragPreview?.deltaFrames).toBe(60),
      )
      fireEvent.pointerUp(el, { pointerId: 2, clientX: 560 })

      expect(clipA().timelineRange.startFrame).toBe(160)
      expect(doc().past).toHaveLength(1)
      expect(transport().dragPreview).toBeNull()
    } finally {
      captureSpy.mockRestore()
    }
  })

  test('pointerleave after capture failure cancels without wedging a preview', async () => {
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')
    const captureSpy = vi
      .spyOn(el, 'setPointerCapture')
      .mockImplementation(() => {
        throw new DOMException('inactive pointer')
      })

    try {
      fireEvent.pointerDown(el, { pointerId: 3, clientX: 500 })
      fireEvent.pointerMove(el, { pointerId: 3, clientX: 560 })
      await waitFor(() =>
        expect(transport().dragPreview?.deltaFrames).toBe(60),
      )
      fireEvent.pointerLeave(el, { pointerId: 3, clientX: 560 })
      fireEvent.pointerUp(el, { pointerId: 3, clientX: 560 })

      expect(transport().dragPreview).toBeNull()
      expect(doc().past).toHaveLength(0)
      expect(clipA().timelineRange.startFrame).toBe(100)
    } finally {
      captureSpy.mockRestore()
    }
  })

  test('lost pointer capture cancels the live session without committing', async () => {
    render(<Track track={doc().doc.tracks[0]} />)
    const el = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(el, { pointerId: 4, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 4, clientX: 560 })
    await waitFor(() =>
      expect(transport().dragPreview?.deltaFrames).toBe(60),
    )
    fireEvent.lostPointerCapture(el, { pointerId: 4 })
    fireEvent.pointerUp(el, { pointerId: 4, clientX: 560 })

    expect(transport().dragPreview).toBeNull()
    expect(doc().past).toHaveLength(0)
    expect(clipA().timelineRange.startFrame).toBe(100)
  })

  test('a drag crossing the virtual window keeps its capture host through commit', async () => {
    const view = render(
      <Track
        track={doc().doc.tracks[0]}
        timelineOriginFrame={0}
        timelineWindowEndFrame={200}
      />,
    )
    const el = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(el, { pointerId: 8, clientX: 500 })
    fireEvent.pointerMove(el, { pointerId: 8, clientX: 650 })
    await waitFor(() =>
      expect(transport().dragPreview?.deltaFrames).toBe(150),
    )

    expect(document.body.contains(el)).toBe(true)
    expect(el).toHaveAttribute('data-virtual-gesture-host', 'true')
    expect(el).not.toHaveAttribute('aria-hidden')
    expect(el).toHaveAttribute('role', 'button')
    expect(el).toHaveAttribute('tabindex', '0')
    expect(el).toHaveAttribute('aria-label', 'clipA, video clip')
    expect(el).toHaveAttribute('aria-pressed')
    expect(el).toHaveAttribute('aria-keyshortcuts')
    expect(el).toHaveStyle({ transform: 'translateX(199px)', width: '1px' })

    // Simulate an origin rebase that culls the committed range but brings the
    // live preview back inside the new physical window. Track must retain the
    // same captured ClipView because it participates in the active gesture.
    view.rerender(
      <Track
        track={doc().doc.tracks[0]}
        timelineOriginFrame={200}
        timelineWindowEndFrame={400}
      />,
    )
    expect(screen.getByTestId('clip-clipA')).toBe(el)
    expect(el).toHaveAttribute('data-virtual-gesture-host', 'false')
    expect(el).toHaveStyle({ transform: 'translateX(50px)', width: '50px' })

    fireEvent.pointerUp(el, { pointerId: 8, clientX: 650 })
    expect(clipA().timelineRange.startFrame).toBe(250)
    expect(doc().past).toHaveLength(1)
    expect(transport().dragPreview).toBeNull()
  })

  test('live gesture membership is not rescanned for preview delta updates', () => {
    const track = makeTrack('stable-membership', [makeClip('stable-clip', 10, 20)])
    const membershipScan = vi.spyOn(track.clips, 'some')
    render(<Track track={track} timelineWindowEndFrame={200} />)

    expect(membershipScan).not.toHaveBeenCalled()

    act(() => transport().setDragPreview({
      clipId: 'stable-clip',
      deltaFrames: 1,
    }))
    expect(membershipScan).not.toHaveBeenCalled()

    act(() => transport().setDragPreview({
      clipId: 'stable-clip',
      deltaFrames: 2,
    }))
    act(() => transport().setPlayheadFrame(12))
    expect(membershipScan).not.toHaveBeenCalled()

    act(() => transport().setDragPreview(null))
  })

  test('bounds cold gesture hosts for an oversized imported link group', () => {
    const linkedClips = Array.from({ length: 2_000 }, (_, index) => ({
      ...makeClip(`oversized-${index}`, 1_000 + index * 30, 20),
      linkGroupId: 'oversized-imported-group',
    }))
    const track = makeTrack('oversized-track', linkedClips, 'audio')

    act(() => transport().setDragPreview({
      clipId: 'owner-on-another-track',
      deltaFrames: 1,
      linkGroupId: 'oversized-imported-group',
    }))
    const { container } = render(
      <Track track={track} timelineOriginFrame={0} timelineWindowEndFrame={200} />,
    )

    expect(
      container.querySelectorAll('[data-virtual-gesture-host="true"]'),
    ).toHaveLength(1)
    expect(screen.getByTestId('clip-oversized-0')).toBeInTheDocument()
    expect(screen.queryByTestId('clip-oversized-1')).not.toBeInTheDocument()

    act(() => transport().setDragPreview(null))
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
        deltaFrames: 60,
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
        deltaFrames: 0,
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
        deltaFrames: 30,
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
      expect(transport().dragPreview?.deltaFrames).toBe(40),
    )
    fireEvent.pointerMove(elA, { pointerId: 1, clientX: 580 })
    await waitFor(() =>
      expect(transport().dragPreview?.deltaFrames).toBe(80),
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
      schemaVersion: 15,
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

  /** A manually linked pair whose assets, source ranges, starts, and
   * durations deliberately differ. */
  function makeUnequalLinkedDoc(withAudioBlock = false): TimelineDoc {
    const video = {
      ...makeClip('vid', 100, 70),
      assetId: 'asset-video',
      sourceRange: { startFrame: 11, durationFrames: 70 },
      linkGroupId: 'link_1',
    }
    const audio = {
      ...makeClip('aud', 35, 40),
      assetId: 'asset-audio',
      sourceRange: { startFrame: 22, durationFrames: 40 },
      linkGroupId: 'link_1',
    }
    return {
      schemaVersion: 15,
      id: 'doc-unequal-linked-drag',
      name: 'unequal linked drag fixture',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks: [
        makeTrack('V1', [video]),
        makeTrack(
          'A1',
          withAudioBlock ? [audio, makeClip('audioBlock', 120, 20)] : [audio],
          'audio',
        ),
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
    await waitFor(() => expect(transport().dragPreview?.deltaFrames).toBe(60))

    // Both halves visually follow the SAME preview — partner ghosts the gesture.
    expect(videoEl).toHaveStyle({ transform: 'translateX(160px)' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(160px)' })
    expect(videoEl).toHaveClass('dragging')
    expect(audioEl).toHaveClass('dragging')
    // Still mid-drag: the document itself is untouched.
    expect(vidClip().timelineRange.startFrame).toBe(100)
    expect(audClip().timelineRange.startFrame).toBe(100)
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(videoEl, { pointerId: 1, clientX: 560 })

    expect(vidClip().timelineRange.startFrame).toBe(160)
    expect(audClip().timelineRange.startFrame).toBe(160)
    expect(videoEl).not.toHaveClass('dragging')
    expect(audioEl).not.toHaveClass('dragging')
    expect(doc().past).toHaveLength(1) // ONE entry for the whole linked move
  })

  test('unequal linked members preview and commit from their own starts with one shared delta', async () => {
    doc().setDoc(makeUnequalLinkedDoc())
    render(
      <>
        <Track track={v1()} />
        <Track track={a1()} />
      </>,
    )
    const videoEl = screen.getByTestId('clip-vid')
    const audioEl = screen.getByTestId('clip-aud')

    expect(videoEl).toHaveStyle({ transform: 'translateX(100px)', width: '70px' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(35px)', width: '40px' })

    fireEvent.pointerDown(videoEl, { pointerId: 9, clientX: 500 })
    fireEvent.pointerMove(videoEl, { pointerId: 9, clientX: 557 })
    await waitFor(() => expect(transport().dragPreview?.deltaFrames).toBe(57))

    expect(videoEl).toHaveStyle({ transform: 'translateX(157px)', width: '70px' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(92px)', width: '40px' })
    expect(vidClip().timelineRange).toEqual({ startFrame: 100, durationFrames: 70 })
    expect(audClip().timelineRange).toEqual({ startFrame: 35, durationFrames: 40 })
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(videoEl, { pointerId: 9, clientX: 557 })

    expect(vidClip().timelineRange).toEqual({ startFrame: 157, durationFrames: 70 })
    expect(audClip().timelineRange).toEqual({ startFrame: 92, durationFrames: 40 })
    expect(vidClip().sourceRange).toEqual({ startFrame: 11, durationFrames: 70 })
    expect(audClip().sourceRange).toEqual({ startFrame: 22, durationFrames: 40 })
    expect(
      vidClip().timelineRange.startFrame - audClip().timelineRange.startFrame,
    ).toBe(65)
    expect(doc().past).toHaveLength(1)

    doc().undo()
    expect(vidClip().timelineRange.startFrame).toBe(100)
    expect(audClip().timelineRange.startFrame).toBe(35)
    doc().redo()
    expect(vidClip().timelineRange.startFrame).toBe(157)
    expect(audClip().timelineRange.startFrame).toBe(92)
  })

  test('an offscreen linked partner mounts for the live drag, then commits atomically', async () => {
    const linked = makeUnequalLinkedDoc()
    linked.tracks[1].clips[0] = {
      ...linked.tracks[1].clips[0],
      timelineRange: { startFrame: 1_000, durationFrames: 40 },
    }
    doc().setDoc(linked)
    render(
      <>
        <Track
          track={v1()}
          timelineOriginFrame={0}
          timelineWindowEndFrame={200}
        />
        <Track
          track={a1()}
          timelineOriginFrame={0}
          timelineWindowEndFrame={200}
        />
      </>,
    )
    const videoEl = screen.getByTestId('clip-vid')
    expect(screen.queryByTestId('clip-aud')).not.toBeInTheDocument()

    fireEvent.pointerDown(videoEl, { pointerId: 14, clientX: 100 })
    fireEvent.pointerMove(videoEl, { pointerId: 14, clientX: 120 })
    await waitFor(() => expect(transport().dragPreview?.deltaFrames).toBe(20))

    const audioEl = screen.getByTestId('clip-aud')
    expect(audioEl).toHaveAttribute('data-virtual-gesture-host', 'true')
    expect(audioEl).not.toHaveAttribute('role')
    expect(audioEl).toHaveAttribute('tabindex', '-1')
    expect(audioEl).toHaveAttribute('aria-hidden', 'true')
    expect(audioEl).not.toHaveAttribute('aria-label')
    expect(audioEl).toHaveClass('dragging')
    expect(audioEl).toHaveStyle({ width: '1px' })
    expect(doc().doc).toBe(linked)

    fireEvent.pointerUp(videoEl, { pointerId: 14, clientX: 120 })

    expect(vidClip().timelineRange.startFrame).toBe(120)
    expect(audClip().timelineRange.startFrame).toBe(1_020)
    expect(doc().past).toEqual([linked])
    expect(screen.queryByTestId('clip-aud')).not.toBeInTheDocument()
  })

  test('linked move clamps live to the earliest partner timeline floor', async () => {
    doc().setDoc(makeUnequalLinkedDoc())
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <>
        <Track track={v1()} />
        <Track track={a1()} />
      </>,
    )
    const videoEl = screen.getByTestId('clip-vid')
    const audioEl = screen.getByTestId('clip-aud')
    const before = doc().doc

    fireEvent.pointerDown(videoEl, { pointerId: 11, clientX: 500 })
    fireEvent.pointerMove(videoEl, { pointerId: 11, clientX: 400 }) // raw -100
    await waitFor(() => expect(transport().dragPreview?.deltaFrames).toBe(-35))

    expect(videoEl).toHaveStyle({ transform: 'translateX(65px)' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(0px)' })
    expect(doc().doc).toBe(before)
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(videoEl, { pointerId: 11, clientX: 400 })

    expect(vidClip().timelineRange.startFrame).toBe(65)
    expect(audClip().timelineRange.startFrame).toBe(0)
    expect(
      vidClip().timelineRange.startFrame - audClip().timelineRange.startFrame,
    ).toBe(65)
    expect(doc().past).toEqual([before])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test('capture-phase unlink uses the fresh group identity for the gesture session', () => {
    doc().setDoc(makeUnequalLinkedDoc())
    render(
      <div onPointerDownCapture={() => doc().unlinkClip('vid')}>
        <Track track={v1()} />
        <Track track={a1()} />
      </div>,
    )
    const videoEl = screen.getByTestId('clip-vid')

    fireEvent.pointerDown(videoEl, { pointerId: 12, clientX: 500 })

    expect(vidClip().linkGroupId).toBeUndefined()
    expect(audClip().linkGroupId).toBeUndefined()
    expect(transport().dragPreview).toMatchObject({
      clipId: 'vid',
      deltaFrames: 0,
    })
    expect(transport().dragPreview?.linkGroupId).toBeUndefined()
    fireEvent.pointerUp(videoEl, { pointerId: 12, clientX: 500 })
  })

  test('capture-phase deletion cannot reintroduce a stale selected clip id', () => {
    doc().setDoc(makeUnequalLinkedDoc())
    act(() => transport().setSelectedClip('aud'))
    render(
      <div
        onPointerDownCapture={() => {
          const current = doc().doc
          doc().setDoc({
            ...current,
            tracks: current.tracks.map((track) =>
              track.id === 'V1' ? { ...track, clips: [] } : track,
            ),
          })
        }}
      >
        <Track track={v1()} />
        <Track track={a1()} />
      </div>,
    )
    const staleVideoEl = screen.getByTestId('clip-vid')

    fireEvent.pointerDown(staleVideoEl, { pointerId: 13, clientX: 500 })

    expect(doc().doc.tracks[0].clips).toEqual([])
    expect(transport().dragPreview).toBeNull()
    expect(transport().selectedClipIds).toEqual(['aud'])
    expect(transport().selectedClipId).toBe('aud')
  })

  test('an unequal linked collision snaps both previews back and commits no history', async () => {
    doc().setDoc(makeUnequalLinkedDoc(true))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <>
        <Track track={v1()} />
        <Track track={a1()} />
      </>,
    )
    const videoEl = screen.getByTestId('clip-vid')
    const audioEl = screen.getByTestId('clip-aud')

    fireEvent.pointerDown(videoEl, { pointerId: 10, clientX: 500 })
    fireEvent.pointerMove(videoEl, { pointerId: 10, clientX: 560, altKey: true })
    await waitFor(() => expect(transport().dragPreview?.deltaFrames).toBe(60))
    expect(videoEl).toHaveStyle({ transform: 'translateX(160px)' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(95px)' })
    expect(videoEl).toHaveClass('dragging')
    expect(audioEl).toHaveClass('dragging')

    fireEvent.pointerUp(videoEl, { pointerId: 10, clientX: 560, altKey: true })

    expect(transport().dragPreview).toBeNull()
    expect(videoEl).toHaveStyle({ transform: 'translateX(100px)' })
    expect(audioEl).toHaveStyle({ transform: 'translateX(35px)' })
    expect(videoEl).not.toHaveClass('dragging')
    expect(audioEl).not.toHaveClass('dragging')
    expect(vidClip().timelineRange.startFrame).toBe(100)
    expect(audClip().timelineRange.startFrame).toBe(35)
    expect(doc().past).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test('cross-track video drag ghosts the linked audio partner onto the matching audio lane', async () => {
    const linked = makeLinkedDoc()
    linked.tracks.splice(1, 0, makeTrack('V2', []))
    linked.tracks.push(makeTrack('A2', [], 'audio'))
    doc().setDoc(linked)
    render(
      <>
        <Track track={trackById('V2')} />
        <Track track={trackById('V1')} />
        <Track track={trackById('A1')} />
        <Track track={trackById('A2')} />
      </>,
    )
    mockLaneRect('V2', 0)
    mockLaneRect('V1', 56)
    mockLaneRect('A1', 112)
    mockLaneRect('A2', 168)

    const videoEl = screen.getByTestId('clip-vid')
    const audioEl = screen.getByTestId('clip-aud')
    fireEvent.pointerDown(videoEl, { pointerId: 4, clientX: 500, clientY: 84 })
    fireEvent.pointerMove(videoEl, { pointerId: 4, clientX: 560, clientY: 28 })
    await waitFor(() =>
      expect(transport().dragPreview).toMatchObject({
        clipId: 'vid',
        deltaFrames: 60,
        targetTrackId: 'V2',
        trackOffsetY: -56,
        linkGroupId: 'link_1',
        partnerTrackOffsets: { aud: 56 },
      }),
    )

    expect(videoEl).toHaveStyle({ transform: 'translate(160px, -56px)' })
    expect(audioEl).toHaveStyle({ transform: 'translate(160px, 56px)' })
    fireEvent.pointerUp(videoEl, { pointerId: 4, clientX: 560, clientY: 28 })

    expect(trackById('V1').clips).toHaveLength(0)
    expect(trackById('A1').clips).toHaveLength(0)
    expect(trackById('V2').clips.find((clip) => clip.id === 'vid')?.timelineRange.startFrame).toBe(160)
    expect(trackById('A2').clips.find((clip) => clip.id === 'aud')?.timelineRange.startFrame).toBe(160)
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
    await waitFor(() => expect(transport().dragPreview?.deltaFrames).toBe(60))
    fireEvent.pointerUp(loneEl, { pointerId: 1, clientX: 560 })

    const lone = v1().clips.find((c) => c.id === 'lone') as Clip
    expect(lone.timelineRange.startFrame).toBe(360) // its own move went through
    expect(doc().past).toHaveLength(1) // one entry, for the lone clip only
    expect(vidClip().timelineRange.startFrame).toBe(100) // linked pair untouched
    expect(audClip().timelineRange.startFrame).toBe(100)
  })
})
