/**
 * app/previewController.test.ts — Phase 3.4, reworked for the 4.1c
 * compositor swap. Drives the composition root with injected fakes (no
 * Worker, no OffscreenCanvas, no fetch) and asserts the wiring: every
 * video asset reaches the bridge, docs are forwarded, playhead moves
 * render doc frames rAF-coalesced, removals release worker decoders.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import type { ChunkProvider } from '../engine/worker-bridge'
import type { RenderFrameResult } from '../engine/render-bridge'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import type { BridgeLike, PreviewDeps } from './previewController'
import { disposePreview, initPreview } from './previewController'

const F60: FrameRate = { num: 60, den: 1 }

class FakeBridge implements BridgeLike {
  onWorkerError: ((message: string) => void) | null = null
  onAssetReady: ((assetId: string) => void) | null = null
  docs: TimelineDoc[] = []
  configured: Array<{ assetId: string; codec: string; rate: FrameRate }> = []
  released: string[] = []
  rendered: number[] = []
  disposed = false

  setDoc(doc: TimelineDoc): void {
    this.docs.push(doc)
  }
  async configureAsset(
    assetId: string,
    config: VideoDecoderConfig,
    rate: FrameRate,
  ): Promise<void> {
    this.configured.push({ assetId, codec: config.codec, rate })
    this.onAssetReady?.(assetId) // like the real bridge's assetConfigured ack
  }
  releaseAsset(assetId: string): void {
    this.released.push(assetId)
  }
  async renderFrame(frame: number): Promise<RenderFrameResult> {
    this.rendered.push(frame)
    return { status: 'drawn', drawnClipIds: [], missingClipIds: [], renderMs: 1 }
  }
  dispose(): void {
    this.disposed = true
  }
}

function makeDeps() {
  const bridge = new FakeBridge()
  const provider: ChunkProvider = { chunksForTimestamp: async () => [] }
  const demuxedAsset: MediaAsset = {
    id: 'ignored',
    fileName: 'clip.mp4',
    objectUrl: 'blob:demuxed',
    kind: 'video',
    durationFrames: 412,
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
    fetchBlob: async () => new Blob(['x'], { type: 'video/mp4' }),
    demux: async () => ({ asset: demuxedAsset, chunkProvider: provider }),
  }
  return { deps, bridge }
}

const canvasEl = () => document.createElement('canvas')
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

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
  test('importing a video demuxes it, configures its decoder, updates the store', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    // The doc reached the worker before any composite could reference it.
    expect(bridge.docs).toEqual([initialDoc])

    const placeholder = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    await flush()

    // Configured under the STORE's asset id (clips reference that id).
    expect(bridge.configured).toEqual([
      { assetId: placeholder.id, codec: 'avc1.64042a', rate: F60 },
    ])
    // Real metadata merged onto the placeholder row.
    const updated = useMediaStore.getState().assets.get(placeholder.id)
    expect(updated).toMatchObject({
      durationFrames: 412,
      frameRate: F60,
      width: 1920,
    })
    // First frame rendered after init+load (coalesced into one rAF).
    await nextFrame()
    expect(bridge.rendered).toEqual([0])
  })

  test('EVERY video asset gets its own decoder, not just the newest', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)

    const one = useMediaStore.getState().addAsset(new File(['x'], 'one.mp4', { type: 'video/mp4' }))
    const two = useMediaStore.getState().addAsset(new File(['x'], 'two.mp4', { type: 'video/mp4' }))
    await flush()

    expect(bridge.configured.map((c) => c.assetId).sort()).toEqual(
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
    t.setPlayheadFrame(10)
    t.setPlayheadFrame(20)
    t.setPlayheadFrame(30)
    await nextFrame()
    await flush()

    expect(bridge.rendered).toEqual([30])
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
    expect(bridge.rendered).toEqual([0])
  })

  test('removing an asset releases its worker decoder', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    const placeholder = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    await flush()
    expect(bridge.configured).toHaveLength(1)

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
    expect(bridge.configured).toHaveLength(0)
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
    expect(bridge.configured).toHaveLength(0)
    expect(warn).toHaveBeenCalled()

    // The failed asset is retried on the next media-pool change.
    useMediaStore.getState().addAsset(new File(['x'], 'poke.mp3', { type: 'audio/mpeg' }))
    await flush()
    expect(attempts).toBe(2)
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
    expect(bridge.configured).toHaveLength(0)
  })
})
