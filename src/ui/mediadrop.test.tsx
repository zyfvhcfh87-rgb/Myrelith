/**
 * ui/mediadrop.test.tsx — Phase 4.0 media → timeline flow.
 *
 * MediaPool rows advertise {asset id, kind} per the ui/dnd.ts contract;
 * Track lanes accept kind-matched drops and commit exactly ONE
 * documentStore.insertClip (one undo entry). jsdom has no real drag-and-
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
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import { ASSET_DRAG_TYPE, assetKindDragType } from './dnd'
import MediaPool from './MediaPool'
import Track from './timeline/Track'

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function makeAsset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-9',
    fileName: 'beach.mp4',
    objectUrl: 'blob:fake',
    kind: 'video',
    durationFrames: 120,
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
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, locked }
}

/** V1 (video, empty), A1 (audio, empty), VL (video, locked). */
function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 1,
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

const doc = () => useDocumentStore.getState()
const trackById = (id: string) =>
  doc().doc.tracks.find((t) => t.id === id) as TrackData

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
  })
  useMediaStore.setState({ assets: new Map() })
  doc().setDoc(makeDoc())
})

function seedAsset(asset: MediaAsset): void {
  useMediaStore.setState((s) => {
    const assets = new Map(s.assets)
    assets.set(asset.id, asset)
    return { assets }
  })
}

/* ------------------------------------------------------------------ */
/* MediaPool — drag source                                              */
/* ------------------------------------------------------------------ */

describe('MediaPool drag source', () => {
  test('rows are draggable only once metadata is ready', () => {
    seedAsset(makeAsset())
    seedAsset(makeAsset({ id: 'asset-raw', fileName: 'raw.mov', durationFrames: 0 }))
    render(<MediaPool />)
    expect(screen.getByTitle('beach.mp4')).toHaveAttribute('draggable', 'true')
    expect(screen.getByTitle('raw.mov')).toHaveAttribute('draggable', 'false')
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
  test('video drop inserts one clip at the pointer frame — one undo entry', () => {
    seedAsset(makeAsset())
    render(<Track track={trackById('V1')} />)
    const lane = screen.getByTestId('track-V1')
    const dataTransfer = assetDragData(makeAsset())

    fireEvent.dragOver(lane, { dataTransfer })
    expect(lane.className).toContain('drop-target') // accepted → highlighted

    // jsdom rects sit at x=0, so clientX 240 at zoom 1 is frame 240.
    fireEvent.drop(lane, { dataTransfer, clientX: 240 })
    expect(lane.className).not.toContain('drop-target')

    const clips = trackById('V1').clips
    expect(clips).toHaveLength(1)
    expect(clips[0].assetId).toBe('asset-9')
    expect(clips[0].name).toBe('beach.mp4')
    expect(clips[0].timelineRange).toEqual({ startFrame: 240, durationFrames: 120 })
    expect(clips[0].sourceRange).toEqual({ startFrame: 0, durationFrames: 120 })
    expect(doc().past).toHaveLength(1) // exactly ONE undo entry

    doc().undo()
    expect(trackById('V1').clips).toHaveLength(0)
  })

  test('drop honors zoom when mapping pixels to frames', () => {
    seedAsset(makeAsset())
    act(() => useTransportStore.getState().setZoom(2))
    render(<Track track={trackById('V1')} />)
    const dataTransfer = assetDragData(makeAsset())

    fireEvent.drop(screen.getByTestId('track-V1'), { dataTransfer, clientX: 240 })
    expect(trackById('V1').clips[0].timelineRange.startFrame).toBe(120)
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

  test('overlapping drop is rejected: no clip, no history, domain warns', () => {
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
    expect(warnSpy).toHaveBeenCalled()
  })
})
