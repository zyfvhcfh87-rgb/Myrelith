/**
 * workers/render.worker.ts — The compositing worker. Phase 4.1b.
 *
 * Hosts ONE VideoDecoder + ImageBitmap cache PER ASSET and runs
 * pipeline/render.compositeFrame over them, so multi-track timelines
 * decode in parallel and draw off the main thread. Inherits every
 * hard-won rule from the decode worker (Phase 2.2/2.5):
 * - every VideoFrame closes the moment its bitmap copy exists;
 * - caches hold decoder-independent ImageBitmaps, never VideoFrames;
 * - backpressure: decodeQueueSize < QUEUE_HIGH_WATER, park on dequeue;
 * - reset() UNCONFIGURES a decoder — reconfigure after every reset;
 * - latest-wins: newer composites (and setDoc/configureAsset) supersede
 *   in-flight ones, which unwind fast and never touch the screen.
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
 * Layering: workers/ → domain/, engine/frame-cache, decode-protocol
 * (types), pipeline/render (sanctioned: pure compositing core, imports
 * domain/ only). Logic lives in createRenderWorkerCore() with injected
 * browser deps; the real wiring at the bottom only runs in a worker scope.
 */

import { FrameRingBuffer } from '../engine/frame-cache'
import type { AssetId, TimelineDoc } from '../domain/schema'
import type { Composite2D, FrameSource } from '../pipeline/render'
import { compositeFrame } from '../pipeline/render'
import type { ChunkPayload } from './decode-protocol'
import type {
  BitmapLike,
  DecodableFrame,
  VideoDecoderLike,
} from './decode.worker'
import type {
  CompositeSourceEntry,
  FromRenderWorker,
  ToRenderWorker,
} from './render-protocol'

/** Same high-water mark as the decode worker (plan-mandated). */
const QUEUE_HIGH_WATER = 8

/** Ring-buffer capacity PER ASSET (each asset caches independently). */
const CACHE_CAPACITY = 12

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
  getContext(contextId: '2d'): Composite2D | null
}

/** Everything the core needs from the outside world. */
export interface RenderWorkerEnv {
  post(msg: FromRenderWorker): void
  createDecoder(init: {
    output: (frame: DecodableFrame) => void
    error: (e: { message: string }) => void
  }): VideoDecoderLike
  isConfigSupported(config: VideoDecoderConfig): Promise<{ supported?: boolean }>
  createChunk(payload: ChunkPayload): unknown
  /** GPU-copy a frame into a decoder-independent bitmap (createImageBitmap). */
  createBitmap(frame: DecodableFrame): Promise<BitmapLike>
  /** Create the scratch compositing surface (new OffscreenCanvas). */
  createCanvas(width: number, height: number): RenderCanvasLike
  now(): number
}

/* ------------------------------------------------------------------ */
/* Core                                                                 */
/* ------------------------------------------------------------------ */

/** One asset's decode machinery. Created by configureAsset. */
interface AssetState {
  config: VideoDecoderConfig
  decoder: VideoDecoderLike | null
  /** Decoded frames as ImageBitmaps, keyed by asset timestamp µs. */
  cache: FrameRingBuffer<BitmapLike>
  /** Feed loops parked on backpressure; woken by dequeue and supersession. */
  waiters: Set<() => void>
  /** Serializes decode batches: same-asset entries run one after another. */
  chain: Promise<void>
  /** Bumped when the asset is reconfigured/released: outstanding loans
   * must close their bitmap instead of re-putting it into a new cache. */
  epoch: number
  /** Decoder faulted (or torn down): entries resolve null until reconfigured. */
  dead: boolean
  /** createImageBitmap jobs of the CURRENT batch (one batch at a time per
   * asset, thanks to `chain`); awaited before the post-flush cache probe. */
  batchJobs: Array<Promise<void>>
}

/** A bitmap on loan from its cache to the in-flight composite. */
interface Loan {
  state: AssetState
  epoch: number
  key: number
  bitmap: BitmapLike
}

export function createRenderWorkerCore(env: RenderWorkerEnv): {
  handleMessage(msg: ToRenderWorker): Promise<void>
} {
  let visible: RenderCanvasLike | null = null
  let visibleCtx: Composite2D | null = null
  let scratch: RenderCanvasLike | null = null
  let scratchCtx: Composite2D | null = null
  let doc: TimelineDoc | null = null
  /** Bumped by every composite/setDoc/configureAsset/releaseAsset/close;
   * stale composites and parked feed loops check it and unwind. */
  let generation = 0
  /** Composites run strictly one at a time (stale ones exit immediately). */
  let compositeChain: Promise<void> = Promise.resolve()
  const assets = new Map<AssetId, AssetState>()

  function wake(state: AssetState): void {
    const waiters = [...state.waiters]
    state.waiters.clear()
    for (const wakeOne of waiters) wakeOne()
  }

  function waitForWake(state: AssetState): Promise<void> {
    return new Promise((resolve) => state.waiters.add(resolve))
  }

  /** Invalidate all in-flight work (new composite / doc / config change). */
  function supersede(): number {
    generation++
    for (const state of assets.values()) wake(state)
    return generation
  }

  /** Size both canvases to the doc; a resize wipes them (next blit repaints). */
  function syncCanvases(): void {
    if (!visible || !doc) return
    if (visible.width !== doc.width || visible.height !== doc.height) {
      visible.width = doc.width
      visible.height = doc.height
    }
    if (!scratch) {
      scratch = env.createCanvas(doc.width, doc.height)
      scratchCtx = scratch.getContext('2d')
      if (!scratchCtx) {
        env.post({ type: 'error', message: 'scratch canvas 2d context unavailable' })
      }
    } else if (scratch.width !== doc.width || scratch.height !== doc.height) {
      scratch.width = doc.width
      scratch.height = doc.height
    }
  }

  /** Cached timestamp within tolerance of the target, or null. */
  function findCachedKey(
    cache: FrameRingBuffer<BitmapLike>,
    targetTimestampUs: number,
    toleranceUs: number,
  ): number | null {
    for (const key of cache.keys()) {
      if (Math.abs(key - targetTimestampUs) <= toleranceUs) return key
    }
    return null
  }

  /** Tear one asset's machinery down (release/replace/close paths). */
  function teardownAsset(state: AssetState): void {
    state.epoch++ // outstanding loans now close instead of re-putting
    state.dead = true
    state.decoder?.close()
    state.decoder = null
    state.cache.clear()
    wake(state)
  }

  /**
   * Produce the bitmap for one composite source entry. Runs on the asset's
   * chain (never concurrently with another batch for the same asset).
   * Order: cache probe → decode the provided batch → probe again. A found
   * bitmap is take()n out of the cache and recorded as a loan.
   */
  async function resolveEntry(
    state: AssetState,
    entry: CompositeSourceEntry,
    myGen: number,
    loans: Loan[],
    requestId: number,
  ): Promise<BitmapLike | null> {
    if (generation !== myGen) return null
    if (state.dead) return null
    const decoder = state.decoder
    if (!decoder) return null

    const cachedKey = findCachedKey(state.cache, entry.targetTimestampUs, entry.toleranceUs)
    if (cachedKey !== null) {
      const bitmap = state.cache.take(cachedKey) as BitmapLike
      loans.push({ state, epoch: state.epoch, key: cachedKey, bitmap })
      return bitmap
    }

    if (entry.chunks.length === 0) return null // cold cache, no chunks: miss
    if (entry.chunks[0].type !== 'key') {
      env.post({
        type: 'error',
        requestId,
        assetId: entry.assetId,
        message: 'composite batch must start with a keyframe chunk',
      })
      return null
    }

    try {
      // reset() unconfigures (spec) — reconfigure before decoding.
      decoder.reset()
      decoder.configure(state.config)

      for (const chunk of entry.chunks) {
        while (decoder.decodeQueueSize >= QUEUE_HIGH_WATER) {
          // Check BEFORE parking: a supersession that fired while this loop
          // was feeding (not parked) already spent its wake — parking after
          // it would wait for a dequeue that a stale batch may never get.
          if (generation !== myGen || state.dead) return null
          await waitForWake(state)
          if (generation !== myGen || state.dead) return null
        }
        if (generation !== myGen || state.dead) return null
        decoder.decode(env.createChunk(chunk))
      }
      try {
        await decoder.flush()
      } catch {
        // flush() rejects when superseded mid-flush or on decoder trouble;
        // the generation check and final probe below decide what remains.
      }
    } catch (e) {
      env.post({
        type: 'error',
        requestId,
        assetId: entry.assetId,
        message: `decode failed: ${e instanceof Error ? e.message : String(e)}`,
      })
      return null
    }

    // Outputs are emitted by now; wait for their bitmap copies to land.
    await Promise.allSettled(state.batchJobs.splice(0))
    if (generation !== myGen) return null

    const key = findCachedKey(state.cache, entry.targetTimestampUs, entry.toleranceUs)
    if (key === null) return null // target not in the batch / tolerance
    const bitmap = state.cache.take(key) as BitmapLike
    loans.push({ state, epoch: state.epoch, key, bitmap })
    return bitmap
  }

  async function handleConfigureAsset(
    msg: Extract<ToRenderWorker, { type: 'configureAsset' }>,
  ): Promise<void> {
    supersede() // in-flight composites may reference the machinery we replace
    const existing = assets.get(msg.assetId)
    if (existing) {
      teardownAsset(existing)
      assets.delete(msg.assetId)
    }

    const support = await env.isConfigSupported(msg.config)
    if (!support.supported) {
      env.post({
        type: 'error',
        assetId: msg.assetId,
        message: `codec not supported by this browser: ${msg.config.codec}`,
      })
      return
    }

    const state: AssetState = {
      config: msg.config,
      decoder: null,
      cache: new FrameRingBuffer<BitmapLike>(CACHE_CAPACITY),
      waiters: new Set(),
      chain: Promise.resolve(),
      epoch: 0,
      dead: false,
      batchJobs: [],
    }
    state.decoder = env.createDecoder({
      // The cache path from the decode worker: GPU-copy to a bitmap, then
      // close the VideoFrame at the first possible moment — it owns a
      // hardware decoder output buffer (the Phase 2.5 crawl bug).
      output: (frame) => {
        const timestampUs = frame.timestamp
        const job = env
          .createBitmap(frame)
          .then((bitmap) => {
            try {
              state.cache.put(timestampUs, bitmap)
            } catch {
              bitmap.close() // cache refused it (aliased key): do not leak
            }
          })
          .catch(() => undefined) // bitmap creation failed: nothing to cache
          .finally(() => frame.close())
        state.batchJobs.push(job)
      },
      error: (e) => {
        state.dead = true
        wake(state)
        env.post({
          type: 'error',
          assetId: msg.assetId,
          message: `decoder: ${e.message}`,
        })
      },
    })
    state.decoder.ondequeue = () => wake(state)
    state.decoder.configure(msg.config)
    assets.set(msg.assetId, state)
    env.post({ type: 'assetConfigured', assetId: msg.assetId })
  }

  function handleComposite(
    msg: Extract<ToRenderWorker, { type: 'composite' }>,
  ): Promise<void> {
    // Supersede AT ARRIVAL: older in-flight/queued composites unwind now.
    const myGen = supersede()

    const run = async (): Promise<void> => {
      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      if (!visibleCtx || !scratch || !scratchCtx || !doc) {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: 'composite before init/setDoc',
        })
        return
      }
      const startedAt = env.now()

      // Source table: exact (assetId, sourceFrame) keys, memoized so two
      // clips sharing an entry share one decode and ONE loan.
      const table = new Map<string, CompositeSourceEntry>()
      for (const entry of msg.sources) {
        table.set(`${entry.assetId}@${entry.sourceFrame}`, entry)
      }
      const memo = new Map<string, Promise<BitmapLike | null>>()
      const loans: Loan[] = []
      const source: FrameSource = {
        getFrame: (assetId, sourceFrame) => {
          const key = `${assetId}@${sourceFrame}`
          const memoized = memo.get(key)
          if (memoized) return memoized
          const entry = table.get(key)
          const state = entry ? assets.get(entry.assetId) : undefined
          let promise: Promise<BitmapLike | null>
          if (!entry || !state) {
            promise = Promise.resolve(null)
          } else {
            promise = state.chain.then(() =>
              resolveEntry(state, entry, myGen, loans, msg.requestId),
            )
            state.chain = promise.then(
              () => undefined,
              () => undefined,
            )
          }
          memo.set(key, promise)
          return promise
        },
      }

      const target = scratchCtx
      let result
      try {
        result = await compositeFrame(doc, msg.frame, target, source)
      } finally {
        // Return every loan: ownership back to the cache — unless the
        // asset was reconfigured/released meanwhile (epoch mismatch), in
        // which case the bitmap belongs to a dead stream and closes here.
        for (const loan of loans) {
          if (loan.state.epoch === loan.epoch) {
            loan.state.cache.put(loan.key, loan.bitmap)
          } else {
            loan.bitmap.close()
          }
        }
      }

      if (generation !== myGen) {
        postSuperseded(msg.requestId)
        return
      }
      // Atomic present: the only write the visible canvas ever sees.
      // (At runtime `scratch` is an OffscreenCanvas — a valid drawImage
      // source; the structural Composite2D signature says ImageBitmap.)
      visibleCtx.drawImage(scratch as unknown as ImageBitmap, 0, 0)
      env.post({
        type: 'compositeDone',
        requestId: msg.requestId,
        status: 'drawn',
        drawnClipIds: result.drawn,
        missingClipIds: result.missing,
        renderMs: env.now() - startedAt,
      })
    }

    // Strictly sequential; a failure posts an error and keeps the chain.
    compositeChain = compositeChain.then(() =>
      run().catch((e) => {
        env.post({
          type: 'error',
          requestId: msg.requestId,
          message: `composite failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        })
      }),
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
        visibleCtx = visible.getContext('2d')
        if (!visibleCtx) {
          env.post({ type: 'error', message: 'OffscreenCanvas 2d context unavailable' })
        }
        syncCanvases()
        break
      }
      case 'setDoc': {
        supersede() // an in-flight composite is rendering a stale doc
        doc = msg.doc
        syncCanvases()
        break
      }
      case 'configureAsset':
        await handleConfigureAsset(msg)
        break
      case 'releaseAsset': {
        supersede()
        const state = assets.get(msg.assetId)
        if (state) {
          teardownAsset(state)
          assets.delete(msg.assetId)
        }
        break
      }
      case 'composite':
        await handleComposite(msg)
        break
      case 'close': {
        supersede()
        for (const state of assets.values()) teardownAsset(state)
        assets.clear()
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
        requestId: msg.type === 'composite' ? msg.requestId : undefined,
        message: `worker ${msg.type} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      })
    }
  }

  return { handleMessage }
}

/* ------------------------------------------------------------------ */
/* Real worker wiring (skipped in tests / main thread)                  */
/* ------------------------------------------------------------------ */

declare const WorkerGlobalScope: unknown

if (typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined') {
  const core = createRenderWorkerCore({
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
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
    now: () => performance.now(),
  })

  self.addEventListener('message', (event: MessageEvent<ToRenderWorker>) => {
    void core.handleMessage(event.data)
  })
}
