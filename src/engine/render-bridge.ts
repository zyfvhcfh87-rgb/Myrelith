/**
 * engine/render-bridge.ts — Main-thread facade over the render worker.
 * Phase 4.1c.
 *
 * Speaks document frames on one side (renderFrame(frame)) and the typed
 * ToRenderWorker/FromRenderWorker protocol on the other. Owns everything
 * the render-protocol says the MAIN side owns:
 * - deciding which clip-keyed sources a composite needs, via the
 *   canonical domain visibleVideoLayersAtFrame plan over the SAME document
 *   snapshot it last posted (setDoc stores it, satisfying the protocol's
 *   ordering contract);
 * - all µs math: doc frame → asset frame (rescaleFrames) → target/
 *   tolerance microseconds (frame↔seconds only at this boundary, rule 2);
 * - handing each asset Blob to the worker once, then posting lightweight
 *   frame requests with explicit playback/seek intent;
 * - temporarily supporting the old transferred-chunk path while its final
 *   previewController caller migrates;
 * - request-id bookkeeping with latest-wins supersession, mirroring the
 *   worker's own (a newer renderFrame settles older in-flight ones as
 *   'superseded'; the worker answers every request regardless).
 *
 * Layering: engine/ → domain/ + types-only worker protocols. Tests inject a
 * fake worker; the deprecated path also injects fake chunk providers.
 */

import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import type { AssetId, ClipId, FrameRate, TimelineDoc } from '../domain/schema'
import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import { visibleVideoLayersAtFrame } from '../domain/selectors'
import type { VisibleVideoLayer } from '../domain/selectors'
import { framesToSeconds, rescaleFrames } from '../domain/time'
import type { ChunkPayload } from '../workers/decode-protocol'
import type {
  CompositeSourceEntry,
  FromRenderWorker,
  RenderMode,
  StreamingCompositeSourceEntry,
  ToRenderWorker,
} from '../workers/render-protocol'
import type { ChunkProvider, WorkerLike } from './worker-bridge'

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

/** Temporary keyframe-batch source retained while previewController migrates. */
interface LegacyAssetSource {
  protocol: 'legacy'
  rate: FrameRate
  chunkProvider: ChunkProvider
  runtimeToken: object
}

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
  | LegacyAssetSource
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
  private readonly sources = new Map<AssetId, AssetSource>()
  /** Invalidates legacy chunk reads when any source is replaced or removed. */
  private sourceRevision = 0
  private nextRequestId = 1
  /** Id of the newest renderFrame CALL — stale calls detect supersession. */
  private latestCallId = 0
  private readonly pending = new Map<number, PendingRender>()
  private readonly pendingConfigures = new Map<
    AssetId,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  private disposed = false
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
    this.post({ type: 'setDoc', doc }, [])
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
    this.sourceRevision++
    this.sources.set(assetId, {
      protocol: 'legacy',
      rate,
      chunkProvider,
      runtimeToken: {},
    })
    return new Promise((resolve, reject) => {
      this.pendingConfigures.set(assetId, { resolve, reject })
      this.post({ type: 'configureAsset', assetId, config }, [])
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
    this.sourceRevision++
    this.sources.set(assetId, {
      protocol: 'streaming',
      kind: 'video',
      rate,
      runtimeToken,
    })
    return new Promise((resolve, reject) => {
      this.pendingConfigures.set(assetId, { resolve, reject })
      this.post({ type: 'openAsset', assetId, blob, budget }, [])
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
    this.sourceRevision++
    this.sources.set(assetId, {
      protocol: 'streaming',
      kind: 'image',
      runtimeToken,
    })
    return new Promise((resolve, reject) => {
      this.pendingConfigures.set(assetId, { resolve, reject })
      this.post({ type: 'openImage', assetId, blob }, [])
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
    const layers = visibleVideoLayersAtFrame(doc, frame)
    for (const layer of layers) {
      const source = this.sources.get(layer.clip.assetId)
      if (source && source.protocol !== protocol) {
        return Promise.resolve({
          status: 'error',
          drawnClipIds: [],
          missingClipIds: [],
          renderMs: 0,
          message: `asset ${layer.clip.assetId} uses the ${source.protocol} render protocol`,
        })
      }
    }

    // Invalid calls above do not become latest: they neither post a worker
    // cancellation nor disturb the last valid presentation.
    const requestId = this.nextRequestId++
    this.latestCallId = requestId
    if (mode === undefined) return this.renderLegacyFrame(doc, layers, frame, requestId)
    return this.renderStreamingFrame(doc, layers, frame, requestId, mode)
  }

  private async renderLegacyFrame(
    doc: TimelineDoc,
    layers: VisibleVideoLayer[],
    frame: number,
    requestId: number,
  ): Promise<RenderFrameResult> {
    const revision = this.sourceRevision

    // Which (asset, sourceFrame) pairs does this composite need? The domain
    // render plan is the same ordered truth compositeFrame consumes;
    // dedupe only the decode work, exactly like the worker's source table.
    const wants = new Map<
      string,
      { assetId: AssetId; sourceFrame: number; source: LegacyAssetSource }
    >()
    for (const layer of layers) {
      const clip = layer.clip
      const source = this.sources.get(clip.assetId)
      if (!source) continue
      if (source.protocol !== 'legacy') continue // prevalidated above
      const sourceFrame = layer.sourceFrame
      wants.set(`${clip.assetId}@${sourceFrame}`, {
        assetId: clip.assetId,
        sourceFrame,
        source,
      })
    }

    // Fetch every batch concurrently; a provider failure degrades to an
    // empty batch (the worker may still hold the frame in cache).
    const entries: CompositeSourceEntry[] = await Promise.all(
      [...wants.values()].map(async ({ assetId, sourceFrame, source }) => {
        const assetFrame = rescaleFrames(sourceFrame, doc.frameRate, source.rate)
        const targetSec = framesToSeconds(assetFrame, source.rate)
        const toleranceSec = source.rate.den / source.rate.num / 2
        let chunks: ChunkPayload[] = []
        try {
          chunks = await source.chunkProvider.chunksForTimestamp(targetSec, toleranceSec)
        } catch (e) {
          console.warn(
            `[render-bridge] chunk fetch failed for asset ${assetId}:`,
            e instanceof Error ? e.message : e,
          )
        }
        return {
          assetId,
          sourceFrame,
          targetTimestampUs: Math.round(targetSec * 1e6),
          toleranceUs: Math.round(toleranceSec * 1e6),
          chunks,
        }
      }),
    )

    // A newer call started — or the doc was swapped — while we were
    // reading chunks: don't even post.
    if (
      this.latestCallId !== requestId
      || this.doc !== doc
      || this.sourceRevision !== revision
      || this.disposed
    ) return SUPERSEDED

    this.settlePendingAsSuperseded()

    return new Promise((resolve) => {
      this.pending.set(requestId, {
        resolve,
        sources: new Map(
          [...wants.values()].map(({ assetId, source }) => [assetId, source]),
        ),
      })
      this.post(
        { type: 'composite', requestId, frame, sources: entries },
        entries.flatMap((entry) => entry.chunks.map((chunk) => chunk.data)),
      )
    })
  }

  private renderStreamingFrame(
    doc: TimelineDoc,
    layers: VisibleVideoLayer[],
    frame: number,
    requestId: number,
    mode: RenderMode,
  ): Promise<RenderFrameResult> {
    const entries: StreamingCompositeSourceEntry[] = []
    const requestSources = new Map<AssetId, AssetSource>()
    for (const layer of layers) {
      const clip = layer.clip
      const source = this.sources.get(clip.assetId)
      if (!source) continue
      if (source.protocol !== 'streaming') continue // prevalidated above
      requestSources.set(clip.assetId, source)
      const targetTimestampUs = source.kind === 'image'
        ? 0
        : Math.round(
            framesToSeconds(
              rescaleFrames(layer.sourceFrame, doc.frameRate, source.rate),
              source.rate,
            ) * 1e6,
          )
      entries.push({
        clipId: clip.id,
        assetId: clip.assetId,
        sourceFrame: layer.sourceFrame,
        targetTimestampUs,
      })
    }

    // Unlike the legacy batch table, entries stay clip-keyed. Two clips may
    // show the same asset frame while owning independent playback cursors.
    this.settlePendingAsSuperseded()
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, sources: requestSources })
      this.post({ type: 'renderFrame', requestId, frame, mode, sources: entries }, [])
    })
  }

  /** Shut the worker's decoders down and terminate the worker. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sourceRevision++
    this.post({ type: 'close' }, [])
    this.settlePendingAsSuperseded()
    for (const waiter of this.pendingConfigures.values()) {
      waiter.reject(new Error('bridge disposed'))
    }
    this.pendingConfigures.clear()
  }

  private settlePendingAsSuperseded(): void {
    for (const pending of this.pending.values()) pending.resolve(SUPERSEDED)
    this.pending.clear()
  }

  private post(msg: ToRenderWorker, transfer: Transferable[]): void {
    this.worker.postMessage(msg, transfer)
  }

  private route(msg: FromRenderWorker): void {
    switch (msg.type) {
      case 'assetConfigured': {
        this.pendingConfigures.get(msg.assetId)?.resolve()
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
      case 'error': {
        // A configure failure rejects its waiter (unsupported codec, …).
        if (
          msg.requestId === undefined
          && msg.assetId !== undefined
          && this.pendingConfigures.has(msg.assetId)
        ) {
          const waiter = this.pendingConfigures.get(msg.assetId) as {
            resolve: () => void
            reject: (error: Error) => void
          }
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
        this.worker.terminate?.()
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
