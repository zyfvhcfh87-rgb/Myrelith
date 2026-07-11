/**
 * engine/render-bridge.ts — Main-thread facade over the render worker.
 * Phase 4.1c.
 *
 * Speaks document frames on one side (renderFrame(frame)) and the typed
 * ToRenderWorker/FromRenderWorker protocol on the other. Owns everything
 * the render-protocol says the MAIN side owns:
 * - deciding which (asset, sourceFrame) pairs a composite needs, via the
 *   canonical domain visibleVideoLayersAtFrame plan over the SAME document
 *   snapshot it last posted (setDoc
 *   stores it, satisfying the protocol's ordering contract);
 * - all µs math: doc frame → asset frame (rescaleFrames) → target/
 *   tolerance microseconds (frame↔seconds only at this boundary, rule 2);
 * - fetching chunk batches from per-asset ChunkProviders CONCURRENTLY and
 *   TRANSFERRING their buffers;
 * - request-id bookkeeping with latest-wins supersession, mirroring the
 *   worker's own (a newer renderFrame settles older in-flight ones as
 *   'superseded'; the worker answers every request regardless).
 *
 * Layering: engine/ → domain/ + types-only worker protocols. Chunk
 * providers (pipeline/VideoChunkSource) are injected behind the same
 * structural interface DecodeWorkerBridge uses; tests inject fakes for
 * both the worker and the providers.
 */

import type { AssetId, ClipId, FrameRate, TimelineDoc } from '../domain/schema'
import { visibleVideoLayersAtFrame } from '../domain/selectors'
import { framesToSeconds, rescaleFrames } from '../domain/time'
import type { ChunkPayload } from '../workers/decode-protocol'
import type {
  CompositeSourceEntry,
  FromRenderWorker,
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

/** What the bridge knows about one configured asset. */
interface AssetSource {
  rate: FrameRate
  chunkProvider: ChunkProvider
}

export class RenderWorkerBridge {
  private readonly worker: WorkerLike
  /** The doc snapshot last posted via setDoc — composites are built from
   * THIS, never from a fresher store read (protocol ordering contract). */
  private doc: TimelineDoc | null = null
  private readonly sources = new Map<AssetId, AssetSource>()
  private nextRequestId = 1
  /** Id of the newest renderFrame CALL — stale calls detect supersession. */
  private latestCallId = 0
  private readonly pending = new Map<number, (result: RenderFrameResult) => void>()
  private readonly pendingConfigures = new Map<
    AssetId,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  /** Errors not tied to a request (decoder faults, stray failures). */
  onWorkerError: ((message: string) => void) | null = null
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
   */
  configureAsset(
    assetId: AssetId,
    config: VideoDecoderConfig,
    rate: FrameRate,
    chunkProvider: ChunkProvider,
  ): Promise<void> {
    this.sources.set(assetId, { rate, chunkProvider })
    return new Promise((resolve, reject) => {
      this.pendingConfigures
        .get(assetId)
        ?.reject(new Error('superseded by a newer configureAsset'))
      this.pendingConfigures.set(assetId, { resolve, reject })
      this.post({ type: 'configureAsset', assetId, config }, [])
    })
  }

  /** Drop an asset's decoder, cache and chunk source. */
  releaseAsset(assetId: AssetId): void {
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
   * missingClipIds.
   */
  async renderFrame(frame: number): Promise<RenderFrameResult> {
    const doc = this.doc
    if (!doc) {
      return {
        status: 'error',
        drawnClipIds: [],
        missingClipIds: [],
        renderMs: 0,
        message: 'no document configured (call setDoc first)',
      }
    }
    const requestId = this.nextRequestId++
    this.latestCallId = requestId

    // Which (asset, sourceFrame) pairs does this composite need? The domain
    // render plan is the same ordered truth compositeFrame consumes;
    // dedupe only the decode work, exactly like the worker's source table.
    const wants = new Map<string, { assetId: AssetId; sourceFrame: number }>()
    for (const layer of visibleVideoLayersAtFrame(doc, frame)) {
      const clip = layer.clip
      if (!this.sources.has(clip.assetId)) continue
      const sourceFrame = layer.sourceFrame
      wants.set(`${clip.assetId}@${sourceFrame}`, {
        assetId: clip.assetId,
        sourceFrame,
      })
    }

    // Fetch every batch concurrently; a provider failure degrades to an
    // empty batch (the worker may still hold the frame in cache).
    const entries: CompositeSourceEntry[] = await Promise.all(
      [...wants.values()].map(async ({ assetId, sourceFrame }) => {
        const source = this.sources.get(assetId) as AssetSource
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
    if (this.latestCallId !== requestId || this.doc !== doc) return SUPERSEDED

    // Latest wins: settle every older in-flight request now.
    for (const resolve of this.pending.values()) resolve(SUPERSEDED)
    this.pending.clear()

    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.post(
        { type: 'composite', requestId, frame, sources: entries },
        entries.flatMap((entry) => entry.chunks.map((chunk) => chunk.data)),
      )
    })
  }

  /** Shut the worker's decoders down and terminate the worker. */
  dispose(): void {
    this.post({ type: 'close' }, [])
    this.worker.terminate?.()
    for (const resolve of this.pending.values()) resolve(SUPERSEDED)
    this.pending.clear()
    for (const waiter of this.pendingConfigures.values()) {
      waiter.reject(new Error('bridge disposed'))
    }
    this.pendingConfigures.clear()
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
        const resolve = this.pending.get(msg.requestId)
        if (!resolve) break // late reply for a superseded request: ignore
        this.pending.delete(msg.requestId)
        resolve({
          status: msg.status,
          drawnClipIds: msg.drawnClipIds,
          missingClipIds: msg.missingClipIds,
          renderMs: msg.renderMs,
        })
        break
      }
      case 'error': {
        // A configure failure rejects its waiter (unsupported codec, …).
        if (msg.assetId !== undefined && this.pendingConfigures.has(msg.assetId)) {
          const waiter = this.pendingConfigures.get(msg.assetId) as {
            resolve: () => void
            reject: (error: Error) => void
          }
          this.pendingConfigures.delete(msg.assetId)
          waiter.reject(new Error(msg.message))
          break
        }
        // Request-fatal errors settle the composite: the worker sends NO
        // compositeDone for these. (Asset-scoped errors DURING a composite
        // carry an assetId and are followed by a compositeDone — those go
        // to onWorkerError below, not here.)
        if (msg.requestId !== undefined && msg.assetId === undefined) {
          const resolve = this.pending.get(msg.requestId)
          if (resolve) {
            this.pending.delete(msg.requestId)
            resolve({
              status: 'error',
              drawnClipIds: [],
              missingClipIds: [],
              renderMs: 0,
              message: msg.message,
            })
            break
          }
        }
        this.onWorkerError?.(msg.message)
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
