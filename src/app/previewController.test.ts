/**
 * Composition-root tests for the preview pipeline. Imported media is already
 * analyzed before it reaches mediaStore, so this controller keeps connected
 * videos warm and forwards each document-referenced still to the worker once.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type {
  Clip,
  FrameRate,
  MediaAsset,
  TimelineDoc,
  Track,
} from '../domain/schema'
import {
  RenderAssetOpenError,
  type RenderFrameResult,
} from '../engine/render-bridge'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreviewStatusStore } from '../state/previewStatusStore'
import { useTransportStore } from '../state/transportStore'
import type { RenderMode } from '../workers/render-protocol'
import { resetMediaCompatibilityController } from './mediaCompatibilityController'
import type { BridgeLike, PreviewDeps } from './previewController'
import { disposePreview, initPreview } from './previewController'

const F60: FrameRate = { num: 60, den: 1 }

class FakeBridge implements BridgeLike {
  onWorkerError: ((message: string) => void) | null = null
  onAssetError: ((
    assetId: string,
    runtimeToken: object,
    trackKind: 'video' | null,
    message: string,
  ) => void) | null = null
  onAssetReady: ((assetId: string) => void) | null = null
  docs: TimelineDoc[] = []
  opened: Array<{
    assetId: string
    blob: Blob
    rate: FrameRate
    budget: LocalDecoderBudget
    runtimeToken: object
  }> = []
  openedImages: Array<{
    assetId: string
    blob: Blob
    runtimeToken: object
  }> = []
  released: string[] = []
  rendered: Array<{ frame: number; mode: RenderMode }> = []
  disposed = false
  openImpl: (
    assetId: string,
    blob: Blob,
    rate: FrameRate,
    budget: LocalDecoderBudget,
    runtimeToken: object,
  ) => Promise<void> = async () => {}
  openImageImpl: (
    assetId: string,
    blob: Blob,
    runtimeToken: object,
  ) => Promise<void> = async () => {}
  renderImpl: (
    frame: number,
    mode: RenderMode,
  ) => Promise<RenderFrameResult> = async () => ({
    status: 'drawn',
    drawnClipIds: [],
    missingClipIds: [],
    renderMs: 1,
  })

  setDoc(doc: TimelineDoc): void {
    this.docs.push(doc)
  }

  async openAsset(
    assetId: string,
    blob: Blob,
    rate: FrameRate,
    budget: LocalDecoderBudget,
    runtimeToken: object,
  ): Promise<void> {
    this.opened.push({ assetId, blob, rate, budget, runtimeToken })
    await this.openImpl(assetId, blob, rate, budget, runtimeToken)
    this.onAssetReady?.(assetId)
  }

  async openImage(
    assetId: string,
    blob: Blob,
    runtimeToken: object,
  ): Promise<void> {
    this.openedImages.push({ assetId, blob, runtimeToken })
    await this.openImageImpl(assetId, blob, runtimeToken)
    this.onAssetReady?.(assetId)
  }

  releaseAsset(assetId: string): void {
    this.released.push(assetId)
  }

  async renderFrame(frame: number, mode: RenderMode): Promise<RenderFrameResult> {
    this.rendered.push({ frame, mode })
    return this.renderImpl(frame, mode)
  }

  dispose(): void {
    this.disposed = true
  }
}

function makeDeps() {
  const bridge = new FakeBridge()
  const blob = new Blob(['x'], { type: 'video/mp4' })
  const deps: PreviewDeps = {
    createBridge: () => bridge,
    transferCanvas: () => ({}) as OffscreenCanvas,
    init: vi.fn(),
    fetchBlob: vi.fn(async () => blob),
  }
  return { deps, bridge, blob }
}

let assetCounter = 0

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const id = overrides.id ?? `asset-${++assetCounter}`
  return {
    id,
    fileName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 1,
    objectUrl: `blob:${id}`,
    kind: 'video',
    durationFrames: 120,
    durationMicroseconds: 2_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
    },
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

function makeImageAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const id = overrides.id ?? `image-${++assetCounter}`
  return makeAsset({
    id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    objectUrl: `blob:${id}`,
    kind: 'image',
    durationFrames: 300,
    durationMicroseconds: 5_000_000,
    sourceBounds: { video: null, audio: null },
    frameRate: null,
    width: 640,
    height: 360,
    hasAudio: false,
    audioSampleRate: null,
    audioChannels: null,
    decoderConfigB64: null,
    ...overrides,
  })
}

function seedAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const asset = makeAsset(overrides)
  expect(useMediaStore.getState().addAsset(asset)).toBe(true)
  return asset
}

function seedImageAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const asset = makeImageAsset(overrides)
  expect(useMediaStore.getState().addAsset(asset)).toBe(true)
  return asset
}

function descriptorFrom(asset: MediaAsset): PortableAssetDescriptor {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    durationMicroseconds: asset.durationMicroseconds,
    sourceBounds: asset.sourceBounds,
    nativeFrameRate: asset.frameRate,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
  }
}

function makeClip(id: string, assetId: string): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode: 'timed',
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

function makeStillClip(id: string, assetId: string): Clip {
  return {
    ...makeClip(id, assetId),
    sourceMode: 'still',
    sourceRange: { startFrame: 0, durationFrames: 1 },
  }
}

function makeVideoDoc(assetIds: readonly string[]): TimelineDoc {
  const tracks: Track[] = assetIds.map((assetId, index) => ({
    id: `track-${index}`,
    kind: 'video',
    name: `V${index + 1}`,
    clips: [makeClip(`clip-${index}`, assetId)],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }))
  return { ...initialDoc, tracks }
}

function makeStillDoc(assetIds: readonly string[]): TimelineDoc {
  const tracks: Track[] = assetIds.map((assetId, index) => ({
    id: `track-${index}`,
    kind: 'video',
    name: `V${index + 1}`,
    clips: [makeStillClip(`clip-${index}`, assetId)],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }))
  return { ...initialDoc, tracks }
}

function makeImageBackedTextDoc(assetId: string): TimelineDoc {
  const textClip: Clip = {
    ...makeClip('text-clip', assetId),
    text: {
      content: 'A title',
      fontFamily: 'Arial',
      fontSizePx: 48,
      color: '#ffffff',
      align: 'center',
      bold: false,
      italic: false,
    },
  }
  return {
    ...initialDoc,
    tracks: [{
      id: 'track-text',
      kind: 'video',
      name: 'V1',
      clips: [textClip],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
    }],
  }
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
  assetCounter = 0
  resetMediaCompatibilityController()
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  useDocumentStore.getState().setDoc(initialDoc)
  useTransportStore.setState({
    playheadFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    zoom: 1,
    inOut: null,
    dragPreview: null,
  })
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  usePreviewStatusStore.getState().resetPreviewStatus()
})

afterEach(() => {
  disposePreview()
})

describe('previewController', () => {
  test('keeps an unreferenced analyzed video warm without re-demuxing', async () => {
    const { deps, bridge, blob } = makeDeps()
    initPreview(canvasEl(), deps)
    expect(bridge.docs).toEqual([initialDoc])

    const asset = seedAsset({
      id: 'clip',
      fileName: 'clip.mp4',
      objectUrl: 'blob:clip-source',
    })
    await flush()

    expect(deps.fetchBlob).toHaveBeenCalledOnce()
    expect(deps.fetchBlob).toHaveBeenCalledWith(asset.objectUrl)
    expect(bridge.opened).toEqual([{
      assetId: asset.id,
      blob,
      rate: F60,
      budget: {
        fileBytes: 1,
        durationMicroseconds: 2_000_000,
        width: 1920,
        height: 1080,
        framesPerSecond: 60,
        sampleRate: 48_000,
        channels: 2,
      },
      runtimeToken: expect.objectContaining({
        assetId: asset.id,
        objectUrl: asset.objectUrl,
      }),
    }])
    expect(useMediaStore.getState().assets.get(asset.id)).toBe(asset)

    await nextFrame()
    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('every video asset gets its own worker source', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    const one = seedAsset({ id: 'one' })
    const two = seedAsset({ id: 'two' })
    await flush()

    expect(bridge.opened.map((entry) => entry.assetId).sort()).toEqual(
      [one.id, two.id].sort(),
    )
  })

  test('hands a referenced still Blob to the worker exactly once', async () => {
    const { deps, bridge, blob } = makeDeps()
    useDocumentStore.getState().setDoc(makeStillDoc(['still', 'still']))
    initPreview(canvasEl(), deps)
    const image = seedImageAsset({
      id: 'still',
      objectUrl: 'blob:still-source',
    })
    await flush()

    expect(deps.fetchBlob).toHaveBeenCalledOnce()
    expect(deps.fetchBlob).toHaveBeenCalledWith(image.objectUrl)
    expect(bridge.opened).toHaveLength(0)
    expect(bridge.openedImages).toEqual([{
      assetId: image.id,
      blob,
      runtimeToken: expect.objectContaining({
        assetId: image.id,
        objectUrl: image.objectUrl,
      }),
    }])

    seedAsset({ id: 'audio-poke', kind: 'audio', frameRate: null })
    await flush()
    expect(bridge.openedImages).toHaveLength(1)
  })

  test('keeps an unreferenced still out of the worker', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)

    seedImageAsset({ id: 'unused-still' })
    await flush()

    expect(deps.fetchBlob).not.toHaveBeenCalled()
    expect(bridge.openedImages).toHaveLength(0)
    expect(bridge.released).toHaveLength(0)
  })

  test('reconciles shared still references on every document change', async () => {
    const { deps, bridge } = makeDeps()
    const image = seedImageAsset({ id: 'shared-still' })
    useDocumentStore.getState().setDoc(makeStillDoc([image.id, image.id]))
    initPreview(canvasEl(), deps)
    await flush()

    expect(bridge.openedImages.map((entry) => entry.assetId)).toEqual([image.id])

    useDocumentStore.getState().setDoc(makeStillDoc([image.id]))
    expect(bridge.released).toEqual([])
    expect(bridge.openedImages).toHaveLength(1)

    useDocumentStore.getState().setDoc(makeStillDoc([]))
    expect(bridge.released).toEqual([image.id])

    useDocumentStore.getState().setDoc(makeStillDoc([image.id]))
    await flush()
    expect(bridge.openedImages.map((entry) => entry.assetId)).toEqual([
      image.id,
      image.id,
    ])
  })

  test('video and still assets keep separate worker-owned sources', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    const video = seedAsset({ id: 'video' })
    const image = seedImageAsset({ id: 'image' })
    useDocumentStore.getState().setDoc(makeStillDoc([image.id]))
    await flush()

    expect(bridge.opened.map((entry) => entry.assetId)).toEqual([video.id])
    expect(bridge.openedImages.map((entry) => entry.assetId)).toEqual([image.id])
  })

  test('does not open an image referenced only by a procedural text clip', async () => {
    const { deps, bridge } = makeDeps()
    const image = seedImageAsset({ id: 'text-backing-image' })
    useDocumentStore.getState().setDoc(makeImageBackedTextDoc(image.id))

    initPreview(canvasEl(), deps)
    await flush()

    expect(deps.fetchBlob).not.toHaveBeenCalled()
    expect(bridge.openedImages).toHaveLength(0)
  })

  test('descriptor-only media is never fetched or opened', async () => {
    const offline = makeAsset({ id: 'offline-only' })
    expect(useMediaStore.getState().replaceAssets(
      [descriptorFrom(offline)],
      [],
    )).toBe(true)
    const { deps, bridge } = makeDeps()

    initPreview(canvasEl(), deps)
    await flush()
    await nextFrame()

    expect(deps.fetchBlob).not.toHaveBeenCalled()
    expect(bridge.opened).toHaveLength(0)
    expect(bridge.openedImages).toHaveLength(0)
  })

  test('publishes only offline video sources visible at the current frame', async () => {
    const offline = makeAsset({ id: 'offline-current-frame' })
    expect(useMediaStore.getState().replaceAssets(
      [descriptorFrom(offline)],
      [],
    )).toBe(true)
    useDocumentStore.getState().setDoc(makeVideoDoc([offline.id]))
    const { deps } = makeDeps()

    initPreview(canvasEl(), deps)
    await nextFrame()

    expect(usePreviewStatusStore.getState().offlineVisualAssetIds)
      .toEqual([offline.id])

    useTransportStore.getState().setPlayheadFrame(30)
    await nextFrame()
    expect(usePreviewStatusStore.getState().offlineVisualAssetIds).toEqual([])
  })

  test('reconnecting the current source clears offline status and repaints', async () => {
    const reconnected = makeAsset({
      id: 'reconnected-current-frame',
      objectUrl: 'blob:reconnected-current-frame',
    })
    expect(useMediaStore.getState().replaceAssets(
      [descriptorFrom(reconnected)],
      [],
    )).toBe(true)
    useDocumentStore.getState().setDoc(makeVideoDoc([reconnected.id]))
    const { deps, bridge, blob } = makeDeps()
    initPreview(canvasEl(), deps)
    await nextFrame()
    expect(usePreviewStatusStore.getState().offlineVisualAssetIds)
      .toEqual([reconnected.id])
    bridge.rendered.length = 0

    expect(useMediaStore.getState().connectAsset(reconnected)).toBe(true)
    await flush()
    await nextFrame()

    expect(deps.fetchBlob).toHaveBeenCalledWith(reconnected.objectUrl)
    expect(bridge.opened).toEqual([{
      assetId: reconnected.id,
      blob,
      rate: F60,
      budget: expect.objectContaining({
        fileBytes: 1,
        durationMicroseconds: 2_000_000,
        framesPerSecond: 60,
      }),
      runtimeToken: expect.objectContaining({
        assetId: reconnected.id,
        objectUrl: reconnected.objectUrl,
      }),
    }])
    expect(usePreviewStatusStore.getState().offlineVisualAssetIds).toEqual([])
    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('mixed online and offline layers still render the connected composition', async () => {
    const online = makeAsset({
      id: 'mixed-online',
      objectUrl: 'blob:mixed-online',
    })
    const offline = makeAsset({
      id: 'mixed-offline',
      objectUrl: 'blob:mixed-offline-unused',
    })
    expect(useMediaStore.getState().replaceAssets(
      [descriptorFrom(online), descriptorFrom(offline)],
      [online],
    )).toBe(true)
    const document = makeVideoDoc([online.id, offline.id])
    useDocumentStore.getState().setDoc(document)
    const { deps, bridge, blob } = makeDeps()

    initPreview(canvasEl(), deps)
    await flush()
    await nextFrame()

    expect(bridge.docs).toEqual([document])
    expect(deps.fetchBlob).toHaveBeenCalledOnce()
    expect(deps.fetchBlob).toHaveBeenCalledWith(online.objectUrl)
    expect(bridge.opened).toEqual([{
      assetId: online.id,
      blob,
      rate: F60,
      budget: expect.objectContaining({
        fileBytes: 1,
        durationMicroseconds: 2_000_000,
        framesPerSecond: 60,
      }),
      runtimeToken: expect.objectContaining({
        assetId: online.id,
        objectUrl: online.objectUrl,
      }),
    }])
    expect(usePreviewStatusStore.getState().offlineVisualAssetIds)
      .toEqual([offline.id])
    expect(bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('scrubbing renders rAF-coalesced document frames', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    seedAsset()
    await flush()
    await nextFrame()
    bridge.rendered.length = 0

    const transport = useTransportStore.getState()
    transport.setIsScrubbing(true)
    transport.setPlayheadFrame(10)
    transport.setPlayheadFrame(20)
    transport.setPlayheadFrame(30)
    await nextFrame()
    await flush()

    expect(bridge.rendered).toEqual([{ frame: 30, mode: 'seek' }])
  })

  test('Play primes playback mode and rapid ticks keep only the latest frame', async () => {
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

  test('playback yields to seek during scrub and resumes afterward', async () => {
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
  })

  test('mode is chosen at dispatch so pause wins over queued Play', async () => {
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

  test('a document change reaches the worker and repaints', async () => {
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

  test('a source becoming ready repaints after the initial frame', async () => {
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
    const asset = seedAsset()
    await flush()

    useMediaStore.getState().removeAsset(asset.id)
    expect(bridge.released).toEqual([asset.id])
  })

  test('initPreview is idempotent per canvas', () => {
    const { deps, bridge } = makeDeps()
    const canvas = canvasEl()
    initPreview(canvas, deps)
    initPreview(canvas, deps)
    expect(bridge.disposed).toBe(false)
    expect(vi.mocked(deps.init)).toHaveBeenCalledTimes(1)
  })

  test('a failing transfer disables preview without crashing', () => {
    const { deps } = makeDeps()
    deps.transferCanvas = () => {
      throw new Error('OffscreenCanvas unsupported')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => initPreview(canvasEl(), deps)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('audio imports never reach the preview pipeline', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    seedAsset({
      id: 'song',
      fileName: 'song.mp3',
      mimeType: 'audio/mpeg',
      kind: 'audio',
      frameRate: null,
      width: null,
      height: null,
      decoderConfigB64: null,
    })
    await flush()

    expect(deps.fetchBlob).not.toHaveBeenCalled()
    expect(bridge.opened).toHaveLength(0)
  })

  test('a Blob fetch failure disconnects the exact source without implicit retry', async () => {
    const { deps, bridge } = makeDeps()
    let attempts = 0
    deps.fetchBlob = vi.fn(async () => {
      attempts++
      throw new Error('source URL unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const bad = seedAsset({ id: 'bad', fileName: 'bad.mp4' })
    await flush()

    expect(bridge.opened).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('loading "bad.mp4" failed'),
      'source URL unavailable',
    )
    expect(useMediaStore.getState().assets.has(bad.id)).toBe(false)
    expect(useMediaStore.getState().descriptors.has(bad.id)).toBe(true)
    expect(useMediaStore.getState().compatibility.get(bad.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'resource-unavailable',
        runtimeFailures: [{
          surface: 'preview',
          trackKind: null,
          reason: 'resource-unavailable',
          detail: 'source URL unavailable',
        }],
      },
    })

    seedAsset({ id: 'poke', kind: 'audio', frameRate: null })
    await flush()
    expect(attempts).toBe(1)
    expect(bridge.opened).toHaveLength(0)
    warn.mockRestore()
  })

  test('a worker open failure disconnects the exact source without implicit retry', async () => {
    const { deps, bridge } = makeDeps()
    let attempts = 0
    bridge.openImpl = async () => {
      attempts++
      throw new Error('worker could not open source')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const bad = seedAsset({ id: 'bad', fileName: 'bad.mp4' })
    await flush()

    expect(attempts).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('loading "bad.mp4" failed'),
      'worker could not open source',
    )
    expect(useMediaStore.getState().assets.has(bad.id)).toBe(false)
    expect(useMediaStore.getState().compatibility.get(bad.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'decode-failed',
        runtimeFailures: [{
          surface: 'preview',
          trackKind: 'video',
          reason: 'decode-failed',
          detail: 'worker could not open source',
        }],
      },
    })

    seedAsset({ id: 'poke', kind: 'audio', frameRate: null })
    await flush()
    expect(attempts).toBe(1)
    expect(bridge.opened).toHaveLength(1)
    warn.mockRestore()
  })

  test('a still-image worker failure stays image-scoped and disconnects its source', async () => {
    const { deps, bridge } = makeDeps()
    bridge.openImageImpl = async () => {
      throw new RenderAssetOpenError(
        'worker openImage failed: decoded image exceeded its budget',
        { trackKind: null, reason: 'resource-limit' },
      )
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useDocumentStore.getState().setDoc(makeStillDoc(['huge-image']))
    initPreview(canvasEl(), deps)
    const bad = seedImageAsset({
      id: 'huge-image',
      fileName: 'huge-image.png',
    })
    await flush()

    expect(bridge.opened).toHaveLength(0)
    expect(bridge.openedImages).toHaveLength(1)
    expect(useMediaStore.getState().assets.has(bad.id)).toBe(false)
    expect(useMediaStore.getState().compatibility.get(bad.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'resource-limit',
        runtimeFailures: [{
          surface: 'preview',
          trackKind: null,
          reason: 'resource-limit',
          detail: 'worker openImage failed: decoded image exceeded its budget',
        }],
      },
    })
    warn.mockRestore()
  })

  test('a worker Input-construction failure remains file-level', async () => {
    const { deps, bridge } = makeDeps()
    bridge.openImpl = async () => {
      throw new RenderAssetOpenError(
        'worker openAsset failed: Input construction failed',
        { trackKind: null, reason: 'resource-unavailable' },
      )
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const bad = seedAsset({ id: 'source-error', fileName: 'source-error.mp4' })
    await flush()

    expect(useMediaStore.getState().assets.has(bad.id)).toBe(false)
    expect(useMediaStore.getState().compatibility.get(bad.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'resource-unavailable',
        runtimeFailures: [{
          surface: 'preview',
          trackKind: null,
          reason: 'resource-unavailable',
          detail: 'worker openAsset failed: Input construction failed',
        }],
      },
    })
    warn.mockRestore()
  })

  test('a worker decoder budget rejection remains a video resource limit', async () => {
    const { deps, bridge } = makeDeps()
    bridge.openImpl = async () => {
      throw new RenderAssetOpenError(
        'worker openAsset failed: ProRes budget exceeded',
        { trackKind: 'video', reason: 'resource-limit' },
      )
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const bad = seedAsset({ id: 'large-prores', fileName: 'large.mov' })
    await flush()

    expect(useMediaStore.getState().assets.has(bad.id)).toBe(false)
    expect(useMediaStore.getState().compatibility.get(bad.id)).toMatchObject({
      status: 'error',
      report: {
        reason: 'resource-limit',
        runtimeFailures: [{
          surface: 'preview',
          trackKind: 'video',
          reason: 'resource-limit',
          detail: 'worker openAsset failed: ProRes budget exceeded',
        }],
      },
    })
    warn.mockRestore()
  })

  test('removal during Blob fetch cancels before worker open', async () => {
    const { deps, bridge, blob } = makeDeps()
    const fetched = deferred<Blob>()
    deps.fetchBlob = () => fetched.promise
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const asset = seedAsset({ id: 'gone' })

    useMediaStore.getState().removeAsset(asset.id)
    fetched.resolve(blob)
    await flush()

    expect(bridge.released).toEqual([asset.id])
    expect(bridge.opened).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('removal during worker open treats late rejection as cancellation', async () => {
    const { deps, bridge } = makeDeps()
    const opening = deferred<void>()
    bridge.openImpl = () => opening.promise
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const asset = seedAsset({ id: 'gone' })
    await flush()
    expect(bridge.opened).toHaveLength(1)

    useMediaStore.getState().removeAsset(asset.id)
    opening.reject(new Error('asset released'))
    await flush()

    expect(bridge.released).toEqual([asset.id])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('dispose during Blob fetch prevents late worker work', async () => {
    const { deps, bridge, blob } = makeDeps()
    const fetched = deferred<Blob>()
    deps.fetchBlob = () => fetched.promise
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    seedAsset({ id: 'late' })

    disposePreview()
    fetched.resolve(blob)
    await flush()

    expect(bridge.disposed).toBe(true)
    expect(bridge.opened).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('a queued render from an old canvas cannot use a new bridge', async () => {
    const first = makeDeps()
    const second = makeDeps()

    initPreview(canvasEl(), first.deps)
    initPreview(canvasEl(), second.deps)
    await nextFrame()

    expect(first.bridge.rendered).toEqual([])
    expect(second.bridge.rendered).toEqual([{ frame: 0, mode: 'seek' }])
  })

  test('an asset-scoped worker failure disconnects the source it opened', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    const asset = seedAsset({ id: 'runtime-bad' })
    await flush()
    const runtimeToken = bridge.opened[0].runtimeToken

    bridge.onAssetError?.(asset.id, runtimeToken, 'video', 'decode exploded')

    expect(useMediaStore.getState().assets.has(asset.id)).toBe(false)
    expect(useMediaStore.getState().descriptors.has(asset.id)).toBe(true)
    expect(useMediaStore.getState().compatibility.get(asset.id)).toMatchObject({
      status: 'error',
      report: {
        runtimeFailures: [{
          surface: 'preview',
          trackKind: 'video',
          reason: 'decode-failed',
          detail: 'decode exploded',
        }],
      },
    })
  })

  test('an asset failure from an old open cannot disconnect its replacement', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    const original = seedAsset({ id: 'relinked' })
    await flush()
    const staleToken = bridge.opened[0].runtimeToken

    useMediaStore.getState().disconnectAsset(original.id)
    const replacement = { ...original, objectUrl: 'blob:replacement' }
    expect(useMediaStore.getState().connectAsset(replacement)).toBe(true)
    await flush()

    bridge.onAssetError?.(
      original.id,
      staleToken,
      'video',
      'late old-source failure',
    )

    expect(useMediaStore.getState().assets.get(original.id)).toBe(replacement)
    expect(useMediaStore.getState().compatibility.has(original.id)).toBe(false)
  })

  test('worker diagnostics keep their controller prefix without blaming media', async () => {
    const { deps, bridge } = makeDeps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const asset = seedAsset({ id: 'still-online' })
    await flush()

    bridge.onWorkerError?.('decode exploded')

    expect(warn).toHaveBeenCalledWith(
      '[previewController] worker error:',
      'decode exploded',
    )
    expect(useMediaStore.getState().assets.get(asset.id)).toBe(asset)
    expect(useMediaStore.getState().compatibility.has(asset.id)).toBe(false)
    warn.mockRestore()
  })

  test('a request-global render result is diagnostic-only', async () => {
    const { deps, bridge } = makeDeps()
    bridge.renderImpl = async () => ({
      status: 'error',
      drawnClipIds: [],
      missingClipIds: [],
      renderMs: 1,
      message: 'compositor unavailable',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initPreview(canvasEl(), deps)
    const asset = seedAsset({ id: 'render-survivor' })
    await flush()
    await nextFrame()
    await flush()

    expect(warn).toHaveBeenCalledWith(
      '[previewController] render failed:',
      'compositor unavailable',
    )
    expect(useMediaStore.getState().assets.get(asset.id)).toBe(asset)
    expect(useMediaStore.getState().compatibility.has(asset.id)).toBe(false)
    warn.mockRestore()
  })

  test('dispose unsubscribes and disposes the bridge', async () => {
    const { deps, bridge } = makeDeps()
    initPreview(canvasEl(), deps)
    disposePreview()
    expect(bridge.disposed).toBe(true)

    seedAsset({ id: 'after-dispose' })
    await flush()
    expect(bridge.opened).toHaveLength(0)
  })
})
