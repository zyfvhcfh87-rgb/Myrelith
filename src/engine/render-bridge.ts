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
 * Layering: engine/ → domain/ + types-only worker protocols, plus the one
 * pure, versioned plugin-effect protocol validator/ownership contract. Tests
 * inject a fake worker; the deprecated path also injects fake chunk providers.
 */

import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import type { PresentationProfile } from '../domain/presentationProfile'
import type { AssetId, ClipId, FrameRate, TimelineDoc } from '../domain/schema'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { VideoScopeAnalysis } from '../domain/videoScopes'
import {
  videoCompositionRequests,
  type VideoCompositionPlan,
} from '../domain/videoCompositionPlan'
import type {
  PluginVideoEffectExecutionPlan,
  VideoEffectStagePlan,
} from '../domain/pluginVideoEffectStagePlan'
import { framesToMicroseconds } from '../domain/time'
import {
  PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
  isPluginEffectBridgeWorkerMessage,
  zeroAttachedPluginEffectBuffer,
  type PluginEffectBridgeApplyMessage,
  type PluginEffectBridgeHandler,
  type PluginEffectBridgeWorkerMessage,
} from '../workers/plugin-effect-bridge-protocol'
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
  generation: number
  plan: VideoCompositionPlan
  /** Exact source objects captured when this request was posted. */
  sources: Map<AssetId, AssetSource>
}

interface PendingPluginEffectCall {
  readonly generation: number
  readonly renderRequestId: number
  readonly controller: AbortController
}

function executionMatches(
  left: PluginVideoEffectExecutionPlan,
  right: PluginVideoEffectExecutionPlan,
): boolean {
  return left.catalogGeneration === right.catalogGeneration
    && left.signerFingerprint === right.signerFingerprint
    && left.packageDigest === right.packageDigest
    && left.pluginId === right.pluginId
    && left.pluginVersion === right.pluginVersion
    && left.kind === right.kind
    && left.contributionVersion === right.contributionVersion
    && left.contributionId === right.contributionId
    && left.descriptorVersion === right.descriptorVersion
    && left.entrypoint === right.entrypoint
    && left.canonicalParameterJson === right.canonicalParameterJson
}

function matchingPlannedExecution(
  plan: VideoCompositionPlan,
  descriptorId: string,
  candidate: PluginVideoEffectExecutionPlan,
): PluginVideoEffectExecutionPlan | null {
  const inspect = (stagePlan: VideoEffectStagePlan | undefined) => {
    if (!stagePlan) return null
    for (const stage of stagePlan.stages) {
      if (
        stage.kind === 'plugin'
        && stage.status === 'ready'
        && stage.effect?.id === descriptorId
        && stage.execution
        && executionMatches(stage.execution, candidate)
      ) return stage.execution
    }
    return null
  }
  for (const item of plan.items) {
    if (item.kind === 'clip') {
      const execution = inspect(item.request.effectStagePlan)
      if (execution) return execution
    } else if (item.kind === 'text') {
      const execution = inspect(item.effectStagePlan)
      if (execution) return execution
    } else if (item.kind !== 'caption') {
      for (const request of item.requests) {
        const execution = inspect(request.effectStagePlan)
        if (execution) return execution
      }
    }
  }
  return null
}

export class RenderWorkerBridge {
  private readonly worker: WorkerLike
  private readonly pluginEffectHandler: PluginEffectBridgeHandler | null
  /** The doc snapshot last posted via setDoc — composites are built from
   * THIS, never from a fresher store read (protocol ordering contract). */
  private doc: TimelineDoc | null = null
  private readonly sources = new Map<AssetId, AssetSource>()
  /** Invalidates legacy chunk reads when any source is replaced or removed. */
  private sourceRevision = 0
  private nextRequestId = 1
  private nextRenderGeneration = 1
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
  private readonly pendingPluginEffects = new Map<number, PendingPluginEffectCall>()
  private disposed = false
  private closeTimeout: ReturnType<typeof setTimeout> | null = null
  private closePromise: Promise<void> | null = null
  private resolveClose: (() => void) | null = null
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

  constructor(
    worker: WorkerLike,
    pluginEffectHandler: PluginEffectBridgeHandler | null = null,
  ) {
    this.worker = worker
    this.pluginEffectHandler = pluginEffectHandler
    worker.addEventListener('message', (event: MessageEvent) => {
      this.route(event.data)
    })
  }

  /** Hand the visible drawing surface to the worker (transferred, once). */
  init(canvas: OffscreenCanvas): void {
    this.post({ type: 'init', canvas }, [canvas])
  }

  /** Post a new doc snapshot; subsequent composites are built from it. */
  setDoc(doc: TimelineDoc): void {
    this.doc = doc
    this.abortPluginEffectCalls()
    this.settlePendingAsSuperseded()
    this.post({ type: 'setDoc', doc }, [])
  }

  /** Resize preview-only worker surfaces; authored geometry stays unchanged. */
  setPresentationProfile(profile: PresentationProfile): void {
    if (this.disposed) return
    this.abortPluginEffectCalls()
    this.settlePendingAsSuperseded()
    this.post({ type: 'setPresentationProfile', profile }, [])
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
  renderFrame(plan: VideoCompositionPlan): Promise<RenderFrameResult>
  renderFrame(plan: VideoCompositionPlan, mode: RenderMode): Promise<RenderFrameResult>
  renderFrame(plan: VideoCompositionPlan, mode?: RenderMode): Promise<RenderFrameResult> {
    const doc = this.doc
    const frame = plan.frame
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
    if (!Number.isSafeInteger(frame) || frame < 0) {
      return Promise.resolve({
        status: 'error',
        drawnClipIds: [],
        missingClipIds: [],
        renderMs: 0,
        message: 'visual plan frame must be a non-negative integer',
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
    const generation = this.takeRenderGeneration()
    this.latestCallId = requestId
    this.abortPluginEffectCalls()
    if (mode === undefined) {
      return this.renderLegacyFrame(doc, plan, frame, requestId, generation)
    }
    return this.renderStreamingFrame(doc, plan, frame, requestId, generation, mode)
  }

  private async renderLegacyFrame(
    doc: TimelineDoc,
    plan: VideoCompositionPlan,
    frame: number,
    requestId: number,
    generation: number,
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
        generation,
        plan,
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
    generation: number,
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
      this.pending.set(requestId, { resolve, generation, plan, sources: requestSources })
      this.post({
        type: 'renderFrame',
        generation,
        requestId,
        frame,
        plan,
        mode,
        sources: entries,
      }, [])
    })
  }

  /** Shut the worker's decoders down and terminate the worker. */
  dispose(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve
    })
    this.disposed = true
    this.sourceRevision++
    this.abortPluginEffectCalls()
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
    return this.closePromise
  }

  private terminateWorker(): void {
    if (this.closeTimeout !== null) {
      clearTimeout(this.closeTimeout)
      this.closeTimeout = null
    }
    if (this.workerTerminated) return
    this.workerTerminated = true
    this.worker.terminate?.()
    this.resolveClose?.()
    this.resolveClose = null
  }

  private settlePendingAsSuperseded(): void {
    for (const pending of this.pending.values()) pending.resolve(SUPERSEDED)
    this.pending.clear()
  }

  private abortPluginEffectCalls(): void {
    for (const pending of this.pendingPluginEffects.values()) {
      pending.controller.abort()
    }
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

  private takeRenderGeneration(): number {
    const generation = this.nextRenderGeneration
    if (!Number.isSafeInteger(generation)) {
      throw new RangeError('Render worker generation overflow')
    }
    this.nextRenderGeneration++
    return generation
  }

  private postPluginBypass(message: PluginEffectBridgeWorkerMessage): void {
    this.post({
      type: 'pluginEffectBypassed',
      protocolVersion: PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
      generation: message.generation,
      renderRequestId: message.renderRequestId,
      effectRequestId: message.effectRequestId,
    }, [])
  }

  private handlePluginEffectCancel(
    message: Extract<PluginEffectBridgeWorkerMessage, { type: 'pluginEffectCancel' }>,
  ): void {
    const pending = this.pendingPluginEffects.get(message.effectRequestId)
    if (
      !pending
      || pending.generation !== message.generation
      || pending.renderRequestId !== message.renderRequestId
    ) return
    pending.controller.abort()
  }

  private async handlePluginEffectApply(
    message: PluginEffectBridgeApplyMessage,
  ): Promise<void> {
    const inputBuffer = message.rgbaBytes
    let resultBuffer: ArrayBuffer | null = null
    try {
      const render = this.pending.get(message.renderRequestId)
      const plannedExecution = render
        && render.generation === message.generation
        ? matchingPlannedExecution(render.plan, message.descriptorId, message.execution)
        : null
      if (!render || !plannedExecution || this.disposed || !this.pluginEffectHandler) {
        if (render && render.generation === message.generation && !this.disposed) {
          this.postPluginBypass(message)
        }
        return
      }
      if (this.pendingPluginEffects.has(message.effectRequestId)) return
      const controller = new AbortController()
      this.pendingPluginEffects.set(message.effectRequestId, {
        generation: message.generation,
        renderRequestId: message.renderRequestId,
        controller,
      })
      let result
      try {
        result = await this.pluginEffectHandler.apply(Object.freeze({
          requestId: message.effectRequestId,
          execution: plannedExecution,
          descriptorId: message.descriptorId,
          timelineFrame: message.timelineFrame,
          frameRateNumerator: message.frameRateNumerator,
          frameRateDenominator: message.frameRateDenominator,
          width: message.width,
          height: message.height,
          stride: message.stride,
          rgbaBytes: new Uint8Array(inputBuffer),
        }), controller.signal)
      } catch {
        result = { status: 'bypassed' as const }
      } finally {
        this.pendingPluginEffects.delete(message.effectRequestId)
      }
      const current = this.pending.get(message.renderRequestId)
      if (
        controller.signal.aborted
        || !current
        || current.generation !== message.generation
        || this.disposed
      ) {
        if (result.status === 'applied') {
          zeroAttachedPluginEffectBuffer(result.rgbaBytes.buffer)
        }
        return
      }
      if (result.status !== 'applied') {
        this.postPluginBypass(message)
        return
      }
      if (
        !(result.rgbaBytes instanceof Uint8Array)
        || result.rgbaBytes.byteOffset !== 0
        || result.rgbaBytes.buffer.byteLength !== result.rgbaBytes.byteLength
        || result.rgbaBytes.byteLength !== inputBuffer.byteLength
      ) {
        zeroAttachedPluginEffectBuffer(result.rgbaBytes.buffer)
        this.postPluginBypass(message)
        return
      }
      resultBuffer = result.rgbaBytes.buffer
      this.post({
        type: 'pluginEffectApplied',
        protocolVersion: PLUGIN_EFFECT_BRIDGE_PROTOCOL_VERSION,
        generation: message.generation,
        renderRequestId: message.renderRequestId,
        effectRequestId: message.effectRequestId,
        rgbaBytes: resultBuffer,
      }, [resultBuffer])
    } finally {
      zeroAttachedPluginEffectBuffer(inputBuffer)
      if (resultBuffer?.byteLength) zeroAttachedPluginEffectBuffer(resultBuffer)
    }
  }

  private route(value: unknown): void {
    const maybeType = value && typeof value === 'object'
      ? (value as { readonly type?: unknown }).type
      : undefined
    if (maybeType === 'pluginEffectApply' || maybeType === 'pluginEffectCancel') {
      if (!isPluginEffectBridgeWorkerMessage(value)) {
        const buffer = (value as { readonly rgbaBytes?: unknown }).rgbaBytes
        if (buffer instanceof ArrayBuffer) zeroAttachedPluginEffectBuffer(buffer)
        return
      }
      if (value.type === 'pluginEffectCancel') {
        this.handlePluginEffectCancel(value)
      } else {
        void this.handlePluginEffectApply(value)
      }
      return
    }
    const msg = value as FromRenderWorker
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
