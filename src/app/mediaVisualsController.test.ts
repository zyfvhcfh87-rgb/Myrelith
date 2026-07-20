/**
 * app/mediaVisualsController.test.ts — the media-pool → visuals wiring,
 * driven with fake generators (the real ones need WebCodecs; they are
 * browser-verified with the UI).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MediaAsset } from '../domain/schema'
import { MediaVisualSourceError } from '../pipeline/visuals'
import { useMediaStore } from '../state/mediaStore'
import { resetMediaCompatibilityController } from './mediaCompatibilityController'
import type { VisualsDeps } from './mediaVisualsController'
import { disposeMediaVisuals, initMediaVisuals } from './mediaVisualsController'

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
const wave = { url: 'blob:wave', width: 800, height: 44 }

function fakeDeps(over: Partial<VisualsDeps> = {}): VisualsDeps {
  return {
    fetchBlob: vi.fn(async () => new Blob(['x'])),
    generateFilmstrip: vi.fn(async () => strip),
    generateWaveform: vi.fn(async () => wave),
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
      a.id,
    )
    expect(deps.generateWaveform).toHaveBeenCalledWith(
      expect.any(Blob),
      a.id,
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

  test('audio assets skip the filmstrip; image assets skip everything', async () => {
    const deps = fakeDeps()
    initMediaVisuals(deps)
    addAsset('song.mp3', 'audio/mpeg')
    addAsset('photo.png', 'image/png')
    await flush()

    expect(deps.generateFilmstrip).not.toHaveBeenCalled()
    expect(deps.generateWaveform).toHaveBeenCalledTimes(1)
    expect(deps.fetchBlob).toHaveBeenCalledTimes(1) // image never fetched
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
})
