/**
 * engine/render-bridge.ts — Main-thread facade over the render worker.
 * Phase 4.1c.
 *
 * Speaks document frames on one side (renderFrame(frame)) and the typed
 * ToRenderWorker/FromRenderWorker protocol on the other. Owns everything
 * the render-protocol says the MAIN side owns:
 * - deciding which clip-keyed sources a composite needs, via the
 *   canonical grouped VideoCompositionPlan over the SAME document
 *   snapshot it last posted (setDoc stores it, satisfying the protocol's
 *   ordering contract);
 * - all µs math: conformed document-rate source frame → target microseconds,
 *   while the native rate owns only decode tolerance (frame↔time conversion
 *   stays at this boundary, rule 2);
 * - handing each asset Blob to the worker once, then posting lightweight
 *   frame requests with explicit playback/seek intent;
 * - preserving the old transferred-chunk overload through the isolated
 *   render-legacy-bridge compatibility delegate;
 * - request-id bookkeeping with latest-wins supersession, mirroring the
 *   worker's own (a newer renderFrame settles older in-flight ones as
 *   'superseded'; the worker answers every request regardless).
 *
 * Layering: engine/ → domain/ + types-only worker protocols. Tests inject a
 * fake worker; the deprecated path also injects fake chunk providers.
 */

import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import type { PresentationProfile } from '../domain/presentationProfile'
import type { AssetId, ClipId, FrameRate, TimelineDoc } from '../domain/schema'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { VideoScopeAnalysis } from '../domain/videoScopes'
import {
  createVideoCompositionPlanner,
  videoCompositionRequests,
  type VideoCompositionPlan,
  type VideoCompositionPlanner,
} from '../domain/videoCompositionPlan'
import { framesToMicroseconds } from '../domain/time'
import type {
  FromRenderWorker,
  RenderMode,
  RenderWorkerCapabilities,
  RenderWorkerRuntimeTelemetrySnapshot,
  StreamingCompositeSourceEntry,
  ToRenderWorker,
} from '../workers/render-protocol'
import {
  buildLegacyRenderRequest,
  createLegacyRenderAssetSource,
  type LegacyRenderAssetSource,
} from './render-legacy-bridge'
import type { ChunkProvider, WorkerLike } from './worker-types'

/** What one renderFrame call came to: exactly one of these, exactly once. */
export interface RenderFrameResult {
  status: 'drawn' | 'superseded' | 'error'
  /** Clips painted, bottom-to-top. Empty unless status === 'drawn'. */
  drawnClipIds: ClipId[]
  /** Active clips whose pixels were unavailable this composite. */
  missingClipIds: ClipId[]
  /** Worker-side decode+composite time in ms (0 when nothing ran). */
  renderMs: number
  /** Present when status === 'error'. */
  message?: string
}

const SUPERSEDED: RenderFrameResult = {
  status: 'superseded',
  drawnClipIds: [],
  missingClipIds: [],
  renderMs: 0,
}

const WORKER_CLOSE_ACK_TIMEOUT_MS = 1_000

export interface RenderAssetOpenFailure {
  trackKind: 'video' | null
  reason: MediaRuntimeFailure['reason']
}

/** Typed worker-source setup rejection for the preview composition root. */
export class RenderAssetOpenError extends Error {
  readonly failure: RenderAssetOpenFailure

  constructor(message: string, failure: RenderAssetOpenFailure) {
    super(message)
    this.name = 'RenderAssetOpenError'
    this.failure = failure
  }
}

/** Blob-backed source owned and decoded by the render worker. */
interface StreamingVideoAssetSource {
  protocol: 'streaming'
  kind: 'video'
  rate: FrameRate
  runtimeToken: object
}

/** A retained frame-zero source decoded and owned by the render worker. */
interface StreamingImageAssetSource {
  protocol: 'streaming'
  kind: 'image'
  runtimeToken: object
}

type AssetSource =
  | LegacyRenderAssetSource
  | StreamingVideoAssetSource
  | StreamingImageAssetSource

interface PendingRender {
  resolve: (result: RenderFrameResult) => void
  /** Exact source objects captured when this request was posted. */
  sources: Map<AssetId, AssetSource>
}

export class RenderWorkerBridge {
  private readonly worker: WorkerLike
  /** The doc snapshot last posted via setDoc — composites are built from
   * THIS, never from a fresher store read (protocol ordering contract). */
  private doc: TimelineDoc | null = null
  private sourceBounds: SourceBoundsCatalog = new Map()
  private visualPlanner: VideoCompositionPlanner | null = null
  private readonly sources = new Map<AssetId, AssetSource>()
  /** Invalidates legacy chunk reads when any source is replaced or removed. */
  private sourceRevision = 0
  private nextRequestId = 1
  private nextTelemetryRequestId = 1
  /** Monotonic identity for one configure/open attempt; prevents asset ABA. */
  private nextSetupId = 1
  /** Id of the newest renderFrame CALL — stale calls detect supersession. */
  private latestCallId = 0
  private readonly pending = new Map<number, PendingRender>()
  private readonly pendingConfigures = new Map<
    AssetId,
    { setupId: number; resolve: () => void; reject: (error: Error) => void }
  >()
  private readonly pendingTelemetry = new Map<
    number,
    {
      resolve: (snapshot: RenderWorkerRuntimeTelemetrySnapshot) => void
      reject: (error: Error) => void
    }
  >()
  private disposed = false
  private closeTimeout: ReturnType<typeof setTimeout> | null = null
  private workerTerminated = false
  /** Errors not tied to a request (decoder faults, stray failures). */
  onWorkerError: ((message: string) => void) | null = null
  /** Current asset-scoped decode failure, paired with its exact open token. */
  onAssetError: ((
    assetId: AssetId,
    runtimeToken: object,
    trackKind: 'video' | null,
    message: string,
  ) => void) | null = null
  /** An asset's decoder became ready — a good moment to re-render. */
  onAssetReady: ((assetId: AssetId) => void) | null = null
  /** Actual capabilities reported by the worker-owned preview compositor. */
  onRendererCapabilities: ((capabilities: RenderWorkerCapabilities) => void) | null = null
  /** Bounded, generation-tagged post-composite scope projection. */
  onVideoScopes: ((
    generation: number,
    frame: number,
    analyzedAt: number,
    analysis: VideoScopeAnalysis,
  ) => void) | null = null

  constructor(worker: WorkerLike) {
    this.worker = worker
    worker.addEventListener('message', (event: MessageEvent) => {
      this.route(event.data as FromRenderWorker)
    })
  }

  /** Hand the visible drawing surface to the worker (transferred, once). */
  init(canvas: OffscreenCanvas): void {
    this.post({ type: 'init', canvas }, [canvas])
  }

  /** Post a new doc snapshot; subsequent composites are built from it. */
  setDoc(doc: TimelineDoc): void {
    this.doc = doc
    this.visualPlanner = createVideoCompositionPlanner(doc, this.sourceBounds)
    this.post({ type: 'setDoc', doc }, [])
  }

  /** Resize preview-only worker surfaces; authored geometry stays unchanged. */
  setPresentationProfile(profile: PresentationProfile): void {
    if (this.disposed) return
    this.settlePendingAsSuperseded()
    this.post({ type: 'setPresentationProfile', profile }, [])
  }

  /** Replace durable media facts without invalidating worker decode lanes. */
  setSourceBoundsCatalog(catalog: SourceBoundsCatalog): void {
    this.sourceBounds = new Map(catalog)
    if (this.doc) {
      this.visualPlanner = createVideoCompositionPlanner(
        this.doc,
        this.sourceBounds,
      )
    }
  }

  /**
   * Register an asset's decoder config + chunk source. Resolves when the
   * worker's decoder is ready (rejects on unsupported codec). Re-configuring
   * an asset replaces its decoder and cache wholesale.
   *
   * @deprecated Use openAsset; retained only until previewController moves.
   */
  configureAsset(
    assetId: AssetId,
    config: VideoDecoderConfig,
    rate: FrameRate,
    chunkProvider: ChunkProvider,
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('bridge disposed'))
    if (this.pendingConfigures.has(assetId)) {
      return Promise.reject(new Error(`asset ${assetId} registration already pending`))
    }
    const setupId = this.takeSetupId()
    this.sourceRevision++
    this.sources.set(assetId, createLegacyRenderAssetSource(rate, chunkProvider))
    return new Promise((resolve, reject) => {
      this.pendingConfigures.set(assetId, { setupId, resolve, reject })
      this.post({ type: 'configureAsset', assetId, setupId, config }, [])
    })
  }

  /**
   * Give the worker a Blob-backed asset source. The Blob is structured-cloned
   * once (never transferred), and the bridge retains only its native rate for
   * exact timestamp conversion. Resolves when the worker can decode it.
   */
  openAsset(
    assetId: AssetId,
    blob: Blob,
    rate: FrameRate,
    budget: LocalDecoderBudget,
    runtimeToken: object = {},
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('bridge disposed'))
    if (this.pendingConfigures.has(assetId)) {
      return Promise.reject(new Error(`asset ${assetId} registration already pending`))
    }
    const setupId = this.takeSetupId()
    this.sourceRevision++
    this.sources.set(assetId, {
      protocol: 'streaming',
      kind: 'video',
      rate,
      runtimeToken,
    })
    return new Promise((resolve, reject) => {
      this.pendingConfigures.set(assetId, { setupId, resolve, reject })
      this.post({ type: 'openAsset', assetId, setupId, blob, budget }, [])
    })
  }

  /**
   * Give the worker one Blob-backed still-image source. The worker re-runs the
   * bounded content inspection, decodes frame zero once, and retains that
   * source until replacement, release, or acknowledged worker shutdown.
   */
  openImage(
    assetId: AssetId,
    blob: Blob,
    runtimeToken: object = {},
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('bridge disposed'))
    if (this.pendingConfigures.has(assetId)) {
      return Promise.reject(new Error(`asset ${assetId} registration already pending`))
    }
    const setupId = this.takeSetupId()
    this.sourceRevision++
    this.sources.set(assetId, {
      protocol: 'streaming',
      kind: 'image',
      runtimeToken,
    })
    return new Promise((resolve, reject) => {
      this.pendingConfigures.set(assetId, { setupId, resolve, reject })
      this.post({ type: 'openImage', assetId, setupId, blob }, [])
    })
  }

  /** Drop an asset's decoder, cache and chunk source. */
  releaseAsset(assetId: AssetId): void {
    this.sourceRevision++
    this.sources.delete(assetId)
    this.pendingConfigures.get(assetId)?.reject(new Error('asset released'))
    this.pendingConfigures.delete(assetId)
    this.post({ type: 'releaseAsset', assetId }, [])
  }

  /** Enable/reset or disable the local-only worker health counters. */
  setRuntimeTelemetryEnabled(enabled: boolean): void {
    if (this.disposed) return
    this.post({ type: 'setRuntimeTelemetry', enabled }, [])
  }

  /** Configure the worker-owned bounded scope sampler for this UI generation. */
  setVideoScopesEnabled(enabled: boolean, generation: number): void {
    if (this.disposed) return
    this.post({ type: 'setVideoScopes', enabled, generation }, [])
  }

  /** Capture a point-in-time worker health snapshot for the performance lab. */
  requestRuntimeTelemetry(): Promise<RenderWorkerRuntimeTelemetrySnapshot> {
    if (this.disposed) return Promise.reject(new Error('bridge disposed'))
    const requestId = this.nextTelemetryRequestId++
    if (!Number.isSafeInteger(requestId)) {
      return Promise.reject(new RangeError('Render telemetry request id overflow'))
    }
    return new Promise((resolve, reject) => {
      this.pendingTelemetry.set(requestId, { resolve, reject })
      this.post({ type: 'requestRuntimeTelemetry', requestId }, [])
    })
  }

  /**
   * Composite document frame `frame` onto the worker's canvas. Latest-wins:
   * a newer call settles older in-flight ones as 'superseded'. Never
   * rejects — failures come back in the result. Clips whose asset has no
   * configured source are simply not requested; the worker reports them in
   * missingClipIds. Supplying mode selects the Blob-backed streaming path;
   * omitting it temporarily selects the deprecated chunk-batch path.
   */
  renderFrame(frame: number): Promise<RenderFrameResult>
  renderFrame(frame: number, mode: RenderMode): Promise<RenderFrameResult>
  renderFrame(frame: number, mode?: RenderMode): Promise<RenderFrameResult> {
    const doc = this.doc
    if (!doc) {
      return Promise.resolve({
        status: 'error',
        drawnClipIds: [],
        missingClipIds: [],
        renderMs: 0,
        message: 'no document configured (call setDoc first)',
      })
    }
    if (this.disposed) {
      return Promise.resolve({
        status: 'error',
        drawnClipIds: [],
        missingClipIds: [],
        renderMs: 0,
        message: 'render bridge is disposed',
      })
    }
    // Omitting mode is the deprecated keyframe-batch path. Once its caller
    // migrates, every render supplies explicit playback/seek intent.
    const protocol = mode === undefined ? 'legacy' : 'streaming'
    const plan = this.visualPlanner?.planFrame(frame)
    if (!plan) {
      return Promise.resolve({
        status: 'error',
        drawnClipIds: [],
        missingClipIds: [],
        renderMs: 0,
        message: 'visual planner is not configured',
      })
    }
    const requests = videoCompositionRequests(plan)
    for (const request of requests) {
      const source = this.sources.get(request.clip.assetId)
      if (source && source.protocol !== protocol) {
        return Promise.resolve({
          status: 'error',
          drawnClipIds: [],
          missingClipIds: [],
          renderMs: 0,
          message: `asset ${request.clip.assetId} uses the ${source.protocol} render protocol`,
        })
      }
    }

    // Invalid calls above do not become latest: they neither post a worker
    // cancellation nor disturb the last valid presentation.
    const requestId = this.nextRequestId++
    this.latestCallId = requestId
    if (mode === undefined) {
      return this.renderLegacyFrame(doc, plan, frame, requestId)
    }
    return this.renderStreamingFrame(doc, plan, frame, requestId, mode)
  }

  private async renderLegacyFrame(
    doc: TimelineDoc,
    plan: VideoCompositionPlan,
    frame: number,
    requestId: number,
  ): Promise<RenderFrameResult> {
    const revision = this.sourceRevision
    const request = await buildLegacyRenderRequest({
      doc,
      plan,
      frame,
      requestId,
      sourceForAsset: (assetId) => {
        const source = this.sources.get(assetId)
        return source?.protocol === 'legacy' ? source : undefined
      },
      isCurrent: () => (
        this.latestCallId === requestId
        && this.doc === doc
        && this.sourceRevision === revision
        && !this.disposed
      ),
    })
    if (!request) return SUPERSEDED

    this.settlePendingAsSuperseded()

    return new Promise((resolve) => {
      this.pending.set(requestId, {
        resolve,
        sources: request.sources,
      })
      this.post(request.message, request.transfer)
    })
  }

  private renderStreamingFrame(
    doc: TimelineDoc,
    plan: VideoCompositionPlan,
    frame: number,
    requestId: number,
    mode: RenderMode,
  ): Promise<RenderFrameResult> {
    const entries: StreamingCompositeSourceEntry[] = []
    const requestSources = new Map<AssetId, AssetSource>()
    for (const request of videoCompositionRequests(plan)) {
      const clip = request.clip
      const source = this.sources.get(clip.assetId)
      if (!source) continue
      if (source.protocol !== 'streaming') continue // prevalidated above
      requestSources.set(clip.assetId, source)
      if (source.kind === 'image') {
        entries.push({
          kind: 'image',
          clipId: clip.id,
          assetId: clip.assetId,
          sourceFrame: 0,
          targetTimestampUs: 0,
        })
      } else {
        entries.push({
          kind: 'video',
          clipId: clip.id,
          assetId: clip.assetId,
          sourceFrame: request.sourceFrame,
          targetTimestampUs: framesToMicroseconds(request.sourceFrame, doc.frameRate),
        })
      }
    }

    // Unlike the legacy batch table, entries stay clip-keyed. Two clips may
    // show the same asset frame while owning independent playback cursors.
    this.settlePendingAsSuperseded()
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, sources: requestSources })
      this.post({
        type: 'renderFrame',
        requestId,
        frame,
        plan,
        mode,
        sources: entries,
      }, [])
    })
  }

  /** Shut the worker's decoders down and terminate the worker. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sourceRevision++
    this.closeTimeout = setTimeout(() => {
      this.closeTimeout = null
      this.terminateWorker()
    }, WORKER_CLOSE_ACK_TIMEOUT_MS)
    this.post({ type: 'close' }, [])
    this.settlePendingAsSuperseded()
    for (const waiter of this.pendingConfigures.values()) {
      waiter.reject(new Error('bridge disposed'))
    }
    this.pendingConfigures.clear()
    for (const waiter of this.pendingTelemetry.values()) {
      waiter.reject(new Error('bridge disposed'))
    }
    this.pendingTelemetry.clear()
  }

  private terminateWorker(): void {
    if (this.closeTimeout !== null) {
      clearTimeout(this.closeTimeout)
      this.closeTimeout = null
    }
    if (this.workerTerminated) return
    this.workerTerminated = true
    this.worker.terminate?.()
  }

  private settlePendingAsSuperseded(): void {
    for (const pending of this.pending.values()) pending.resolve(SUPERSEDED)
    this.pending.clear()
  }

  private post(msg: ToRenderWorker, transfer: Transferable[]): void {
    this.worker.postMessage(msg, transfer)
  }

  private takeSetupId(): number {
    const setupId = this.nextSetupId
    if (!Number.isSafeInteger(setupId)) {
      throw new RangeError('Render worker setup id overflow')
    }
    this.nextSetupId++
    return setupId
  }

  private route(msg: FromRenderWorker): void {
    switch (msg.type) {
      case 'rendererCapabilities': {
        this.onRendererCapabilities?.(msg.capabilities)
        break
      }
      case 'assetConfigured': {
        const waiter = this.pendingConfigures.get(msg.assetId)
        if (!waiter || waiter.setupId !== msg.setupId) break
        waiter.resolve()
        this.pendingConfigures.delete(msg.assetId)
        this.onAssetReady?.(msg.assetId)
        break
      }
      case 'compositeDone': {
        const pending = this.pending.get(msg.requestId)
        if (!pending) break // late reply for a superseded request: ignore
        this.pending.delete(msg.requestId)
        pending.resolve({
          status: msg.status,
          drawnClipIds: msg.drawnClipIds,
          missingClipIds: msg.missingClipIds,
          renderMs: msg.renderMs,
        })
        break
      }
      case 'runtimeTelemetry': {
        const waiter = this.pendingTelemetry.get(msg.requestId)
        if (!waiter) break
        this.pendingTelemetry.delete(msg.requestId)
        waiter.resolve(msg.snapshot)
        break
      }
      case 'videoScopes': {
        this.onVideoScopes?.(
          msg.generation,
          msg.frame,
          msg.analyzedAt,
          msg.analysis,
        )
        break
      }
      case 'error': {
        // A configure failure rejects its waiter (unsupported codec, …).
        if (
          msg.requestId === undefined
          && msg.assetId !== undefined
          && msg.setupId !== undefined
        ) {
          const waiter = this.pendingConfigures.get(msg.assetId)
          // A delayed failure from a released/replaced setup is inert. It
          // must not reject or delete the current source, nor surface as a
          // current worker diagnostic.
          if (!waiter || waiter.setupId !== msg.setupId) break
          this.pendingConfigures.delete(msg.assetId)
          this.sources.delete(msg.assetId)
          this.sourceRevision++
          waiter.reject(msg.mediaFailure
            ? new RenderAssetOpenError(msg.message, msg.mediaFailure)
            : new Error(msg.message))
          break
        }
        // Request-fatal errors settle the composite: the worker sends NO
        // compositeDone for these. (Asset-scoped errors DURING a composite
        // carry an assetId and are followed by a compositeDone — those go
        // to onWorkerError below, not here.)
        if (msg.requestId !== undefined && msg.assetId === undefined) {
          const pending = this.pending.get(msg.requestId)
          if (pending) {
            this.pending.delete(msg.requestId)
            pending.resolve({
              status: 'error',
              drawnClipIds: [],
              missingClipIds: [],
              renderMs: 0,
              message: msg.message,
            })
            break
          }
        }
        if (msg.requestId !== undefined && msg.assetId !== undefined) {
          const source = this.pending.get(msg.requestId)?.sources.get(msg.assetId)
          // A diagnostic from an older request/open must never poison the
          // source that currently owns this durable asset id.
          if (source && this.sources.get(msg.assetId) === source) {
            this.onAssetError?.(
              msg.assetId,
              source.runtimeToken,
              source.protocol === 'streaming' && source.kind === 'image'
                ? null
                : 'video',
              msg.message,
            )
          }
        }
        this.onWorkerError?.(msg.message)
        break
      }
      case 'closed': {
        this.terminateWorker()
        break
      }
    }
  }
}

/**
 * Real wiring: spawn the render worker as a Vite module worker. Kept out
 * of the class so tests construct RenderWorkerBridge with a fake.
 */
export function createRenderWorker(): Worker {
  return new Worker(new URL('../workers/render.worker.ts', import.meta.url), {
    type: 'module',
  })
}
