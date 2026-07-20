import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_PROJECT_SETTINGS,
  createTimelineDoc,
} from '../domain/projectSettings'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaTrackCompatibility,
} from '../domain/mediaCompatibility'
import type {
  Clip,
  FrameRate,
  MediaAsset,
  PartialTrackImportSelection,
  TimelineDoc,
} from '../domain/schema'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import { microsecondsDurationToFrames } from '../domain/time'
import {
  INITIAL_MEDIA_IMPORT_STATE,
  useMediaImportStore,
  type MediaImportPhase,
} from '../state/mediaImportStore'
import {
  acceptPartialMediaImport,
  cancelMediaImport,
  importMedia,
  importMediaFromHandle,
  removeMediaCompatibility,
  resetMediaImportController,
  retryMediaCompatibility,
  resolveMediaImportDecision,
  type MediaImportDeps,
} from './mediaImportController'
import type { LocalMediaFileHandle } from './localMediaHandles'

const F24: FrameRate = { num: 24, den: 1 }
const F30: FrameRate = { num: 30, den: 1 }
const F60: FrameRate = { num: 60, den: 1 }

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-new',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 8,
    lastModified: 123,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 2_000_000,
    frameRate: F60,
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"avc1.64042a"}',
    ...overrides,
  }
}

function makeCompatibility(
  status: MediaCompatibilityReport['status'] = 'ready',
  overrides: Partial<MediaCompatibilityReport> = {},
): MediaCompatibilityReport {
  return {
    status,
    container: {
      name: 'MPEG-4 Part 14',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.64042a, mp4a.40.2"',
    },
    durationMicroseconds: 2_000_000,
    tracks: [],
    reason: status === 'ready' ? null : 'unsupported-codec',
    detail: status === 'ready' ? null : 'This browser cannot decode this codec.',
    ...overrides,
  }
}

function compatibilityTrack(
  kind: MediaTrackCompatibility['kind'],
  decodable: boolean,
  durationMicroseconds: number,
): MediaTrackCompatibility {
  return {
    kind,
    number: 1,
    primary: true,
    codec: kind === 'video' ? 'avc' : 'aac',
    codecParameter: kind === 'video' ? 'avc1.64042a' : 'mp4a.40.2',
    internalCodecId: null,
    decoderConfig: null,
    decoderPath: decodable ? 'native' : null,
    decodable,
    reason: decodable ? null : 'unsupported-codec',
    detail: decodable ? null : `${kind} decoder unavailable`,
    width: kind === 'video' ? 1920 : null,
    height: kind === 'video' ? 1080 : null,
    codedWidth: kind === 'video' ? 1920 : null,
    codedHeight: kind === 'video' ? 1080 : null,
    frameRate: kind === 'video' ? F60 : null,
    sampleRate: kind === 'audio' ? 48_000 : null,
    channels: kind === 'audio' ? 2 : null,
    durationMicroseconds,
  }
}

function limitedPartialProbe(
  asset: MediaAsset,
  selection: PartialTrackImportSelection,
  selectedDurationMicroseconds: number,
  omittedDurationMicroseconds: number,
): MediaProbeResult {
  const videoOnly = selection === 'video-only'
  return {
    status: 'limited',
    asset,
    compatibility: makeCompatibility('limited', {
      durationMicroseconds: Math.max(
        selectedDurationMicroseconds,
        omittedDurationMicroseconds,
      ),
      tracks: [
        compatibilityTrack(
          'video',
          videoOnly,
          videoOnly
            ? selectedDurationMicroseconds
            : omittedDurationMicroseconds,
        ),
        compatibilityTrack(
          'audio',
          !videoOnly,
          videoOnly
            ? omittedDurationMicroseconds
            : selectedDurationMicroseconds,
        ),
      ],
      detail: videoOnly
        ? 'The audio track cannot be decoded.'
        : 'The video track cannot be decoded.',
    }),
  }
}

function readyProbe(asset: MediaAsset): MediaProbeResult {
  return {
    status: 'ready',
    asset,
    compatibility: makeCompatibility('ready', {
      durationMicroseconds: asset.durationMicroseconds,
    }),
  }
}

function makeClip(): Clip {
  return {
    id: 'clip-1',
    assetId: 'existing',
    name: 'Edited clip',
    sourceRange: { startFrame: 0, durationFrames: 30 },
    timelineRange: { startFrame: 0, durationFrames: 30 },
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Fixture {
  deps: MediaImportDeps
  assets: Map<string, MediaAsset>
  compatibility: Map<string, MediaCompatibilityItem>
  currentDocument(): TimelineDoc
  setDocument(document: TimelineDoc): void
  inspect: ReturnType<typeof vi.fn<MediaImportDeps['inspect']>>
  replaceDocument: ReturnType<typeof vi.fn<MediaImportDeps['replaceDocument']>>
  reconformAssets: ReturnType<typeof vi.fn<MediaImportDeps['reconformAssets']>>
  rememberMediaHandle: ReturnType<
    typeof vi.fn<MediaImportDeps['rememberMediaHandle']>
  >
  revokeObjectURL: ReturnType<typeof vi.fn<MediaImportDeps['revokeObjectURL']>>
}

function makeFixture(
  analyzed: MediaAsset = makeAsset(),
  startingDocument = createTimelineDoc(
    'Import test',
    DEFAULT_PROJECT_SETTINGS,
    'doc-import',
  ),
): Fixture {
  let document = startingDocument
  const assets = new Map<string, MediaAsset>()
  const compatibility = new Map<string, MediaCompatibilityItem>()
  let requestCount = 0
  const inspect = vi.fn(async (
    _file: File,
    _rate: FrameRate,
    assetId: string,
  ) => readyProbe({ ...analyzed, id: assetId }))
  const replaceDocument = vi.fn((next: TimelineDoc) => {
    document = next
  })
  const reconformAssets = vi.fn((rate: FrameRate) => {
    for (const [id, asset] of assets) {
      assets.set(id, {
        ...asset,
        durationFrames: microsecondsDurationToFrames(
          asset.durationMicroseconds,
          rate,
        ),
      })
    }
  })
  const rememberMediaHandle = vi.fn(async () => undefined)
  const revokeObjectURL = vi.fn()
  const deps: MediaImportDeps = {
    createAssetId: () => analyzed.id,
    createRequestId: () => `request-${++requestCount}`,
    inspect,
    getDocument: () => document,
    replaceDocument,
    hasAsset: (id) => assets.has(id),
    addAsset: (asset) => {
      if (assets.has(asset.id)) return false
      assets.set(asset.id, asset)
      return true
    },
    reconformAssets,
    startCompatibility: (item) => {
      const current = compatibility.get(item.id)
      if (current?.status === 'checking' || assets.has(item.id)) return false
      compatibility.set(item.id, item)
      return true
    },
    hasCompatibility: (id, requestId) => (
      compatibility.get(id)?.requestId === requestId
    ),
    getCompatibility: (id) => compatibility.get(id),
    setCompatibility: (id, requestId, status, report) => {
      const current = compatibility.get(id)
      if (!current || current.requestId !== requestId) return false
      compatibility.set(id, { ...current, status, report })
      return true
    },
    removeCompatibility: (id) => {
      compatibility.delete(id)
    },
    rememberMediaHandle,
    revokeObjectURL,
  }
  return {
    deps,
    assets,
    compatibility,
    currentDocument: () => document,
    setDocument: (next) => {
      document = next
    },
    inspect,
    replaceDocument,
    reconformAssets,
    rememberMediaHandle,
    revokeObjectURL,
  }
}

const file = () => new File(['source'], 'source.mp4', { type: 'video/mp4' })
const waitForImportPhase = async (expected: MediaImportPhase): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (useMediaImportStore.getState().phase === expected) return
    await Promise.resolve()
  }
  throw new Error(
    `Media import did not reach ${expected}; current phase is ${useMediaImportStore.getState().phase}`,
  )
}

beforeEach(() => {
  resetMediaImportController()
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
})

describe('mediaImportController', () => {
  test('matching FPS analyzes once and commits a complete asset immediately', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30, durationFrames: 999 }))

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })

    expect(fixture.inspect).toHaveBeenCalledOnce()
    expect(fixture.inspect).toHaveBeenCalledWith(
      expect.any(File),
      F30,
      'asset-new',
      expect.any(AbortSignal),
    )
    expect(fixture.assets.get('asset-new')).toMatchObject({
      durationFrames: 60,
      frameRate: F30,
    })
    expect(fixture.replaceDocument).not.toHaveBeenCalled()
    expect(fixture.revokeObjectURL).not.toHaveBeenCalled()
    expect(useMediaImportStore.getState().phase).toBe('idle')
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'ready',
      report: { status: 'ready' },
    })
  })

  test('commits a positive sub-frame source as one timeline frame', async () => {
    const fixture = makeFixture(makeAsset({
      durationFrames: 1,
      durationMicroseconds: 1,
      frameRate: F30,
    }))

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'imported',
    })

    expect(fixture.assets.get('asset-new')?.durationFrames).toBe(1)
  })

  test('a handle-aware import remembers the capability only after commit', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30 }))
    const selected = file()
    const handle = {
      kind: 'file',
      name: selected.name,
      getFile: vi.fn(async () => selected),
    } as unknown as LocalMediaFileHandle

    await expect(
      importMediaFromHandle(selected, handle, fixture.deps),
    ).resolves.toMatchObject({ status: 'imported' })

    expect(fixture.rememberMediaHandle).toHaveBeenCalledOnce()
    expect(fixture.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-import',
      'asset-new',
      handle,
    )
  })

  test('a deferred handle write does not block the editor after commit', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30 }))
    const remembering = deferred<void>()
    fixture.rememberMediaHandle.mockImplementation(() => remembering.promise)
    const selected = file()
    const handle = {
      kind: 'file',
      name: selected.name,
      getFile: vi.fn(async () => selected),
    } as unknown as LocalMediaFileHandle

    await expect(
      importMediaFromHandle(selected, handle, fixture.deps),
    ).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })

    const signal = fixture.inspect.mock.calls[0]?.[3]
    expect(fixture.assets.has('asset-new')).toBe(true)
    expect(fixture.compatibility.get('asset-new')?.status).toBe('ready')
    expect(fixture.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-import',
      'asset-new',
      handle,
    )
    expect(cancelMediaImport()).toBe(false)
    expect(removeMediaCompatibility('asset-new')).toBe(false)
    expect(signal?.aborted).toBe(false)
    expect(useMediaImportStore.getState().phase).toBe('idle')
    expect(fixture.revokeObjectURL).not.toHaveBeenCalled()

    const second = makeFixture(makeAsset({
      id: 'asset-second',
      frameRate: F30,
    }))
    await expect(importMedia(file(), second.deps)).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-second',
    })

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    remembering.reject(new Error('IndexedDB write failed'))
    await vi.waitFor(() => {
      expect(consoleWarn).toHaveBeenCalledWith(
        'Could not finish remembering the imported media file',
        expect.objectContaining({ message: 'IndexedDB write failed' }),
      )
    })
    expect(useMediaImportStore.getState().phase).toBe('idle')
    expect(fixture.compatibility.get('asset-new')?.status).toBe('ready')
    consoleWarn.mockRestore()
  })

  test('leaving to Home keeps the queued handle and late persistence cannot clobber new import UI', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30 }))
    const getDocument = vi.fn(fixture.deps.getDocument)
    fixture.deps.getDocument = getDocument
    const remembering = deferred<void>()
    fixture.rememberMediaHandle.mockImplementation(() => remembering.promise)
    const selected = file()
    const handle = {
      kind: 'file',
      name: selected.name,
      getFile: vi.fn(async () => selected),
    } as unknown as LocalMediaFileHandle

    await expect(
      importMediaFromHandle(selected, handle, fixture.deps),
    ).resolves.toMatchObject({ status: 'imported' })

    // Production leaveActiveProject resets the import controller and clears
    // media while intentionally retaining the outgoing TimelineDoc in memory.
    // Finishing the already-queued sidecar write must not infer asset removal.
    resetMediaImportController()
    fixture.assets.clear()
    expect(fixture.currentDocument().id).toBe('doc-import')

    const pendingProbe = deferred<MediaProbeResult>()
    const nextFixture = makeFixture(makeAsset({
      id: 'asset-next-project',
      frameRate: F30,
    }))
    nextFixture.deps.inspect = vi.fn(() => pendingProbe.promise)
    const nextImport = importMedia(file(), nextFixture.deps)
    await waitForImportPhase('analyzing')

    const documentReadsBeforePersistence = getDocument.mock.calls.length
    remembering.resolve(undefined)
    await remembering.promise
    await Promise.resolve()

    // The background write has no store-inferred deletion path, and it cannot
    // clear or otherwise mutate a newer import's UI ownership.
    expect(getDocument).toHaveBeenCalledTimes(documentReadsBeforePersistence)
    expect(useMediaImportStore.getState().phase).toBe('analyzing')

    expect(cancelMediaImport()).toBe(true)
    pendingProbe.resolve(readyProbe(makeAsset({
      id: 'asset-next-project',
      frameRate: F30,
    })))
    await expect(nextImport).resolves.toEqual({ status: 'cancelled' })
  })

  test('Keep preserves project FPS and conforms duration from microseconds', async () => {
    const fixture = makeFixture()
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('awaiting-decision')

    expect(fixture.assets).toHaveLength(0)
    expect(useMediaImportStore.getState()).toMatchObject({
      phase: 'awaiting-decision',
      prompt: {
        fileName: 'source.mp4',
        projectRate: F30,
        sourceRate: F60,
        canMatchSource: true,
      },
    })
    expect(resolveMediaImportDecision('keep-project-rate')).toBe(true)

    await expect(result).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })
    expect(fixture.currentDocument().frameRate).toEqual(F30)
    expect(fixture.assets.get('asset-new')?.durationFrames).toBe(60)
    expect(fixture.reconformAssets).not.toHaveBeenCalled()
  })

  test('Match changes an empty project and re-conforms all unused media', async () => {
    const fixture = makeFixture()
    fixture.assets.set('existing', makeAsset({
      id: 'existing',
      objectUrl: 'blob:existing',
      durationFrames: 60,
    }))
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('awaiting-decision')

    expect(resolveMediaImportDecision('match-source-rate')).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'imported' })

    expect(fixture.currentDocument().frameRate).toEqual(F60)
    expect(fixture.replaceDocument).toHaveBeenCalledOnce()
    expect(fixture.reconformAssets).toHaveBeenCalledWith(F60)
    expect(fixture.assets.get('existing')?.durationFrames).toBe(120)
    expect(fixture.assets.get('asset-new')?.durationFrames).toBe(120)
  })

  test('Cancel leaves project and media unchanged and revokes the analyzed URL', async () => {
    const fixture = makeFixture()
    const startingDocument = fixture.currentDocument()
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('awaiting-decision')

    expect(cancelMediaImport()).toBe(true)
    await expect(result).resolves.toEqual({ status: 'cancelled' })

    expect(fixture.currentDocument()).toBe(startingDocument)
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce()
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
    expect(useMediaImportStore.getState().phase).toBe('idle')
    expect(fixture.rememberMediaHandle).not.toHaveBeenCalled()
  })

  test('Match remains visible but disabled after timeline editing begins', async () => {
    const empty = createTimelineDoc(
      'Edited import',
      DEFAULT_PROJECT_SETTINGS,
      'doc-edited',
    )
    const edited: TimelineDoc = {
      ...empty,
      tracks: [
        { ...empty.tracks[0], clips: [makeClip()] },
        empty.tracks[1],
      ],
    }
    const fixture = makeFixture(makeAsset(), edited)
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('awaiting-decision')

    expect(useMediaImportStore.getState().prompt).toMatchObject({
      canMatchSource: false,
      matchUnavailableReason: expect.stringContaining('clips have been added'),
    })
    expect(resolveMediaImportDecision('match-source-rate')).toBe(false)
    expect(cancelMediaImport()).toBe(true)
    await expect(result).resolves.toEqual({ status: 'cancelled' })
  })

  test('Match is disabled for a source rate outside project presets', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: { num: 120, den: 1 } }))
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('awaiting-decision')

    expect(useMediaImportStore.getState().prompt).toMatchObject({
      canMatchSource: false,
      matchUnavailableReason: expect.stringContaining('supported project presets'),
    })
    expect(resolveMediaImportDecision('match-source-rate')).toBe(false)
    expect(resolveMediaImportDecision('keep-project-rate')).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'imported' })
    expect(fixture.currentDocument().frameRate).toEqual(F30)
  })

  test('Cancel during analysis waits for cleanup and never commits late work', async () => {
    const pending = deferred<MediaProbeResult>()
    const fixture = makeFixture()
    const inspect = vi.fn((
      _file: File,
      _rate: FrameRate,
      _assetId: string,
      _signal: AbortSignal,
    ) => pending.promise)
    fixture.deps.inspect = inspect
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('analyzing')

    const signal = inspect.mock.calls[0]?.[3]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
    expect(cancelMediaImport()).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(useMediaImportStore.getState().phase).toBe('cancelling')
    pending.resolve(readyProbe(makeAsset()))
    await expect(result).resolves.toEqual({ status: 'cancelled' })

    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('a second selection reports busy while one import owns the flow', async () => {
    const pending = deferred<MediaProbeResult>()
    const fixture = makeFixture()
    fixture.deps.inspect = vi.fn(() => pending.promise)
    const first = importMedia(file(), fixture.deps)

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'busy',
    })
    cancelMediaImport()
    pending.resolve(readyProbe(makeAsset()))
    await expect(first).resolves.toEqual({ status: 'cancelled' })
  })

  test('inspection failure stays visible and retryable in session media state', async () => {
    const fixture = makeFixture()
    fixture.deps.inspect = vi.fn(async () => {
      throw new Error('unsupported container')
    })

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'failed',
      message: 'Could not import "source.mp4": unsupported container',
      itemId: 'asset-new',
    })
    expect(useMediaImportStore.getState()).toMatchObject({
      phase: 'idle',
    })
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'error',
      report: {
        reason: 'decode-failed',
        detail: expect.stringContaining('unsupported container'),
      },
    })
    expect(fixture.assets).toHaveLength(0)
  })

  test('typed unsupported media stays visible and is never committed', async () => {
    const fixture = makeFixture()
    const compatibility = makeCompatibility('unsupported')
    fixture.inspect.mockResolvedValueOnce({
      status: 'unsupported',
      asset: null,
      compatibility,
    })

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'unsupported',
      itemId: 'asset-new',
    })

    expect(fixture.assets).toHaveLength(0)
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'unsupported',
      report: compatibility,
    })
    expect(fixture.inspect).toHaveBeenCalledOnce()
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('typed limited media stays visible and is never committed', async () => {
    const fixture = makeFixture()
    const compatibility = makeCompatibility('limited')
    fixture.inspect.mockResolvedValueOnce({
      status: 'limited',
      asset: null,
      compatibility,
    })

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'limited',
      itemId: 'asset-new',
    })

    expect(fixture.assets).toHaveLength(0)
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'limited',
      report: compatibility,
    })
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('Limited stays provisional until video-only confirmation re-probes and commits', async () => {
    const fixture = makeFixture()
    const initial = limitedPartialProbe(
      makeAsset({
        objectUrl: 'blob:limited-video-initial',
        frameRate: F30,
        durationMicroseconds: 5_000_000,
      }),
      'video-only',
      3_000_000,
      5_000_000,
    )
    const confirmed = limitedPartialProbe(
      makeAsset({
        objectUrl: 'blob:limited-video-confirmed',
        frameRate: F30,
        durationMicroseconds: 5_000_000,
      }),
      'video-only',
      3_000_000,
      5_000_000,
    )
    fixture.inspect.mockReset()
    fixture.inspect
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(confirmed)

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'limited',
      itemId: 'asset-new',
    })
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'limited',
      report: initial.compatibility,
    })
    expect(fixture.inspect).toHaveBeenCalledOnce()
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce()
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith(
      'blob:limited-video-initial',
    )

    await expect(
      acceptPartialMediaImport('asset-new', 'video-only', fixture.deps),
    ).resolves.toEqual({ status: 'imported', assetId: 'asset-new' })

    expect(fixture.inspect).toHaveBeenCalledTimes(2)
    expect(fixture.assets.get('asset-new')).toMatchObject({
      objectUrl: 'blob:limited-video-confirmed',
      kind: 'video',
      partialTrackSelection: 'video-only',
      durationMicroseconds: 3_000_000,
      durationFrames: 90,
      frameRate: F30,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    })
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'ready',
      report: {
        status: 'ready',
        partialImport: { selection: 'video-only' },
      },
    })
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce()
  })

  test('audio-only confirmation re-probes and skips the source FPS decision', async () => {
    const fixture = makeFixture()
    const initial = limitedPartialProbe(
      makeAsset({
        objectUrl: 'blob:limited-audio-initial',
        frameRate: F60,
        durationMicroseconds: 8_000_000,
      }),
      'audio-only',
      4_000_000,
      8_000_000,
    )
    const confirmed = limitedPartialProbe(
      makeAsset({
        objectUrl: 'blob:limited-audio-confirmed',
        frameRate: F60,
        durationMicroseconds: 8_000_000,
      }),
      'audio-only',
      4_000_000,
      8_000_000,
    )
    fixture.inspect.mockReset()
    fixture.inspect
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(confirmed)

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'limited',
    })
    const result = acceptPartialMediaImport(
      'asset-new',
      'audio-only',
      fixture.deps,
    )
    await Promise.resolve()
    expect(useMediaImportStore.getState().phase).not.toBe('awaiting-decision')
    await expect(result).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })

    expect(fixture.inspect).toHaveBeenCalledTimes(2)
    expect(fixture.replaceDocument).not.toHaveBeenCalled()
    expect(fixture.reconformAssets).not.toHaveBeenCalled()
    expect(fixture.assets.get('asset-new')).toMatchObject({
      objectUrl: 'blob:limited-audio-confirmed',
      kind: 'audio',
      partialTrackSelection: 'audio-only',
      durationMicroseconds: 4_000_000,
      durationFrames: 120,
      frameRate: null,
      width: null,
      height: null,
      hasAudio: true,
      decoderConfigB64: null,
    })
    expect(fixture.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith(
      'blob:limited-audio-initial',
    )
  })

  test('rejects a stale visible partial choice without re-probing', async () => {
    const fixture = makeFixture()
    const initial = limitedPartialProbe(
      makeAsset({ objectUrl: 'blob:stale-visible' }),
      'video-only',
      2_000_000,
      2_000_000,
    )
    fixture.inspect.mockReset()
    fixture.inspect.mockResolvedValueOnce(initial)

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'limited',
    })
    const row = fixture.compatibility.get('asset-new')
    if (!row) throw new Error('Limited fixture row missing')
    fixture.compatibility.set('asset-new', { ...row, status: 'unsupported' })

    await expect(
      acceptPartialMediaImport('asset-new', 'video-only', fixture.deps),
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('no longer available'),
      itemId: 'asset-new',
    })
    expect(fixture.inspect).toHaveBeenCalledOnce()
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      'blob:stale-visible',
    )
  })

  test('fails and revokes when the confirmed choice disappears on re-probe', async () => {
    const fixture = makeFixture()
    const initial = limitedPartialProbe(
      makeAsset({ objectUrl: 'blob:stale-reprobe-initial' }),
      'video-only',
      2_000_000,
      2_000_000,
    )
    const changed = limitedPartialProbe(
      makeAsset({ objectUrl: 'blob:stale-reprobe-candidate' }),
      'audio-only',
      2_000_000,
      2_000_000,
    )
    fixture.inspect.mockReset()
    fixture.inspect
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed)

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'limited',
    })
    await expect(
      acceptPartialMediaImport('asset-new', 'video-only', fixture.deps),
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('no longer available'),
    })

    expect(fixture.inspect).toHaveBeenCalledTimes(2)
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(fixture.revokeObjectURL).toHaveBeenNthCalledWith(
      1,
      'blob:stale-reprobe-initial',
    )
    expect(fixture.revokeObjectURL).toHaveBeenNthCalledWith(
      2,
      'blob:stale-reprobe-candidate',
    )
  })

  test('partial FPS cancel restores the Limited row and retained confirmation', async () => {
    const fixture = makeFixture()
    const initial = limitedPartialProbe(
      makeAsset({
        objectUrl: 'blob:partial-cancel-initial',
        frameRate: F60,
      }),
      'video-only',
      2_000_000,
      2_000_000,
    )
    const prompted = limitedPartialProbe(
      makeAsset({
        objectUrl: 'blob:partial-cancel-prompted',
        frameRate: F60,
      }),
      'video-only',
      2_000_000,
      2_000_000,
    )
    const retried = limitedPartialProbe(
      makeAsset({
        objectUrl: 'blob:partial-cancel-retry',
        frameRate: F30,
      }),
      'video-only',
      2_000_000,
      2_000_000,
    )
    fixture.inspect.mockReset()
    fixture.inspect
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(prompted)
      .mockResolvedValueOnce(retried)

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'limited',
    })
    const confirmation = acceptPartialMediaImport(
      'asset-new',
      'video-only',
      fixture.deps,
    )
    await waitForImportPhase('awaiting-decision')
    expect(fixture.assets).toHaveLength(0)

    expect(cancelMediaImport()).toBe(true)
    await expect(confirmation).resolves.toEqual({ status: 'cancelled' })
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'limited',
      report: initial.compatibility,
    })
    expect(fixture.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(fixture.revokeObjectURL).toHaveBeenNthCalledWith(
      1,
      'blob:partial-cancel-initial',
    )
    expect(fixture.revokeObjectURL).toHaveBeenNthCalledWith(
      2,
      'blob:partial-cancel-prompted',
    )

    await expect(
      acceptPartialMediaImport('asset-new', 'video-only', fixture.deps),
    ).resolves.toEqual({ status: 'imported', assetId: 'asset-new' })
    expect(fixture.inspect).toHaveBeenCalledTimes(3)
    expect(fixture.assets.get('asset-new')).toMatchObject({
      objectUrl: 'blob:partial-cancel-retry',
      partialTrackSelection: 'video-only',
    })
    expect(fixture.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  test('typed probe errors stay visible with their exact detail', async () => {
    const fixture = makeFixture()
    const compatibility = makeCompatibility('error', {
      reason: 'malformed-media',
      detail: 'The media duration is missing or invalid.',
    })
    fixture.inspect.mockResolvedValueOnce({
      status: 'error',
      asset: null,
      compatibility,
    })

    await expect(importMedia(file(), fixture.deps)).resolves.toEqual({
      status: 'failed',
      message: 'The media duration is missing or invalid.',
      itemId: 'asset-new',
    })

    expect(fixture.assets).toHaveLength(0)
    expect(fixture.compatibility.get('asset-new')).toMatchObject({
      status: 'error',
      report: compatibility,
    })
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('retry runs only on explicit action and can promote a row to ready', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30 }))
    const unsupported = makeCompatibility('unsupported')
    fixture.inspect
      .mockResolvedValueOnce({
        status: 'unsupported',
        asset: null,
        compatibility: unsupported,
      })
      .mockResolvedValueOnce(readyProbe(makeAsset({ frameRate: F30 })))

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'unsupported',
    })
    expect(fixture.inspect).toHaveBeenCalledOnce()

    await expect(retryMediaCompatibility('asset-new')).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })
    expect(fixture.inspect).toHaveBeenCalledTimes(2)
    expect(fixture.assets.has('asset-new')).toBe(true)
    expect(fixture.compatibility.get('asset-new')?.status).toBe('ready')
  })

  test('retry preserves a selected file handle and remembers it after commit', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30 }))
    const selected = file()
    const handle = {
      kind: 'file',
      name: selected.name,
      getFile: vi.fn(async () => selected),
    } as unknown as LocalMediaFileHandle
    fixture.inspect
      .mockResolvedValueOnce({
        status: 'unsupported',
        asset: null,
        compatibility: makeCompatibility('unsupported'),
      })
      .mockResolvedValueOnce(readyProbe(makeAsset({ frameRate: F30 })))

    await expect(
      importMediaFromHandle(selected, handle, fixture.deps),
    ).resolves.toMatchObject({ status: 'unsupported' })
    expect(fixture.rememberMediaHandle).not.toHaveBeenCalled()

    await expect(retryMediaCompatibility('asset-new')).resolves.toEqual({
      status: 'imported',
      assetId: 'asset-new',
    })
    expect(fixture.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-import',
      'asset-new',
      handle,
    )
  })

  test('removing a checking row aborts and late work cannot resurrect it', async () => {
    const pending = deferred<MediaProbeResult>()
    const fixture = makeFixture()
    const inspect = vi.fn((
      _file: File,
      _rate: FrameRate,
      _assetId: string,
      _signal: AbortSignal,
    ) => pending.promise)
    fixture.deps.inspect = inspect
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('analyzing')

    expect(fixture.compatibility.get('asset-new')?.status).toBe('checking')
    const signal = inspect.mock.calls[0]?.[3]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(removeMediaCompatibility('asset-new')).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(useMediaImportStore.getState().phase).toBe('cancelling')
    pending.resolve(readyProbe(makeAsset()))

    await expect(result).resolves.toEqual({ status: 'cancelled' })
    expect(fixture.compatibility.has('asset-new')).toBe(false)
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
    expect(useMediaImportStore.getState().phase).toBe('idle')
  })

  test('project replacement during analysis rejects the stale import', async () => {
    const pending = deferred<MediaProbeResult>()
    const fixture = makeFixture()
    fixture.deps.inspect = vi.fn(() => pending.promise)
    const result = importMedia(file(), fixture.deps)
    fixture.setDocument({ ...fixture.currentDocument(), id: 'another-doc' })
    pending.resolve(readyProbe(makeAsset()))

    await expect(result).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('active project changed'),
    })
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
  })

  test('settings change while the prompt is open rejects the stale choice', async () => {
    const fixture = makeFixture()
    const result = importMedia(file(), fixture.deps)
    await waitForImportPhase('awaiting-decision')
    fixture.setDocument({ ...fixture.currentDocument(), frameRate: F24 })

    expect(resolveMediaImportDecision('keep-project-rate')).toBe(true)
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('project settings changed'),
    })
    expect(fixture.assets).toHaveLength(0)
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith('blob:source')
  })

  test('duplicate asset ids fail without transferring URL ownership', async () => {
    const fixture = makeFixture(makeAsset({ frameRate: F30 }))
    fixture.assets.set('asset-new', makeAsset({
      frameRate: F30,
      objectUrl: 'blob:existing',
    }))

    await expect(importMedia(file(), fixture.deps)).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('already in use'),
    })
    expect(fixture.assets.get('asset-new')?.objectUrl).toBe('blob:existing')
    expect(fixture.inspect).not.toHaveBeenCalled()
    expect(fixture.revokeObjectURL).not.toHaveBeenCalled()
  })
})
