/**
 * workers/decode.worker.ts — The decode worker. Phase 2.2 — the most
 * memory-critical module in the project (spec Bottlenecks #1 and #3).
 *
 * Non-negotiables implemented here:
 * - EVERY decoded VideoFrame is closed as soon as its pixels are used —
 *   drawn and/or copied to an ImageBitmap. Raw VideoFrames are NEVER
 *   cached: they own the hardware decoder's output buffers, and holding
 *   even ~12 of them starves the decoder into a one-frame-per-eviction
 *   crawl (found live in the Phase 2.5 gate). The ring buffer holds
 *   decoder-independent ImageBitmaps instead, closed on eviction/clear.
 * - Backpressure: never let decodeQueueSize exceed QUEUE_HIGH_WATER; wait
 *   for 'dequeue' before feeding more (keeps the worker responsive and
 *   memory bounded).
 * - Latest-wins seeks: a newer seek resets the decoder, wakes any waiting
 *   feed loop, and the stale loop exits at its next generation check —
 *   scrubbing never queues up a backlog of dead work.
 * - Seeks check the ring buffer first: stepping backward onto a recently
 *   decoded frame draws from cache and never touches the decoder.
 *
 * Layering note: importing engine/frame-cache from workers/ is sanctioned
 * by ARCHITECTURE.md — it is a pure, React-free class with no other deps.
 *
 * The logic lives in createDecodeWorkerCore() with injected browser deps so
 * Vitest can drive it with fakes (decode.worker.test.ts proves the close /
 * backpressure / supersede behavior). The real wiring at the bottom only
 * runs inside an actual worker scope.
 */

import { FrameRingBuffer } from '../engine/frame-cache'
import type {
  ChunkPayload,
  FromDecodeWorker,
  ToDecodeWorker,
} from './decode-protocol'

/** Plan-mandated high-water mark for decoder queue backpressure. */
const QUEUE_HIGH_WATER = 8

/** Plan-mandated ring buffer capacity (frame-cache default is also 12). */
const CACHE_CAPACITY = 12

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

/** The slice of ImageBitmap the worker caches (real ImageBitmap satisfies it). */
export interface BitmapLike {
  width: number
  height: number
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
  /** GPU-copy a frame into a decoder-independent bitmap (createImageBitmap). */
  createBitmap(frame: DecodableFrame): Promise<BitmapLike>
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
  /** Last applied config — reset() UNCONFIGURES a decoder (per spec), so
   * every reset must reapply this before the next decode. */
  let currentConfig: VideoDecoderConfig | null = null
  /** Bumped by every seek/configure/close; stale async loops check it and bail. */
  let generation = 0
  let target: SeekTarget | null = null
  /** Feed loops parked on backpressure; woken by dequeue events and resets. */
  const queueWaiters = new Set<() => void>()
  /** Recently decoded frames as ImageBitmaps, keyed by timestamp µs. */
  const cache = new FrameRingBuffer<BitmapLike>(CACHE_CAPACITY)

  function wakeAllWaiters(): void {
    const waiters = [...queueWaiters]
    queueWaiters.clear()
    for (const wake of waiters) wake()
  }

  function waitForWake(): Promise<void> {
    return new Promise((resolve) => queueWaiters.add(resolve))
  }

  /** Fit the canvas to the image and draw it full-surface. */
  function drawToCanvas(image: unknown, width: number, height: number): void {
    if (canvas === null || ctx === null) throw new Error('canvas not initialized')
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  }

  /**
   * The output callback. Draw the target synchronously if this is it, then
   * ALWAYS: GPU-copy the frame to an ImageBitmap for the cache and close
   * the VideoFrame at the first possible moment — the decoder needs its
   * output buffer back or it stalls (see file header).
   */
  function onFrame(frame: DecodableFrame): void {
    try {
      const t = target
      if (
        t !== null &&
        !t.drew &&
        Math.abs(frame.timestamp - t.targetTimestampUs) <= t.toleranceUs
      ) {
        t.drew = true
        drawToCanvas(frame, frame.displayWidth, frame.displayHeight)
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
    }
    // Cache path: bitmap first, close the frame the moment the copy exists
    // (or failed). The bitmap belongs to the ring buffer from then on.
    const timestamp = frame.timestamp
    void env
      .createBitmap(frame)
      .then((bitmap) => {
        try {
          cache.put(timestamp, bitmap)
        } catch {
          bitmap.close() // cache refused it (aliased key): do not leak
        }
      })
      .catch(() => undefined) // bitmap creation failed: nothing to cache
      .finally(() => frame.close())
  }

  /** Cached timestamp within tolerance of the target, or null. */
  function findCachedKey(targetTimestampUs: number, toleranceUs: number): number | null {
    for (const key of cache.keys()) {
      if (Math.abs(key - targetTimestampUs) <= toleranceUs) return key
    }
    return null
  }

  /**
   * Drop all in-flight decoder work. reset() moves a VideoDecoder to
   * "unconfigured" (spec behavior, found the hard way in the 2.5 gate), so
   * the config is reapplied immediately — callers may decode right after.
   */
  function resetDecoder(dec: VideoDecoderLike): void {
    dec.reset()
    if (currentConfig) dec.configure(currentConfig)
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
    cache.clear() // cached frames belong to the OLD stream — never reuse
    target = null
    decoder = env.createDecoder({
      output: onFrame,
      error: (e) => env.post({ type: 'error', message: `decoder: ${e.message}` }),
    })
    decoder.ondequeue = wakeAllWaiters
    currentConfig = config
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

    // Cache first: a backward step onto a recent frame skips decoding
    // entirely. Take → draw → put back (recency refreshed).
    const cachedKey = findCachedKey(msg.targetTimestampUs, msg.toleranceUs)
    if (cachedKey !== null) {
      generation++ // any in-flight batch must not draw over this
      wakeAllWaiters()
      resetDecoder(decoder)
      target = null
      const startedAt = env.now()
      const cached = cache.take(cachedKey) as BitmapLike
      try {
        drawToCanvas(cached, cached.width, cached.height)
        env.post({
          type: 'frameReady',
          requestId: msg.requestId,
          drewFrame: true,
          frameTimestampUs: cachedKey,
          decodeMs: env.now() - startedAt,
        })
      } catch (e) {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: `draw failed: ${e instanceof Error ? e.message : String(e)}`,
        })
      } finally {
        cache.put(cachedKey, cached) // ownership back to the cache
      }
      return
    }

    const gen = ++generation
    // Free any older feed loop stuck on backpressure, then drop its queue.
    wakeAllWaiters()
    resetDecoder(decoder)
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
    try {
      await dispatch(msg)
    } catch (e) {
      // Uncaught async exceptions in a worker are silent to the page —
      // never let one vanish: report it tied to the request if possible.
      env.post({
        type: 'error',
        requestId: msg.type === 'seek' ? msg.requestId : undefined,
        message: `worker ${msg.type} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      })
    }
  }

  async function dispatch(msg: ToDecodeWorker): Promise<void> {
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
        cache.clear()
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
    createBitmap: (frame) =>
      createImageBitmap(frame as unknown as ImageBitmapSource),
    now: () => performance.now(),
  })

  self.addEventListener('message', (event: MessageEvent<ToDecodeWorker>) => {
    void core.handleMessage(event.data)
  })
}
