/**
 * app/previewController.test.ts — Phase 3.4, reworked for the 4.1c
 * compositor swap. Drives the composition root with injected fakes (no
 * Worker, no OffscreenCanvas, no fetch) and asserts the wiring: every
 * video asset reaches the bridge, docs are forwarded, playhead moves
 * render doc frames/modes rAF-coalesced, removals release worker sources.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import type { RenderFrameResult } from '../engine/render-bridge'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import type { RenderMode } from '../workers/render-protocol'
import type { BridgeLike, PreviewDeps } from './previewController'
import { disposePreview, initPreview } from './previewController'

const F60: FrameRate = { num: 60, den: 1 }

class FakeBridge implements BridgeLike {
  onWorkerError: ((message: string) => void) | null = null
  onAssetReady: ((assetId: string) => void) | null = null
  docs: TimelineDoc[] = []
  opened: Array<{ assetId: string; blob: Blob; rate: FrameRate }> = []
  released: string[] = []
  rendered: Array<{ frame: number; mode: RenderMode }> = []
  disposed = false
  openImpl: (assetId: string, blob: Blob, rate: FrameRate) => Promise<void> =
    async () => {}

  setDoc(doc: TimelineDoc): void {
    this.docs.push(doc)
  }
  async openAsset(assetId: string, blob: Blob, rate: FrameRate): Promise<void> {
    this.opened.push({ assetId, blob, rate })
    await this.openImpl(assetId, blob, rate)
    this.onAssetReady?.(assetId) // like the real bridge's assetConfigured ack
  }
  releaseAsset(assetId: string): void {
    this.released.push(assetId)
  }
  async renderFrame(frame: number, mode: RenderMode): Promise<RenderFrameResult> {
    this.rendered.push({ frame, mode })
    return { status: 'drawn', drawnClipIds: [], missingClipIds: [], renderMs: 1 }
  }
  dispose(): void {
    this.disposed = true
  }
}

function makeDeps() {
  const bridge = new FakeBridge()
  const blob = new Blob(['x'], { type: 'video/mp4' })
  const demuxedAsset: MediaAsset = {
    id: 'ignored',
    fileName: 'clip.mp4',
    mimeType: 'video/demux-temporary',
    size: 999,
    lastModified: 999,
    objectUrl: 'blob:demuxed',
    kind: 'video',
    durationFrames: 206,
    durationMicroseconds: 6_866_667,
    frameRate: F60,
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"avc1.64042a"}',
  }
  const deps: PreviewDeps = {
    createBridge: () => bridge,
    transferCanvas: () => ({}) as OffscreenCanvas,
    init: vi.fn(),
    fetchBlob: async () => blob,
    demux: async () => ({ asset: demuxedAsset }),
  }
  return { deps, bridge, blob, demuxedAsset }
}

const canvasEl = () => document.createElement('canvas')
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const initialDoc = useDocumentStore.getState().doc

beforeEach(() => {
  useDocumentStore.getState().setDoc(initialDoc)
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
  })
  useMediaStore.setState({ assets: new Map() })
  URL.createObjectURL = vi.fn(() => 'blob:mock') as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
})

afterEach(() => {
  disposePreview()
})

describe('previewController', () => {
  test('importing a video inspects metadata and opens its original Blob once', async () => {
    const { deps, bridge, blob } = makeDeps()
    const demux = vi.fn(deps.demux)
    initPreview(canvasEl(), { ...deps, demux })
    // The doc reached the worker before any composite could reference it.
    expect(bridge.docs).toEqual([initialDoc])

    const placeholder = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'clip.mp4', {
        type: 'video/mp4',
        lastModified: 1_725_000_000_002,
      }))
    await flush()

    expect(demux).toHaveBeenCalledWith(expect.any(File), initialDoc.frameRate)

    // Opened under the STORE's asset id with the fetched Blob itself. The
    // bridge structured-clones this once; no encoded chunk batches exist.
    expect(bridge.opened).toEqual([{ assetId: placeholder.id, blob, rate: F60 }])
    // Real metadata merged onto the placeholder row.
    const updated = useMediaStore.getState().assets.get(placeholder.id)
    expect(updated).toMatchObject({
      mimeType: 'video/mp4',
      size: 1,
      lastModified: 1_725_000_000_002,
      durationFrames: 206,
      durationMicroseconds: 6_866_667,
      frameRate: F60,
      width: 1920,
    })
    // First frame rendered after init+load (coalesced into one rAF).
    await nextFrame()
    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('reconforms duration if the project rate changes while demux is pending', async () => {
    const { deps, demuxedAsset } = makeDeps()
    const pending = deferred<{ asset: MediaAsset }>()
    initPreview(canvasEl(), { ...deps, demux: () => pending.promise })

    const placeholder = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    await flush()

    useDocumentStore.getState().setDoc({
      ...initialDoc,
      id: 'retimed-project',
      frameRate: F60,
    })
    pending.resolve({ asset: demuxedAsset })
    await flush()

    expect(useMediaStore.getState().assets.get(placeholder.id)).toMatchObject({
      durationFrames: 412,
      durationMicroseconds: 6_866_667,
    })
  })

  test('EVERY video asset gets its own worker source, not just the newest', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)

    const one = useMediaStore.getState().addAsset(new File(['x'], 'one.mp4', { type: 'video/mp4' }))
    const two = useMediaStore.getState().addAsset(new File(['x'], 'two.mp4', { type: 'video/mp4' }))
    await flush()

    expect(bridge.opened.map((entry) => entry.assetId).sort()).toEqual(
      [one.id, two.id].sort(),
    )
  })

  test('scrubbing renders rAF-coalesced DOC frames (bridge owns rescaling)', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    useMediaStore.getState().addAsset(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    await flush()
    await nextFrame()
    bridge.rendered.length = 0

    // Three rapid moves inside one frame collapse to the last one — and
    // the frame stays in DOCUMENT frames (no asset rescale up here).
    const t = useTransportStore.getState()
    t.setIsScrubbing(true)
    t.setPlayheadFrame(10)
    t.setPlayheadFrame(20)
    t.setPlayheadFrame(30)
    await nextFrame()
    await flush()

    expect(bridge.rendered).toEqual([{ frame: 30, mode: 'seek' }])
  })

  test('Play primes playback mode and rapid playback ticks keep only the latest frame', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    await nextFrame()
    bridge.rendered.length = 0

    const transport = useTransportStore.getState()
    transport.setIsPlaying(true)
    await nextFrame()
    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'playback' }])

    bridge.rendered.length = 0
    transport.setPlayheadFrame(1)
    transport.setPlayheadFrame(2)
    transport.setPlayheadFrame(3)
    await nextFrame()
    expect(bridge.rendered).toEqual([{ frame: 3, mode: 'playback' }])
  })

  test('playback yields to seek during scrub and resumes when the scrub ends', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    await nextFrame()
    bridge.rendered.length = 0

    const transport = useTransportStore.getState()
    transport.setIsPlaying(true)
    await nextFrame()
    transport.setIsScrubbing(true)
    await nextFrame()
    transport.setIsScrubbing(false)
    await nextFrame()
    transport.setIsPlaying(false)
    await nextFrame()

    expect(bridge.rendered).toEqual([
      { frame: 0, mode: 'playback' },
      { frame: 0, mode: 'seek' },
      { frame: 0, mode: 'playback' },
      { frame: 0, mode: 'seek' },
    ])

    bridge.rendered.length = 0
    transport.setIsScrubbing(true)
    transport.setIsScrubbing(false)
    await nextFrame()
    expect(bridge.rendered).toEqual([])
  })

  test('mode is chosen at dispatch so pause wins over a queued Play render', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    await nextFrame()
    bridge.rendered.length = 0

    const transport = useTransportStore.getState()
    transport.setIsPlaying(true)
    transport.setIsPlaying(false)
    await nextFrame()

    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('a document change reaches the worker and repaints the playhead frame', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    await nextFrame()
    bridge.rendered.length = 0

    const changed = { ...initialDoc, name: 'edited' }
    useDocumentStore.getState().setDoc(changed)

    expect(bridge.docs).toEqual([initialDoc, changed])
    await nextFrame()
    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('a source becoming ready repaints after the initial frame already ran', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    await nextFrame()
    bridge.rendered.length = 0

    bridge.onAssetReady?.('A')
    await nextFrame()

    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('removing an asset releases its worker source', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    const placeholder = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    await flush()
    expect(bridge.opened).toHaveLength(1)

    useMediaStore.getState().removeAsset(placeholder.id)
    expect(bridge.released).toEqual([placeholder.id])
  })

  test('initPreview is idempotent per canvas (StrictMode double-mount)', () => {
    const { deps, bridge } = makeDeps()
    const canvas = canvasEl()
    initPreview(canvas, deps)
    initPreview(canvas, deps) // second mount of the same canvas: no-op
    expect(bridge.disposed).toBe(false)
    expect(vi.mocked(deps.init)).toHaveBeenCalledTimes(1)
  })

  test('a failing transfer disables the preview without crashing', () => {
    const { deps } = makeDeps()
    deps.transferCanvas = () => {
      throw new Error('OffscreenCanvas unsupported')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => initPreview(canvasEl(), deps)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('audio imports never reach the preview pipeline (filtered upstream)', async () => {
    const { deps, bridge } = makeDeps()
    const demuxSpy = vi.fn(deps.demux)
    deps.demux = demuxSpy
    initPreview(canvasEl(), deps)
    useMediaStore.getState().addAsset(new File(['x'], 'song.mp3', { type: 'audio/mpeg' }))
    await flush()
    expect(demuxSpy).not.toHaveBeenCalled()
    expect(bridge.opened).toHaveLength(0)
  })

  test('a demux failure logs, stays retriable, and leaves the preview usable', async () => {
    const { deps, bridge } = makeDeps()
    let attempts = 0
    deps.demux = async () => {
      attempts++
      throw new Error('corrupt container')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    useMediaStore.getState().addAsset(new File(['x'], 'bad.mp4', { type: 'video/mp4' }))
    await flush()
    expect(bridge.opened).toHaveLength(0)
    expect(warn).toHaveBeenCalled()

    // The failed asset is retried on the next media-pool change.
    useMediaStore.getState().addAsset(new File(['x'], 'poke.mp3', { type: 'audio/mpeg' }))
    await flush()
    expect(attempts).toBe(2)
    warn.mockRestore()
  })

  test('a worker open failure logs and retries on the next media change', async () => {
    const { deps, bridge } = makeDeps()
    let attempts = 0
    bridge.openImpl = async () => {
      attempts++
      if (attempts === 1) throw new Error('worker could not open source')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    useMediaStore.getState().addAsset(new File(['x'], 'bad.mp4', { type: 'video/mp4' }))
    await flush()

    expect(attempts).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('loading "bad.mp4" failed'),
      'worker could not open source',
    )

    useMediaStore.getState().addAsset(new File(['x'], 'poke.mp3', { type: 'audio/mpeg' }))
    await flush()
    expect(attempts).toBe(2)
    expect(bridge.opened).toHaveLength(2)
    warn.mockRestore()
  })

  test('removal during Blob fetch cancels silently before metadata inspection', async () => {
    const { deps, bridge, blob } = makeDeps()
    const fetched = deferred<Blob>()
    const demux = vi.fn(deps.demux)
    deps.fetchBlob = () => fetched.promise
    deps.demux = demux
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const asset = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'gone.mp4', { type: 'video/mp4' }))

    useMediaStore.getState().removeAsset(asset.id)
    fetched.resolve(blob)
    await flush()

    expect(bridge.released).toEqual([asset.id])
    expect(demux).not.toHaveBeenCalled()
    expect(bridge.opened).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('removal during metadata inspection cancels before opening the worker source', async () => {
    const { deps, bridge, demuxedAsset } = makeDeps()
    const inspected = deferred<{ asset: MediaAsset }>()
    deps.demux = () => inspected.promise
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const asset = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'gone.mp4', { type: 'video/mp4' }))
    await flush()

    useMediaStore.getState().removeAsset(asset.id)
    inspected.resolve({ asset: demuxedAsset })
    await flush()

    expect(bridge.released).toEqual([asset.id])
    expect(bridge.opened).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('synchronous removal during metadata update cannot reopen the asset', async () => {
    const { deps, bridge } = makeDeps()
    const unsubscribe = useMediaStore.subscribe((current, previous) => {
      for (const [id, asset] of current.assets) {
        if (asset.frameRate && !previous.assets.get(id)?.frameRate) {
          useMediaStore.getState().removeAsset(id)
        }
      }
    })
    try {
      initPreview(canvasEl(), deps)
      const asset = useMediaStore
        .getState()
        .addAsset(new File(['x'], 'gone.mp4', { type: 'video/mp4' }))
      await flush()

      expect(bridge.released).toEqual([asset.id])
      expect(bridge.opened).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  test('removal during worker open treats the late cancellation as expected', async () => {
    const { deps, bridge } = makeDeps()
    const opening = deferred<void>()
    bridge.openImpl = () => opening.promise
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const asset = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'gone.mp4', { type: 'video/mp4' }))
    await flush()
    expect(bridge.opened).toHaveLength(1)

    useMediaStore.getState().removeAsset(asset.id)
    opening.reject(new Error('asset released'))
    await flush()

    expect(bridge.released).toEqual([asset.id])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('dispose during Blob fetch prevents late metadata and worker work', async () => {
    const { deps, bridge, blob } = makeDeps()
    const fetched = deferred<Blob>()
    const demux = vi.fn(deps.demux)
    deps.fetchBlob = () => fetched.promise
    deps.demux = demux
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    useMediaStore.getState().addAsset(new File(['x'], 'late.mp4', { type: 'video/mp4' }))

    disposePreview()
    fetched.resolve(blob)
    await flush()

    expect(bridge.disposed).toBe(true)
    expect(demux).not.toHaveBeenCalled()
    expect(bridge.opened).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('a queued render from an old canvas cannot draw through a new bridge', async () => {
    const first = makeDeps()
    const second = makeDeps()

    initPreview(canvasEl(), first.deps)
    initPreview(canvasEl(), second.deps)
    await nextFrame()

    expect(first.bridge.rendered).toEqual([])
    expect(second.bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('worker diagnostics keep their controller prefix', () => {
    const { deps, bridge } = makeDeps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)

    bridge.onWorkerError?.('decode exploded')

    expect(warn).toHaveBeenCalledWith(
      '[previewController] worker error:',
      'decode exploded',
    )
    warn.mockRestore()
  })

  test('dispose unsubscribes and disposes the bridge', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    disposePreview()
    expect(bridge.disposed).toBe(true)

    // Store changes after dispose reach nothing.
    useMediaStore.getState().addAsset(new File(['x'], 'c.mp4', { type: 'video/mp4' }))
    await flush()
    expect(bridge.opened).toHaveLength(0)
  })
})
