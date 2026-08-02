/**
 * engine/worker-bridge.ts — Retired main-thread decode-worker facade retained
 * as a tested compatibility module. Current preview uses RenderWorkerBridge.
 *
 * Speaks frames on one side (renderFrameAt(frame)) and the typed
 * ToDecodeWorker/FromDecodeWorker protocol on the other. Owns:
 * - frame → microsecond conversion (domain/time at the boundary, rule 2),
 * - request-id bookkeeping and latest-wins supersession: a newer
 *   renderFrameAt call resolves all older in-flight ones as 'superseded'
 *   (matching the worker's own latest-wins behavior),
 * - transfer lists: chunk buffers and the canvas are TRANSFERRED, never
 *   copied.
 *
 * Layering: engine/ → domain/ + the types-only worker protocol. The chunk
 * provider (pipeline/VideoChunkSource) is injected behind a structural
 * interface, so this file never imports pipeline/ — and tests inject fakes
 * for both the worker and the provider.
 */

import type { FrameRate } from '../domain/schema'
import { framesToSeconds } from '../domain/time'
import type {
  ChunkPayload,
  FromDecodeWorker,
  ToDecodeWorker,
} from '../workers/decode-protocol'
import type { ChunkProvider, WorkerLike } from './worker-types'

export type { ChunkProvider, WorkerLike } from './worker-types'

/** What a render request came to: exactly one of these, exactly once. */
export type RenderStatus = 'drawn' | 'missed' | 'superseded' | 'error'

export interface RenderResult {
  status: RenderStatus
  /** Timestamp of the frame drawn (µs), or -1 when nothing was drawn. */
  frameTimestampUs: number
  /** Worker-side decode+draw time in ms (0 when nothing ran). */
  decodeMs: number
  /** Present when status === 'error'. */
  message?: string
}

/** What the bridge decodes from: a rate + a chunk provider, per asset. */
interface BridgeSource {
  rate: FrameRate
  chunkProvider: ChunkProvider
}

/** @deprecated Runtime-dead compatibility facade; use RenderWorkerBridge. */
export class DecodeWorkerBridge {
  private readonly worker: WorkerLike
  private source: BridgeSource | null = null
  private nextRequestId = 1
  /** Id of the newest renderFrameAt CALL — stale calls detect supersession. */
  private latestCallId = 0
  private readonly pending = new Map<number, (result: RenderResult) => void>()
  private pendingConfigure: {
    resolve: () => void
    reject: (error: Error) => void
  } | null = null
  /** Errors not tied to a request (decoder faults mid-stream) land here. */
  onWorkerError: ((message: string) => void) | null = null

  constructor(worker: WorkerLike) {
    this.worker = worker
    worker.addEventListener('message', (event: MessageEvent) => {
      this.route(event.data as FromDecodeWorker)
    })
  }

  /**
   * Point the bridge at an asset's chunks/rate. Callable repeatedly (the
   * preview switches assets); any in-flight requests resolve 'superseded'.
   * Pair with configure() for the matching decoder config.
   */
  setSource(rate: FrameRate, chunkProvider: ChunkProvider): void {
    this.source = { rate, chunkProvider }
    for (const resolve of this.pending.values()) {
      resolve({ status: 'superseded', frameTimestampUs: -1, decodeMs: 0 })
    }
    this.pending.clear()
  }

  /** Hand the drawing surface to the worker (transferred, call once). */
  init(canvas: OffscreenCanvas): void {
    this.post({ type: 'init', canvas }, [canvas])
  }

  /** Configure the worker's decoder; resolves on ack, rejects on failure. */
  configure(config: VideoDecoderConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingConfigure = { resolve, reject }
      this.post({ type: 'configure', config }, [])
    })
  }

  /**
   * Render the given integer frame (at the CURRENT source's rate) onto the
   * worker's canvas. Latest-wins: issuing a new call settles older in-flight
   * calls as 'superseded'. Never rejects — errors come back in the result.
   */
  async renderFrameAt(frame: number): Promise<RenderResult> {
    const source = this.source
    if (!source) {
      return {
        status: 'error',
        frameTimestampUs: -1,
        decodeMs: 0,
        message: 'no source configured (call setSource first)',
      }
    }
    const requestId = this.nextRequestId++
    this.latestCallId = requestId

    const targetSec = framesToSeconds(frame, source.rate)
    const toleranceSec = source.rate.den / source.rate.num / 2

    let chunks: ChunkPayload[]
    try {
      chunks = await source.chunkProvider.chunksForTimestamp(targetSec, toleranceSec)
    } catch (e) {
      return {
        status: 'error',
        frameTimestampUs: -1,
        decodeMs: 0,
        message: e instanceof Error ? e.message : String(e),
      }
    }

    // A newer call started — or the source was swapped — while we were
    // reading chunks: don't even post.
    if (this.latestCallId !== requestId || this.source !== source) {
      return { status: 'superseded', frameTimestampUs: -1, decodeMs: 0 }
    }

    // Latest wins: settle every older in-flight request now.
    for (const resolve of this.pending.values()) {
      resolve({ status: 'superseded', frameTimestampUs: -1, decodeMs: 0 })
    }
    this.pending.clear()

    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.post(
        {
          type: 'seek',
          requestId,
          targetTimestampUs: Math.round(targetSec * 1e6),
          toleranceUs: Math.round(toleranceSec * 1e6),
          chunks,
        },
        chunks.map((c) => c.data),
      )
    })
  }

  /** Shut the worker's decoder down and terminate the worker. */
  dispose(): void {
    this.post({ type: 'close' }, [])
    this.worker.terminate?.()
  }

  private post(msg: ToDecodeWorker, transfer: Transferable[]): void {
    this.worker.postMessage(msg, transfer)
  }

  private route(msg: FromDecodeWorker): void {
    switch (msg.type) {
      case 'configured': {
        this.pendingConfigure?.resolve()
        this.pendingConfigure = null
        break
      }
      case 'frameReady': {
        const resolve = this.pending.get(msg.requestId)
        if (!resolve) break // late reply for a superseded request: ignore
        this.pending.delete(msg.requestId)
        resolve({
          status: msg.drewFrame ? 'drawn' : 'missed',
          frameTimestampUs: msg.frameTimestampUs,
          decodeMs: msg.decodeMs,
        })
        break
      }
      case 'error': {
        if (msg.requestId !== undefined && this.pending.has(msg.requestId)) {
          const resolve = this.pending.get(msg.requestId) as (
            r: RenderResult,
          ) => void
          this.pending.delete(msg.requestId)
          resolve({
            status: 'error',
            frameTimestampUs: -1,
            decodeMs: 0,
            message: msg.message,
          })
        } else if (this.pendingConfigure) {
          this.pendingConfigure.reject(new Error(msg.message))
          this.pendingConfigure = null
        } else {
          this.onWorkerError?.(msg.message)
        }
        break
      }
    }
  }
}

/**
 * Real wiring: spawn the decode worker as a Vite module worker. Kept out of
 * the class so tests construct DecodeWorkerBridge with a fake.
 * @deprecated Runtime-dead compatibility factory; use createRenderWorker.
 */
export function createDecodeWorker(): Worker {
  return new Worker(new URL('../workers/decode.worker.ts', import.meta.url), {
    type: 'module',
  })
}
