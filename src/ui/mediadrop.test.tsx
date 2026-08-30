/**
 * ui/mediadrop.test.tsx — Phase 4.0 media → timeline flow.
 *
 * MediaPool rows advertise {asset id, kind} per the ui/dnd.ts contract;
 * Track lanes accept kind-matched drops and commit exactly ONE
 * documentStore action (one undo entry) — a video asset with audio lands
 * as a video+audio clip pair via insertClips. jsdom has no real drag-and-
 * drop, so tests drive the handlers with a stub dataTransfer (see
 * test/setup.ts for the DragEvent polyfill that keeps clientX alive).
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  Clip,
  MediaAsset,
  TimelineDoc,
  Track as TrackData,
} from '../domain/schema'
import type { MediaCompatibilityStatus } from '../domain/mediaCompatibility'
import { dropOsFilesOnTimeline } from '../app/mediaPlacementController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import {
  ASSET_DRAG_TYPE,
  assetKindDragType,
  beginAssetDrag,
  endAssetDrag,
} from './dnd'
import { FILES_DRAG_TYPE } from './fileDrag'
import MediaPool from './MediaPool'
import Track from './timeline/Track'

vi.mock('../app/mediaPlacementController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/mediaPlacementController')>()
  return {
    ...actual,
    dropOsFilesOnTimeline: vi.fn(actual.dropOsFilesOnTimeline),
  }
})

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function makeAsset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-9',
    fileName: 'beach.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:fake',
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 4_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...over,
  }
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

function makeTrack(
  id: string,
  kind: TrackData['kind'],
  clips: Clip[] = [],
  locked = false,
): TrackData {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked }
}

/** V1 (video, empty), A1 (audio, empty), VL (video, locked). */
function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 15,
    id: 'doc-mediadrop',
    name: 'media drop fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', 'video'),
      makeTrack('A1', 'audio'),
      makeTrack('VL', 'video', [], true),
    ],
  }
}

/**
 * Minimal dataTransfer stand-in for an in-flight asset drag, as a lane
 * sees it: kind marker readable via `types`, id readable via getData.
 */
function assetDragData(asset: Pick<MediaAsset, 'id' | 'kind'>) {
  return {
    types: [ASSET_DRAG_TYPE, assetKindDragType(asset.kind)],
    getData: (format: string) => (format === ASSET_DRAG_TYPE ? asset.id : ''),
    setData: () => {},
    dropEffect: 'none',
    effectAllowed: 'copy',
  }
}

function fileDragData(files: File[]) {
  return {
    types: [FILES_DRAG_TYPE],
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    })),
    files,
    getData: () => '',
    setData: () => {},
    dropEffect: 'none',
    effectAllowed: 'copy',
  }
}

const doc = () => useDocumentStore.getState()
const trackById = (id: string) =>
  doc().doc.tracks.find((t) => t.id === id) as TrackData

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  endAssetDrag()
  vi.mocked(dropOsFilesOnTimeline).mockReset()
  vi.mocked(dropOsFilesOnTimeline).mockResolvedValue({ status: 'cancelled' })
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
    mediaPlacementPreview: null,
    mediaPlacementStatus: '',
  })
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  doc().setDoc(makeDoc())
})

function seedAsset(asset: MediaAsset): void {
  expect(useMediaStore.getState().addAsset(asset)).toBe(true)
}

function seedCompatibility(
  asset: MediaAsset,
  status: MediaCompatibilityStatus,
): void {
  useMediaStore.setState({
    compatibility: new Map([[
      asset.id,
      {
        id: asset.id,
        requestId: 'request-drag',
        fileName: asset.fileName,
        declaredMimeType: asset.mimeType,
        size: asset.size,
        lastModified: asset.lastModified,
        status,
        report: null,
      },
    ]]),
  })
}

/* ------------------------------------------------------------------ */
/* MediaPool — drag source                                              */
/* ------------------------------------------------------------------ */

describe('MediaPool drag source', () => {
  test('rows are draggable only once metadata is ready', () => {
    const checking = makeAsset()
    seedAsset(checking)
    seedCompatibility(checking, 'checking')
    seedAsset(makeAsset({ id: 'asset-raw', fileName: 'raw.mov', durationFrames: 0 }))
    render(<MediaPool />)
    expect(screen.getByTitle('beach.mp4')).toHaveAttribute('draggable', 'false')
    expect(screen.getByTitle('raw.mov')).toHaveAttribute('draggable', 'false')
  })

  test('a ready compatibility report enables the drag source', () => {
    const asset = makeAsset()
    seedAsset(asset)
    seedCompatibility(asset, 'ready')
    render(<MediaPool />)

    expect(screen.getByTitle('beach.mp4')).toHaveAttribute('draggable', 'true')
  })

  test('dragstart advertises asset id + kind per the dnd contract', () => {
    seedAsset(makeAsset())
    render(<MediaPool />)

    const written = new Map<string, string>()
    const dataTransfer = {
      setData: (format: string, value: string) => void written.set(format, value),
      getData: (format: string) => written.get(format) ?? '',
      types: [] as string[],
      dropEffect: 'none',
      effectAllowed: 'none',
    }
    fireEvent.dragStart(screen.getByTitle('beach.mp4'), { dataTransfer })

    expect(written.get(ASSET_DRAG_TYPE)).toBe('asset-9')
    expect(written.has(assetKindDragType('video'))).toBe(true)
    expect(dataTransfer.effectAllowed).toBe('copy')
  })
})

/* ------------------------------------------------------------------ */
/* Track — drop target                                                  */
/* ------------------------------------------------------------------ */

describe('Track drop target', () => {
  test('A/V video drop lands a video+audio clip pair — one undo entry', () => {
    seedAsset(makeAsset()) // hasAudio: true
    render(<Track track={trackById('V1')} />)
    const lane = screen.getByTestId('track-V1')
    const dataTransfer = assetDragData(makeAsset())

    fireEvent.dragOver(lane, { dataTransfer })
    expect(lane.className).toContain('drop-target') // accepted → highlighted

    // jsdom rects sit at x=0, so clientX 240 at zoom 1 is frame 240.
    fireEvent.drop(lane, { dataTransfer, clientX: 240 })
    expect(lane.className).not.toContain('drop-target')

    const video = trackById('V1').clips
    expect(video).toHaveLength(1)
    expect(video[0].assetId).toBe('asset-9')
    expect(video[0].name).toBe('beach.mp4')
    expect(video[0].sourceMode).toBe('timed')
    expect(video[0].timelineRange).toEqual({ startFrame: 240, durationFrames: 120 })
    expect(video[0].sourceRange).toEqual({ startFrame: 0, durationFrames: 120 })

    // The file's audio landed with it: same asset, same range, own id.
    const audio = trackById('A1').clips
    expect(audio).toHaveLength(1)
    expect(audio[0].assetId).toBe('asset-9')
    expect(audio[0].timelineRange).toEqual({ startFrame: 240, durationFrames: 120 })
    expect(audio[0].id).not.toBe(video[0].id)

    // The pair lands LINKED: one shared, defined group id.
    expect(video[0].linkGroupId).toBeDefined()
    expect(audio[0].linkGroupId).toBe(video[0].linkGroupId)

    expect(doc().past).toHaveLength(1) // exactly ONE undo entry for the pair

    doc().undo() // one undo removes BOTH halves
    expect(trackById('V1').clips).toHaveLength(0)
    expect(trackById('A1').clips).toHaveLength(0)
  })

  test('an image drop creates one still clip with independent timeline duration', () => {
    const image = makeAsset({
      id: 'image-1',
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
    })
    seedAsset(image)
    render(<Track track={trackById('V1')} />)
    const lane = screen.getByTestId('track-V1')
    const dataTransfer = assetDragData(image)

    fireEvent.dragOver(lane, { dataTransfer })
    expect(lane).toHaveClass('drop-target')
    fireEvent.drop(lane, { dataTransfer, clientX: 30 })

    expect(trackById('V1').clips).toHaveLength(1)
    expect(trackById('V1').clips[0]).toMatchObject({
      assetId: 'image-1',
      sourceMode: 'still',
      sourceRange: { startFrame: 0, durationFrames: 1 },
      timelineRange: { startFrame: 30, durationFrames: 150 },
    })
    expect(trackById('A1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(1)

    doc().undo()
    expect(trackById('V1').clips).toHaveLength(0)
  })

  test('a second A/V drop gets a DIFFERENT linkGroupId from the first', () => {
    seedAsset(makeAsset()) // hasAudio: true
    render(<Track track={trackById('V1')} />)
    const lane = screen.getByTestId('track-V1')

    fireEvent.drop(lane, { dataTransfer: assetDragData(makeAsset()), clientX: 0 })
    // Second drop, far enough right to avoid overlapping either half of the first.
    fireEvent.drop(lane, { dataTransfer: assetDragData(makeAsset()), clientX: 240 })

    const [firstVideo, secondVideo] = trackById('V1').clips
    const [firstAudio, secondAudio] = trackById('A1').clips
    expect(firstVideo.linkGroupId).toBeDefined()
    expect(secondVideo.linkGroupId).toBeDefined()
    expect(secondVideo.linkGroupId).not.toBe(firstVideo.linkGroupId)
    expect(firstAudio.linkGroupId).toBe(firstVideo.linkGroupId)
    expect(secondAudio.linkGroupId).toBe(secondVideo.linkGroupId)
  })

  test('A/V drop suffixes a colliding generated linkGroupId without merging groups', () => {
    const uuid = '00000000-0000-4000-8000-000000000012'
    const existingGroupId = `link_${uuid}`
    seedAsset(makeAsset()) // hasAudio: true
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video', [
          { ...makeClip('existingV', 0, 120), linkGroupId: existingGroupId },
        ]),
        makeTrack('A1', 'audio', [
          { ...makeClip('existingA', 0, 120), linkGroupId: existingGroupId },
        ]),
        makeTrack('VL', 'video', [], true),
      ],
    })
    render(<Track track={trackById('V1')} />)

    const uuidSpy = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(uuid)
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000013')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000014')
    try {
      fireEvent.drop(screen.getByTestId('track-V1'), {
        dataTransfer: assetDragData(makeAsset()),
        clientX: 240,
      })
    } finally {
      uuidSpy.mockRestore()
    }

    const [existingVideo, newVideo] = trackById('V1').clips
    const [existingAudio, newAudio] = trackById('A1').clips
    expect(existingVideo.linkGroupId).toBe(existingGroupId)
    expect(existingAudio.linkGroupId).toBe(existingGroupId)
    expect(newVideo.linkGroupId).toBe(`${existingGroupId}_2`)
    expect(newAudio.linkGroupId).toBe(newVideo.linkGroupId)
    expect(doc().past).toHaveLength(1)

    doc().undo()
    expect(trackById('V1').clips).toEqual([existingVideo])
    expect(trackById('A1').clips).toEqual([existingAudio])
  })

  test('silent video (hasAudio false) drops as a lone video clip', () => {
    seedAsset(makeAsset({ hasAudio: false, audioSampleRate: null, audioChannels: null }))
    render(<Track track={trackById('V1')} />)

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: assetDragData(makeAsset()),
      clientX: 240,
    })
    expect(trackById('V1').clips).toHaveLength(1)
    expect(trackById('A1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(1)
    expect(trackById('V1').clips[0].linkGroupId).toBeUndefined() // solo fallback: unlinked
  })

  test('no unlocked audio lane: the video half still lands alone', () => {
    seedAsset(makeAsset()) // hasAudio: true
    doc().setDoc({
      ...makeDoc(),
      tracks: [makeTrack('V1', 'video'), makeTrack('A1', 'audio', [], true)],
    })
    render(<Track track={trackById('V1')} />)

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: assetDragData(makeAsset()),
      clientX: 240,
    })
    expect(trackById('V1').clips).toHaveLength(1)
    expect(trackById('A1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(1)
    expect(trackById('V1').clips[0].linkGroupId).toBeUndefined() // solo fallback: unlinked
  })

  test('occupied A1 still places the video and links onto free A2', () => {
    seedAsset(makeAsset()) // hasAudio: true
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video'),
        makeTrack('V2', 'video'),
        makeTrack('A1', 'audio', [makeClip('existingA', 200, 100)]),
        makeTrack('A2', 'audio'),
      ],
    })
    render(<Track track={trackById('V2')} />)

    fireEvent.drop(screen.getByTestId('track-V2'), {
      dataTransfer: assetDragData(makeAsset()),
      clientX: 240, // A1 is occupied here; A2 is free
    })
    expect(trackById('V2').clips).toHaveLength(1)
    expect(trackById('A1').clips).toHaveLength(1)
    expect(trackById('A2').clips).toHaveLength(1)
    expect(trackById('A2').clips[0].linkGroupId)
      .toBe(trackById('V2').clips[0].linkGroupId)
    expect(doc().past).toHaveLength(1)
  })

  test('occupied audio with no free lane rejects the whole pair', () => {
    seedAsset(makeAsset()) // hasAudio: true
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video'),
        makeTrack('A1', 'audio', [makeClip('existingA', 200, 100)]),
      ],
    })
    render(<Track track={trackById('V1')} />)

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: assetDragData(makeAsset()),
      clientX: 240, // audio half would land inside existingA [200, 300)
    })
    expect(trackById('V1').clips).toHaveLength(0)
    expect(trackById('A1').clips).toHaveLength(1) // only the original
    expect(doc().past).toHaveLength(0)
  })

  test('drop honors zoom when mapping pixels to frames', () => {
    seedAsset(makeAsset())
    act(() => useTransportStore.getState().setZoom(2))
    render(<Track track={trackById('V1')} />)
    const dataTransfer = assetDragData(makeAsset())

    fireEvent.drop(screen.getByTestId('track-V1'), { dataTransfer, clientX: 240 })
    expect(trackById('V1').clips[0].timelineRange.startFrame).toBe(120)
  })

  test('drop mapping adds the bounded timeline origin', () => {
    seedAsset(makeAsset())
    act(() => useTransportStore.getState().setZoom(2))
    render(
      <Track
        track={trackById('V1')}
        timelineOriginFrame={1_000_000}
        timelineWindowEndFrame={1_100_000}
      />,
    )

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: assetDragData(makeAsset()),
      clientX: 240,
    })
    expect(trackById('V1').clips[0].timelineRange.startFrame).toBe(1_000_120)
    expect(trackById('A1').clips[0].timelineRange.startFrame).toBe(1_000_120)
  })

  test('kind mismatch is refused both ways (no highlight, no doc change)', () => {
    seedAsset(makeAsset())
    seedAsset(makeAsset({ id: 'asset-a', fileName: 'voice.wav', kind: 'audio' }))
    render(
      <>
        <Track track={trackById('V1')} />
        <Track track={trackById('A1')} />
      </>,
    )
    const video = screen.getByTestId('track-V1')
    const audio = screen.getByTestId('track-A1')
    const videoDrag = assetDragData(makeAsset())
    const audioDrag = assetDragData({ id: 'asset-a', kind: 'audio' })

    fireEvent.dragOver(audio, { dataTransfer: videoDrag })
    expect(audio.className).not.toContain('drop-target')
    fireEvent.drop(audio, { dataTransfer: videoDrag, clientX: 100 })

    fireEvent.dragOver(video, { dataTransfer: audioDrag })
    expect(video.className).not.toContain('drop-target')
    fireEvent.drop(video, { dataTransfer: audioDrag, clientX: 100 })

    expect(trackById('V1').clips).toHaveLength(0)
    expect(trackById('A1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
  })

  test('audio asset lands on the audio lane', () => {
    const wav = makeAsset({
      id: 'asset-a',
      fileName: 'voice.wav',
      kind: 'audio',
      frameRate: null,
      width: null,
      height: null,
      durationFrames: 90,
    })
    seedAsset(wav)
    render(<Track track={trackById('A1')} />)

    fireEvent.drop(screen.getByTestId('track-A1'), {
      dataTransfer: assetDragData(wav),
      clientX: 30,
    })
    expect(trackById('A1').clips[0].timelineRange).toEqual({
      startFrame: 30,
      durationFrames: 90,
    })
  })

  test('locked lane refuses the drag entirely', () => {
    seedAsset(makeAsset())
    render(<Track track={trackById('VL')} />)
    const lane = screen.getByTestId('track-VL')
    const dataTransfer = assetDragData(makeAsset())

    fireEvent.dragOver(lane, { dataTransfer })
    expect(lane.className).not.toContain('drop-target')
    fireEvent.drop(lane, { dataTransfer, clientX: 50 })
    expect(trackById('VL').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
  })

  test('stale asset id (removed mid-drag) is a safe no-op', () => {
    render(<Track track={trackById('V1')} />)
    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: assetDragData({ id: 'asset-gone', kind: 'video' }),
      clientX: 60,
    })
    expect(trackById('V1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
  })

  test('a compatibility change during drag is rejected at the drop boundary', () => {
    const asset = makeAsset()
    seedAsset(asset)
    seedCompatibility(asset, 'ready')
    render(<Track track={trackById('V1')} />)
    const lane = screen.getByTestId('track-V1')
    const dataTransfer = assetDragData(asset)

    fireEvent.dragOver(lane, { dataTransfer })
    expect(lane).toHaveClass('drop-target')
    act(() => seedCompatibility(asset, 'limited'))
    fireEvent.drop(lane, { dataTransfer, clientX: 60 })

    expect(trackById('V1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
  })

  test('overlapping drop is rejected: no clip and no history', () => {
    seedAsset(makeAsset())
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video', [makeClip('existing', 200, 100)]),
        makeTrack('A1', 'audio'),
      ],
    })
    render(<Track track={trackById('V1')} />)

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: assetDragData(makeAsset()),
      clientX: 240, // lands inside [200, 300)
    })
    expect(trackById('V1').clips).toHaveLength(1) // only the original
    expect(doc().past).toHaveLength(0)
  })
})

describe('Track OS file drop', () => {
  test('captures the integer drop frame without placing before import', () => {
    render(<Track track={trackById('V1')} />)
    const file = new File(['video'], 'take.mp4', { type: 'video/mp4' })

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: fileDragData([file]),
      clientX: 240,
    })

    expect(dropOsFilesOnTimeline).toHaveBeenCalledWith({
      documentId: 'doc-mediadrop',
      trackId: 'V1',
      trackKind: 'video',
      startFrame: 240,
      files: [file],
    })
    expect(trackById('V1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
  })

  test('honors zoom and the bounded timeline origin for OS files', () => {
    act(() => useTransportStore.getState().setZoom(2))
    render(
      <Track
        track={trackById('V1')}
        timelineOriginFrame={1_000_000}
        timelineWindowEndFrame={1_100_000}
      />,
    )

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: fileDragData([
        new File(['video'], 'take.mp4', { type: 'video/mp4' }),
      ]),
      clientX: 240,
    })

    expect(dropOsFilesOnTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        startFrame: 1_000_120,
        trackId: 'V1',
        trackKind: 'video',
      }),
    )
  })

  test('passes every dropped file through so the controller can refuse multiples', () => {
    render(<Track track={trackById('V1')} />)
    const files = [
      new File(['a'], 'a.mp4', { type: 'video/mp4' }),
      new File(['b'], 'b.mp4', { type: 'video/mp4' }),
    ]

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: fileDragData(files),
      clientX: 0,
    })

    expect(dropOsFilesOnTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ files }),
    )
    expect(trackById('V1').clips).toHaveLength(0)
  })

  test('passes the rendered document identity, not a later live replacement', () => {
    render(<Track documentId="doc-rendered" track={trackById('V1')} />)

    fireEvent.drop(screen.getByTestId('track-V1'), {
      dataTransfer: fileDragData([
        new File(['video'], 'take.mp4', { type: 'video/mp4' }),
      ]),
      clientX: 0,
    })

    expect(dropOsFilesOnTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-rendered',
        trackId: 'V1',
        trackKind: 'video',
      }),
    )
    expect(doc().doc.id).toBe('doc-mediadrop')
  })
})

describe('Track placement ghost', () => {
  test('shows a duration-accurate ghost for an in-flight Media Pool asset', async () => {
    const asset = makeAsset()
    seedAsset(asset)
    beginAssetDrag({
      assetId: asset.id,
      kind: asset.kind,
      durationFrames: asset.durationFrames,
    })
    render(<Track track={trackById('V1')} />)

    fireEvent.dragOver(screen.getByTestId('track-V1'), {
      dataTransfer: assetDragData(asset),
      clientX: 240,
    })

    const ghost = await screen.findByTestId('media-placement-ghost')
    expect(ghost).toHaveAttribute('data-placement-valid', 'true')
    expect(ghost).toHaveStyle({
      transform: 'translateX(240px)',
      width: '120px',
    })
  })

  test('shows a one-frame insertion marker for an OS file before release', async () => {
    render(<Track track={trackById('V1')} />)

    fireEvent.dragOver(screen.getByTestId('track-V1'), {
      dataTransfer: fileDragData([
        new File(['video'], 'take.mp4', { type: 'video/mp4' }),
      ]),
      clientX: 240,
    })

    const ghost = await screen.findByTestId('media-placement-ghost')
    expect(ghost).toHaveClass('marker')
    expect(ghost).toHaveStyle({
      transform: 'translateX(240px)',
      width: '1px',
    })
  })

  test('a queued hover frame cannot resurrect a ghost after drop', () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      render(<Track track={trackById('V1')} />)
      const lane = screen.getByTestId('track-V1')
      fireEvent.dragOver(lane, {
        dataTransfer: fileDragData([
          new File(['video'], 'take.mp4', { type: 'video/mp4' }),
        ]),
        clientX: 240,
      })
      expect(frames).toHaveLength(1)
      expect(screen.queryByTestId('media-placement-ghost')).not.toBeInTheDocument()

      fireEvent.drop(lane, {
        dataTransfer: fileDragData([
          new File(['a'], 'a.mp4', { type: 'video/mp4' }),
          new File(['b'], 'b.mp4', { type: 'video/mp4' }),
        ]),
        clientX: 240,
      })
      act(() => {
        for (const frame of frames) frame(0)
      })

      expect(useTransportStore.getState().mediaPlacementPreview).toBeNull()
      expect(screen.queryByTestId('media-placement-ghost')).not.toBeInTheDocument()
    } finally {
      raf.mockRestore()
    }
  })

  test('a queued hover frame cannot resurrect a ghost after leaving the lane', () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      render(<Track track={trackById('V1')} />)
      const lane = screen.getByTestId('track-V1')
      const dataTransfer = fileDragData([
        new File(['video'], 'take.mp4', { type: 'video/mp4' }),
      ])
      fireEvent.dragOver(lane, {
        dataTransfer,
        clientX: 240,
      })
      expect(frames).toHaveLength(1)
      expect(screen.queryByTestId('media-placement-ghost')).not.toBeInTheDocument()

      fireEvent.dragLeave(lane, {
        dataTransfer,
        relatedTarget: null,
      })
      act(() => {
        for (const frame of frames) frame(0)
      })

      expect(useTransportStore.getState().mediaPlacementPreview).toBeNull()
      expect(screen.queryByTestId('media-placement-ghost')).not.toBeInTheDocument()
    } finally {
      raf.mockRestore()
    }
  })

  test('a queued asset hover frame cannot resurrect a ghost after drag end', () => {
    const asset = makeAsset()
    seedAsset(asset)
    render(
      <>
        <MediaPool />
        <Track track={trackById('V1')} />
      </>,
    )
    const card = screen.getByTitle(asset.fileName)
    const dragData = assetDragData(asset)
    fireEvent.dragStart(card, { dataTransfer: dragData })

    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      fireEvent.dragOver(screen.getByTestId('track-V1'), {
        dataTransfer: dragData,
        clientX: 240,
      })
      expect(frames).toHaveLength(1)
      expect(screen.queryByTestId('media-placement-ghost')).not.toBeInTheDocument()

      fireEvent.dragEnd(card, { dataTransfer: dragData })
      act(() => {
        for (const frame of frames) frame(0)
      })

      expect(useTransportStore.getState().mediaPlacementPreview).toBeNull()
      expect(screen.queryByTestId('media-placement-ghost')).not.toBeInTheDocument()
    } finally {
      raf.mockRestore()
    }
  })
})
