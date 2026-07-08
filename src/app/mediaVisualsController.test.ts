/**
 * app/mediaVisualsController.test.ts — the media-pool → visuals wiring,
 * driven with fake generators (the real ones need WebCodecs; they are
 * browser-verified with the UI).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useMediaStore } from '../state/mediaStore'
import type { VisualsDeps } from './mediaVisualsController'
import { disposeMediaVisuals, initMediaVisuals } from './mediaVisualsController'

let urlCounter = 0
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  urlCounter = 0
  URL.createObjectURL = vi.fn(
    () => `blob:mock-${++urlCounter}`,
  ) as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  useMediaStore.setState({ assets: new Map(), visuals: new Map() })
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

const addAsset = (name: string, type: string) =>
  useMediaStore.getState().addAsset(new File(['x'], name, { type }))

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('mediaVisualsController', () => {
  test('a video asset gets BOTH generators and its visuals stored once', async () => {
    const deps = fakeDeps()
    initMediaVisuals(deps)
    const a = addAsset('a.mp4', 'video/mp4')
    await flush()

    expect(deps.generateFilmstrip).toHaveBeenCalledTimes(1)
    expect(deps.generateWaveform).toHaveBeenCalledTimes(1)
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

  test('assets present BEFORE init are picked up by the initial scan', async () => {
    const a = addAsset('early.mp4', 'video/mp4')
    const deps = fakeDeps()
    initMediaVisuals(deps)
    await flush()
    expect(useMediaStore.getState().visuals.has(a.id)).toBe(true)
  })

  test('a failing generator warns and leaves the asset visuals-less', async () => {
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

    // No retry storm: the next pool change leaves the failure alone.
    addAsset('ok.mp3', 'audio/mpeg')
    await flush()
    expect(deps.generateFilmstrip).toHaveBeenCalledTimes(1)
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
    // The late result's URLs were revoked by the store guard.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:strip')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:wave')
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
