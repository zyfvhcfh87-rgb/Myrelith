import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, MediaAsset, TimelineDoc, Track as TrackData } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import {
  resetDocumentStoreForTest,
  resetMediaStoreForTest,
  resetTransportStoreForTest,
} from '../test/storeFixtures'
import { importMedia } from './mediaImportController'
import {
  dropOsFilesOnTimeline,
  placeImportedAsset,
  resetMediaPlacementControllerForTest,
  TIMELINE_MULTI_FILE_DROP_MESSAGE,
} from './mediaPlacementController'

vi.mock('./mediaImportController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mediaImportController')>()
  return {
    ...actual,
    importMedia: vi.fn(actual.importMedia),
  }
})

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
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
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
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function makeDoc(): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'doc-place-ctrl',
    name: 'placement controller fixture',
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

const doc = () => useDocumentStore.getState()
const trackById = (id: string) =>
  doc().doc.tracks.find((t) => t.id === id) as TrackData

beforeEach(() => {
  resetMediaPlacementControllerForTest()
  resetTransportStoreForTest()
  resetMediaStoreForTest()
  resetDocumentStoreForTest(makeDoc())
  vi.mocked(importMedia).mockReset()
})

describe('placeImportedAsset', () => {
  test('places a linked A/V pair as one undo entry', () => {
    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)

    expect(placeImportedAsset('doc-place-ctrl', 'asset-9', 'V1', 240))
      .toEqual({ status: 'placed', assetId: 'asset-9' })
    expect(trackById('V1').clips[0].timelineRange.startFrame).toBe(240)
    expect(trackById('A1').clips[0].linkGroupId)
      .toBe(trackById('V1').clips[0].linkGroupId)
    expect(doc().past).toHaveLength(1)
  })

  test('does not write timeline history when the project was replaced', () => {
    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)

    expect(placeImportedAsset('doc-other', 'asset-9', 'V1', 0, true))
      .toEqual({
        status: 'not-placed',
        assetId: 'asset-9',
        reason: 'stale-document',
      })
    expect(trackById('V1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toContain('could not be placed')
  })

  test('leaves a successful import in the pool when overlap rejects placement', () => {
    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video', [makeClip('existing', 200, 100)]),
        makeTrack('A1', 'audio'),
        makeTrack('VL', 'video', [], true),
      ],
    })

    expect(placeImportedAsset('doc-place-ctrl', 'asset-9', 'V1', 240, true))
      .toEqual({
        status: 'not-placed',
        assetId: 'asset-9',
        reason: 'overlap',
      })
    expect(useMediaStore.getState().assets.has('asset-9')).toBe(true)
    expect(trackById('V1').clips).toHaveLength(1)
    expect(doc().past).toHaveLength(0)
  })
})

describe('dropOsFilesOnTimeline', () => {
  test('refuses a multi-file timeline drop before import', async () => {
    const result = await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      startFrame: 12,
      files: [
        new File(['a'], 'a.mp4', { type: 'video/mp4' }),
        new File(['b'], 'b.mp4', { type: 'video/mp4' }),
      ],
    })

    expect(result).toEqual({
      status: 'refused',
      message: TIMELINE_MULTI_FILE_DROP_MESSAGE,
    })
    expect(importMedia).not.toHaveBeenCalled()
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe(TIMELINE_MULTI_FILE_DROP_MESSAGE)
    expect(useTransportStore.getState().mediaPlacementPreview).toBeNull()
  })

  test('imports first, then places the same asset at the captured frame', async () => {
    vi.mocked(importMedia).mockImplementation(async () => {
      expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
      return { status: 'imported', assetId: 'asset-9' }
    })

    const file = new File(['video'], 'beach.mp4', { type: 'video/mp4' })
    const result = await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      startFrame: 240,
      files: [file],
    })

    expect(importMedia).toHaveBeenCalledWith(file)
    expect(result).toEqual({ status: 'placed', assetId: 'asset-9' })
    expect(trackById('V1').clips[0].timelineRange).toEqual({
      startFrame: 240,
      durationFrames: 120,
    })
    expect(useMediaStore.getState().assets.has('asset-9')).toBe(true)
    expect(useTransportStore.getState().mediaPlacementPreview).toBeNull()
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('Placed beach.mp4 on the timeline.')
  })

  test('keeps an imported asset when the lane is no longer valid', async () => {
    vi.mocked(importMedia).mockImplementation(async () => {
      expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
      doc().setDoc({
        ...makeDoc(),
        tracks: [
          makeTrack('V1', 'video', [makeClip('existing', 200, 100)]),
          makeTrack('A1', 'audio'),
        ],
      })
      return { status: 'imported', assetId: 'asset-9' }
    })

    const result = await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      startFrame: 240,
      files: [new File(['video'], 'beach.mp4', { type: 'video/mp4' })],
    })

    expect(result).toMatchObject({ status: 'not-placed', reason: 'overlap' })
    expect(useMediaStore.getState().assets.has('asset-9')).toBe(true)
    expect(trackById('V1').clips.map((item) => item.id)).toEqual(['existing'])
    expect(doc().past).toHaveLength(0)
  })
})
