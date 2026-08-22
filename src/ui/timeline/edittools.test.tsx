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
  defaultClipAudioSettings,
  defaultClipVisualSettings,
} from '../../domain/clipInspector'
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
import { usePreferencesStore } from '../../state/preferencesStore'
import { useTransportStore } from '../../state/transportStore'
import ClipView from './ClipView'
import Track from './Track'

function makeClip(id: string, tlStart: number, duration: number, srcStart = 0): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: srcStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    blendMode: 'normal',
    volume: 1,
    visual: defaultClipVisualSettings(),
    audio: defaultClipAudioSettings(),
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
    schemaVersion: 14,
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
    markers: [],
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
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
    audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
  },
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
  sourceBounds: connectedAsset.sourceBounds,
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
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 3_000_000 },
    audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 3_000_000 },
  },
}

const linkedVideoAsset: MediaAsset = {
  ...connectedAsset,
  id: 'asset-linked-video',
  fileName: 'linked-video.mp4',
}

const stillAsset: MediaAsset = {
  ...connectedAsset,
  id: 'asset-still',
  fileName: 'poster.png',
  mimeType: 'image/png',
  kind: 'image',
  durationFrames: 150,
  durationMicroseconds: 5_000_000,
  sourceBounds: { video: null, audio: null },
  frameRate: null,
  width: 640,
  height: 360,
  hasAudio: false,
  audioSampleRate: null,
  audioChannels: null,
  decoderConfigB64: null,
}

const linkedVideoDescriptor: PortableAssetDescriptor = {
  ...connectedDescriptor,
  id: linkedVideoAsset.id,
  fileName: linkedVideoAsset.fileName,
}

const linkedAudioDescriptor: PortableAssetDescriptor = {
  ...connectedDescriptor,
  id: 'asset-linked-audio',
  fileName: 'linked-audio.mp4',
  // Exactly 65 document frames at 30 fps after canonical rounding.
  durationMicroseconds: 2_166_667,
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_166_667 },
    audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_166_667 },
  },
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

function installStillFixture(): void {
  const still = {
    ...makeClip('still', 100, 150),
    assetId: stillAsset.id,
    name: stillAsset.fileName,
    sourceMode: 'still' as const,
    sourceRange: { startFrame: 0, durationFrames: 1 },
  }
  doc().setDoc({
    ...makeDoc(),
    id: 'doc-still-tools',
    name: 'still tools fixture',
    tracks: [makeTrack('V1', [still])],
  })
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map([[stillAsset.id, stillAsset]]),
    visuals: new Map(),
  })
}

interface LinkedBoundsFixtureOptions {
  videoTimelineStart?: number
  audioTimelineStart?: number
  videoSourceStart?: number
  audioSourceStart?: number
}

function installLinkedBoundsFixture(
  options: LinkedBoundsFixtureOptions = {},
): void {
  const groupId = 'link_preview_bounds'
  const video = {
    ...makeClip(
      'linked-video',
      options.videoTimelineStart ?? 100,
      40,
      options.videoSourceStart ?? 11,
    ),
    assetId: linkedVideoAsset.id,
    linkGroupId: groupId,
  }
  const audio = {
    ...makeClip(
      'linked-audio',
      options.audioTimelineStart ?? 35,
      40,
      options.audioSourceStart ?? 22,
    ),
    assetId: linkedAudioDescriptor.id,
    linkGroupId: groupId,
  }
  doc().setDoc({
    ...makeDoc(),
    id: 'doc-linked-bounds',
    name: 'linked bounds fixture',
    tracks: [
      makeTrack('V1', [video]),
      { ...makeTrack('A1', [audio]), kind: 'audio' },
    ],
  })
  useMediaStore.setState({
    descriptors: new Map([
      [linkedVideoDescriptor.id, linkedVideoDescriptor],
      [linkedAudioDescriptor.id, linkedAudioDescriptor],
    ]),
    assets: new Map([[linkedVideoAsset.id, linkedVideoAsset]]),
    visuals: new Map(),
  })
}

function renderLinkedBoundsTracks() {
  return render(
    <>
      <Track track={doc().doc.tracks[0]} />
      <Track track={doc().doc.tracks[1]} />
    </>,
  )
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
  warnSpy.mockClear()
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
    editPreview: null,
    snapGuide: null,
  })
  usePreferencesStore.getState().setSnappingEnabled(true)
  doc().setDoc(makeDoc())
  useMediaStore.setState({
    descriptors: new Map([[connectedDescriptor.id, connectedDescriptor]]),
    assets: new Map([[connectedAsset.id, connectedAsset]]),
    visuals: new Map(),
  })
})

const renderTrack = () => render(<Track track={v1()} />)

describe('selection (select tool)', () => {
  test('normal pointer selection replaces the group, begins a move, and empty-lane pointerdown clears it', () => {
    renderTrack()
    const documentBefore = doc().doc
    const pastBefore = doc().past
    const futureBefore = doc().future
    fireEvent.pointerDown(screen.getByTestId('clip-clipA'), { pointerId: 1, clientX: 120 })
    expect(transport().selectedClipId).toBe('clipA')
    expect(transport().selectedClipIds).toEqual(['clipA'])
    expect(transport().dragPreview?.clipId).toBe('clipA')
    fireEvent.pointerUp(screen.getByTestId('clip-clipA'), { pointerId: 1, clientX: 120 })

    // Selected styling appears after the store round-trip.
    expect(screen.getByTestId('clip-clipA').className).toContain('selected')
    expect(screen.getByTestId('clip-clipA')).toHaveAttribute(
      'data-primary-selected',
      'true',
    )

    fireEvent.pointerDown(screen.getByTestId('clip-clipB'), {
      pointerId: 2,
      clientX: 170,
      ctrlKey: true,
    })
    expect(transport().selectedClipIds).toEqual(['clipA', 'clipB'])

    fireEvent.pointerDown(screen.getByTestId('track-V1'), { pointerId: 3, clientX: 700 })
    expect(transport().selectedClipId).toBeNull()
    expect(transport().selectedClipIds).toEqual([])
    expect(doc().doc).toBe(documentBefore)
    expect(doc().past).toBe(pastBefore)
    expect(doc().future).toBe(futureBefore)
  })

  test('Ctrl/Command-pointerdown toggles clips, updates primary, and never starts a drag', () => {
    renderTrack()
    const clipA = screen.getByTestId('clip-clipA')
    const clipB = screen.getByTestId('clip-clipB')
    const clipC = screen.getByTestId('clip-clipC')

    fireEvent.pointerDown(clipA, { pointerId: 1, clientX: 120 })
    fireEvent.pointerUp(clipA, { pointerId: 1, clientX: 120 })

    fireEvent.pointerDown(screen.getByTestId('clip-clipB-edge-start'), {
      pointerId: 2,
      clientX: 170,
      ctrlKey: true,
    })
    expect(transport().selectedClipIds).toEqual(['clipA', 'clipB'])
    expect(transport().selectedClipId).toBe('clipB')
    expect(transport().dragPreview).toBeNull()
    expect(clipA).toHaveClass('selected')
    expect(clipA).not.toHaveClass('primary-selected')
    expect(clipB).toHaveClass('selected', 'primary-selected')

    fireEvent.pointerDown(clipC, {
      pointerId: 3,
      clientX: 290,
      metaKey: true,
    })
    expect(transport().selectedClipIds).toEqual(['clipA', 'clipB', 'clipC'])
    expect(transport().selectedClipId).toBe('clipC')
    expect(transport().dragPreview).toBeNull()

    // Removing a non-primary clip leaves the current primary alone.
    fireEvent.pointerDown(screen.getByTestId('clip-clipB-edge-end'), {
      pointerId: 4,
      clientX: 170,
      ctrlKey: true,
    })
    expect(transport().selectedClipIds).toEqual(['clipA', 'clipC'])
    expect(transport().selectedClipId).toBe('clipC')

    // Removing the primary falls back to the last remaining selection.
    fireEvent.pointerDown(clipC, {
      pointerId: 5,
      clientX: 290,
      metaKey: true,
    })
    expect(transport().selectedClipIds).toEqual(['clipA'])
    expect(transport().selectedClipId).toBe('clipA')
    expect(transport().dragPreview).toBeNull()
  })

  test('normal pointerdown collapses an existing group to one clip', () => {
    renderTrack()
    act(() => {
      transport().setSelectedClip('clipA')
      transport().toggleClipSelection('clipB')
    })

    const clipC = screen.getByTestId('clip-clipC')
    fireEvent.pointerDown(clipC, { pointerId: 1, clientX: 290 })

    expect(transport().selectedClipIds).toEqual(['clipC'])
    expect(transport().selectedClipId).toBe('clipC')
    expect(transport().dragPreview?.clipId).toBe('clipC')
    fireEvent.pointerUp(clipC, { pointerId: 1, clientX: 290 })
  })

  test('clips expose pressed-button semantics and Enter/Space keyboard selection', () => {
    renderTrack()
    const clipA = screen.getByRole('button', { name: 'clipA, video clip' })
    const clipB = screen.getByRole('button', { name: 'clipB, video clip' })

    expect(clipA).toHaveAttribute('aria-pressed', 'false')
    expect(clipA).toHaveAttribute('tabindex', '0')
    expect(clipA).toHaveAttribute(
      'title',
      expect.stringContaining('Enter or Space'),
    )

    clipA.focus()
    expect(clipA).toHaveFocus()
    fireEvent.keyDown(clipA, { key: 'Enter' })
    expect(transport().selectedClipIds).toEqual(['clipA'])
    expect(transport().selectedClipId).toBe('clipA')
    expect(clipA).toHaveAttribute('aria-pressed', 'true')
    expect(transport().dragPreview).toBeNull()

    fireEvent.keyDown(clipB, { key: ' ', metaKey: true })
    expect(transport().selectedClipIds).toEqual(['clipA', 'clipB'])
    expect(transport().selectedClipId).toBe('clipB')
    expect(clipB).toHaveAttribute('aria-pressed', 'true')
    expect(transport().dragPreview).toBeNull()
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

  test('trim preview snaps to a marker without history, then commits one entry', async () => {
    doc().setDoc({
      ...makeDoc(),
      markers: [{ id: 'marker-beat', frame: 133, label: 'Beat', color: 'yellow' }],
    })
    renderTrack()
    const clip = screen.getByTestId('clip-clipA')
    const edge = screen.getByTestId('clip-clipA-edge-end')

    fireEvent.pointerDown(edge, { pointerId: 31, clientX: 150 })
    fireEvent.pointerMove(clip, { pointerId: 31, clientX: 130 })

    await waitFor(() => {
      expect(transport().editPreview?.deltaFrames).toBe(-17)
      expect(transport().snapGuide).toMatchObject({
        frame: 133,
        candidateKind: 'marker',
      })
    })
    expect(clipById('clipA').timelineRange.durationFrames).toBe(50)
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(clip, { pointerId: 31, clientX: 130 })

    expect(clipById('clipA').timelineRange.durationFrames).toBe(33)
    expect(doc().past).toHaveLength(1)
    expect(transport().editPreview).toBeNull()
    expect(transport().snapGuide).toBeNull()
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
      schemaVersion: 14,
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
      markers: [],
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

describe('still-image timeline gestures', () => {
  test('Slip selects and explains the still but starts no gesture or history entry', () => {
    installStillFixture()
    act(() => transport().setTool('slip'))
    renderTrack()
    const clip = screen.getByRole('button', {
      name: 'poster.png, still image clip',
    })
    const before = doc().doc

    expect(clip).toHaveAttribute('data-source-mode', 'still')
    expect(clip).toHaveAttribute('title', expect.stringContaining('Slip is unavailable'))
    fireEvent.pointerDown(clip, { pointerId: 30, clientX: 120 })
    fireEvent.pointerMove(clip, { pointerId: 30, clientX: 220 })
    fireEvent.pointerUp(clip, { pointerId: 30, clientX: 220 })

    expect(transport().selectedClipId).toBe('still')
    expect(transport().editPreview).toBeNull()
    expect(doc().doc).toBe(before)
    expect(doc().past).toHaveLength(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('an end trim extends beyond nominal image duration while source stays one frame', async () => {
    installStillFixture()
    renderTrack()
    const clip = screen.getByTestId('clip-still')

    fireEvent.pointerDown(screen.getByTestId('clip-still-edge-end'), {
      pointerId: 31,
      clientX: 250,
    })
    fireEvent.pointerMove(clip, { pointerId: 31, clientX: 450 })
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(200))
    fireEvent.pointerUp(clip, { pointerId: 31, clientX: 450 })

    expect(clipById('still')).toMatchObject({
      timelineRange: { startFrame: 100, durationFrames: 350 },
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })
    expect(doc().past).toHaveLength(1)
  })

  test('razor partitions timeline geometry but both still halves retain frame 0', () => {
    installStillFixture()
    act(() => transport().setTool('razor'))
    renderTrack()

    fireEvent.pointerDown(screen.getByTestId('clip-still'), {
      pointerId: 32,
      clientX: 30,
    })

    const [left, right] = v1().clips
    expect(left.timelineRange).toEqual({ startFrame: 100, durationFrames: 30 })
    expect(right.timelineRange).toEqual({ startFrame: 130, durationFrames: 120 })
    expect(left.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(right.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
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

describe('linked gesture bounds', () => {
  test('plain trim-start uses the partner timeline floor for both live ghosts', async () => {
    installLinkedBoundsFixture({ audioTimelineStart: 2 })
    renderLinkedBoundsTracks()
    const video = screen.getByTestId('clip-linked-video')
    const audio = screen.getByTestId('clip-linked-audio')
    const before = doc().doc

    fireEvent.pointerDown(screen.getByTestId('clip-linked-video-edge-start'), {
      pointerId: 18,
      clientX: 100,
    })
    fireEvent.pointerMove(video, { pointerId: 18, clientX: 50 }) // raw -50
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(-2))

    expect(video).toHaveStyle({ transform: 'translateX(98px)', width: '42px' })
    expect(audio).toHaveStyle({ transform: 'translateX(0px)', width: '42px' })
    expect(doc().doc).toBe(before)
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(video, { pointerId: 18, clientX: 50 })

    expect(doc().doc.tracks[0].clips[0]).toMatchObject({
      timelineRange: { startFrame: 98, durationFrames: 42 },
      sourceRange: { startFrame: 9, durationFrames: 42 },
    })
    expect(doc().doc.tracks[1].clips[0]).toMatchObject({
      timelineRange: { startFrame: 0, durationFrames: 42 },
      sourceRange: { startFrame: 20, durationFrames: 42 },
    })
    expect(doc().past).toEqual([before])
    expect(warnSpy).not.toHaveBeenCalled()
    expectCurrentDocumentToRemainPortable()
  })

  test('ripple-start uses the partner source floor while both timeline heads stay fixed', async () => {
    installLinkedBoundsFixture({ audioSourceStart: 2 })
    act(() => transport().setTool('trim'))
    renderLinkedBoundsTracks()
    const video = screen.getByTestId('clip-linked-video')
    const audio = screen.getByTestId('clip-linked-audio')
    const before = doc().doc

    fireEvent.pointerDown(screen.getByTestId('clip-linked-video-edge-start'), {
      pointerId: 19,
      clientX: 100,
    })
    fireEvent.pointerMove(video, { pointerId: 19, clientX: 50 }) // raw -50
    await waitFor(() => expect(transport().editPreview).toMatchObject({
      kind: 'ripple-start',
      deltaFrames: -2,
    }))

    expect(video).toHaveStyle({ transform: 'translateX(100px)', width: '42px' })
    expect(audio).toHaveStyle({ transform: 'translateX(35px)', width: '42px' })
    expect(doc().doc).toBe(before)

    fireEvent.pointerUp(video, { pointerId: 19, clientX: 50 })

    expect(doc().doc.tracks[0].clips[0]).toMatchObject({
      timelineRange: { startFrame: 100, durationFrames: 42 },
      sourceRange: { startFrame: 9, durationFrames: 42 },
    })
    expect(doc().doc.tracks[1].clips[0]).toMatchObject({
      timelineRange: { startFrame: 35, durationFrames: 42 },
      sourceRange: { startFrame: 0, durationFrames: 42 },
    })
    expect(doc().past).toEqual([before])
    expect(warnSpy).not.toHaveBeenCalled()
    expectCurrentDocumentToRemainPortable()
  })

  test('trim-end uses the offline partner asset headroom for both live ghosts and commit', async () => {
    installLinkedBoundsFixture()
    renderLinkedBoundsTracks()
    const video = screen.getByTestId('clip-linked-video')
    const audio = screen.getByTestId('clip-linked-audio')
    const before = doc().doc

    fireEvent.pointerDown(screen.getByTestId('clip-linked-video-edge-end'), {
      pointerId: 20,
      clientX: 140,
    })
    fireEvent.pointerMove(video, { pointerId: 20, clientX: 190 }) // raw +50
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(3))

    expect(video).toHaveStyle({ width: '43px' })
    expect(audio).toHaveStyle({ width: '43px' })
    expect(doc().doc).toBe(before)
    expect(doc().past).toHaveLength(0)

    fireEvent.pointerUp(video, { pointerId: 20, clientX: 190 })

    const videoClip = doc().doc.tracks[0].clips[0]
    const audioClip = doc().doc.tracks[1].clips[0]
    expect(videoClip.sourceRange).toEqual({ startFrame: 11, durationFrames: 43 })
    expect(audioClip.sourceRange).toEqual({ startFrame: 22, durationFrames: 43 })
    expect(audioClip.sourceRange.startFrame + audioClip.sourceRange.durationFrames).toBe(65)
    expect(doc().past).toEqual([before])
    expect(warnSpy).not.toHaveBeenCalled()
    expectCurrentDocumentToRemainPortable()
  })

  test('pointer-up cancels when the document changes during a linked trim', async () => {
    installLinkedBoundsFixture()
    renderLinkedBoundsTracks()
    const video = screen.getByTestId('clip-linked-video')

    fireEvent.pointerDown(screen.getByTestId('clip-linked-video-edge-end'), {
      pointerId: 24,
      clientX: 140,
    })
    fireEvent.pointerMove(video, { pointerId: 24, clientX: 190 })
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(3))

    act(() => doc().unlinkClip('linked-video'))
    const interveningDoc = doc().doc
    const interveningPast = doc().past
    const interveningFuture = doc().future
    expect(interveningDoc.tracks[0].clips[0].linkGroupId).toBeUndefined()
    expect(interveningDoc.tracks[1].clips[0].linkGroupId).toBeUndefined()

    fireEvent.pointerUp(video, { pointerId: 24, clientX: 190 })

    expect(doc().doc).toBe(interveningDoc)
    expect(doc().past).toBe(interveningPast)
    expect(doc().future).toBe(interveningFuture)
    expect(interveningDoc.tracks[0].clips[0].sourceRange).toEqual({
      startFrame: 11,
      durationFrames: 40,
    })
    expect(interveningDoc.tracks[1].clips[0].sourceRange).toEqual({
      startFrame: 22,
      durationFrames: 40,
    })
    expect(transport().dragPreview).toBeNull()
    expect(transport().editPreview).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
    expectCurrentDocumentToRemainPortable()
  })

  test('ripple-end routes through the same offline partner headroom', async () => {
    installLinkedBoundsFixture()
    act(() => transport().setTool('trim'))
    renderLinkedBoundsTracks()
    const video = screen.getByTestId('clip-linked-video')
    const audio = screen.getByTestId('clip-linked-audio')
    const before = doc().doc

    fireEvent.pointerDown(screen.getByTestId('clip-linked-video-edge-end'), {
      pointerId: 22,
      clientX: 140,
    })
    fireEvent.pointerMove(video, { pointerId: 22, clientX: 190 })
    await waitFor(() => expect(transport().editPreview).toMatchObject({
      kind: 'ripple-end',
      deltaFrames: 3,
    }))

    expect(video).toHaveStyle({ width: '43px' })
    expect(audio).toHaveStyle({ width: '43px' })
    expect(doc().doc).toBe(before)

    fireEvent.pointerUp(video, { pointerId: 22, clientX: 190 })

    expect(doc().doc.tracks[0].clips[0].sourceRange).toEqual({
      startFrame: 11,
      durationFrames: 43,
    })
    expect(doc().doc.tracks[1].clips[0].sourceRange).toEqual({
      startFrame: 22,
      durationFrames: 43,
    })
    expect(doc().past).toEqual([before])
    expect(warnSpy).not.toHaveBeenCalled()
    expectCurrentDocumentToRemainPortable()
  })

  test('slip uses the same partner headroom and stays one portable history entry', async () => {
    installLinkedBoundsFixture()
    act(() => transport().setTool('slip'))
    renderLinkedBoundsTracks()
    const video = screen.getByTestId('clip-linked-video')
    const before = doc().doc

    fireEvent.pointerDown(video, { pointerId: 21, clientX: 120 })
    fireEvent.pointerMove(video, { pointerId: 21, clientX: 200 }) // raw +80
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(3))
    expect(doc().doc).toBe(before)

    fireEvent.pointerUp(video, { pointerId: 21, clientX: 200 })

    expect(doc().doc.tracks[0].clips[0].sourceRange).toEqual({
      startFrame: 14,
      durationFrames: 40,
    })
    expect(doc().doc.tracks[1].clips[0].sourceRange).toEqual({
      startFrame: 25,
      durationFrames: 40,
    })
    expect(doc().past).toEqual([before])
    expect(warnSpy).not.toHaveBeenCalled()
    expectCurrentDocumentToRemainPortable()
  })

  test('negative slip stops at the smallest linked source in-point', async () => {
    installLinkedBoundsFixture({ audioSourceStart: 2 })
    act(() => transport().setTool('slip'))
    renderLinkedBoundsTracks()
    const video = screen.getByTestId('clip-linked-video')
    const audio = screen.getByTestId('clip-linked-audio')
    const before = doc().doc

    fireEvent.pointerDown(video, { pointerId: 23, clientX: 120 })
    fireEvent.pointerMove(video, { pointerId: 23, clientX: 40 }) // raw -80
    await waitFor(() => expect(transport().editPreview?.deltaFrames).toBe(-2))

    expect(video).toHaveStyle({ transform: 'translateX(100px)', width: '40px' })
    expect(audio).toHaveStyle({ transform: 'translateX(35px)', width: '40px' })
    expect(doc().doc).toBe(before)

    fireEvent.pointerUp(video, { pointerId: 23, clientX: 40 })

    expect(doc().doc.tracks[0].clips[0].sourceRange).toEqual({
      startFrame: 9,
      durationFrames: 40,
    })
    expect(doc().doc.tracks[1].clips[0].sourceRange).toEqual({
      startFrame: 0,
      durationFrames: 40,
    })
    expect(doc().past).toEqual([before])
    expect(warnSpy).not.toHaveBeenCalled()
    expectCurrentDocumentToRemainPortable()
  })
})

describe('keyboard trim, ripple, slip, and slide', () => {
  test('] previews a trim, Escape cancels, Enter commits one undoable edit', () => {
    renderTrack()
    const clip = screen.getByRole('button', { name: 'clipA, video clip' })
    clip.focus()
    expect(clip).toHaveFocus()

    fireEvent.keyDown(clip, { key: ']' })
    expect(transport().editPreview).toMatchObject({
      clipId: 'clipA',
      kind: 'trim-end',
      deltaFrames: 0,
    })
    expect(clip).toHaveTextContent('Trim end started')

    fireEvent.keyDown(clip, { key: 'ArrowLeft' })
    expect(transport().editPreview?.deltaFrames).toBe(-1)
    expect(clipById('clipA').timelineRange.durationFrames).toBe(50)
    expect(doc().past).toHaveLength(0)

    fireEvent.keyDown(clip, { key: 'Escape' })
    expect(transport().editPreview).toBeNull()
    expect(clipById('clipA').timelineRange.durationFrames).toBe(50)
    expect(doc().past).toHaveLength(0)
    expect(clip).toHaveTextContent('Trim end cancelled')

    fireEvent.keyDown(clip, { key: ']' })
    fireEvent.keyDown(clip, { key: 'ArrowLeft' })
    fireEvent.keyDown(clip, { key: 'Enter' })
    expect(clipById('clipA').timelineRange).toEqual({
      startFrame: 100,
      durationFrames: 49,
    })
    expect(doc().past).toHaveLength(1)
    expect(transport().editPreview).toBeNull()
    expect(clip).toHaveTextContent('Trim end applied')

    act(() => doc().undo())
    expect(clipById('clipA').timelineRange.durationFrames).toBe(50)
  })

  test('trim tool plus [ ripple-trims the start from the keyboard', () => {
    act(() => transport().setTool('trim'))
    renderTrack()
    const clip = screen.getByRole('button', { name: 'clipA, video clip' })
    clip.focus()
    fireEvent.keyDown(clip, { key: '[' })
    expect(transport().editPreview?.kind).toBe('ripple-start')
    fireEvent.keyDown(clip, { key: 'ArrowRight' })
    fireEvent.keyDown(clip, { key: 'Enter' })

    expect(clipById('clipA').timelineRange).toEqual({
      startFrame: 101,
      durationFrames: 49,
    })
    expect(clipById('clipB').timelineRange.startFrame).toBe(151)
    expect(doc().past).toHaveLength(1)
  })

  test('Slip and Slide arrow keys preview, cancel, and commit', () => {
    renderTrack()
    const clipA = screen.getByRole('button', { name: 'clipA, video clip' })
    act(() => transport().setTool('slip'))
    clipA.focus()
    fireEvent.keyDown(clipA, { key: 'ArrowRight' })
    expect(transport().editPreview).toMatchObject({
      clipId: 'clipA',
      kind: 'slip',
      deltaFrames: 1,
    })
    fireEvent.keyDown(clipA, { key: 'Escape' })
    expect(transport().editPreview).toBeNull()
    expect(clipById('clipA').sourceRange.startFrame).toBe(20)

    fireEvent.keyDown(clipA, { key: 'ArrowRight' })
    fireEvent.keyDown(clipA, { key: 'Enter' })
    expect(clipById('clipA').sourceRange.startFrame).toBe(21)
    expect(doc().past).toHaveLength(1)

    const clipB = screen.getByRole('button', { name: 'clipB, video clip' })
    act(() => transport().setTool('slide'))
    clipB.focus()
    fireEvent.keyDown(clipB, { key: 'ArrowRight' })
    expect(transport().editPreview).toMatchObject({
      clipId: 'clipB',
      kind: 'slide',
      deltaFrames: 1,
    })
    fireEvent.keyDown(clipB, { key: 'Enter' })
    expect(clipById('clipB').timelineRange.startFrame).toBe(151)
    expect(doc().past).toHaveLength(2)
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
