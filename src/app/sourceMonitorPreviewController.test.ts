/**
 * Source Monitor preview: one worker-owned canvas for the open source.
 * The review document never enters documentStore or history.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { PresentationProfile } from '../domain/presentationProfile'
import type {
  FrameRate,
  MediaAsset,
  TimelineDoc,
} from '../domain/schema'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import { createVideoCompositionPlanner } from '../domain/videoCompositionPlan'
import type { RenderFrameResult } from '../engine/render-bridge'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { useTransportStore } from '../state/transportStore'
import { openSourceAsset } from './sourceMonitorController'
import {
  disposeSourcePreview,
  initSourcePreview,
  setSourcePreviewViewport,
  type SourcePreviewBridge,
  type SourcePreviewDeps,
} from './sourceMonitorPreviewController'
import type { RenderMode } from '../workers/render-protocol'
import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'

const F30: FrameRate = { num: 30, den: 1 }

class FakeBridge implements SourcePreviewBridge {
  onWorkerError: ((message: string) => void) | null = null
  onAssetError: ((
    assetId: string,
    runtimeToken: object,
    trackKind: 'video' | null,
    message: string,
  ) => void) | null = null
  onAssetReady: ((assetId: string) => void) | null = null
  docs: TimelineDoc[] = []
  profiles: PresentationProfile[] = []
  opened: Array<{
    assetId: string
    blob: Blob
    rate: FrameRate
    budget: LocalDecoderBudget
    runtimeToken: object
  }> = []
  openedImages: Array<{ assetId: string; blob: Blob; runtimeToken: object }> = []
  released: string[] = []
  rendered: Array<{ frame: number; mode: RenderMode }> = []
  disposed = false

  setDoc(doc: TimelineDoc): void {
    this.docs.push(doc)
  }

  setPresentationProfile(profile: PresentationProfile): void {
    this.profiles.push(profile)
  }

  async openAsset(
    assetId: string,
    blob: Blob,
    rate: FrameRate,
    budget: LocalDecoderBudget,
    runtimeToken: object,
  ): Promise<void> {
    this.opened.push({ assetId, blob, rate, budget, runtimeToken })
    this.onAssetReady?.(assetId)
  }

  async openImage(
    assetId: string,
    blob: Blob,
    runtimeToken: object,
  ): Promise<void> {
    this.openedImages.push({ assetId, blob, runtimeToken })
    this.onAssetReady?.(assetId)
  }

  releaseAsset(assetId: string): void {
    this.released.push(assetId)
  }

  async renderFrame(
    plan: VideoCompositionPlan,
    mode: RenderMode,
  ): Promise<RenderFrameResult> {
    this.rendered.push({ frame: plan.frame, mode })
    return {
      status: 'drawn',
      drawnClipIds: plan.items.flatMap((item) => (
        item.kind === 'clip' ? [item.request.clip.id] : []
      )),
      missingClipIds: [],
      renderMs: 1,
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

function makeDeps() {
  const bridge = new FakeBridge()
  const blob = new Blob(['source'], { type: 'video/mp4' })
  const deps: SourcePreviewDeps = {
    createBridge: () => bridge,
    createVisualPlanner: (doc, catalog) => createVideoCompositionPlanner(doc, catalog),
    transferCanvas: () => ({}) as OffscreenCanvas,
    init: vi.fn(),
    fetchBlob: vi.fn(async () => blob),
  }
  return { deps, bridge, blob }
}

function makeAsset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-source',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 300,
    durationMicroseconds: 10_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 10_000_000 },
    },
    frameRate: F30,
    width: 1280,
    height: 720,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: null,
    ...over,
  }
}

function compatibility(
  over: Partial<MediaCompatibilityItem> = {},
): MediaCompatibilityItem {
  return {
    id: 'asset-source',
    requestId: 'req-source',
    fileName: 'clip.mp4',
    declaredMimeType: 'video/mp4',
    size: 1_024,
    lastModified: 1_725_000_000_000,
    status: 'ready',
    report: null,
    ...over,
  }
}

function seed(asset: MediaAsset, item = compatibility({ id: asset.id, fileName: asset.fileName })): void {
  useMediaStore.setState({
    descriptors: new Map([[asset.id, {
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
    }]]),
    assets: new Map([[asset.id, asset]]),
    visuals: new Map(),
    compatibility: new Map([[asset.id, item]]),
  })
}

const canvasEl = () => document.createElement('canvas')
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  useSourceMonitorStore.getState().resetSourceMonitor()
  useTransportStore.getState().resetTransport()
  useTransportStore.getState().setPlayheadFrame(48)
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
})

afterEach(async () => {
  await disposeSourcePreview()
  useSourceMonitorStore.getState().resetSourceMonitor()
})

describe('sourceMonitorPreviewController', () => {
  test('decodes the open source onto its own canvas without touching Program', async () => {
    const { deps, bridge, blob } = makeDeps()
    const asset = makeAsset()
    seed(asset)
    const project = useDocumentStore.getState().doc
    initSourcePreview(canvasEl(), deps)
    setSourcePreviewViewport({
      widthCssPx: 640,
      heightCssPx: 360,
      devicePixelRatio: 1,
    })

    expect(openSourceAsset(asset.id).status).toBe('ok')
    await nextFrame()
    await flush()

    expect(deps.init).toHaveBeenCalledOnce()
    expect(deps.fetchBlob).toHaveBeenCalledWith('blob:source')
    expect(bridge.opened).toEqual([expect.objectContaining({
      assetId: 'asset-source',
      blob,
      rate: F30,
    })])
    expect(bridge.docs.at(-1)).toMatchObject({
      width: 1280,
      height: 720,
      frameRate: F30,
    })
    expect(bridge.docs.at(-1)?.id).not.toBe(project.id)
    expect(bridge.rendered.at(-1)).toEqual({ frame: 0, mode: 'seek' })
    expect(useDocumentStore.getState().doc).toBe(project)
    expect(useTransportStore.getState().playheadFrame).toBe(48)

    useSourceMonitorStore.getState().scrubPlayhead(12)
    await nextFrame()
    await flush()
    expect(bridge.rendered.at(-1)).toEqual({ frame: 12, mode: 'seek' })
    expect(useTransportStore.getState().playheadFrame).toBe(48)
  })

  test('opens stills through the image path and leaves audio without a decoder', async () => {
    const { deps, bridge } = makeDeps()
    const still = makeAsset({
      id: 'still-1',
      fileName: 'still.webp',
      mimeType: 'image/webp',
      kind: 'image',
      objectUrl: 'blob:still',
      hasAudio: false,
      frameRate: null,
      audioSampleRate: null,
      audioChannels: null,
      durationFrames: 150,
      durationMicroseconds: 5_000_000,
    })
    seed(still)
    initSourcePreview(canvasEl(), deps)
    expect(openSourceAsset(still.id).status).toBe('ok')
    await nextFrame()
    await flush()
    expect(bridge.openedImages).toEqual([expect.objectContaining({
      assetId: 'still-1',
    })])
    expect(bridge.opened).toEqual([])

    await disposeSourcePreview()
    const audioDeps = makeDeps()
    const audio = makeAsset({
      id: 'audio-1',
      fileName: 'tone.wav',
      mimeType: 'audio/wav',
      kind: 'audio',
      objectUrl: 'blob:audio',
      width: null,
      height: null,
      frameRate: null,
    })
    seed(audio)
    initSourcePreview(canvasEl(), audioDeps.deps)
    expect(openSourceAsset(audio.id).status).toBe('ok')
    await nextFrame()
    await flush()
    expect(audioDeps.bridge.opened).toEqual([])
    expect(audioDeps.bridge.openedImages).toEqual([])
    expect(audioDeps.bridge.rendered.at(-1)?.frame).toBe(0)
  })

  test('releases the review source when the session closes', async () => {
    const { deps, bridge } = makeDeps()
    seed(makeAsset())
    initSourcePreview(canvasEl(), deps)
    expect(openSourceAsset('asset-source').status).toBe('ok')
    await nextFrame()
    await flush()

    useSourceMonitorStore.getState().closeSource()
    await nextFrame()
    await flush()
    expect(bridge.released).toContain('asset-source')
  })
})
