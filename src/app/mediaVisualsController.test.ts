/**
 * app/mediaVisualsController.test.ts — the media-pool → visuals wiring,
 * driven with fake generators (the real ones need WebCodecs; they are
 * browser-verified with the UI).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaAsset, TimelineDoc } from '../domain/schema'
import {
  MediaVisualDecodeError,
  MediaVisualSourceError,
} from '../pipeline/visuals'
import { StaticImageThumbnailError } from '../pipeline/static-image-thumbnail'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { resetMediaCompatibilityController } from './mediaCompatibilityController'
import type { VisualsDeps } from './mediaVisualsController'
import {
  disposeMediaVisuals,
  getMediaVisualSchedulerSnapshot,
  initMediaVisuals,
  mediaVisualPriorityForAsset,
  setMediaVisualTimelineViewport,
  waitForMediaVisualsIdle,
} from './mediaVisualsController'

let urlCounter = 0
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  urlCounter = 0
  assetCounter = 0
  resetMediaCompatibilityController()
  URL.createObjectURL = vi.fn(
    () => `blob:mock-${++urlCounter}`,
  ) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
})

afterEach(() => {
  disposeMediaVisuals()
  warnSpy.mockRestore()
})

const strip = { url: 'blob:strip', tiles: 4, tileWidth: 78, tileHeight: 44 }
const imageTile = {
  url: 'blob:image-tile',
  tiles: 1,
  tileWidth: 80,
  tileHeight: 44,
}
const wave = { url: 'blob:wave', width: 800, height: 44 }

function fakeDeps(over: Partial<VisualsDeps> = {}): VisualsDeps {
  return {
    fetchBlob: vi.fn(async () => new Blob(['x'])),
    generateFilmstrip: vi.fn(async () => strip),
    generateWaveform: vi.fn(async () => wave),
    generateStaticImageThumbnail: vi.fn(async () => imageTile),
    ...over,
  }
}

let assetCounter = 0

const addAsset = (
  name: string,
  type: string,
  overrides: Partial<MediaAsset> = {},
): MediaAsset => {
  const kind = type.startsWith('video/')
    ? 'video'
    : type.startsWith('audio/')
      ? 'audio'
      : 'image'
  const asset: MediaAsset = {
    id: `asset-${++assetCounter}`,
    fileName: name,
    mimeType: type,
    size: 1,
    lastModified: 1,
    objectUrl: `blob:${name}`,
    kind,
    durationFrames: 60,
    durationMicroseconds: 2_000_000,
    sourceBounds: kind === 'image'
      ? { video: null, audio: null }
      : {
          video: kind === 'video'
            ? { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 }
            : null,
          audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
        },
    frameRate: kind === 'video' ? { num: 30, den: 1 } : null,
    width: kind === 'audio' ? null : 1920,
    height: kind === 'audio' ? null : 1080,
    hasAudio: kind !== 'image',
    audioSampleRate: kind !== 'image' ? 48_000 : null,
    audioChannels: kind !== 'image' ? 2 : null,
    decoderConfigB64: kind === 'video' ? '{"codec":"avc1.64042a"}' : null,
    ...overrides,
  }
  expect(useMediaStore.getState().addAsset(asset)).toBe(true)
  return asset
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('mediaVisualsController', () => {
  test('a video asset gets BOTH generators and its visuals stored once', async () => {
    const deps = fakeDeps()
    initMediaVisuals(deps)
    const a = addAsset('a.mp4', 'video/mp4')
    await flush()

    expect(deps.generateFilmstrip).toHaveBeenCalledTimes(1)
    expect(deps.generateWaveform).toHaveBeenCalledTimes(1)
    expect(deps.generateFilmstrip).toHaveBeenCalledWith(
      expect.any(Blob),
      {
        sourceId: a.id,
        signal: expect.any(AbortSignal),
        budget: {
          fileBytes: 1,
          durationMicroseconds: 2_000_000,
          width: 1920,
          height: 1080,
          framesPerSecond: 30,
          sampleRate: 48_000,
          channels: 2,
        },
      },
    )
    expect(deps.generateWaveform).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        sourceId: a.id,
        budget: expect.objectContaining({
          fileBytes: 1,
          durationMicroseconds: 2_000_000,
          sampleRate: 48_000,
          channels: 2,
        }),
      }),
    )
    expect(useMediaStore.getState().visuals.get(a.id)).toEqual({
      filmstrip: strip,
      waveform: wave,
    })

    // Another pool change must NOT re-process the finished asset.
    addAsset('b.mp3', 'audio/mpeg')
    await flush()
    expect(deps.generateFilmstrip).toHaveBeenCalledTimes(1)
    expect(deps.generateWaveform).toHaveBeenCalledTimes(2) // b only
  })

  test('audio gets a waveform while an image gets exactly one thumbnail tile', async () => {
    const deps = fakeDeps()
    initMediaVisuals(deps)
    const audio = addAsset('song.mp3', 'audio/mpeg')
    const image = addAsset('photo.png', 'image/png')
    await flush()

    expect(deps.generateFilmstrip).not.toHaveBeenCalled()
    expect(deps.generateWaveform).toHaveBeenCalledTimes(1)
    expect(deps.generateStaticImageThumbnail).toHaveBeenCalledOnce()
    expect(deps.generateStaticImageThumbnail).toHaveBeenCalledWith(
      expect.any(Blob),
      { signal: expect.any(AbortSignal) },
    )
    expect(deps.fetchBlob).toHaveBeenCalledTimes(2)
    expect(useMediaStore.getState().visuals.get(audio.id)).toEqual({
      filmstrip: null,
      waveform: wave,
    })
    expect(useMediaStore.getState().visuals.get(image.id)).toEqual({
      filmstrip: imageTile,
      waveform: null,
    })
  })

  test('partial imports generate visuals only for the retained track kind', async () => {
    const deps = fakeDeps()
    initMediaVisuals(deps)
    const videoOnly = addAsset('picture-only.mp4', 'video/mp4', {
      partialTrackSelection: 'video-only',
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    })
    const audioOnly = addAsset('sound-only.mp4', 'audio/mp4', {
      partialTrackSelection: 'audio-only',
    })
    await flush()

    expect(deps.fetchBlob).toHaveBeenCalledTimes(2)
    expect(deps.generateFilmstrip).toHaveBeenCalledOnce()
    expect(deps.generateWaveform).toHaveBeenCalledOnce()
    expect(useMediaStore.getState().visuals.get(videoOnly.id)).toEqual({
      filmstrip: strip,
      waveform: null,
    })
    expect(useMediaStore.getState().visuals.get(audioOnly.id)).toEqual({
      filmstrip: null,
      waveform: wave,
    })
  })

  test('assets present BEFORE init are picked up by the initial scan', async () => {
    const a = addAsset('early.mp4', 'video/mp4')
    const deps = fakeDeps()
    initMediaVisuals(deps)
    await flush()
    expect(useMediaStore.getState().visuals.has(a.id)).toBe(true)
  })

  test('a waveform failure revokes its successful sibling and disconnects the source', async () => {
    const deps = fakeDeps({
      generateWaveform: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    initMediaVisuals(deps)
    const a = addAsset('bad.mp4', 'video/mp4')
    await flush()

    expect(warnSpy).toHaveBeenCalled()
    expect(useMediaStore.getState().visuals.has(a.id)).toBe(false)
    expect(useMediaStore.getState().assets.has(a.id)).toBe(false)
    expect(useMediaStore.getState().descriptors.has(a.id)).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(strip.url)
    expect(useMediaStore.getState().compatibility.get(a.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'decode-failed',
        runtimeFailures: [{
          surface: 'waveform',
          trackKind: 'audio',
          reason: 'decode-failed',
          detail: 'boom',
        }],
      },
    })

    // No retry storm: the next pool change leaves the failure alone.
    addAsset('ok.mp3', 'audio/mpeg')
    await flush()
    expect(deps.generateFilmstrip).toHaveBeenCalledTimes(1)
  })

  test('a filmstrip failure is reported against the video track', async () => {
    const deps = fakeDeps({
      generateFilmstrip: vi.fn(async () => {
        throw new Error('thumbnail decode failed')
      }),
    })
    initMediaVisuals(deps)
    const asset = addAsset('bad-video.mp4', 'video/mp4')
    await flush()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(wave.url)
    expect(useMediaStore.getState().compatibility.get(asset.id)).toMatchObject({
      status: 'error',
      report: {
        runtimeFailures: [{
          surface: 'filmstrip',
          trackKind: 'video',
          reason: 'decode-failed',
          detail: 'thumbnail decode failed',
        }],
      },
    })
  })

  test('a filmstrip budget rejection stays an exact resource limit', async () => {
    const deps = fakeDeps({
      generateFilmstrip: vi.fn(async () => {
        throw new MediaVisualDecodeError({
          reason: 'resource-limit',
          detail: 'Local ProRes safety budget is incomplete.',
        })
      }),
    })
    initMediaVisuals(deps)
    const asset = addAsset('large-prores.mov', 'video/quicktime')
    await flush()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(wave.url)
    expect(useMediaStore.getState().compatibility.get(asset.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'resource-limit',
        runtimeFailures: [{
          surface: 'filmstrip',
          trackKind: 'video',
          reason: 'resource-limit',
          detail: 'Local ProRes safety budget is incomplete.',
        }],
      },
    })
  })

  test('an image-thumbnail budget rejection is asset-scoped without blaming a video track', async () => {
    const deps = fakeDeps({
      generateStaticImageThumbnail: vi.fn(async () => {
        throw new StaticImageThumbnailError(
          'resource-limit',
          'The still-image thumbnail is too large.',
        )
      }),
    })
    initMediaVisuals(deps)
    const asset = addAsset('large.png', 'image/png')
    await flush()

    expect(useMediaStore.getState().compatibility.get(asset.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'resource-limit',
        runtimeFailures: [{
          surface: 'filmstrip',
          trackKind: null,
          reason: 'resource-limit',
          detail: 'The still-image thumbnail is too large.',
        }],
      },
    })
  })

  test('a source fetch failure reports the exact visuals surface as unavailable', async () => {
    const deps = fakeDeps({
      fetchBlob: vi.fn(async () => {
        throw new Error('object URL disappeared')
      }),
    })
    initMediaVisuals(deps)
    const asset = addAsset('missing.mp3', 'audio/mpeg')
    await flush()

    expect(deps.generateWaveform).not.toHaveBeenCalled()
    expect(useMediaStore.getState().compatibility.get(asset.id)).toMatchObject({
      status: 'error',
      report: {
        runtimeFailures: [{
          surface: 'waveform',
          trackKind: null,
          reason: 'resource-unavailable',
          detail: 'object URL disappeared',
        }],
      },
    })
  })

  test('a pre-track visual source failure does not blame a media track', async () => {
    const sourceFailure = new Error('Mediabunny input construction failed')
    const deps = fakeDeps({
      generateFilmstrip: vi.fn(async () => {
        throw new MediaVisualSourceError(sourceFailure)
      }),
    })
    initMediaVisuals(deps)
    const asset = addAsset('source-error.mp4', 'video/mp4')
    await flush()

    expect(useMediaStore.getState().compatibility.get(asset.id)).toMatchObject({
      status: 'error',
      report: {
        runtimeFailures: [{
          surface: 'filmstrip',
          trackKind: null,
          reason: 'resource-unavailable',
          detail: sourceFailure.message,
        }],
      },
    })
  })

  test('an asset removed mid-generation never lands in the store', async () => {
    let releaseBlob: (b: Blob) => void = () => {}
    const gate = new Promise<Blob>((r) => (releaseBlob = r))
    const deps = fakeDeps({ fetchBlob: vi.fn(() => gate) })
    initMediaVisuals(deps)
    const a = addAsset('gone.mp4', 'video/mp4')

    useMediaStore.getState().removeAsset(a.id)
    releaseBlob(new Blob(['x']))
    await flush()

    expect(useMediaStore.getState().visuals.size).toBe(0)
    expect(deps.generateFilmstrip).not.toHaveBeenCalled()
    expect(deps.generateWaveform).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:strip')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:wave')
  })

  test('dispose invalidates an old result even when the next project reuses its id', async () => {
    let releaseBlob: (blob: Blob) => void = () => {}
    const gate = new Promise<Blob>((resolve) => (releaseBlob = resolve))
    const deps = fakeDeps({ fetchBlob: vi.fn(() => gate) })
    initMediaVisuals(deps)
    addAsset('old.mp4', 'video/mp4')

    disposeMediaVisuals()
    useMediaStore.setState({
      descriptors: new Map(),
      assets: new Map(),
      visuals: new Map(),
      compatibility: new Map(),
    })
    assetCounter = 0
    const replacement = addAsset('replacement.mp4', 'video/mp4')
    expect(replacement.id).toBe('asset-1')

    releaseBlob(new Blob(['x']))
    await flush()

    expect(useMediaStore.getState().visuals.size).toBe(0)
    expect(deps.generateFilmstrip).not.toHaveBeenCalled()
    expect(deps.generateWaveform).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:strip')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:wave')
  })

  test('init is idempotent (StrictMode): one subscription, one pass', async () => {
    const deps = fakeDeps()
    initMediaVisuals(deps)
    initMediaVisuals(deps)
    addAsset('a.mp4', 'video/mp4')
    await flush()
    expect(deps.generateFilmstrip).toHaveBeenCalledTimes(1)
  })

  test('bounds bulk A/V analysis to the two-decoder budget and exposes queue evidence', async () => {
    let releaseStrip: (result: typeof strip) => void = () => {}
    let releaseWave: (result: typeof wave) => void = () => {}
    const stripGate = new Promise<typeof strip>((resolve) => (releaseStrip = resolve))
    const waveGate = new Promise<typeof wave>((resolve) => (releaseWave = resolve))
    const deps = fakeDeps({
      generateFilmstrip: vi.fn(() => stripGate),
      generateWaveform: vi.fn(() => waveGate),
    })
    initMediaVisuals(deps, { scheduler: { yieldControl: async () => {} } })
    addAsset('bulk-a.mp4', 'video/mp4')
    addAsset('bulk-b.mp4', 'video/mp4')
    addAsset('bulk-c.mp4', 'video/mp4')
    await flush()

    expect(deps.fetchBlob).toHaveBeenCalledTimes(1)
    expect(getMediaVisualSchedulerSnapshot()).toMatchObject({
      queueDepth: 2,
      activeJobCount: 1,
      activeDecoderCount: 2,
      maxQueueDepth: 3,
      maxActiveDecoderCount: 2,
    })

    const originalDocument = useDocumentStore.getState().doc
    let trackReads = 0
    const instrumentedDocument = { ...originalDocument }
    Object.defineProperty(instrumentedDocument, 'tracks', {
      enumerable: true,
      get: () => {
        trackReads += 1
        return originalDocument.tracks
      },
    })
    try {
      useDocumentStore.setState({ doc: instrumentedDocument })
      trackReads = 0
      setMediaVisualTimelineViewport({ startFrame: 10, endFrame: 20 })
      expect(trackReads).toBe(1)
    } finally {
      useDocumentStore.setState({ doc: originalDocument })
    }

    releaseStrip(strip)
    releaseWave(wave)
    const evidence = await waitForMediaVisualsIdle()
    expect(evidence).toMatchObject({
      queueDepth: 0,
      activeJobCount: 0,
      activeDecoderCount: 0,
      enqueuedCount: 3,
      completedCount: 3,
      cancelledCount: 0,
      failedCount: 0,
      maxActiveDecoderCount: 2,
    })
    expect(evidence?.waitTimesMs).toHaveLength(3)
    expect(useMediaStore.getState().visuals.size).toBe(3)
  })

  test('removal aborts active analysis and revokes every late sibling URL', async () => {
    let releaseStrip: (result: typeof strip) => void = () => {}
    let releaseWave: (result: typeof wave) => void = () => {}
    const stripGate = new Promise<typeof strip>((resolve) => (releaseStrip = resolve))
    const waveGate = new Promise<typeof wave>((resolve) => (releaseWave = resolve))
    const deps = fakeDeps({
      generateFilmstrip: vi.fn(() => stripGate),
      generateWaveform: vi.fn(() => waveGate),
    })
    initMediaVisuals(deps, { scheduler: { yieldControl: async () => {} } })
    const asset = addAsset('remove-active.mp4', 'video/mp4')
    await flush()
    expect(getMediaVisualSchedulerSnapshot()?.activeDecoderCount).toBe(2)

    useMediaStore.getState().removeAsset(asset.id)
    const idle = waitForMediaVisualsIdle()
    releaseStrip(strip)
    releaseWave(wave)
    const evidence = await idle

    expect(evidence).toMatchObject({
      completedCount: 0,
      cancelledCount: 1,
      failedCount: 0,
      activeDecoderCount: 0,
    })
    expect(useMediaStore.getState().visuals.has(asset.id)).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(strip.url)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(wave.url)
  })

  test('replacement cancels the old generation without deleting the new record', async () => {
    let oldAborted = false
    const deps = fakeDeps({
      fetchBlob: vi.fn((url: string, signal: AbortSignal) => {
        if (url !== 'blob:old.mp4') return Promise.resolve(new Blob(['new']))
        return new Promise<Blob>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            oldAborted = true
            const error = new Error('old source cancelled')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      }),
    })
    initMediaVisuals(deps, { scheduler: { yieldControl: async () => {} } })
    const old = addAsset('old.mp4', 'video/mp4')
    await flush()

    const replacement: MediaAsset = {
      ...old,
      fileName: 'new.mp4',
      objectUrl: 'blob:new.mp4',
    }
    useMediaStore.setState((current) => ({
      assets: new Map(current.assets).set(old.id, replacement),
    }))
    const evidence = await waitForMediaVisualsIdle()

    expect(oldAborted).toBe(true)
    expect(deps.fetchBlob).toHaveBeenCalledWith('blob:new.mp4', expect.any(AbortSignal))
    expect(useMediaStore.getState().visuals.get(old.id)).toEqual({
      filmstrip: strip,
      waveform: wave,
    })
    expect(evidence).toMatchObject({
      enqueuedCount: 2,
      completedCount: 1,
      cancelledCount: 1,
      failedCount: 0,
    })
  })

  test('does not rescan completed assets when timeline priority changes', async () => {
    const originalDocument = useDocumentStore.getState().doc
    initMediaVisuals(fakeDeps(), { scheduler: { yieldControl: async () => {} } })
    addAsset('completed.mp4', 'video/mp4')
    await waitForMediaVisualsIdle()

    let trackReads = 0
    const instrumentedDocument = { ...originalDocument }
    Object.defineProperty(instrumentedDocument, 'tracks', {
      enumerable: true,
      get: () => {
        trackReads += 1
        return originalDocument.tracks
      },
    })
    try {
      useDocumentStore.setState({ doc: instrumentedDocument })
      setMediaVisualTimelineViewport({ startFrame: 10, endFrame: 20 })

      expect(trackReads).toBe(0)
    } finally {
      useDocumentStore.setState({ doc: originalDocument })
    }
  })

  test('derives selected, visible, and background priority from current timeline facts', () => {
    const document = {
      tracks: [{
        clips: [
          {
            id: 'visible-clip',
            assetId: 'visible-asset',
            timelineRange: { startFrame: 100, durationFrames: 50 },
          },
          {
            id: 'selected-clip',
            assetId: 'selected-asset',
            timelineRange: { startFrame: 1_000, durationFrames: 50 },
          },
        ],
      }],
    } as unknown as TimelineDoc
    const viewport = { startFrame: 120, endFrame: 140 }

    expect(mediaVisualPriorityForAsset(
      'selected-asset',
      document,
      'selected-clip',
      viewport,
    )).toBe('selected')
    expect(mediaVisualPriorityForAsset(
      'visible-asset',
      document,
      'selected-clip',
      viewport,
    )).toBe('visible')
    expect(mediaVisualPriorityForAsset(
      'background-asset',
      document,
      'selected-clip',
      viewport,
    )).toBe('background')
    expect(mediaVisualPriorityForAsset(
      'visible-asset',
      document,
      null,
      { startFrame: 150, endFrame: 200 },
    )).toBe('background')
  })
})
