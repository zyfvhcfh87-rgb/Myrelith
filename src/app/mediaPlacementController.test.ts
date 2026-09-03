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
import { importMedia, importMediaFiles } from './mediaImportController'
import {
  applyMediaPlacementHoverPreview,
  dropOsFilesOnTimeline,
  importDroppedMediaFiles,
  invalidateMediaPlacementHover,
  mediaPlacementPreviewEpoch,
  placeImportedAsset,
  resetMediaPlacementControllerForTest,
  TIMELINE_MULTI_FILE_DROP_MESSAGE,
} from './mediaPlacementController'

vi.mock('./mediaImportController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mediaImportController')>()
  return {
    ...actual,
    importMedia: vi.fn(actual.importMedia),
    importMediaFiles: vi.fn(actual.importMediaFiles),
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
    schemaVersion: 19,
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

function fillHistoryToCapacity(): TimelineDoc {
  const state = doc()
  const current = state.doc
  useDocumentStore.setState({
    doc: current,
    past: Array.from({ length: 100 }, (_, index) => ({
      ...state.project,
      name: `history-${index}`,
    })),
    future: [],
  })
  return current
}

beforeEach(() => {
  resetMediaPlacementControllerForTest()
  resetTransportStoreForTest()
  resetMediaStoreForTest()
  resetDocumentStoreForTest(makeDoc())
  vi.mocked(importMedia).mockReset()
  vi.mocked(importMediaFiles).mockReset()
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

  test('places a second A/V drop onto V2 by linking free A2 instead of occupied A1', () => {
    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
    expect(useMediaStore.getState().addAsset(makeAsset({
      id: 'asset-10',
      fileName: 'second.mp4',
      objectUrl: 'blob:fake-2',
    }))).toBe(true)
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video'),
        makeTrack('V2', 'video'),
        makeTrack('A1', 'audio'),
        makeTrack('A2', 'audio'),
      ],
    })

    expect(placeImportedAsset('doc-place-ctrl', 'asset-9', 'V1', 0))
      .toEqual({ status: 'placed', assetId: 'asset-9' })
    expect(placeImportedAsset('doc-place-ctrl', 'asset-10', 'V2', 0))
      .toEqual({ status: 'placed', assetId: 'asset-10' })
    expect(trackById('V2').clips[0].assetId).toBe('asset-10')
    expect(trackById('A1').clips[0].assetId).toBe('asset-9')
    expect(trackById('A2').clips[0].assetId).toBe('asset-10')
    expect(trackById('A2').clips[0].linkGroupId)
      .toBe(trackById('V2').clips[0].linkGroupId)
    expect(doc().past).toHaveLength(2)
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

  test('rejects the whole A/V pair when every unlocked audio lane overlaps', () => {
    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video'),
        makeTrack('A1', 'audio', [makeClip('existingA', 200, 100)]),
        makeTrack('A2', 'audio', [makeClip('existingA2', 200, 100)]),
      ],
    })

    expect(placeImportedAsset('doc-place-ctrl', 'asset-9', 'V1', 240, true))
      .toEqual({
        status: 'not-placed',
        assetId: 'asset-9',
        reason: 'overlap',
      })
    expect(trackById('V1').clips).toHaveLength(0)
    expect(trackById('A1').clips.map((item) => item.id)).toEqual(['existingA'])
    expect(trackById('A2').clips.map((item) => item.id)).toEqual(['existingA2'])
    expect(doc().past).toHaveLength(0)
  })

  test('detects a successful place at the 100-entry history cap', () => {
    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
    const current = fillHistoryToCapacity()

    expect(placeImportedAsset('doc-place-ctrl', 'asset-9', 'V1', 240))
      .toEqual({ status: 'placed', assetId: 'asset-9' })
    expect(doc().doc).not.toBe(current)
    expect(doc().past).toHaveLength(100)
    expect(doc().past[99].sequences[0]).toBe(current)
    expect(trackById('V1').clips).toHaveLength(1)
  })

  test('detects a rejected place at the 100-entry history cap', () => {
    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video', [makeClip('existing', 200, 100)]),
        makeTrack('A1', 'audio'),
      ],
    })
    const current = fillHistoryToCapacity()

    expect(placeImportedAsset('doc-place-ctrl', 'asset-9', 'V1', 240))
      .toEqual({
        status: 'not-placed',
        assetId: 'asset-9',
        reason: 'overlap',
      })
    expect(doc().doc).toBe(current)
    expect(doc().past).toHaveLength(100)
    expect(trackById('V1').clips.map((item) => item.id)).toEqual(['existing'])
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

  test('refusing a later drop cancels an in-flight import so it cannot place', async () => {
    let finishImport: ((result: { status: 'imported'; assetId: string }) => void) | undefined
    vi.mocked(importMedia).mockImplementation(() => new Promise((resolve) => {
      finishImport = resolve
    }))

    const first = dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      startFrame: 240,
      files: [new File(['video'], 'beach.mp4', { type: 'video/mp4' })],
    })
    expect(importMedia).toHaveBeenCalledOnce()

    const refused = await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      startFrame: 12,
      files: [
        new File(['a'], 'a.mp4', { type: 'video/mp4' }),
        new File(['b'], 'b.mp4', { type: 'video/mp4' }),
      ],
    })
    expect(refused).toEqual({
      status: 'refused',
      message: TIMELINE_MULTI_FILE_DROP_MESSAGE,
    })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe(TIMELINE_MULTI_FILE_DROP_MESSAGE)

    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
    finishImport!({ status: 'imported', assetId: 'asset-9' })

    expect(await first).toEqual({ status: 'cancelled' })
    expect(trackById('V1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe(TIMELINE_MULTI_FILE_DROP_MESSAGE)
  })

  test('a later invalid-lane drop also cancels an in-flight import', async () => {
    let finishImport: ((result: { status: 'imported'; assetId: string }) => void) | undefined
    vi.mocked(importMedia).mockImplementation(() => new Promise((resolve) => {
      finishImport = resolve
    }))

    const first = dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      startFrame: 240,
      files: [new File(['video'], 'beach.mp4', { type: 'video/mp4' })],
    })
    expect(importMedia).toHaveBeenCalledOnce()

    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video', [], true),
        makeTrack('A1', 'audio'),
      ],
    })
    expect(await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      trackKind: 'video',
      startFrame: 0,
      files: [new File(['video'], 'locked.mp4', { type: 'video/mp4' })],
    })).toMatchObject({ status: 'not-placed', reason: 'locked-track' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('The lane is no longer valid for this drop.')

    expect(useMediaStore.getState().addAsset(makeAsset())).toBe(true)
    finishImport!({ status: 'imported', assetId: 'asset-9' })

    expect(await first).toEqual({ status: 'cancelled' })
    expect(trackById('V1').clips).toHaveLength(0)
    expect(doc().past).toHaveLength(0)
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('The lane is no longer valid for this drop.')
  })

  test('does not import when the rendered document has already been replaced', async () => {
    doc().setDoc({ ...makeDoc(), id: 'doc-other' })

    const result = await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      trackKind: 'video',
      startFrame: 240,
      files: [new File(['video'], 'stale.mp4', { type: 'video/mp4' })],
    })

    expect(importMedia).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'not-placed',
      assetId: '',
      reason: 'stale-document',
    })
    expect(useMediaStore.getState().assets.size).toBe(0)
  })

  test('does not import when the rendered lane was locked, removed, or changed kind', async () => {
    doc().setDoc({
      ...makeDoc(),
      tracks: [
        makeTrack('V1', 'video', [], true),
        makeTrack('A1', 'audio'),
      ],
    })
    expect(await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      trackKind: 'video',
      startFrame: 0,
      files: [new File(['video'], 'locked.mp4', { type: 'video/mp4' })],
    })).toMatchObject({ status: 'not-placed', reason: 'locked-track' })
    expect(importMedia).not.toHaveBeenCalled()

    doc().setDoc({
      ...makeDoc(),
      tracks: [makeTrack('A1', 'audio')],
    })
    expect(await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      trackKind: 'video',
      startFrame: 0,
      files: [new File(['video'], 'gone.mp4', { type: 'video/mp4' })],
    })).toMatchObject({ status: 'not-placed', reason: 'missing-track' })
    expect(importMedia).not.toHaveBeenCalled()

    doc().setDoc({
      ...makeDoc(),
      tracks: [
        { ...makeTrack('V1', 'video'), kind: 'audio' },
        makeTrack('A1', 'audio'),
      ],
    })
    expect(await dropOsFilesOnTimeline({
      documentId: 'doc-place-ctrl',
      trackId: 'V1',
      trackKind: 'video',
      startFrame: 0,
      files: [new File(['video'], 'kind.mp4', { type: 'video/mp4' })],
    })).toMatchObject({ status: 'not-placed', reason: 'wrong-kind' })
    expect(importMedia).not.toHaveBeenCalled()
  })
})

describe('importDroppedMediaFiles', () => {
  test('announces success, partial success, and empty drops', async () => {
    vi.mocked(importMediaFiles).mockResolvedValueOnce({
      status: 'batch-complete',
      results: [
        { status: 'imported', assetId: 'a' },
        { status: 'imported', assetId: 'b' },
      ],
    })
    expect(await importDroppedMediaFiles([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ])).toMatchObject({ status: 'batch-complete' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('Imported 2 files.')

    vi.mocked(importMediaFiles).mockResolvedValueOnce({
      status: 'imported',
      assetId: 'one',
    })
    expect(await importDroppedMediaFiles([
      new File(['one'], 'one.png', { type: 'image/png' }),
    ])).toMatchObject({ status: 'imported' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('Imported 1 file.')

    vi.mocked(importMediaFiles).mockResolvedValueOnce({
      status: 'batch-complete',
      results: [
        { status: 'imported', assetId: 'a' },
        { status: 'failed', message: 'Could not read the second file.' },
      ],
    })
    expect(await importDroppedMediaFiles([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ])).toMatchObject({ status: 'batch-complete' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('Imported 1 of 2 files.')

    expect(await importDroppedMediaFiles([])).toEqual({ status: 'cancelled' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('No files to import.')
  })

  test('announces busy, cancelled, unsupported, and failed terminal states', async () => {
    vi.mocked(importMediaFiles).mockResolvedValueOnce({ status: 'busy' })
    expect(await importDroppedMediaFiles([
      new File(['a'], 'a.png', { type: 'image/png' }),
    ])).toEqual({ status: 'busy' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('Import already in progress.')

    vi.mocked(importMediaFiles).mockResolvedValueOnce({ status: 'cancelled' })
    expect(await importDroppedMediaFiles([
      new File(['a'], 'a.png', { type: 'image/png' }),
    ])).toEqual({ status: 'cancelled' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('Import cancelled.')

    vi.mocked(importMediaFiles).mockResolvedValueOnce({
      status: 'unsupported',
      itemId: 'bad',
    })
    expect(await importDroppedMediaFiles([
      new File(['a'], 'a.bin', { type: 'application/octet-stream' }),
    ])).toMatchObject({ status: 'unsupported' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('Could not import the file.')

    vi.mocked(importMediaFiles).mockResolvedValueOnce({
      status: 'failed',
      message: 'The decoder failed.',
    })
    expect(await importDroppedMediaFiles([
      new File(['a'], 'a.mp4', { type: 'video/mp4' }),
    ])).toMatchObject({ status: 'failed' })
    expect(useTransportStore.getState().mediaPlacementStatus)
      .toBe('The decoder failed.')

    vi.mocked(importMediaFiles).mockRejectedValueOnce(new Error('boom'))
    expect(await importDroppedMediaFiles([
      new File(['a'], 'a.mp4', { type: 'video/mp4' }),
    ])).toEqual({ status: 'failed', message: 'boom' })
    expect(useTransportStore.getState().mediaPlacementStatus).toBe('boom')
  })
})

describe('applyMediaPlacementHoverPreview', () => {
  test('ignores a queued hover after drop invalidation or a pending marker', () => {
    const hover = {
      trackId: 'V1',
      startFrame: 240,
      durationFrames: null,
      valid: true,
      phase: 'hover' as const,
    }
    const epoch = mediaPlacementPreviewEpoch()
    invalidateMediaPlacementHover()
    applyMediaPlacementHoverPreview(hover, epoch)
    expect(useTransportStore.getState().mediaPlacementPreview).toBeNull()

    const pendingEpoch = mediaPlacementPreviewEpoch()
    useTransportStore.getState().setMediaPlacementPreview({
      ...hover,
      phase: 'pending',
    })
    applyMediaPlacementHoverPreview(hover, pendingEpoch)
    expect(useTransportStore.getState().mediaPlacementPreview).toEqual({
      ...hover,
      phase: 'pending',
    })
  })
})
