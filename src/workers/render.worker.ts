/**
 * workers/render.worker.ts — The compositing worker. Phase 4.1b.
 *
 * Runs pipeline/render.compositeFrame off the main thread. The streaming
 * path owns one Blob-backed video source per asset and one sequential cursor
 * per visible clip. Static images use one separately retained worker-owned
 * frame-zero source shared across all of their layers and requests. The
 * deprecated keyframe-batch path is isolated behind render-legacy.ts and
 * remains only for named compatibility APIs. Both paths retain the hard-won
 * ownership rules from the original decode worker (Phase 2.2/2.5):
 * - every VideoFrame closes the moment its bitmap copy exists;
 * - caches hold decoder-independent ImageBitmaps, never VideoFrames;
 * - backpressure: decodeQueueSize < QUEUE_HIGH_WATER, park on dequeue;
 * - reset() UNCONFIGURES a decoder — reconfigure after every reset;
 * - latest-wins PRESENTATION: stale composites never touch the screen;
 *   normal playback supersession keeps useful sequential decode work alive.
 *
 * On top of those, three render-specific rules:
 * - DOUBLE BUFFERING: compositeFrame draws onto a worker-private scratch
 *   canvas; only the newest composite blits scratch → visible canvas.
 *   A superseded composite can never flash a torn/stale frame.
 * - SEQUENTIAL composites, serialized per-asset batches: two clips may
 *   need the SAME asset at different frames in one composite (the
 *   render.ts contract) — the per-asset chain decodes them one after the
 *   other while different assets run concurrently.
 * - LOANS: a bitmap handed to the compositor is take()n out of its cache
 *   so a later decode batch in the same composite cannot evict-and-close
 *   it mid-draw; after the composite it is re-put (or closed, if the
 *   asset was reconfigured meanwhile — epoch mismatch).
 *
 * Layering: workers/ → domain/, engine/frame-cache, decode-types
 * (types), pipeline/render (sanctioned: pure compositing core, imports
 * domain/ only). Logic lives in createRenderWorkerCore() with injected
 * browser deps; the real wiring at the bottom only runs in a worker scope.
 */

import { FrameRingBuffer } from '../engine/frame-cache'
import type { AssetId, ClipId, TimelineDoc } from '../domain/schema'
import {
  fullResolutionPresentationProfile,
  presentationProfileMatchesDocument,
  type PresentationProfile,
} from '../domain/presentationProfile'
import { videoCompositionRequests } from '../domain/videoCompositionPlan'
import {
  supportsCanvasEffectFilter,
  supportsCanvasEffectPixels,
} from '../domain/effectStack'
import {
  analyzeVideoScopes,
  VIDEO_SCOPE_SAMPLE_HEIGHT,
  VIDEO_SCOPE_SAMPLE_WIDTH,
  type VideoScopeAnalysis,
} from '../domain/videoScopes'
import { assertRenderSurfaceBudget } from '../domain/renderSurfaceBudget'
import {
  invalidateMediaDecoderRuntime,
  invalidateMediaDecoderSource,
  type LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import type {
  Composite2D,
  FrameSource,
  RenderFrameSource,
  TransitionSurfaceProvider,
  TransitionSurfaces,
  VideoEffectStageExecutor,
} from '../pipeline/render'
import { compositeFrame } from '../pipeline/render'
import {
  LensRemapUnavailableError,
  LENS_REMAP_BACKEND_VERSION,
  type LensRemapAvailability,
  type LensRemapProvider,
} from '../pipeline/lensRemap'
import {
  createDocumentLensRemapProvider,
  documentHasLensCorrection,
  documentHasSupportedLensCorrection,
  WebGl2LensRemapBackend,
} from '../pipeline/lensRemapWebgl'
import {
  decodeStaticImage,
  staticImageDecodedByteLength,
  STATIC_IMAGE_RESIDENT_BUDGET_BYTES,
  StaticImageDecodeError,
  type DecodedStaticImage,
  type StaticImageDecodedByteReservation,
  type StaticImageDecodedByteReserver,
  type StaticImageRenderSource,
} from '../pipeline/static-image'
import type {
  BitmapLike,
  VideoDecoderLike,
} from './decode-types'
import {
  createLegacyRenderWorkerCompatibility,
  type LegacyRenderWorkerCompatibility,
  type LegacyRenderWorkerEnv,
} from './render-legacy'
import type {
  FromRenderWorker,
  RenderWorkerRuntimeTelemetrySnapshot,
  RenderFrameMessage,
  StreamingCompositeSourceEntry,
  StreamingVideoSourceEntry,
  ToRenderWorker,
} from './render-protocol'
import {
  WorkerVideoSourceOpenError,
  openWorkerVideoSource,
} from './video-source'
import type {
  DecodedVideoFrame,
  VideoFrameCursor,
  WorkerVideoSource,
} from './video-source'
import type {
  VideoScopeAnalyzeMessage,
  VideoScopeWorkerReply,
} from './video-scopes-protocol'
import {
  PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
  isPluginEffectBridgeHostMessage,
  zeroAttachedPluginEffectBuffer,
} from './plugin-effect-bridge-protocol'

/** A larger forward gap is a discontinuity, not useful sequential catch-up. */
const PLAYBACK_RESTART_GAP_US = 1_000_000

/* ------------------------------------------------------------------ */
/* Structural types for injectable browser deps                         */
/* ------------------------------------------------------------------ */

/**
 * The slice of OffscreenCanvas the worker uses. Its 2D context must
 * satisfy pipeline/render's Composite2D — the real
 * OffscreenCanvasRenderingContext2D does.
 */
export interface RenderCanvasLike {
  width: number
  height: number
  getContext(
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings,
  ): Composite2D | null
}

const SRGB_2D_CONTEXT: CanvasRenderingContext2DSettings = {
  colorSpace: 'srgb',
}

/** Everything the core needs from the outside world. */
export interface RenderWorkerEnv extends LegacyRenderWorkerEnv {
  post(msg: FromRenderWorker, transfer?: Transferable[]): void
  /** Open one worker-owned Mediabunny source for a structured-cloned Blob. */
  openVideoSource(
    blob: Blob,
    sourceId: AssetId,
    budget: LocalDecoderBudget,
  ): Promise<WorkerVideoSource>
  /** Decode and transfer one bounded frame-zero image source to this owner. */
  decodeImage(
    blob: Blob,
    signal: AbortSignal,
    reserveDecodedBytes: StaticImageDecodedByteReserver,
  ): Promise<DecodedStaticImage>
  /** Forget session capability facts before an asset source changes. */
  invalidateDecoderSource(sourceId: AssetId): void
  /** Forget every realm-local capability fact when this worker closes. */
  invalidateDecoderRuntime(): void
  /** Normalize orientation and copy a streamed frame. Does not close it. */
  createStreamingBitmap(frame: DecodedVideoFrame): Promise<BitmapLike>
  /** Create the scratch compositing surface (new OffscreenCanvas). */
  createCanvas(width: number, height: number): RenderCanvasLike
  /** Create this worker owner's one reusable manual lens-remap backend. */
  createLensRemapBackend?(): WebGl2LensRemapBackend
  /** Yield non-critical analysis until after the current render task. */
  schedule?(callback: () => void): void
  /** Analyze the tiny scope sample away from the render worker when available. */
  analyzeVideoScopes?(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<VideoScopeAnalysis>
  /** Terminate analysis resources and settle after the child worker retires. */
  releaseVideoScopes?(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Core                                                                 */
/* ------------------------------------------------------------------ */

interface OwnedStreamingFrame {
  timestampUs: number
  bitmap: BitmapLike
}

interface PlaybackLaneState {
  clipId: ClipId
  cursor: VideoFrameCursor
  current: OwnedStreamingFrame | null
  lookahead: OwnedStreamingFrame | null
  lastSourceFrame: number | null
  lastTargetTimestampUs: number | null
  epoch: number
  ended: boolean
  closed: boolean
}

interface StreamingAssetState {
  source: WorkerVideoSource
  lanes: Map<ClipId, PlaybackLaneState>
  pendingCopies: Set<Promise<OwnedStreamingFrame | null>>
  epoch: number
}

/** One retained static source, shared read-only across every frame request. */
interface StaticImageAssetState {
  source: StaticImageRenderSource
  decodedBytes: number
  reservation: StaticImageDecodedByteReservation
  loans: number
  retired: boolean
  closed: boolean
  closePromise: Promise<void>
  resolveClosed(): void
  rejectClosed(error: unknown): void
}

interface PendingStaticImageOpen {
  revision: number
  controller: AbortController
  done: Promise<void>
}

interface StreamingLoan {
  bitmap: BitmapLike
  settle(): void
}

interface StaticImageLoan {
  source: RenderFrameSource
  settle(): void
}

class StaticImageResidentBudgetError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StaticImageResidentBudgetError'
  }
}

interface ClipDecodeIdentity {
  assetId: AssetId
  sourceStart: number
  sourceDuration: number
  timelineStart: number
  timelineDuration: number
}

interface PendingPluginEffect {
  readonly generation: number
  readonly workerGeneration: number
  readonly renderRequestId: number
  readonly expectedByteLength: number
  readonly resolve: (result: { readonly status: 'applied'; readonly rgba: Uint8Array<ArrayBuffer> }
    | { readonly status: 'bypassed' }) => void
}

export function createRenderWorkerCore(env: RenderWorkerEnv): {
  handleMessage(msg: ToRenderWorker): Promise<void>
  revisionEntryCounts(): { assets: number; playbackLanes: number }
} {
  let visible: RenderCanvasLike | null = null
  let visibleCtx: Composite2D | null = null
  let scratch: RenderCanvasLike | null = null
  let scratchCtx: Composite2D | null = null
  let transitionLeg: RenderCanvasLike | null = null
  let transitionLegCtx: Composite2D | null = null
  let transitionGroup: RenderCanvasLike | null = null
  let transitionGroupCtx: Composite2D | null = null
  let publishedCanvasFilterCapability: boolean | null = null
  let publishedCanvasPixelCapability: boolean | null = null
  let publishedLensCapabilityKey: string | null = null
  let lensBackend: WebGl2LensRemapBackend | null = null
  let lensRemapProvider: LensRemapProvider | null = null
  let lensRemapAvailability: LensRemapAvailability | undefined
  let lensOwnerTerminal = false
  let videoScopeCanvas: RenderCanvasLike | null = null
  let videoScopeCtx: Composite2D | null = null
  let videoScopesEnabled = false
  let videoScopeGeneration = 0
  let videoScopeTaskPending = false
  let lastVideoScopeAnalysisAt = Number.NEGATIVE_INFINITY
  let scratchFrame: number | null = null
  let doc: TimelineDoc | null = null
  let presentationProfile: PresentationProfile | null = null
  /** Bumped by every composite/setDoc/configureAsset/releaseAsset/close;
   * stale composites and parked feed loops check it and unwind. */
  let generation = 0
  let nextPluginEffectRequestId = 1
  const pendingPluginEffects = new Map<number, PendingPluginEffect>()
  /** Composites run strictly one at a time (stale ones exit immediately). */
  let compositeChain: Promise<void> = Promise.resolve()
  /** Invalidates asset opens/configures that outlive a worker-wide close. */
  let workerLifecycle = 0
  /** Worker-global tokens prevent ABA when per-key revision entries retire. */
  let revisionToken = 0
  /** Deprecated chunk-backed state lives behind one compatibility delegate. */
  let legacyCompatibility: LegacyRenderWorkerCompatibility | null = null
  /** Blob-backed streaming asset states. */
  const streamingAssets = new Map<AssetId, StreamingAssetState>()
  /** Blob-backed static image states (one retained frame per asset). */
  const staticImageAssets = new Map<AssetId, StaticImageAssetState>()
  /** Includes active and retired-but-borrowed stills until their actual close. */
  let residentStaticImageBytes = 0
  /** Abortable opens let replacement/release/close retire late decodes. */
  const pendingStaticImageOpens = new Map<AssetId, PendingStaticImageOpen>()
  /** The newest removed generation each asset must finish retiring behind. */
  const staticImageRetirementByAsset = new Map<AssetId, Promise<void>>()
  /** Every removed generation still owed an exact close before worker ACK. */
  const outstandingStaticImageRetirements = new Set<Promise<void>>()
  const assetRevisions = new Map<AssetId, number>()
  /** Only seek cursors are presentation-scoped and cancelled on supersession. */
  const activeSeekCursors = new Set<VideoFrameCursor>()
  /** Latest playback request's active clip lanes; updated at message arrival. */
  let desiredPlaybackLaneKeys = new Set<string>()
  const playbackLaneRevisions = new Map<string, number>()
  let runtimeTelemetryEnabled = false
  let renderQueueDepth = 0
  let renderQueueMaxDepth = 0
  let decodeQueueDepth = 0
  let decodeQueueMaxDepth = 0
  let cacheHits = 0
  let cacheMisses = 0
  let decodedVideoFrameCloses = 0
  let streamingBitmapCloses = 0
  let staticImageSourceCloses = 0

  function setRuntimeTelemetry(enabled: boolean): void {
    runtimeTelemetryEnabled = enabled
    renderQueueDepth = 0
    renderQueueMaxDepth = 0
    decodeQueueDepth = 0
    decodeQueueMaxDepth = 0
    cacheHits = 0
    cacheMisses = 0
    decodedVideoFrameCloses = 0
    streamingBitmapCloses = 0
    staticImageSourceCloses = 0
  }

  function enterRenderQueue(): void {
    if (!runtimeTelemetryEnabled) return
    renderQueueDepth++
    renderQueueMaxDepth = Math.max(renderQueueMaxDepth, renderQueueDepth)
  }

  function leaveRenderQueue(): void {
    if (!runtimeTelemetryEnabled) return
    renderQueueDepth = Math.max(0, renderQueueDepth - 1)
  }

  async function trackedDecode<T>(run: () => Promise<T>): Promise<T> {
    if (!runtimeTelemetryEnabled) return run()
    decodeQueueDepth++
    decodeQueueMaxDepth = Math.max(decodeQueueMaxDepth, decodeQueueDepth)
    try {
      return await run()
    } finally {
      decodeQueueDepth--
    }
  }

  function countCacheHit(): void {
    if (runtimeTelemetryEnabled) cacheHits++
  }

  function countCacheMiss(): void {
    if (runtimeTelemetryEnabled) cacheMisses++
  }

  function closeStreamingBitmap(bitmap: BitmapLike | null): void {
    if (!bitmap) return
    bitmap.close()
    if (runtimeTelemetryEnabled) streamingBitmapCloses++
  }

  function closeStaticImageSource(source: StaticImageRenderSource): void {
    source.close()
    if (runtimeTelemetryEnabled) staticImageSourceCloses++
  }

  function runtimeTelemetrySnapshot(): RenderWorkerRuntimeTelemetrySnapshot {
    let videoDecoders = activeSeekCursors.size
    let pendingBitmapCopies = 0
    let streamingFrameBitmaps = 0
    let estimatedStreamingFrameBytes = 0
    for (const state of streamingAssets.values()) {
      videoDecoders += state.lanes.size
      pendingBitmapCopies += state.pendingCopies.size
      for (const lane of state.lanes.values()) {
        for (const frame of [lane.current, lane.lookahead]) {
          if (!frame) continue
          streamingFrameBitmaps++
          estimatedStreamingFrameBytes += frame.bitmap.width * frame.bitmap.height * 4
        }
      }
    }
    const scratchSurfaceBytes = scratch ? scratch.width * scratch.height * 4 : 0
    const transitionSurfaceBytes = (
      (transitionLeg ? transitionLeg.width * transitionLeg.height * 4 : 0)
      + (transitionGroup ? transitionGroup.width * transitionGroup.height * 4 : 0)
    )
    return {
      enabled: runtimeTelemetryEnabled,
      active: {
        videoSources: streamingAssets.size,
        videoDecoders,
        pendingBitmapCopies,
        pendingStaticImageOpens: pendingStaticImageOpens.size,
      },
      queues: {
        renderDepth: renderQueueDepth,
        renderMaxDepth: renderQueueMaxDepth,
        decodeDepth: decodeQueueDepth,
        decodeMaxDepth: decodeQueueMaxDepth,
      },
      caches: { hits: cacheHits, misses: cacheMisses },
      decodedMedia: {
        retainedStaticImages: staticImageAssets.size,
        retainedStaticImageBytes: residentStaticImageBytes,
      },
      derivedCaches: {
        streamingFrameBitmaps,
        estimatedStreamingFrameBytes,
        scratchSurfaceBytes,
        transitionSurfaceBytes,
      },
      closes: {
        decodedVideoFrames: decodedVideoFrameCloses,
        streamingBitmaps: streamingBitmapCloses,
        staticImageSources: staticImageSourceCloses,
      },
    }
  }

  function nextRevisionToken(): number {
    revisionToken++
    if (!Number.isSafeInteger(revisionToken)) {
      throw new RangeError('Render worker revision token overflow')
    }
    return revisionToken
  }

  function nextAssetRevision(assetId: AssetId): number {
    const revision = nextRevisionToken()
    assetRevisions.set(assetId, revision)
    return revision
  }

  function clearAssetRevision(assetId: AssetId, revision: number): void {
    if (assetRevisions.get(assetId) === revision) {
      assetRevisions.delete(assetId)
    }
  }

  function assetRevisionIsCurrent(
    assetId: AssetId,
    revision: number,
    lifecycle: number,
  ): boolean {
    return assetRevisions.get(assetId) === revision && workerLifecycle === lifecycle
  }

  function cancelActiveSeeks(): void {
    const cursors = [...activeSeekCursors]
    activeSeekCursors.clear()
    for (const cursor of cursors) {
      void cursor.close().catch(() => undefined)
    }
  }

  function cancelPendingPluginEffects(): void {
    for (const [effectRequestId, pending] of pendingPluginEffects) {
      env.post({
        type: 'pluginEffectCancel',
        protocolVersion: PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
        generation: pending.generation,
        renderRequestId: pending.renderRequestId,
        effectRequestId,
      })
      pending.resolve({ status: 'bypassed' })
    }
    pendingPluginEffects.clear()
  }

  /** Invalidate presentation work without cancelling persistent playback lanes. */
  function supersede(): number {
    generation++
    legacyCompatibility?.wakeAll()
    cancelActiveSeeks()
    cancelPendingPluginEffects()
    return generation
  }

  function takePluginEffectRequestId(): number {
    const requestId = nextPluginEffectRequestId
    if (!Number.isSafeInteger(requestId)) {
      throw new RangeError('Plugin effect request id overflow')
    }
    nextPluginEffectRequestId++
    return requestId
  }

  function handlePluginEffectHostMessage(value: unknown): void {
    const candidate = value && typeof value === 'object'
      ? value as { readonly effectRequestId?: unknown; readonly rgbaBytes?: unknown }
      : null
    const effectRequestId = candidate && Number.isSafeInteger(candidate.effectRequestId)
      ? Number(candidate.effectRequestId)
      : -1
    const pending = pendingPluginEffects.get(effectRequestId)
    const expectedByteLength = pending?.expectedByteLength ?? -1
    if (!isPluginEffectBridgeHostMessage(value, expectedByteLength)) {
      if (candidate?.rgbaBytes instanceof ArrayBuffer) {
        zeroAttachedPluginEffectBuffer(candidate.rgbaBytes)
      }
      if (pending) {
        pendingPluginEffects.delete(effectRequestId)
        pending.resolve({ status: 'bypassed' })
      }
      return
    }
    if (
      !pending
      || pending.generation !== value.generation
      || pending.renderRequestId !== value.renderRequestId
      || generation !== pending.workerGeneration
    ) {
      if (value.type === 'pluginEffectApplied') {
        zeroAttachedPluginEffectBuffer(value.rgbaBytes)
      }
      return
    }
    pendingPluginEffects.delete(effectRequestId)
    if (value.type === 'pluginEffectBypassed') {
      pending.resolve({ status: 'bypassed' })
      return
    }
    pending.resolve({
      status: 'applied',
      rgba: new Uint8Array(value.rgbaBytes),
    })
  }

  function pluginEffectExecutor(
    renderGeneration: number,
    renderRequestId: number,
    workerGeneration: number,
    returnedBuffers: Set<ArrayBuffer>,
  ): VideoEffectStageExecutor {
    return {
      bypassPolicy: 'allow',
      applyPluginEffect(request) {
        if (generation !== workerGeneration) {
          if (request.rgba.byteLength > 0) request.rgba.fill(0)
          return Promise.resolve({ status: 'bypassed' })
        }
        const rgbaBytes = request.rgba.buffer
        if (
          !(rgbaBytes instanceof ArrayBuffer)
          || request.rgba.byteOffset !== 0
          || rgbaBytes.byteLength !== request.rgba.byteLength
        ) {
          request.rgba.fill(0)
          return Promise.resolve({ status: 'bypassed' })
        }
        const effectRequestId = takePluginEffectRequestId()
        return new Promise((resolve) => {
          pendingPluginEffects.set(effectRequestId, {
            generation: renderGeneration,
            workerGeneration,
            renderRequestId,
            expectedByteLength: request.rgba.byteLength,
            resolve: (result) => {
              if (result.status === 'applied') {
                returnedBuffers.add(result.rgba.buffer)
              }
              resolve(result)
            },
          })
          env.post({
            type: 'pluginEffectApply',
            protocolVersion: PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
            generation: renderGeneration,
            renderRequestId,
            effectRequestId,
            execution: request.execution,
            descriptorId: request.effect.id,
            timelineFrame: request.timelineFrame,
            frameRateNumerator: request.frameRate.num,
            frameRateDenominator: request.frameRate.den,
            width: request.width,
            height: request.height,
            stride: request.stride,
            rgbaBytes,
          }, [rgbaBytes])
        })
      },
    }
  }

  function currentPresentationProfile(): PresentationProfile | null {
    if (!doc) return null
    if (
      presentationProfile
      && presentationProfileMatchesDocument(presentationProfile, doc)
    ) return presentationProfile
    presentationProfile = fullResolutionPresentationProfile(doc, 'paused')
    return presentationProfile
  }

  function lensUnavailable(reason: string): LensRemapAvailability {
    return {
      status: 'unavailable',
      backendVersion: LENS_REMAP_BACKEND_VERSION,
      maximumTextureSize: lensBackend?.maximumTextureSize ?? null,
      reason,
    }
  }

  function prepareLensRemap(nextDoc: TimelineDoc): void {
    lensRemapProvider = null
    lensRemapAvailability = undefined
    if (!documentHasLensCorrection(nextDoc)) return

    if (documentHasSupportedLensCorrection(nextDoc) && !lensBackend) {
      if (lensOwnerTerminal) {
        lensRemapAvailability = lensUnavailable(
          'The lens-remap context was lost. Retry requires a fresh preview worker.',
        )
      } else if (!env.createLensRemapBackend) {
        lensRemapAvailability = lensUnavailable(
          'WebGL2 lens remapping is unavailable in this preview renderer.',
        )
      } else {
        try {
          lensBackend = env.createLensRemapBackend()
        } catch (cause) {
          lensOwnerTerminal = true
          lensRemapAvailability = lensUnavailable(
            cause instanceof Error ? cause.message : String(cause),
          )
        }
      }
    }

    try {
      const profile = currentPresentationProfile()
      lensRemapProvider = createDocumentLensRemapProvider(
        nextDoc,
        lensBackend,
        profile?.outputWidth ?? nextDoc.width,
        profile?.outputHeight ?? nextDoc.height,
        false,
      )
    } catch (cause) {
      lensRemapProvider = null
      lensRemapAvailability = lensUnavailable(
        cause instanceof Error ? cause.message : String(cause),
      )
    }

    if (lensBackend && !lensRemapAvailability) {
      lensRemapAvailability = {
        status: 'available',
        backendVersion: LENS_REMAP_BACKEND_VERSION,
        maximumTextureSize: lensBackend.maximumTextureSize,
        reason: null,
      }
    } else if (!lensRemapAvailability) {
      lensRemapAvailability = lensUnavailable(
        'This document contains a preserved unsupported lens-correction version.',
      )
    }
  }

  function failLensOwner(error: LensRemapUnavailableError): void {
    if (error.terminalOwner) {
      lensOwnerTerminal = true
      lensBackend?.dispose()
      lensBackend = null
      lensRemapProvider = null
    }
    lensRemapAvailability = lensUnavailable(error.message)
    syncCanvases()
  }

  /** Size every disposable canvas to the active presentation profile. */
  function syncCanvases(): void {
    const profile = currentPresentationProfile()
    if (!visible || !profile) return
    const { outputWidth, outputHeight } = profile
    assertRenderSurfaceBudget(outputWidth, outputHeight)
    if (visible.width !== outputWidth || visible.height !== outputHeight) {
      visible.width = outputWidth
      visible.height = outputHeight
    }
    if (!scratch) {
      scratch = env.createCanvas(outputWidth, outputHeight)
      scratchCtx = scratch.getContext('2d', SRGB_2D_CONTEXT)
      if (!scratchCtx) {
        env.post({ type: 'error', message: 'scratch canvas 2d context unavailable' })
      }
    } else if (scratch.width !== outputWidth || scratch.height !== outputHeight) {
      scratch.width = outputWidth
      scratch.height = outputHeight
    }
    if (scratchCtx) {
      const canvasFilter = supportsCanvasEffectFilter(scratchCtx)
      const canvasPixelAccess = supportsCanvasEffectPixels(scratchCtx)
      lensRemapProvider?.setOutputSurface?.(
        outputWidth,
        outputHeight,
        false,
      )
      const lensCapabilityKey = JSON.stringify(lensRemapAvailability ?? null)
      if (
        canvasFilter !== publishedCanvasFilterCapability
        || canvasPixelAccess !== publishedCanvasPixelCapability
        || lensCapabilityKey !== publishedLensCapabilityKey
      ) {
        publishedCanvasFilterCapability = canvasFilter
        publishedCanvasPixelCapability = canvasPixelAccess
        publishedLensCapabilityKey = lensCapabilityKey
        env.post({
          type: 'rendererCapabilities',
          capabilities: {
            canvasFilter,
            canvasPixelAccess,
            ...(lensRemapAvailability ? { lensRemap: lensRemapAvailability } : {}),
          },
        })
      }
    }
    if (
      transitionLeg
      && (
        transitionLeg.width !== outputWidth
        || transitionLeg.height !== outputHeight
      )
    ) {
      transitionLeg.width = outputWidth
      transitionLeg.height = outputHeight
    }
    if (
      transitionGroup
      && (
        transitionGroup.width !== outputWidth
        || transitionGroup.height !== outputHeight
      )
    ) {
      transitionGroup.width = outputWidth
      transitionGroup.height = outputHeight
    }
  }

  function releaseVideoScopeSurface(): void {
    if (videoScopeCanvas) {
      videoScopeCanvas.width = 1
      videoScopeCanvas.height = 1
    }
    videoScopeCanvas = null
    videoScopeCtx = null
  }

  function setVideoScopes(enabled: boolean, nextGeneration: number): void {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 0) {
      throw new RangeError('video scope generation must be a non-negative safe integer')
    }
    videoScopesEnabled = enabled
    videoScopeGeneration = nextGeneration
    lastVideoScopeAnalysisAt = Number.NEGATIVE_INFINITY
    if (!enabled) {
      releaseVideoScopeSurface()
      void env.releaseVideoScopes?.()
    }
  }

  function scheduleVideoScopes(): void {
    if (
      !videoScopesEnabled
      || publishedCanvasPixelCapability !== true
      || videoScopeTaskPending
      || env.now() - lastVideoScopeAnalysisAt < 250
    ) return

    const scheduledGeneration = videoScopeGeneration
    const scheduledLifecycle = workerLifecycle
    videoScopeTaskPending = true
    const run = async (): Promise<void> => {
      if (
        !videoScopesEnabled
        || videoScopeGeneration !== scheduledGeneration
        || workerLifecycle !== scheduledLifecycle
        || !scratch
      ) {
        videoScopeTaskPending = false
        return
      }

      try {
        const sampledFrame = scratchFrame
        if (sampledFrame === null) return
        if (!videoScopeCanvas) {
          videoScopeCanvas = env.createCanvas(
            VIDEO_SCOPE_SAMPLE_WIDTH,
            VIDEO_SCOPE_SAMPLE_HEIGHT,
          )
          videoScopeCtx = videoScopeCanvas.getContext('2d', SRGB_2D_CONTEXT)
        }
        if (
          !videoScopeCtx
          || !supportsCanvasEffectPixels(videoScopeCtx)
          || !videoScopeCtx.getImageData
        ) return
        videoScopeCtx.clearRect(
          0,
          0,
          VIDEO_SCOPE_SAMPLE_WIDTH,
          VIDEO_SCOPE_SAMPLE_HEIGHT,
        )
        videoScopeCtx.drawImage(
          scratch as unknown as CanvasImageSource,
          0,
          0,
          scratch.width,
          scratch.height,
          0,
          0,
          VIDEO_SCOPE_SAMPLE_WIDTH,
          VIDEO_SCOPE_SAMPLE_HEIGHT,
        )
        const pixels = videoScopeCtx.getImageData(
          0,
          0,
          VIDEO_SCOPE_SAMPLE_WIDTH,
          VIDEO_SCOPE_SAMPLE_HEIGHT,
        )
        const analysis = env.analyzeVideoScopes
          ? await env.analyzeVideoScopes(
              pixels.data,
              VIDEO_SCOPE_SAMPLE_WIDTH,
              VIDEO_SCOPE_SAMPLE_HEIGHT,
            )
          : analyzeVideoScopes(
              pixels.data,
              VIDEO_SCOPE_SAMPLE_WIDTH,
              VIDEO_SCOPE_SAMPLE_HEIGHT,
            )
        const analyzedAt = env.now()
        if (
          !videoScopesEnabled
          || videoScopeGeneration !== scheduledGeneration
          || workerLifecycle !== scheduledLifecycle
        ) return
        lastVideoScopeAnalysisAt = analyzedAt
        env.post({
          type: 'videoScopes',
          generation: scheduledGeneration,
          frame: sampledFrame,
          analyzedAt,
          analysis,
        })
      } catch {
        // Scopes are diagnostic only: sampling failures never fail playback.
      } finally {
        videoScopeTaskPending = false
      }
    }
    const invoke = (): void => { void run() }
    if (env.schedule) env.schedule(invoke)
    else queueMicrotask(invoke)
  }

  const transitionSurfaceProvider: TransitionSurfaceProvider = {
    get: (): TransitionSurfaces => {
      const profile = currentPresentationProfile()
      if (!profile) throw new Error('transition surfaces requested before setDoc')
      if (!transitionLeg) {
        transitionLeg = env.createCanvas(profile.outputWidth, profile.outputHeight)
        transitionLegCtx = transitionLeg.getContext('2d', SRGB_2D_CONTEXT)
      }
      if (!transitionGroup) {
        transitionGroup = env.createCanvas(profile.outputWidth, profile.outputHeight)
        transitionGroupCtx = transitionGroup.getContext('2d', SRGB_2D_CONTEXT)
      }
      if (!transitionLegCtx || !transitionGroupCtx) {
        throw new Error('transition canvas 2d context unavailable')
      }
      return {
        leg: {
          canvas: transitionLeg as unknown as CanvasImageSource,
          ctx: transitionLegCtx,
        },
        group: {
          canvas: transitionGroup as unknown as CanvasImageSource,
          ctx: transitionGroupCtx,
        },
      }
    },
  }

  legacyCompatibility = createLegacyRenderWorkerCompatibility(env, {
    supersede,
    generationIsCurrent: (candidate) => generation === candidate,
    isReady: () => Boolean(visibleCtx && scratch && scratchCtx && doc),
    createCache: (capacity) => new FrameRingBuffer<BitmapLike>(capacity),
    enqueueComposite: (run) => {
      compositeChain = compositeChain.then(run)
      return compositeChain
    },
    composite: (plan, source) => {
      if (!doc || !scratchCtx) {
        throw new Error('legacy composite invoked before init/setDoc')
      }
      return compositeFrame(
        doc,
        plan,
        scratchCtx,
        source as FrameSource,
        transitionSurfaceProvider,
        currentPresentationProfile() ?? undefined,
        lensRemapProvider,
      )
    },
    present: () => {
      if (!visibleCtx || !scratch) {
        throw new Error('legacy presentation invoked before init/setDoc')
      }
      visibleCtx.drawImage(scratch as unknown as ImageBitmap, 0, 0)
    },
  })

  function closeOwnedStreamingFrame(frame: OwnedStreamingFrame | null): void {
    closeStreamingBitmap(frame?.bitmap ?? null)
  }

  async function disposePlaybackLane(lane: PlaybackLaneState): Promise<void> {
    if (lane.closed) return
    lane.closed = true
    lane.epoch++
    closeOwnedStreamingFrame(lane.current)
    closeOwnedStreamingFrame(lane.lookahead)
    lane.current = null
    lane.lookahead = null
    await lane.cursor.close()
  }

  async function closePlaybackLane(
    state: StreamingAssetState,
    clipId: ClipId,
  ): Promise<void> {
    const lane = state.lanes.get(clipId)
    if (!lane) return
    state.lanes.delete(clipId)
    await disposePlaybackLane(lane)
  }

  async function teardownStreamingAsset(state: StreamingAssetState): Promise<void> {
    state.epoch++
    const lanes = [...state.lanes.values()]
    state.lanes.clear()
    const closeResults = await Promise.allSettled([
      ...lanes.map((lane) => disposePlaybackLane(lane)),
      state.source.close(),
    ])
    while (state.pendingCopies.size > 0) {
      await Promise.allSettled([...state.pendingCopies])
    }
    const errors = closeResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close streaming render asset')
    }
  }

  async function removeStreamingAsset(assetId: AssetId): Promise<void> {
    const state = streamingAssets.get(assetId)
    if (!state) return
    streamingAssets.delete(assetId)
    await teardownStreamingAsset(state)
  }

  function createStaticImageAssetState(
    source: StaticImageRenderSource,
    decodedBytes: number,
    reservation: StaticImageDecodedByteReservation,
  ): StaticImageAssetState {
    let resolveClosed: () => void = () => undefined
    let rejectClosed: (error: unknown) => void = () => undefined
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve
      rejectClosed = reject
    })
    return {
      source,
      decodedBytes,
      reservation,
      loans: 0,
      retired: false,
      closed: false,
      closePromise,
      resolveClosed,
      rejectClosed,
    }
  }

  function reserveStaticImageBytes(
    inspectedDecodedBytes: number,
  ): StaticImageDecodedByteReservation {
    if (
      !Number.isSafeInteger(inspectedDecodedBytes)
      || inspectedDecodedBytes <= 0
    ) {
      throw new StaticImageResidentBudgetError(
        'Inspected still-image allocation could not be accounted.',
      )
    }
    if (
      inspectedDecodedBytes > STATIC_IMAGE_RESIDENT_BUDGET_BYTES
      || inspectedDecodedBytes
        > STATIC_IMAGE_RESIDENT_BUDGET_BYTES - residentStaticImageBytes
    ) {
      throw new StaticImageResidentBudgetError(
        'Resident still-image budget exceeded before decode: '
        + `${residentStaticImageBytes} + ${inspectedDecodedBytes} > `
        + `${STATIC_IMAGE_RESIDENT_BUDGET_BYTES} bytes.`,
      )
    }

    residentStaticImageBytes += inspectedDecodedBytes
    let bytes = inspectedDecodedBytes
    let released = false
    return {
      reconcile: (decodedBytes) => {
        if (
          released
          || !Number.isSafeInteger(decodedBytes)
          || decodedBytes <= 0
        ) return false
        const otherResidentBytes = residentStaticImageBytes - bytes
        if (
          otherResidentBytes < 0
          || decodedBytes
            > STATIC_IMAGE_RESIDENT_BUDGET_BYTES - otherResidentBytes
        ) return false
        residentStaticImageBytes = otherResidentBytes + decodedBytes
        bytes = decodedBytes
        return true
      },
      release: () => {
        if (released) return
        released = true
        residentStaticImageBytes -= bytes
        bytes = 0
        if (residentStaticImageBytes < 0) {
          residentStaticImageBytes = 0
          throw new Error('Resident still-image byte ledger underflow')
        }
      },
    }
  }

  function rejectUninstalledStaticImage(
    decoded: DecodedStaticImage,
    reservations: readonly (
      StaticImageDecodedByteReservation | null | undefined
    )[],
    message: string,
    cause?: unknown,
  ): never {
    let cleanupError: unknown
    try {
      closeStaticImageSource(decoded.source)
    } catch (error) {
      cleanupError = error
    }
    const uniqueReservations = new Set(
      reservations.filter(
        (reservation): reservation is StaticImageDecodedByteReservation =>
          reservation !== null && reservation !== undefined,
      ),
    )
    for (const reservation of uniqueReservations) {
      try {
        reservation.release()
      } catch (error) {
        cleanupError = cleanupError === undefined
          ? error
          : new AggregateError(
              [cleanupError, error],
              'Still-image source and reservation cleanup failed',
            )
      }
    }
    const combinedCause = cause === undefined
      ? cleanupError
      : cleanupError === undefined
        ? cause
        : new AggregateError(
            [cause, cleanupError],
            'Still-image budget rejection cleanup failed',
          )
    throw new StaticImageResidentBudgetError(message, combinedCause)
  }

  function installStaticImage(
    decoded: DecodedStaticImage,
    expectedReservation: StaticImageDecodedByteReservation | null,
  ): StaticImageAssetState {
    const reservation = decoded.decodedByteReservation ?? null
    if (reservation !== expectedReservation) {
      return rejectUninstalledStaticImage(
        decoded,
        [expectedReservation, reservation],
        'Still-image decoder returned a different resident-byte reservation.',
      )
    }
    let decodedBytes: number
    try {
      decodedBytes = staticImageDecodedByteLength(decoded)
    } catch (error) {
      return rejectUninstalledStaticImage(
        decoded,
        [reservation],
        'Decoded still-image allocation could not be accounted.',
        error,
      )
    }
    if (reservation === null) {
      return rejectUninstalledStaticImage(
        decoded,
        [],
        'Still-image decoder bypassed the required resident-byte reservation.',
      )
    }
    if (!reservation.reconcile(decodedBytes)) {
      return rejectUninstalledStaticImage(
        decoded,
        [reservation],
        'Resident still-image budget exceeded while reconciling the exact '
        + `${decodedBytes}-byte allocation.`,
      )
    }
    return createStaticImageAssetState(
      decoded.source,
      decodedBytes,
      reservation,
    )
  }

  /** Close only after every composite that borrowed this source has settled. */
  function maybeCloseStaticImage(state: StaticImageAssetState): void {
    if (!state.retired || state.loans !== 0 || state.closed) return
    state.closed = true
    let closeError: unknown
    try {
      closeStaticImageSource(state.source)
    } catch (error) {
      closeError = error
    }
    try {
      state.reservation.release()
    } catch (error) {
      closeError = closeError === undefined
        ? error
        : new AggregateError(
            [closeError, error],
            'Still-image source and reservation close failed',
          )
    }
    if (closeError === undefined) state.resolveClosed()
    else state.rejectClosed(closeError)
  }

  function retireStaticImage(state: StaticImageAssetState): Promise<void> {
    state.retired = true
    maybeCloseStaticImage(state)
    return state.closePromise
  }

  function trackStaticImageRetirement(
    assetId: AssetId,
    state: StaticImageAssetState,
  ): Promise<void> {
    const retirement = retireStaticImage(state)
    staticImageRetirementByAsset.set(assetId, retirement)
    outstandingStaticImageRetirements.add(retirement)
    const finished = () => {
      if (staticImageRetirementByAsset.get(assetId) === retirement) {
        staticImageRetirementByAsset.delete(assetId)
      }
      outstandingStaticImageRetirements.delete(retirement)
    }
    void retirement.then(finished, finished)
    return retirement
  }

  async function removeStaticImageAsset(assetId: AssetId): Promise<void> {
    const previousRetirement = staticImageRetirementByAsset.get(assetId)
    if (previousRetirement) {
      // The operation that began this retirement owns its diagnostic. A newer
      // generation only needs the exact-close barrier before it may decode.
      await previousRetirement.catch(() => undefined)
    }
    const state = staticImageAssets.get(assetId)
    if (!state) return
    staticImageAssets.delete(assetId)
    await trackStaticImageRetirement(assetId, state)
  }

  function borrowStaticImage(
    assetId: AssetId,
    state: StaticImageAssetState,
  ): StaticImageLoan | null {
    if (
      state.retired
      || state.closed
      || staticImageAssets.get(assetId) !== state
    ) return null
    state.loans++
    let settled = false
    return {
      source: state.source,
      settle: () => {
        if (settled) return
        settled = true
        state.loans--
        maybeCloseStaticImage(state)
      },
    }
  }

  function abortPendingStaticImageOpen(assetId: AssetId): void {
    pendingStaticImageOpens.get(assetId)?.controller.abort()
  }

  function collectClipDecodeIdentities(
    value: TimelineDoc | null,
  ): Map<ClipId, ClipDecodeIdentity> {
    const identities = new Map<ClipId, ClipDecodeIdentity>()
    if (!value) return identities
    for (const track of value.tracks) {
      if (track.kind !== 'video') continue
      for (const clip of track.clips) {
        identities.set(clip.id, {
          assetId: clip.assetId,
          sourceStart: clip.sourceRange.startFrame,
          sourceDuration: clip.sourceRange.durationFrames,
          timelineStart: clip.timelineRange.startFrame,
          timelineDuration: clip.timelineRange.durationFrames,
        })
      }
    }
    return identities
  }

  function sameClipDecodeIdentity(
    left: ClipDecodeIdentity | undefined,
    right: ClipDecodeIdentity | undefined,
  ): boolean {
    return (
      left !== undefined
      && right !== undefined
      && left.assetId === right.assetId
      && left.sourceStart === right.sourceStart
      && left.sourceDuration === right.sourceDuration
      && left.timelineStart === right.timelineStart
      && left.timelineDuration === right.timelineDuration
    )
  }

  function invalidatePlaybackPolicyForDoc(
    previousDoc: TimelineDoc | null,
    nextDoc: TimelineDoc,
  ): void {
    if (!previousDoc) return
    const previous = collectClipDecodeIdentities(previousDoc)
    const next = collectClipDecodeIdentities(nextDoc)
    const frameRateChanged = (
      previousDoc.frameRate.num !== nextDoc.frameRate.num
      || previousDoc.frameRate.den !== nextDoc.frameRate.den
    )
    for (const [clipId, identity] of previous) {
      const key = playbackLaneKey(identity.assetId, clipId)
      if (
        desiredPlaybackLaneKeys.has(key)
        && (frameRateChanged || !sameClipDecodeIdentity(identity, next.get(clipId)))
      ) {
        const revision = bumpPlaybackLaneRevision(key)
        desiredPlaybackLaneKeys.delete(key)
        clearPlaybackLaneRevision(key, revision)
      }
    }
  }

  async function prunePlaybackLanes(
    previousDoc: TimelineDoc | null,
    nextDoc: TimelineDoc,
  ): Promise<void> {
    const previous = collectClipDecodeIdentities(previousDoc)
    const next = collectClipDecodeIdentities(nextDoc)
    const frameRateChanged = previousDoc !== null && (
      previousDoc.frameRate.num !== nextDoc.frameRate.num
      || previousDoc.frameRate.den !== nextDoc.frameRate.den
    )

    const closes: Promise<void>[] = []
    for (const [assetId, state] of streamingAssets) {
      for (const clipId of state.lanes.keys()) {
        const compatible = (
          !frameRateChanged
          && sameClipDecodeIdentity(previous.get(clipId), next.get(clipId))
          && next.get(clipId)?.assetId === assetId
        )
        if (!compatible) {
          desiredPlaybackLaneKeys.delete(playbackLaneKey(assetId, clipId))
          closes.push(closePlaybackLane(state, clipId))
        }
      }
    }
    const results = await Promise.allSettled(closes)
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to prune streaming playback lanes')
    }
  }

  async function copyDecodedFrame(
    state: StreamingAssetState,
    decoded: DecodedVideoFrame,
  ): Promise<OwnedStreamingFrame> {
    const job = (async (): Promise<OwnedStreamingFrame> => {
      try {
        return {
          timestampUs: decoded.timestampUs,
          bitmap: await env.createStreamingBitmap(decoded),
        }
      } finally {
        closeDecodedFrame(decoded)
      }
    })()
    state.pendingCopies.add(job)
    try {
      return await job
    } finally {
      state.pendingCopies.delete(job)
    }
  }

  function closeDecodedFrame(frame: DecodedVideoFrame | null): void {
    if (!frame) return
    frame.frame.close()
    if (runtimeTelemetryEnabled) decodedVideoFrameCloses++
  }

  function playbackLaneKey(assetId: AssetId, clipId: ClipId): string {
    return `${assetId}\u0000${clipId}`
  }

  function bumpPlaybackLaneRevision(key: string): number {
    const revision = nextRevisionToken()
    playbackLaneRevisions.set(key, revision)
    return revision
  }

  function clearPlaybackLaneRevision(key: string, revision: number): void {
    if (playbackLaneRevisions.get(key) === revision) {
      playbackLaneRevisions.delete(key)
    }
  }

  function sameLaneKeySet(left: Set<string>, right: Set<string>): boolean {
    if (left.size !== right.size) return false
    for (const key of left) {
      if (!right.has(key)) return false
    }
    return true
  }

  function playbackPolicyAllows(
    entry: StreamingVideoSourceEntry,
    revision: number,
  ): boolean {
    const key = playbackLaneKey(entry.assetId, entry.clipId)
    return (
      (playbackLaneRevisions.get(key) ?? 0) === revision
      && desiredPlaybackLaneKeys.has(key)
    )
  }

  function applyPlaybackPolicy(
    msg: RenderFrameMessage,
  ): Promise<unknown[]> {
    const videoSources = msg.sources.filter(
      (entry): entry is StreamingVideoSourceEntry =>
        entry.kind === 'video' && streamingAssets.has(entry.assetId),
    )
    const nextKeys = msg.mode === 'playback'
      ? new Set(videoSources.map((entry) =>
          playbackLaneKey(entry.assetId, entry.clipId),
        ))
      : new Set<string>()
    const retiredRevisions = new Map<string, number>()
    if (!sameLaneKeySet(desiredPlaybackLaneKeys, nextKeys)) {
      const changedKeys = new Set([...desiredPlaybackLaneKeys, ...nextKeys])
      for (const key of changedKeys) {
        if (desiredPlaybackLaneKeys.has(key) !== nextKeys.has(key)) {
          const revision = bumpPlaybackLaneRevision(key)
          if (!nextKeys.has(key)) retiredRevisions.set(key, revision)
        }
      }
    }
    desiredPlaybackLaneKeys = nextKeys
    for (const [key, revision] of retiredRevisions) {
      clearPlaybackLaneRevision(key, revision)
    }

    const closes: Promise<void>[] = []
    for (const [assetId, state] of streamingAssets) {
      for (const clipId of state.lanes.keys()) {
        if (!nextKeys.has(playbackLaneKey(assetId, clipId))) {
          closes.push(closePlaybackLane(state, clipId))
        }
      }
    }
    return Promise.allSettled(closes).then((results) =>
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
    )
  }

  function streamingStateIsCurrent(
    assetId: AssetId,
    state: StreamingAssetState,
  ): boolean {
    return streamingAssets.get(assetId) === state
  }

  function playbackLaneIsCurrent(
    entry: StreamingVideoSourceEntry,
    state: StreamingAssetState,
    lane: PlaybackLaneState,
  ): boolean {
    return (
      streamingStateIsCurrent(entry.assetId, state)
      && state.lanes.get(entry.clipId) === lane
      && !lane.closed
    )
  }

  function shouldRestartPlaybackLane(
    lane: PlaybackLaneState,
    entry: StreamingVideoSourceEntry,
  ): boolean {
    if (lane.lastSourceFrame === null || lane.lastTargetTimestampUs === null) {
      return false
    }
    return (
      entry.sourceFrame < lane.lastSourceFrame
      || entry.targetTimestampUs < lane.lastTargetTimestampUs
      || entry.targetTimestampUs - lane.lastTargetTimestampUs > PLAYBACK_RESTART_GAP_US
    )
  }

  function createPlaybackLane(
    state: StreamingAssetState,
    entry: StreamingVideoSourceEntry,
  ): PlaybackLaneState {
    const lane: PlaybackLaneState = {
      clipId: entry.clipId,
      cursor: state.source.openPlaybackLane({
        startTimestampUs: entry.targetTimestampUs,
      }),
      current: null,
      lookahead: null,
      lastSourceFrame: null,
      lastTargetTimestampUs: null,
      epoch: 0,
      ended: false,
      closed: false,
    }
    state.lanes.set(entry.clipId, lane)
    return lane
  }

  async function resolvePlaybackEntry(
    state: StreamingAssetState,
    entry: StreamingVideoSourceEntry,
    loans: StreamingLoan[],
    requestId: number,
  ): Promise<BitmapLike | null> {
    const key = playbackLaneKey(entry.assetId, entry.clipId)
    const policyRevision = playbackLaneRevisions.get(key) ?? 0
    if (!playbackPolicyAllows(entry, policyRevision)) return null
    try {
      let lane = state.lanes.get(entry.clipId)
      if (lane && shouldRestartPlaybackLane(lane, entry)) {
        await closePlaybackLane(state, entry.clipId)
        lane = undefined
      }
      if (
        !streamingStateIsCurrent(entry.assetId, state)
        || !playbackPolicyAllows(entry, policyRevision)
      ) {
        return null
      }
      lane ??= createPlaybackLane(state, entry)
      if (
        lane.current
        && lane.current.timestampUs <= entry.targetTimestampUs
        && (
          lane.lookahead === null
          || lane.lookahead.timestampUs > entry.targetTimestampUs
        )
      ) countCacheHit()
      else countCacheMiss()

      let candidate: DecodedVideoFrame | null = null
      let pendingFuture: DecodedVideoFrame | null = null
      try {
        while (
          playbackLaneIsCurrent(entry, state, lane)
          && playbackPolicyAllows(entry, policyRevision)
        ) {
          const lookahead = lane.lookahead
          if (lookahead) {
            if (lookahead.timestampUs > entry.targetTimestampUs) break
            closeOwnedStreamingFrame(lane.current)
            lane.current = lookahead
            lane.lookahead = null
            continue
          }
          if (lane.ended) break

          const decoded = await trackedDecode(() => lane.cursor.next())
          if (
            !playbackLaneIsCurrent(entry, state, lane)
            || !playbackPolicyAllows(entry, policyRevision)
          ) {
            closeDecodedFrame(decoded)
            try {
              await closePlaybackLane(state, entry.clipId)
            } catch {
              // Intentional invalidation is already taking ownership down.
            }
            return null
          }
          if (!decoded) {
            lane.ended = true
            break
          }
          if (decoded.timestampUs <= entry.targetTimestampUs) {
            closeDecodedFrame(candidate)
            candidate = decoded
            continue
          }
          pendingFuture = decoded

          if (candidate) {
            const selected = candidate
            candidate = null
            const current = await copyDecodedFrame(state, selected)
            if (
              !playbackLaneIsCurrent(entry, state, lane)
              || !playbackPolicyAllows(entry, policyRevision)
            ) {
              closeStreamingBitmap(current.bitmap)
              closeDecodedFrame(pendingFuture)
              pendingFuture = null
              return null
            }
            closeOwnedStreamingFrame(lane.current)
            lane.current = current
          }

          const selectedFuture = pendingFuture
          pendingFuture = null
          const future = await copyDecodedFrame(state, selectedFuture)
          if (
            !playbackLaneIsCurrent(entry, state, lane)
            || !playbackPolicyAllows(entry, policyRevision)
          ) {
            closeStreamingBitmap(future.bitmap)
            return null
          }
          lane.lookahead = future
          break
        }

        if (candidate) {
          const selected = candidate
          candidate = null
          const current = await copyDecodedFrame(state, selected)
          if (
            !playbackLaneIsCurrent(entry, state, lane)
            || !playbackPolicyAllows(entry, policyRevision)
          ) {
            closeStreamingBitmap(current.bitmap)
            return null
          }
          closeOwnedStreamingFrame(lane.current)
          lane.current = current
        }
      } finally {
        closeDecodedFrame(candidate)
        closeDecodedFrame(pendingFuture)
      }

      if (
        !playbackLaneIsCurrent(entry, state, lane)
        || !playbackPolicyAllows(entry, policyRevision)
      ) {
        return null
      }
      lane.lastSourceFrame = entry.sourceFrame
      lane.lastTargetTimestampUs = entry.targetTimestampUs
      const current = lane.current
      if (!current) return null

      const assetEpoch = state.epoch
      const laneEpoch = lane.epoch
      lane.current = null
      loans.push({
        bitmap: current.bitmap,
        settle: () => {
          if (
            streamingStateIsCurrent(entry.assetId, state)
            && state.epoch === assetEpoch
            && state.lanes.get(entry.clipId) === lane
            && lane.epoch === laneEpoch
            && !lane.closed
            && lane.current === null
            && playbackPolicyAllows(entry, policyRevision)
          ) {
            lane.current = current
          } else {
            closeStreamingBitmap(current.bitmap)
          }
        },
      })
      return current.bitmap
    } catch (error) {
      try {
        await closePlaybackLane(state, entry.clipId)
      } catch {
        // The original decode/copy error is the useful one to report.
      }
      if (
        !streamingStateIsCurrent(entry.assetId, state)
        || !playbackPolicyAllows(entry, policyRevision)
      ) {
        return null
      }
      env.post({
        type: 'error',
        requestId,
        assetId: entry.assetId,
        message: `streaming playback failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      return null
    }
  }

  async function resolveSeekEntry(
    state: StreamingAssetState,
    entry: StreamingVideoSourceEntry,
    myGen: number,
    loans: StreamingLoan[],
    requestId: number,
  ): Promise<BitmapLike | null> {
    let cursor: VideoFrameCursor | null = null
    try {
      // A scrub is an intentional mode discontinuity for this clip.
      await closePlaybackLane(state, entry.clipId)
      if (generation !== myGen || !streamingStateIsCurrent(entry.assetId, state)) {
        return null
      }

      cursor = state.source.openSeekLane(entry.targetTimestampUs)
      activeSeekCursors.add(cursor)
      countCacheMiss()
      const activeCursor = cursor
      const decoded = await trackedDecode(() => activeCursor.next())
      if (!decoded) return null
      if (generation !== myGen || !streamingStateIsCurrent(entry.assetId, state)) {
        closeDecodedFrame(decoded)
        return null
      }
      const frame = await copyDecodedFrame(state, decoded)
      if (generation !== myGen || !streamingStateIsCurrent(entry.assetId, state)) {
        closeStreamingBitmap(frame.bitmap)
        return null
      }

      loans.push({
        bitmap: frame.bitmap,
        settle: () => closeStreamingBitmap(frame.bitmap),
      })
      return frame.bitmap
    } catch (error) {
      if (generation === myGen && streamingStateIsCurrent(entry.assetId, state)) {
        env.post({
          type: 'error',
          requestId,
          assetId: entry.assetId,
          message: `streaming seek failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      return null
    } finally {
      if (cursor) {
        activeSeekCursors.delete(cursor)
        try {
          await cursor.close()
        } catch {
          // A source replacement/cancellation may already be closing it.
        }
      }
    }
  }

  /** Install one deprecated chunk decoder after current sources retire. */
  async function configureAssetAtRevision(
    msg: Extract<ToRenderWorker, { type: 'configureAsset' }>,
    revision: number,
    lifecycle: number,
  ): Promise<void> {
    env.invalidateDecoderSource(msg.assetId)
    supersede() // in-flight composites may reference the machinery we replace
    legacyCompatibility?.releaseAsset(msg.assetId)
    try {
      await removeStreamingAsset(msg.assetId)
      await removeStaticImageAsset(msg.assetId)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
    if (!legacyCompatibility) {
      throw new Error('legacy render compatibility is unavailable')
    }
    await legacyCompatibility.configureAsset(
      msg,
      () => assetRevisionIsCurrent(msg.assetId, revision, lifecycle),
    )
  }

  async function handleConfigureAsset(
    msg: Extract<ToRenderWorker, { type: 'configureAsset' }>,
  ): Promise<void> {
    const revision = nextAssetRevision(msg.assetId)
    abortPendingStaticImageOpen(msg.assetId)
    const lifecycle = workerLifecycle
    try {
      await configureAssetAtRevision(msg, revision, lifecycle)
    } finally {
      clearAssetRevision(msg.assetId, revision)
    }
  }

  async function openAssetAtRevision(
    msg: Extract<ToRenderWorker, { type: 'openAsset' }>,
    revision: number,
    lifecycle: number,
  ): Promise<void> {
    env.invalidateDecoderSource(msg.assetId)
    supersede()

    legacyCompatibility?.releaseAsset(msg.assetId)
    try {
      await removeStreamingAsset(msg.assetId)
      await removeStaticImageAsset(msg.assetId)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return

    let source: WorkerVideoSource
    try {
      source = await env.openVideoSource(msg.blob, msg.assetId, msg.budget)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      env.invalidateDecoderSource(msg.assetId)
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) {
      try {
        await source.close()
      } catch {
        // This open lost its revision; never reject the newer asset waiter.
      }
      return
    }

    streamingAssets.set(msg.assetId, {
      source,
      lanes: new Map(),
      pendingCopies: new Set(),
      epoch: 0,
    })
    env.post({
      type: 'assetConfigured',
      assetId: msg.assetId,
      setupId: msg.setupId,
    })
  }

  async function handleOpenAsset(
    msg: Extract<ToRenderWorker, { type: 'openAsset' }>,
  ): Promise<void> {
    const revision = nextAssetRevision(msg.assetId)
    abortPendingStaticImageOpen(msg.assetId)
    const lifecycle = workerLifecycle
    try {
      await openAssetAtRevision(msg, revision, lifecycle)
    } finally {
      clearAssetRevision(msg.assetId, revision)
    }
  }

  function staticImageFailure(error: unknown): {
    trackKind: null
    reason: 'resource-limit' | 'decode-failed'
  } {
    return {
      trackKind: null,
      reason:
        error instanceof StaticImageResidentBudgetError
        || (
          error instanceof StaticImageDecodeError
          && error.reason === 'resource-limit'
        )
          ? 'resource-limit'
          : 'decode-failed',
    }
  }

  async function closeStaleStaticImageSource(
    assetId: AssetId,
    source: StaticImageRenderSource,
    lifecycle: number,
  ): Promise<void> {
    try {
      source.close()
    } catch (error) {
      if (workerLifecycle === lifecycle) {
        env.post({
          type: 'error',
          message:
            `stale image cleanup failed for asset ${assetId}: `
            + (error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error)),
        })
      }
    }
  }

  async function openImageAtRevision(
    msg: Extract<ToRenderWorker, { type: 'openImage' }>,
    revision: number,
    lifecycle: number,
    signal: AbortSignal,
  ): Promise<void> {
    env.invalidateDecoderSource(msg.assetId)
    supersede()

    legacyCompatibility?.releaseAsset(msg.assetId)
    try {
      await removeStreamingAsset(msg.assetId)
      await removeStaticImageAsset(msg.assetId)
    } catch (error) {
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      throw error
    }
    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return

    let decoded: DecodedStaticImage
    let reservationRequested = false
    const reservationCapture: {
      current: StaticImageDecodedByteReservation | null
    } = { current: null }
    const reserveDecodedBytes: StaticImageDecodedByteReserver = (
      inspectedDecodedBytes,
    ) => {
      if (reservationRequested) {
        throw new StaticImageResidentBudgetError(
          'Still-image decoder requested more than one byte reservation.',
        )
      }
      reservationRequested = true
      reservationCapture.current = reserveStaticImageBytes(
        inspectedDecodedBytes,
      )
      return reservationCapture.current
    }
    try {
      decoded = await env.decodeImage(
        msg.blob,
        signal,
        reserveDecodedBytes,
      )
    } catch (error) {
      // The production decoder releases failed/cancelled leases itself. The
      // worker repeats the idempotent release so a faulty injected decoder
      // cannot strand realm budget after requesting a lease and rejecting.
      reservationCapture.current?.release()
      if (
        signal.aborted
        || !assetRevisionIsCurrent(msg.assetId, revision, lifecycle)
      ) return
      env.invalidateDecoderSource(msg.assetId)
      throw error
    }

    const reservedBytes = reservationCapture.current
    const returnedReservation = decoded.decodedByteReservation ?? null
    if (returnedReservation !== reservedBytes) {
      try {
        rejectUninstalledStaticImage(
          decoded,
          [reservedBytes, returnedReservation],
          'Still-image decoder returned a different resident-byte reservation.',
        )
      } catch (error) {
        if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
        throw error
      }
    }

    if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) {
      await closeStaleStaticImageSource(
        msg.assetId,
        decoded.source,
        lifecycle,
      )
      reservedBytes?.release()
      return
    }

    staticImageAssets.set(
      msg.assetId,
      installStaticImage(decoded, reservedBytes),
    )
    env.post({
      type: 'assetConfigured',
      assetId: msg.assetId,
      setupId: msg.setupId,
    })
  }

  async function handleOpenImage(
    msg: Extract<ToRenderWorker, { type: 'openImage' }>,
  ): Promise<void> {
    const revision = nextAssetRevision(msg.assetId)
    const previousOpen = pendingStaticImageOpens.get(msg.assetId)
    previousOpen?.controller.abort()
    const lifecycle = workerLifecycle
    const controller = new AbortController()
    const operation: PendingStaticImageOpen = {
      revision,
      controller,
      done: Promise.resolve(),
    }
    pendingStaticImageOpens.set(msg.assetId, operation)
    operation.done = (async () => {
      if (previousOpen) await previousOpen.done.catch(() => undefined)
      if (!assetRevisionIsCurrent(msg.assetId, revision, lifecycle)) return
      await openImageAtRevision(
        msg,
        revision,
        lifecycle,
        controller.signal,
      )
    })()
    try {
      await operation.done
    } finally {
      if (pendingStaticImageOpens.get(msg.assetId) === operation) {
        pendingStaticImageOpens.delete(msg.assetId)
      }
      clearAssetRevision(msg.assetId, revision)
    }
  }

  async function handleReleaseAsset(assetId: AssetId): Promise<void> {
    const revision = nextAssetRevision(assetId)
    abortPendingStaticImageOpen(assetId)
    const lifecycle = workerLifecycle
    try {
      env.invalidateDecoderSource(assetId)
      supersede()
      legacyCompatibility?.releaseAsset(assetId)
      try {
        await removeStreamingAsset(assetId)
        await removeStaticImageAsset(assetId)
      } catch (error) {
        if (!assetRevisionIsCurrent(assetId, revision, lifecycle)) {
          // This cleanup belonged to a source that a newer open already
          // replaced. Keep the diagnostic global so it cannot reject or
          // disconnect that newer asset generation.
          if (workerLifecycle === lifecycle) {
            env.post({
              type: 'error',
              message:
                `stale release cleanup failed for asset ${assetId}: `
                + (error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error)),
            })
          }
          return
        }
        throw error
      }
    } finally {
      clearAssetRevision(assetId, revision)
    }
  }

  function handleComposite(
    msg: Extract<ToRenderWorker, { type: 'composite' }>,
  ): Promise<void> {
    if (!legacyCompatibility) {
      return Promise.reject(
        new Error('legacy render compatibility is unavailable'),
      )
    }
    return legacyCompatibility.handleComposite(msg)
  }

  function handleRenderFrame(msg: RenderFrameMessage): Promise<void> {
    // A newer request supersedes only visible presentation. Playback lanes
    // keep decoding on the serialized chain and can serve the newer request.
    const myGen = supersede()
    // Mode changes and cuts retire obsolete playback cursors immediately, so
    // a parked old decode cannot hold the latest seek behind compositeChain.
    const retirement = applyPlaybackPolicy(msg)

    const run = async (): Promise<void> => {
      const retirementErrors = await retirement
      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      if (retirementErrors.length > 0) {
        throw new AggregateError(
          retirementErrors,
          'Failed to retire obsolete playback lanes',
        )
      }
      if (!visibleCtx || !scratch || !scratchCtx || !doc) {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: 'renderFrame before init/setDoc',
        })
        return
      }
      if (msg.plan.frame !== msg.frame) {
        throw new Error('renderFrame plan frame does not match request frame')
      }

      const startedAt = env.now()
      const renderDoc = doc
      const entriesByClip = new Map<ClipId, StreamingCompositeSourceEntry>()
      for (const entry of msg.sources) entriesByClip.set(entry.clipId, entry)

      // Queue clip-keyed entries in the exact order carried by the plan.
      const queues = new Map<string, Array<StreamingCompositeSourceEntry | null>>()
      for (const request of videoCompositionRequests(msg.plan)) {
        const entry = entriesByClip.get(request.clip.id)
        const key = `${request.clip.assetId}@${request.sourceFrame}`
        const queue = queues.get(key) ?? []
        queue.push(
          entry
          && entry.assetId === request.clip.assetId
          && entry.sourceFrame === request.sourceFrame
            ? entry
            : null,
        )
        queues.set(key, queue)
      }

      const memo = new Map<ClipId, Promise<RenderFrameSource | null>>()
      const staticMemo = new Map<
        AssetId,
        Promise<RenderFrameSource | null>
      >()
      const loans: StreamingLoan[] = []
      const staticLoans: StaticImageLoan[] = []
      const returnedPluginEffectBuffers = new Set<ArrayBuffer>()
      const source: FrameSource = {
        getFrame: (assetId, sourceFrame) => {
          const queue = queues.get(`${assetId}@${sourceFrame}`)
          const entry = queue?.shift()
          if (!entry) return Promise.resolve(null)
          if (entry.kind === 'image') {
            const staticState = staticImageAssets.get(entry.assetId)
            if (!staticState) {
              countCacheMiss()
              return Promise.resolve(null)
            }
            const memoizedStatic = staticMemo.get(entry.assetId)
            if (memoizedStatic) {
              countCacheHit()
              return memoizedStatic
            }
            const loan = borrowStaticImage(entry.assetId, staticState)
            if (loan) countCacheHit()
            else countCacheMiss()
            if (loan) staticLoans.push(loan)
            const staticSource = Promise.resolve(loan?.source ?? null)
            staticMemo.set(entry.assetId, staticSource)
            return staticSource
          }
          const memoized = memo.get(entry.clipId)
          if (memoized) {
            countCacheHit()
            return memoized
          }
          const state = streamingAssets.get(entry.assetId)
          if (!state) countCacheMiss()
          const promise: Promise<RenderFrameSource | null> = !state
            ? Promise.resolve(null)
            : msg.mode === 'playback'
              ? resolvePlaybackEntry(state, entry, loans, msg.requestId)
              : resolveSeekEntry(state, entry, myGen, loans, msg.requestId)
          memo.set(entry.clipId, promise)
          return promise
        },
      }

      let result
      try {
        result = await compositeFrame(
          renderDoc,
          msg.plan,
          scratchCtx,
          source,
          transitionSurfaceProvider,
          currentPresentationProfile() ?? undefined,
          lensRemapProvider,
          pluginEffectExecutor(
            msg.generation,
            msg.requestId,
            myGen,
            returnedPluginEffectBuffers,
          ),
        )
      } finally {
        for (const loan of loans) loan.settle()
        for (const loan of staticLoans) loan.settle()
        for (const buffer of returnedPluginEffectBuffers) {
          zeroAttachedPluginEffectBuffer(buffer)
        }
      }

      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      visibleCtx.drawImage(scratch as unknown as ImageBitmap, 0, 0)
      scratchFrame = msg.frame
      env.post({
        type: 'compositeDone',
        requestId: msg.requestId,
        status: 'drawn',
        drawnClipIds: result.drawn,
        missingClipIds: result.missing,
        renderMs: env.now() - startedAt,
      })
      scheduleVideoScopes()
    }

    enterRenderQueue()
    compositeChain = compositeChain.then(() =>
      run().catch((error) => {
        if (error instanceof LensRemapUnavailableError) failLensOwner(error)
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: `renderFrame failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        })
      }).finally(leaveRenderQueue),
    )
    return compositeChain
  }

  function postSuperseded(requestId: number): void {
    env.post({
      type: 'compositeDone',
      requestId,
      status: 'superseded',
      drawnClipIds: [],
      missingClipIds: [],
      renderMs: 0,
    })
  }

  async function dispatch(msg: ToRenderWorker): Promise<void> {
    switch (msg.type) {
      case 'init': {
        visible = msg.canvas
        visibleCtx = visible.getContext('2d', SRGB_2D_CONTEXT)
        if (!visibleCtx) {
          env.post({ type: 'error', message: 'OffscreenCanvas 2d context unavailable' })
        }
        syncCanvases()
        break
      }
      case 'setDoc': {
        const previousDoc = doc
        invalidatePlaybackPolicyForDoc(previousDoc, msg.doc)
        supersede() // an in-flight composite is rendering a stale doc
        doc = msg.doc
        prepareLensRemap(msg.doc)
        syncCanvases()
        await prunePlaybackLanes(previousDoc, msg.doc)
        break
      }
      case 'setPresentationProfile': {
        supersede()
        presentationProfile = msg.profile
        syncCanvases()
        break
      }
      case 'openAsset':
        await handleOpenAsset(msg)
        break
      case 'openImage':
        await handleOpenImage(msg)
        break
      case 'configureAsset':
        await handleConfigureAsset(msg)
        break
      case 'releaseAsset':
        await handleReleaseAsset(msg.assetId)
        break
      case 'renderFrame':
        await handleRenderFrame(msg)
        break
      case 'pluginEffectApplied':
      case 'pluginEffectBypassed':
        handlePluginEffectHostMessage(msg)
        break
      case 'composite':
        await handleComposite(msg)
        break
      case 'setRuntimeTelemetry':
        setRuntimeTelemetry(msg.enabled)
        break
      case 'setVideoScopes':
        setVideoScopes(msg.enabled, msg.generation)
        break
      case 'requestRuntimeTelemetry':
        env.post({
          type: 'runtimeTelemetry',
          requestId: msg.requestId,
          snapshot: runtimeTelemetrySnapshot(),
        })
        break
      case 'close': {
        workerLifecycle++
        videoScopesEnabled = false
        videoScopeGeneration++
        releaseVideoScopeSurface()
        lensRemapProvider = null
        lensBackend?.dispose()
        lensBackend = null
        const videoScopeRelease = env.releaseVideoScopes?.()
        env.invalidateDecoderRuntime()
        supersede()
        assetRevisions.clear()
        const pendingImageOpens = [...pendingStaticImageOpens.values()]
        for (const pending of pendingImageOpens) pending.controller.abort()
        desiredPlaybackLaneKeys.clear()
        playbackLaneRevisions.clear()
        legacyCompatibility?.close()
        const streaming = [...streamingAssets.values()]
        streamingAssets.clear()
        const staticImages = [...staticImageAssets.entries()]
        staticImageAssets.clear()
        for (const [assetId, state] of staticImages) {
          trackStaticImageRetirement(assetId, state)
        }
        const staticRetirements = [
          ...outstandingStaticImageRetirements,
        ]
        const results = await Promise.allSettled(
          [
            ...(videoScopeRelease ? [videoScopeRelease] : []),
            compositeChain,
            ...streaming.map((state) => teardownStreamingAsset(state)),
            ...staticRetirements,
            ...pendingImageOpens.map((pending) => pending.done),
          ],
        )
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason)
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Failed to close render worker')
        }
        break
      }
    }
  }

  async function handleMessage(msg: ToRenderWorker): Promise<void> {
    try {
      await dispatch(msg)
    } catch (e) {
      // Uncaught async exceptions in a worker are silent to the page —
      // never let one vanish (same rule as the decode worker).
      env.post({
        type: 'error',
        requestId:
          msg.type === 'composite' || msg.type === 'renderFrame'
            ? msg.requestId
            : undefined,
        assetId:
          msg.type === 'configureAsset'
          || msg.type === 'openAsset'
          || msg.type === 'openImage'
          || msg.type === 'releaseAsset'
            ? msg.assetId
            : undefined,
        ...(msg.type === 'configureAsset'
          || msg.type === 'openAsset'
          || msg.type === 'openImage'
          ? { setupId: msg.setupId }
          : {}),
        ...(msg.type === 'openAsset' && e instanceof WorkerVideoSourceOpenError
          ? { mediaFailure: e.failure }
          : msg.type === 'openImage'
            ? { mediaFailure: staticImageFailure(e) }
            : {}),
        message: `worker ${msg.type} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      })
    } finally {
      if (msg.type === 'close') env.post({ type: 'closed' })
    }
  }

  return {
    handleMessage,
    revisionEntryCounts: () => ({
      assets: assetRevisions.size,
      playbackLanes: playbackLaneRevisions.size,
    }),
  }
}

/* ------------------------------------------------------------------ */
/* Real worker wiring (skipped in tests / main thread)                  */
/* ------------------------------------------------------------------ */

export async function createOrientedStreamingBitmap(
  decoded: DecodedVideoFrame,
): Promise<BitmapLike> {
  if (decoded.rotation === 0) {
    return createImageBitmap(decoded.frame as unknown as ImageBitmapSource)
  }

  const outputWidth = decoded.displayWidth
  const outputHeight = decoded.displayHeight
  const sourceWidth = decoded.rotation === 180 ? outputWidth : outputHeight
  const sourceHeight = decoded.rotation === 180 ? outputHeight : outputWidth
  const canvas = new OffscreenCanvas(outputWidth, outputHeight)
  const context = canvas.getContext('2d', SRGB_2D_CONTEXT)
  if (!context) throw new Error('orientation canvas 2d context unavailable')

  context.save()
  try {
    if (decoded.rotation === 90) {
      context.translate(outputWidth, 0)
      context.rotate(Math.PI / 2)
    } else if (decoded.rotation === 180) {
      context.translate(outputWidth, outputHeight)
      context.rotate(Math.PI)
    } else {
      context.translate(0, outputHeight)
      context.rotate(-Math.PI / 2)
    }
    context.drawImage(
      decoded.frame as unknown as CanvasImageSource,
      0,
      0,
      sourceWidth,
      sourceHeight,
    )
  } finally {
    context.restore()
  }
  return canvas.transferToImageBitmap()
}

interface RetiringVideoScopeWorker {
  readonly completion: Promise<void>
  readonly resolve: () => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export function createVideoScopeAnalyzer(): {
  analyze(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<VideoScopeAnalysis>
  release(): Promise<void>
} {
  let worker: Worker | null = null
  let requestId = 0
  const retiring = new Map<Worker, RetiringVideoScopeWorker>()
  const terminated = new WeakSet<Worker>()
  const pending = new Map<number, {
    worker: Worker
    resolve(analysis: VideoScopeAnalysis): void
    reject(error: Error): void
  }>()

  const rejectPending = (message: string): void => {
    for (const request of pending.values()) request.reject(new Error(message))
    pending.clear()
  }
  const rejectWorkerPending = (ownedWorker: Worker, message: string): void => {
    for (const [id, request] of pending) {
      if (request.worker !== ownedWorker) continue
      request.reject(new Error(message))
      pending.delete(id)
    }
  }
  const terminateWorker = (ownedWorker: Worker): void => {
    if (terminated.has(ownedWorker)) return
    terminated.add(ownedWorker)
    ownedWorker.terminate()
  }
  const finishRetiringWorker = (ownedWorker: Worker): boolean => {
    const retirement = retiring.get(ownedWorker)
    if (!retirement) return false
    clearTimeout(retirement.timeout)
    retiring.delete(ownedWorker)
    try {
      terminateWorker(ownedWorker)
    } finally {
      retirement.resolve()
    }
    return true
  }
  const startRetiringWorker = (ownedWorker: Worker): void => {
    if (retiring.has(ownedWorker) || terminated.has(ownedWorker)) return
    let resolve = (): void => undefined
    const completion = new Promise<void>((done) => {
      resolve = done
    })
    const timeout = setTimeout(() => {
      finishRetiringWorker(ownedWorker)
    }, 250)
    retiring.set(ownedWorker, { completion, resolve, timeout })
    try {
      ownedWorker.postMessage({ type: 'release' })
    } catch {
      finishRetiringWorker(ownedWorker)
    }
  }
  const ensureWorker = (): Worker => {
    if (worker) return worker
    const created = new Worker(new URL('./video-scopes.worker.ts', import.meta.url), {
      type: 'module',
      name: 'myrelith-video-scopes',
    })
    worker = created
    created.onmessage = (event: MessageEvent<VideoScopeWorkerReply>) => {
      const message = event.data
      if (message.type === 'released') {
        finishRetiringWorker(created)
        return
      }
      const request = pending.get(message.requestId)
      if (!request || request.worker !== created) return
      pending.delete(message.requestId)
      if (message.type === 'analysis') request.resolve(message.analysis)
      else request.reject(new Error(message.message))
    }
    created.onerror = (event) => {
      event.preventDefault()
      rejectWorkerPending(created, event.message || 'Video scope analysis worker failed')
      if (worker === created) worker = null
      if (!finishRetiringWorker(created)) terminateWorker(created)
    }
    return created
  }
  const release = (): Promise<void> => {
    const ownedWorker = worker
    worker = null
    rejectPending('Video scope analysis was released')
    if (ownedWorker) startRetiringWorker(ownedWorker)
    return Promise.all(
      [...retiring.values()].map((retirement) => retirement.completion),
    ).then(() => undefined)
  }
  return {
    analyze: (rgba, width, height) => {
      requestId++
      if (!Number.isSafeInteger(requestId)) {
        void release()
        requestId = 1
      }
      const id = requestId
      const copy = new Uint8ClampedArray(rgba)
      const message: VideoScopeAnalyzeMessage = {
        type: 'analyze',
        requestId: id,
        rgba: copy,
        width,
        height,
      }
      const result = new Promise<VideoScopeAnalysis>((resolve, reject) => {
        pending.set(id, { worker: ensureWorker(), resolve, reject })
      })
      pending.get(id)?.worker.postMessage(message, [copy.buffer])
      return result
    },
    release,
  }
}

declare const WorkerGlobalScope: unknown

if (typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined') {
  const renderWorkerGlobal = self as unknown as {
    postMessage(message: FromRenderWorker, transfer: Transferable[]): void
  }
  const videoScopeAnalyzer = createVideoScopeAnalyzer()
  const core = createRenderWorkerCore({
    post: (msg, transfer = []) => renderWorkerGlobal.postMessage(msg, transfer),
    createDecoder: (init) =>
      new VideoDecoder({
        output: (frame) => init.output(frame),
        error: (e) => init.error(e),
      }) as unknown as VideoDecoderLike,
    isConfigSupported: (config) => VideoDecoder.isConfigSupported(config),
    createChunk: (p) =>
      new EncodedVideoChunk({
        type: p.type,
        timestamp: p.timestampUs,
        duration: p.durationUs,
        data: p.data,
      }),
    createBitmap: (frame) =>
      createImageBitmap(frame as unknown as ImageBitmapSource),
    openVideoSource: (blob, sourceId, budget) => openWorkerVideoSource(
      blob,
      { sourceId, budget },
    ),
    decodeImage: (blob, signal, reserveDecodedBytes) =>
      decodeStaticImage(blob, { signal, reserveDecodedBytes }),
    invalidateDecoderSource: invalidateMediaDecoderSource,
    invalidateDecoderRuntime: invalidateMediaDecoderRuntime,
    createStreamingBitmap: createOrientedStreamingBitmap,
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
    createLensRemapBackend: () => new WebGl2LensRemapBackend(),
    now: () => performance.now(),
    schedule: (callback) => setTimeout(callback, 0),
    analyzeVideoScopes: (rgba, width, height) =>
      videoScopeAnalyzer.analyze(rgba, width, height),
    releaseVideoScopes: () => videoScopeAnalyzer.release(),
  })

  self.addEventListener('message', (event: MessageEvent<ToRenderWorker>) => {
    void core.handleMessage(event.data)
  })
}
