/**
 * workers/decode.worker.ts — The decode worker. Phase 2.2 — the most
 * memory-critical module in the project (spec Bottlenecks #1 and #3).
 *
 * Non-negotiables implemented here:
 * - EVERY decoded frame is close()'d in a `finally`, drawn or not, error or
 *   not. Frames never outlive their output callback. (Ring-buffer caching
 *   arrives in Phase 2.3 and will take over ownership explicitly.)
 * - Backpressure: never let decodeQueueSize exceed QUEUE_HIGH_WATER; wait
 *   for 'dequeue' before feeding more (keeps the worker responsive and
 *   memory bounded).
 * - Latest-wins seeks: a newer seek resets the decoder, wakes any waiting
 *   feed loop, and the stale loop exits at its next generation check —
 *   scrubbing never queues up a backlog of dead work.
 *
 * The logic lives in createDecodeWorkerCore() with injected browser deps so
 * Vitest can drive it with fakes (decode.worker.test.ts proves the close /
 * backpressure / supersede behavior). The real wiring at the bottom only
 * runs inside an actual worker scope.
 */

import type {
  ChunkPayload,
  FromDecodeWorker,
  ToDecodeWorker,
} from './decode-protocol'

/** Plan-mandated high-water mark for decoder queue backpressure. */
const QUEUE_HIGH_WATER = 8

/* ------------------------------------------------------------------ */
/* Structural types for injectable browser deps                         */
/* ------------------------------------------------------------------ */

/** The slice of VideoFrame the worker touches (real VideoFrame satisfies it). */
export interface DecodableFrame {
  timestamp: number
  displayWidth: number
  displayHeight: number
  close(): void
}

/** The slice of VideoDecoder the worker drives. */
export interface VideoDecoderLike {
  decodeQueueSize: number
  ondequeue: (() => void) | null
  configure(config: VideoDecoderConfig): void
  decode(chunk: unknown): void
  flush(): Promise<void>
  reset(): void
  close(): void
}

export interface Canvas2DLike {
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
}

export interface CanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): Canvas2DLike | null
}

/** Everything the core needs from the outside world. */
export interface DecodeWorkerEnv {
  post(msg: FromDecodeWorker): void
  createDecoder(init: {
    output: (frame: DecodableFrame) => void
    error: (e: { message: string }) => void
  }): VideoDecoderLike
  isConfigSupported(config: VideoDecoderConfig): Promise<{ supported?: boolean }>
  createChunk(payload: ChunkPayload): unknown
  now(): number
}

/* ------------------------------------------------------------------ */
/* Core                                                                 */
/* ------------------------------------------------------------------ */

interface SeekTarget {
  requestId: number
  targetTimestampUs: number
  toleranceUs: number
  startedAt: number
  drew: boolean
}

export function createDecodeWorkerCore(env: DecodeWorkerEnv): {
  handleMessage(msg: ToDecodeWorker): Promise<void>
} {
  let canvas: CanvasLike | null = null
  let ctx: Canvas2DLike | null = null
  let decoder: VideoDecoderLike | null = null
  /** Bumped by every seek/configure/close; stale async loops check it and bail. */
  let generation = 0
  let target: SeekTarget | null = null
  /** Feed loops parked on backpressure; woken by dequeue events and resets. */
  const queueWaiters = new Set<() => void>()

  function wakeAllWaiters(): void {
    const waiters = [...queueWaiters]
    queueWaiters.clear()
    for (const wake of waiters) wake()
  }

  function waitForWake(): Promise<void> {
    return new Promise((resolve) => queueWaiters.add(resolve))
  }

  /**
   * The output callback — where the frame-closing rule lives. The frame is
   * closed in `finally` on every path: drawn, ignored, or crashed.
   */
  function onFrame(frame: DecodableFrame): void {
    try {
      const t = target
      if (
        t !== null &&
        !t.drew &&
        canvas !== null &&
        ctx !== null &&
        Math.abs(frame.timestamp - t.targetTimestampUs) <= t.toleranceUs
      ) {
        t.drew = true
        if (
          canvas.width !== frame.displayWidth ||
          canvas.height !== frame.displayHeight
        ) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
        env.post({
          type: 'frameReady',
          requestId: t.requestId,
          drewFrame: true,
          frameTimestampUs: frame.timestamp,
          decodeMs: env.now() - t.startedAt,
        })
      }
    } catch (e) {
      env.post({
        type: 'error',
        requestId: target?.requestId,
        message: `draw failed: ${e instanceof Error ? e.message : String(e)}`,
      })
    } finally {
      frame.close()
    }
  }

  async function handleConfigure(config: VideoDecoderConfig): Promise<void> {
    generation++
    wakeAllWaiters()
    const support = await env.isConfigSupported(config)
    if (!support.supported) {
      env.post({
        type: 'error',
        message: `codec not supported by this browser: ${config.codec}`,
      })
      return
    }
    if (decoder) decoder.close()
    target = null
    decoder = env.createDecoder({
      output: onFrame,
      error: (e) => env.post({ type: 'error', message: `decoder: ${e.message}` }),
    })
    decoder.ondequeue = wakeAllWaiters
    decoder.configure(config)
    env.post({ type: 'configured' })
  }

  async function handleSeek(
    msg: Extract<ToDecodeWorker, { type: 'seek' }>,
  ): Promise<void> {
    if (!decoder || !ctx) {
      env.post({
        type: 'error',
        requestId: msg.requestId,
        message: 'seek before init/configure',
      })
      return
    }
    if (msg.chunks.length > 0 && msg.chunks[0].type !== 'key') {
      env.post({
        type: 'error',
        requestId: msg.requestId,
        message: 'seek batch must start with a keyframe chunk',
      })
      return
    }

    const gen = ++generation
    // Free any older feed loop stuck on backpressure, then drop its queue.
    wakeAllWaiters()
    decoder.reset()
    target = {
      requestId: msg.requestId,
      targetTimestampUs: msg.targetTimestampUs,
      toleranceUs: msg.toleranceUs,
      startedAt: env.now(),
      drew: false,
    }

    for (const chunk of msg.chunks) {
      while (decoder.decodeQueueSize >= QUEUE_HIGH_WATER) {
        await waitForWake()
        if (generation !== gen) return // superseded while parked
      }
      if (generation !== gen) return
      decoder.decode(env.createChunk(chunk))
    }

    // Force out reordered/buffered tail frames — without this, the target
    // frame of a short batch may sit inside the decoder forever.
    try {
      await decoder.flush()
    } catch {
      // flush() rejects when a newer seek reset the decoder mid-flush;
      // if that happened we are stale and the check below exits.
    }
    if (generation !== gen) return

    const t = target
    if (t !== null && t.requestId === msg.requestId && !t.drew) {
      env.post({
        type: 'frameReady',
        requestId: t.requestId,
        drewFrame: false,
        frameTimestampUs: -1,
        decodeMs: env.now() - t.startedAt,
      })
    }
  }

  async function handleMessage(msg: ToDecodeWorker): Promise<void> {
    switch (msg.type) {
      case 'init': {
        canvas = msg.canvas
        ctx = canvas.getContext('2d')
        if (!ctx) env.post({ type: 'error', message: 'OffscreenCanvas 2d context unavailable' })
        break
      }
      case 'configure':
        await handleConfigure(msg.config)
        break
      case 'seek':
        await handleSeek(msg)
        break
      case 'close': {
        generation++
        wakeAllWaiters()
        target = null
        if (decoder) {
          decoder.close()
          decoder = null
        }
        break
      }
    }
  }

  return { handleMessage }
}

/* ------------------------------------------------------------------ */
/* Real worker wiring (skipped in tests / main thread)                  */
/* ------------------------------------------------------------------ */

declare const WorkerGlobalScope: unknown

if (typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined') {
  const core = createDecodeWorkerCore({
    post: (msg) => self.postMessage(msg),
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
    now: () => performance.now(),
  })

  self.addEventListener('message', (event: MessageEvent<ToDecodeWorker>) => {
    void core.handleMessage(event.data)
  })
}
