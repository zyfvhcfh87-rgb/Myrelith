/**
 * ui/timeline/edittools.test.tsx — Phase 4.2 tool gestures.
 *
 * Each tool follows the same contract clipdrag.test.tsx proves for moves:
 *   mid-drag   → only transportStore.editPreview changes, doc untouched
 *   pointerup  → exactly ONE documentStore commit (one undo entry)
 *   rejected   → no history entry, the clip snaps back
 * plus selection behavior and render isolation for selection changes.
 */

import { Profiler } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createProjectFileSnapshot,
  serializeProjectFile,
  type PortableAssetDescriptor,
} from '../../domain/projectFile'
import type {
  Clip,
  MediaAsset,
  TimelineDoc,
  Track as TrackData,
} from '../../domain/schema'
import { useDocumentStore } from '../../state/documentStore'
import { useMediaStore } from '../../state/mediaStore'
import { useTransportStore } from '../../state/transportStore'
import ClipView from './ClipView'
import Track from './Track'

function makeClip(id: string, tlStart: number, duration: number, srcStart = 0): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: srcStart, durationFrames: duration },
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
    solo: false,
    locked: false,
  }
}

/** V1: clipA [100,50) src@20 · clipB [150,80) touching A · clipC [280,40). */
function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc-tools',
    name: 'tools fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', [
        makeClip('clipA', 100, 50, 20),
        makeClip('clipB', 150, 80, 0),
        makeClip('clipC', 280, 40, 0),
      ]),
    ],
  }
}

const connectedAsset: MediaAsset = {
  id: 'asset-1',
  fileName: 'source.mp4',
  mimeType: 'video/mp4',
  size: 1_024,
  lastModified: 1_725_000_000_000,
  objectUrl: 'blob:source',
  kind: 'video',
  durationFrames: 300,
  durationMicroseconds: 10_000_000,
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioSampleRate: 48_000,
  audioChannels: 2,
  decoderConfigB64: null,
}

const connectedDescriptor: PortableAssetDescriptor = {
  id: connectedAsset.id,
  fileName: connectedAsset.fileName,
  mimeType: connectedAsset.mimeType,
  size: connectedAsset.size,
  lastModified: connectedAsset.lastModified,
  kind: connectedAsset.kind,
  durationMicroseconds: connectedAsset.durationMicroseconds,
  nativeFrameRate: connectedAsset.frameRate,
  width: connectedAsset.width,
  height: connectedAsset.height,
  hasAudio: connectedAsset.hasAudio,
  audioSampleRate: connectedAsset.audioSampleRate,
  audioChannels: connectedAsset.audioChannels,
}

const offlineDescriptor: PortableAssetDescriptor = {
  ...connectedDescriptor,
  durationMicroseconds: 3_000_000,
}

const doc = () => useDocumentStore.getState()
const transport = () => useTransportStore.getState()
const v1 = () => doc().doc.tracks[0]
const clipById = (id: string) => v1().clips.find((c) => c.id === id) as Clip

function installOfflineBoundsFixture(): void {
  doc().setDoc({
    ...makeDoc(),
    id: 'doc-offline-bounds',
    name: 'offline bounds fixture',
    tracks: [makeTrack('V1', [makeClip('offline', 100, 50, 20)])],
  })
  useMediaStore.setState({
    descriptors: new Map([[offlineDescriptor.id, offlineDescriptor]]),
    assets: new Map(),
    visuals: new Map(),
  })
}

function expectCurrentDocumentToRemainPortable(): void {
  const descriptors = useMediaStore.getState().descriptors.values()
  expect(() => serializeProjectFile(
    createProjectFileSnapshot(doc().doc, descriptors),
  )).not.toThrow()
}

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
  useMediaStore.setState({
    descriptors: new Map([[connectedDescriptor.id, connectedDescriptor]]),
    assets: new Map([[connectedAsset.id, connectedAsset]]),
    visuals: new Map(),
  })
})

const renderTrack = () => render(<Track track={v1()} />)

describe('selection (select tool)', () => {
  test('pointerdown selects a clip; empty-lane pointerdown deselects', () => {
    renderTrack()
    fireEvent.pointerDown(screen.getByTestId('clip-clipA'), { pointerId: 1, clientX: 120 })
    expect(transport().selectedClipId).toBe('clipA')
    fireEvent.pointerUp(screen.getByTestId('clip-clipA'), { pointerId: 1, clientX: 120 })

    // Selected styling appears after the store round-trip.
    expect(screen.getByTestId('clip-clipA').className).toContain('selected')

    fireEvent.pointerDown(screen.getByTestId('track-V1'), { pointerId: 2, clientX: 700 })
    expect(transport().selectedClipId).toBeNull()
  })

  test('selecting one clip never re-renders the others (isolation)', () => {
    const renders = { A: 0, B: 0 }
    render(
      <>
        <Profiler id="A" onRender={() => renders.A++}>
          <ClipView clip={clipById('clipA')} trackId="V1" />
        </Profiler>
        <Profiler id="B" onRender={() => renders.B++}>
          <ClipView clip={clipById('clipB')} trackId="V1" />
        </Profiler>
      </>,
    )
    const before = { ...renders }
    act(() => transport().setSelectedClip('clipA'))
    expect(renders.A).toBe(before.A + 1) // gained the outline
    expect(renders.B).toBe(before.B) // untouched
  })
})

describe('trim via edges (select tool)', () => {
  test('end-edge drag previews live and commits ONE trimClip', async () => {
    renderTrack()
    const clip = screen.getByTestId('clip-clipA')
    const edge = screen.getByTestId('clip-clipA-edge-end')

    fireEvent.pointerDown(edge, { pointerId: 1, clientX: 150 })
    expect(transport().editPreview).toEqual({
      clipId: 'clipA',
      kind: 'trim-end',
      deltaFrames: 0,
    })
    // The body handler must NOT have started a move drag too.
    expect(transport().dragPreview).toBeNull()

    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 130 }) // -20px @ zoom 1
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(-20))
    expect(clipById('clipA').timelineRange.durationFrames).toBe(50) // doc untouched
    expect(clip).toHaveStyle({ width: '30px' }) // preview shrinks the block

    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 130 })
    expect(clipById('clipA').timelineRange).toEqual({ startFrame: 100, durationFrames: 30 })
    expect(clipById('clipA').sourceRange.durationFrames).toBe(30)
    expect(clipById('clipB').timelineRange.startFrame).toBe(150) // plain trim: no ripple
    expect(doc().past).toHaveLength(1)
    expect(transport().editPreview).toBeNull()
  })

  test('start-edge drag trims head and advances the source in-point', async () => {
    renderTrack()
    const clip = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(screen.getByTestId('clip-clipA-edge-start'), {
      pointerId: 1,
      clientX: 100,
    })
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 110 })
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(10))
    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 110 })

    expect(clipById('clipA').timelineRange).toEqual({ startFrame: 110, durationFrames: 40 })
    expect(clipById('clipA').sourceRange).toEqual({ startFrame: 30, durationFrames: 40 })
    expect(doc().past).toHaveLength(1)
  })

  test('a rejected trim (into a neighbor) snaps back with no history', async () => {
    renderTrack()
    const clip = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(screen.getByTestId('clip-clipA-edge-end'), {
      pointerId: 1,
      clientX: 150,
    })
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 180 }) // +30 → into clipB
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(30))
    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 180 })

    expect(clipById('clipA').timelineRange.durationFrames).toBe(50) // unchanged
    expect(doc().past).toHaveLength(0)
    expect(transport().editPreview).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('ripple trim (trim tool)', () => {
  test('end-edge drag ripples downstream clips on commit', async () => {
    act(() => transport().setTool('trim'))
    renderTrack()
    const clip = screen.getByTestId('clip-clipA')
    fireEvent.pointerDown(screen.getByTestId('clip-clipA-edge-end'), {
      pointerId: 1,
      clientX: 150,
    })
    expect(transport().editPreview?.kind).toBe('ripple-end')

    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 130 })
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(-20))
    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 130 })

    expect(clipById('clipA').timelineRange.durationFrames).toBe(30)
    expect(clipById('clipB').timelineRange.startFrame).toBe(130) // followed left
    expect(clipById('clipC').timelineRange.startFrame).toBe(260) // gap preserved
    expect(doc().past).toHaveLength(1)
  })
})

describe('razor tool', () => {
  test('a click splits THIS clip at the pointer frame — no drag needed', () => {
    act(() => transport().setTool('razor'))
    renderTrack()
    // jsdom rects sit at x=0, so clientX is the offset within the clip:
    // frame = clip start (100) + 30 = 130, strictly inside [100,150).
    fireEvent.pointerDown(screen.getByTestId('clip-clipA'), { pointerId: 1, clientX: 30 })

    const clips = v1().clips
    expect(clips).toHaveLength(4)
    expect(clips[0].timelineRange).toEqual({ startFrame: 100, durationFrames: 30 })
    expect(clips[1].timelineRange).toEqual({ startFrame: 130, durationFrames: 20 })
    // Halves partition the source exactly (src started at 20).
    expect(clips[0].sourceRange).toEqual({ startFrame: 20, durationFrames: 30 })
    expect(clips[1].sourceRange).toEqual({ startFrame: 50, durationFrames: 20 })
    expect(doc().past).toHaveLength(1)
  })

  test('razor-splitting a linked pair: left halves keep the original group, right halves share ONE new group', () => {
    // V1 'vid' and A1 'aud', same range [100,50), both in 'link_orig'.
    doc().setDoc({
      schemaVersion: 1,
      id: 'doc-tools-linked',
      name: 'tools linked fixture',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          name: 'V1',
          clips: [{ ...makeClip('vid', 100, 50), linkGroupId: 'link_orig' }],
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
          clips: [{ ...makeClip('aud', 100, 50), linkGroupId: 'link_orig' }],
          transitions: [],
          hidden: false,
          muted: false,
          solo: false,
          locked: false,
        },
      ],
    })
    act(() => transport().setTool('razor'))
    render(
      <>
        <Track track={doc().doc.tracks[0]} />
        <Track track={doc().doc.tracks[1]} />
      </>,
    )
    // frame = clip start (100) + 30 = 130, strictly inside [100,150).
    fireEvent.pointerDown(screen.getByTestId('clip-vid'), { pointerId: 1, clientX: 30 })

    const videoClips = doc().doc.tracks[0].clips
    const audioClips = doc().doc.tracks[1].clips
    expect(videoClips).toHaveLength(2) // left + right
    expect(audioClips).toHaveLength(2) // partner followed

    const [vLeft, vRight] = videoClips
    const [aLeft, aRight] = audioClips

    // Left halves keep the ORIGINAL group id.
    expect(vLeft.linkGroupId).toBe('link_orig')
    expect(aLeft.linkGroupId).toBe('link_orig')

    // Right halves share ONE NEW group id, distinct from the original.
    expect(vRight.linkGroupId).toBeDefined()
    expect(vRight.linkGroupId).not.toBe('link_orig')
    expect(aRight.linkGroupId).toBe(vRight.linkGroupId)

    expect(doc().past).toHaveLength(1) // ONE history entry for the whole split
  })
})

describe('slip tool', () => {
  test('body drag shifts source only, shows a badge, commits one entry', async () => {
    act(() => transport().setTool('slip'))
    renderTrack()
    const clip = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(clip, { pointerId: 1, clientX: 120 })
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 110 }) // -10
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(-10))
    // Position/width unchanged mid-gesture; the badge narrates instead.
    expect(clip).toHaveStyle({ transform: 'translateX(100px)', width: '50px' })
    expect(screen.getByText('slip -10')).toBeInTheDocument()

    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 110 })
    expect(clipById('clipA').sourceRange).toEqual({ startFrame: 10, durationFrames: 50 })
    expect(clipById('clipA').timelineRange).toEqual({ startFrame: 100, durationFrames: 50 })
    expect(doc().past).toHaveLength(1)
  })

  test('slip clamps live at the source floor (src cannot go below 0)', async () => {
    act(() => transport().setTool('slip'))
    renderTrack()
    const clip = screen.getByTestId('clip-clipA')

    fireEvent.pointerDown(clip, { pointerId: 1, clientX: 120 })
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 60 }) // raw -60, src@20
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(-20))

    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 60 })
    expect(clipById('clipA').sourceRange.startFrame).toBe(0)
    expect(doc().past).toHaveLength(1)
  })
})

describe('offline descriptor source bounds', () => {
  test('plain trim-end stops at the descriptor duration', async () => {
    installOfflineBoundsFixture()
    renderTrack()
    const clip = screen.getByTestId('clip-offline')

    fireEvent.pointerDown(screen.getByTestId('clip-offline-edge-end'), {
      pointerId: 1,
      clientX: 150,
    })
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 350 })
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(20))
    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 350 })

    expect(clipById('offline').sourceRange).toEqual({
      startFrame: 20,
      durationFrames: 70,
    })
    expect(clipById('offline').timelineRange.durationFrames).toBe(70)
    expect(doc().past).toHaveLength(1)
    expectCurrentDocumentToRemainPortable()
  })

  test('ripple trim-end stops at the descriptor duration', async () => {
    installOfflineBoundsFixture()
    act(() => transport().setTool('trim'))
    renderTrack()
    const clip = screen.getByTestId('clip-offline')

    fireEvent.pointerDown(screen.getByTestId('clip-offline-edge-end'), {
      pointerId: 1,
      clientX: 150,
    })
    expect(transport().editPreview?.kind).toBe('ripple-end')
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 350 })
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(20))
    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 350 })

    expect(clipById('offline').sourceRange).toEqual({
      startFrame: 20,
      durationFrames: 70,
    })
    expect(clipById('offline').timelineRange.durationFrames).toBe(70)
    expect(doc().past).toHaveLength(1)
    expectCurrentDocumentToRemainPortable()
  })

  test('slip stops before the source window exceeds descriptor duration', async () => {
    installOfflineBoundsFixture()
    act(() => transport().setTool('slip'))
    renderTrack()
    const clip = screen.getByTestId('clip-offline')

    fireEvent.pointerDown(clip, { pointerId: 1, clientX: 120 })
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 500 })
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(20))
    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 500 })

    expect(clipById('offline').sourceRange).toEqual({
      startFrame: 40,
      durationFrames: 50,
    })
    expect(clipById('offline').timelineRange).toEqual({
      startFrame: 100,
      durationFrames: 50,
    })
    expect(doc().past).toHaveLength(1)
    expectCurrentDocumentToRemainPortable()
  })
})

describe('slide tool', () => {
  test('body drag slides between neighbors: they absorb, downstream stays', async () => {
    act(() => transport().setTool('slide'))
    renderTrack()
    const clip = screen.getByTestId('clip-clipB')

    fireEvent.pointerDown(clip, { pointerId: 1, clientX: 200 })
    fireEvent.pointerMove(clip, { pointerId: 1, clientX: 210 }) // +10
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(10))
    expect(clip).toHaveStyle({ transform: 'translateX(160px)' }) // live position

    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 210 })
    expect(clipById('clipB').timelineRange).toEqual({ startFrame: 160, durationFrames: 80 })
    expect(clipById('clipB').sourceRange.startFrame).toBe(0) // content untouched
    expect(clipById('clipA').timelineRange.durationFrames).toBe(60) // tail grew
    expect(clipById('clipC').timelineRange.startFrame).toBe(280) // across the gap
    expect(doc().past).toHaveLength(1)
  })
})
