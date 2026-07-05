/**
 * app/previewController.test.ts — Phase 3.4. Drives the composition root
 * with injected fakes (no Worker, no OffscreenCanvas, no fetch).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FrameRate, MediaAsset } from '../domain/schema'
import type { ChunkProvider, RenderResult } from '../engine/worker-bridge'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import type { BridgeLike, PreviewDeps } from './previewController'
import { disposePreview, initPreview } from './previewController'

const F60: FrameRate = { num: 60, den: 1 }

class FakeBridge implements BridgeLike {
  onWorkerError: ((message: string) => void) | null = null
  configured: VideoDecoderConfig[] = []
  sources: Array<{ rate: FrameRate }> = []
  rendered: number[] = []
  disposed = false

  setSource(rate: FrameRate): void {
    this.sources.push({ rate })
  }
  async configure(config: VideoDecoderConfig): Promise<void> {
    this.configured.push(config)
  }
  async renderFrameAt(frame: number): Promise<RenderResult> {
    this.rendered.push(frame)
    return { status: 'drawn', frameTimestampUs: 0, decodeMs: 1 }
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
    demux: async () => ({
      asset: demuxedAsset,
      videoTrack: {},
      chunkProvider: provider,
    }),
  }
  return { deps, bridge }
}

const canvasEl = () => document.createElement('canvas')
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

beforeEach(() => {
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
  test('importing a video demuxes it, configures the bridge, updates the store', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)

    const placeholder = useMediaStore
      .getState()
      .addAsset(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    await flush()

    expect(bridge.configured).toHaveLength(1)
    expect(bridge.sources).toEqual([{ rate: F60 }])
    // Real metadata merged onto the placeholder row.
    const updated = useMediaStore.getState().assets.get(placeholder.id)
    expect(updated).toMatchObject({
      durationFrames: 412,
      frameRate: F60,
      width: 1920,
    })
    // First frame rendered after load.
    await nextFrame()
    expect(bridge.rendered).toEqual([0])
  })

  test('scrubbing renders rAF-coalesced frames RESCALED to the asset rate', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    useMediaStore.getState().addAsset(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
    await flush()
    await nextFrame()
    bridge.rendered.length = 0

    // Doc is 30fps, asset is 60fps: playhead 30 → asset frame 60.
    // Three rapid moves inside one frame collapse to the last one.
    const t = useTransportStore.getState()
    t.setPlayheadFrame(10)
    t.setPlayheadFrame(20)
    t.setPlayheadFrame(30)
    await nextFrame()
    await flush()

    expect(bridge.rendered).toEqual([60])
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

  test('a demux failure logs and leaves the preview usable', async () => {
    const { deps, bridge } = makeDeps()
    deps.demux = async () => {
      throw new Error('corrupt container')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    useMediaStore.getState().addAsset(new File(['x'], 'bad.mp4', { type: 'video/mp4' }))
    await flush()
    expect(bridge.configured).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
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
