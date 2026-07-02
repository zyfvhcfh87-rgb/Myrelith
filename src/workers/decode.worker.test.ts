/**
 * workers/decode.worker.test.ts — Phase 2.2.
 *
 * Drives the worker core with fake decoder/canvas and asserts the three
 * safety properties the whole engine depends on:
 *   1. every emitted frame is closed, on every path (drawn/ignored/crash),
 *   2. feeding respects the decodeQueueSize backpressure gate,
 *   3. a newer seek supersedes an older one (latest-wins, no dead work).
 */

import { describe, expect, test, vi } from 'vitest'
import type {
  ChunkPayload,
  FromDecodeWorker,
  ToDecodeWorker,
} from './decode-protocol'
import type {
  Canvas2DLike,
  DecodableFrame,
  DecodeWorkerEnv,
  VideoDecoderLike,
} from './decode.worker'
import { createDecodeWorkerCore } from './decode.worker'

/* ------------------------------------------------------------------ */
/* Fakes                                                                */
/* ------------------------------------------------------------------ */

const FRAME_US = 33366 // ~one NTSC frame

interface TrackedFrame extends DecodableFrame {
  closed: boolean
}

function makeFrame(timestampUs: number, registry: TrackedFrame[]): TrackedFrame {
  const frame: TrackedFrame = {
    timestamp: timestampUs,
    displayWidth: 320,
    displayHeight: 180,
    closed: false,
    close() {
      frame.closed = true
    },
  }
  registry.push(frame)
  return frame
}

interface FakeOptions {
  supported?: boolean
  flushRejects?: boolean
  /** Drain one queue slot per microtask after each decode, like a live decoder. */
  autoDrain?: boolean
}

/**
 * Behaves like a real VideoDecoder where it matters: decode() GROWS the
 * queue (that is what makes backpressure kick in), frames only come out on
 * flush(), and reset() empties the queue and drops pending outputs.
 */
class FakeDecoder implements VideoDecoderLike {
  decodeQueueSize = 0
  ondequeue: (() => void) | null = null
  decoded: ChunkPayload[] = []
  resetCount = 0
  isClosed = false
  private pending: ChunkPayload[] = []

  private readonly output: (frame: DecodableFrame) => void
  private readonly opts: FakeOptions
  private readonly frames: TrackedFrame[]

  constructor(
    output: (frame: DecodableFrame) => void,
    opts: FakeOptions,
    frames: TrackedFrame[],
  ) {
    this.output = output
    this.opts = opts
    this.frames = frames
  }

  configure(): void {}

  decode(chunk: unknown): void {
    const payload = chunk as ChunkPayload
    this.decoded.push(payload)
    this.pending.push(payload)
    this.decodeQueueSize++
    if (this.opts.autoDrain) queueMicrotask(() => this.drain(1))
  }

  /** Simulate the decoder catching up: shrink the queue, fire dequeue. */
  drain(count: number): void {
    this.decodeQueueSize = Math.max(0, this.decodeQueueSize - count)
    this.ondequeue?.()
  }

  /** Like a real decoder: buffered frames only come out on flush(). */
  async flush(): Promise<void> {
    this.decodeQueueSize = 0
    if (this.opts.flushRejects) {
      this.pending = []
      throw new DOMException('flush aborted', 'AbortError')
    }
    for (const payload of this.pending.splice(0)) {
      this.output(makeFrame(payload.timestampUs, this.frames))
    }
  }

  reset(): void {
    this.resetCount++
    this.decodeQueueSize = 0
    this.pending = []
  }

  close(): void {
    this.isClosed = true
  }
}

interface Harness {
  core: ReturnType<typeof createDecodeWorkerCore>
  posts: FromDecodeWorker[]
  frames: TrackedFrame[]
  drawSpy: ReturnType<typeof vi.fn>
  canvas: { width: number; height: number }
  decoder: () => FakeDecoder
}

function makeHarness(opts: FakeOptions = {}, drawImpl?: () => void): Harness {
  const posts: FromDecodeWorker[] = []
  const frames: TrackedFrame[] = []
  let decoder: FakeDecoder | null = null

  const drawSpy = vi.fn(drawImpl ?? (() => {}))
  const ctx: Canvas2DLike = { drawImage: drawSpy }
  const canvas = { width: 0, height: 0, getContext: () => ctx }

  const env: DecodeWorkerEnv = {
    post: (msg) => posts.push(msg),
    createDecoder: (init) => {
      decoder = new FakeDecoder(init.output, opts, frames)
      return decoder
    },
    isConfigSupported: async () => ({ supported: opts.supported ?? true }),
    createChunk: (payload) => payload,
    now: () => 0,
  }

  return {
    core: createDecodeWorkerCore(env),
    posts,
    frames,
    drawSpy,
    canvas,
    decoder: () => {
      if (!decoder) throw new Error('decoder not created yet')
      return decoder
    },
  }
}

const initMsg = (h: Harness): ToDecodeWorker => ({
  type: 'init',
  canvas: h.canvas as unknown as OffscreenCanvas,
})

const configureMsg: ToDecodeWorker = {
  type: 'configure',
  config: { codec: 'avc1.640028' },
}

function chunk(timestampUs: number, type: 'key' | 'delta' = 'delta'): ChunkPayload {
  return { type, timestampUs, durationUs: FRAME_US, data: new ArrayBuffer(4) }
}

/** An n-frame GOP starting at 0: one keyframe, then deltas. */
function gopN(n: number): ChunkPayload[] {
  return Array.from({ length: n }, (_, i) =>
    chunk(FRAME_US * i, i === 0 ? 'key' : 'delta'),
  )
}

/** A 5-frame GOP starting at 0. */
function gop(): ChunkPayload[] {
  return gopN(5)
}

function seekMsg(
  requestId: number,
  targetTimestampUs: number,
  chunks: ChunkPayload[],
): ToDecodeWorker {
  return {
    type: 'seek',
    requestId,
    targetTimestampUs,
    toleranceUs: FRAME_US / 2,
    chunks,
  }
}

async function setup(h: Harness): Promise<void> {
  await h.core.handleMessage(initMsg(h))
  await h.core.handleMessage(configureMsg)
}

const microtasks = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/* ------------------------------------------------------------------ */
/* Configure                                                            */
/* ------------------------------------------------------------------ */

describe('init / configure', () => {
  test('supported config posts configured', async () => {
    const h = makeHarness()
    await setup(h)
    expect(h.posts).toEqual([{ type: 'configured' }])
  })

  test('unsupported config posts an error and creates no decoder', async () => {
    const h = makeHarness({ supported: false })
    await h.core.handleMessage(initMsg(h))
    await h.core.handleMessage(configureMsg)
    expect(h.posts[0].type).toBe('error')
    expect(() => h.decoder()).toThrow()
  })

  test('seek before configure posts an error', async () => {
    const h = makeHarness()
    await h.core.handleMessage(initMsg(h))
    await h.core.handleMessage(seekMsg(1, 0, gop()))
    expect(h.posts[0]).toMatchObject({ type: 'error', requestId: 1 })
  })
})

/* ------------------------------------------------------------------ */
/* Property 1: every frame closed                                       */
/* ------------------------------------------------------------------ */

describe('frame lifecycle', () => {
  test('draws ONLY the target frame; frames live in the cache, close() releases them', async () => {
    const h = makeHarness()
    await setup(h)

    await h.core.handleMessage(seekMsg(7, FRAME_US * 2, gop()))

    expect(h.drawSpy).toHaveBeenCalledTimes(1)
    const drawn = h.drawSpy.mock.calls[0][0] as TrackedFrame
    expect(drawn.timestamp).toBe(FRAME_US * 2)

    // All 5 frames are alive — owned by the ring buffer now, not leaked,
    // not prematurely closed.
    expect(h.frames).toHaveLength(5)
    expect(h.frames.every((f) => !f.closed)).toBe(true)

    expect(h.posts).toContainEqual({
      type: 'frameReady',
      requestId: 7,
      drewFrame: true,
      frameTimestampUs: FRAME_US * 2,
      decodeMs: 0,
    })
    // Canvas adopted the frame's dimensions.
    expect(h.canvas.width).toBe(320)
    expect(h.canvas.height).toBe(180)

    // Teardown proves ownership: close releases every cached frame.
    await h.core.handleMessage({ type: 'close' })
    expect(h.frames.every((f) => f.closed)).toBe(true)
  })

  test('cache stays bounded: a long batch evicts oldest frames (closed exactly once)', async () => {
    const h = makeHarness({ autoDrain: true })
    await setup(h)

    // 20 frames through a 12-slot cache: the first 8 must be evicted+closed.
    await h.core.handleMessage(seekMsg(7, FRAME_US * 19, gopN(20)))

    expect(h.frames).toHaveLength(20)
    const closedCount = h.frames.filter((f) => f.closed).length
    expect(closedCount).toBe(8)
    // Specifically the OLDEST 8 (LRU eviction).
    expect(h.frames.slice(0, 8).every((f) => f.closed)).toBe(true)
    expect(h.frames.slice(8).every((f) => !f.closed)).toBe(true)
  })

  test('missing target: frameReady(drewFrame=false); frames still cached', async () => {
    const h = makeHarness()
    await setup(h)

    await h.core.handleMessage(seekMsg(8, 999_999_999, gop()))

    expect(h.drawSpy).not.toHaveBeenCalled()
    expect(h.frames.every((f) => !f.closed)).toBe(true)
    expect(h.posts).toContainEqual({
      type: 'frameReady',
      requestId: 8,
      drewFrame: false,
      frameTimestampUs: -1,
      decodeMs: 0,
    })
  })

  test('drawImage throwing closes THAT frame (not cached) and reports an error', async () => {
    const h = makeHarness({}, () => {
      throw new Error('GPU said no')
    })
    await setup(h)

    await h.core.handleMessage(seekMsg(9, FRAME_US, gop()))

    // The frame that crashed the draw was never handed to the cache — it
    // must be closed by the finally. The others are cached (alive).
    const crashed = h.frames.find((f) => f.timestamp === FRAME_US) as TrackedFrame
    expect(crashed.closed).toBe(true)
    expect(
      h.frames.filter((f) => f !== crashed).every((f) => !f.closed),
    ).toBe(true)
    expect(h.posts).toContainEqual({
      type: 'error',
      requestId: 9,
      message: 'draw failed: GPU said no',
    })
  })

  test('flush rejection is tolerated: no crash, frameReady(false) still sent', async () => {
    const h = makeHarness({ flushRejects: true })
    await setup(h)
    await h.core.handleMessage(seekMsg(10, 0, gop()))
    expect(h.posts).toContainEqual({
      type: 'frameReady',
      requestId: 10,
      drewFrame: false,
      frameTimestampUs: -1,
      decodeMs: 0,
    })
  })

  test('non-keyframe-first batch is refused before touching the decoder', async () => {
    const h = makeHarness()
    await setup(h)
    await h.core.handleMessage(seekMsg(11, 0, [chunk(0, 'delta'), chunk(FRAME_US)]))
    expect(h.posts).toContainEqual({
      type: 'error',
      requestId: 11,
      message: 'seek batch must start with a keyframe chunk',
    })
    expect(h.decoder().decoded).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* Property 2: backpressure                                             */
/* ------------------------------------------------------------------ */

describe('backpressure', () => {
  test('feeding parks at decodeQueueSize >= 8 and resumes on dequeue', async () => {
    const h = makeHarness()
    await setup(h)
    const dec = h.decoder()

    // 12 chunks against a high-water mark of 8: the feed loop must park
    // after the 8th decode, NOT fire-hose all 12 in.
    const seekDone = h.core.handleMessage(seekMsg(12, FRAME_US * 10, gopN(12)))
    await microtasks()

    expect(dec.decoded).toHaveLength(8)
    expect(dec.decodeQueueSize).toBe(8)

    // Decoder catches up on 4 frames → loop wakes, feeds the remaining 4.
    dec.drain(4)
    await seekDone

    expect(dec.decoded).toHaveLength(12)
    expect(
      h.posts.some(
        (p) => p.type === 'frameReady' && p.requestId === 12 && p.drewFrame,
      ),
    ).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* Property 3: latest-wins seeks                                        */
/* ------------------------------------------------------------------ */

describe('seek supersession', () => {
  test('a newer seek aborts a parked one; only the newest gets frameReady', async () => {
    const h = makeHarness()
    await setup(h)
    const dec = h.decoder()

    // A parks after feeding 8 of its 12 chunks.
    const seekA = h.core.handleMessage(seekMsg(100, FRAME_US * 11, gopN(12)))
    await microtasks()
    expect(dec.decoded).toHaveLength(8)

    // B arrives: resets the decoder (dropping A's queued work) and takes
    // over. A's loop wakes stale and must feed nothing further.
    const laterGop = [chunk(FRAME_US * 30, 'key'), chunk(FRAME_US * 31)]
    const seekB = h.core.handleMessage(seekMsg(200, FRAME_US * 31, laterGop))
    await Promise.all([seekA, seekB])

    // Total fed = A's first 8 + B's 2. Nothing from A after the reset.
    expect(dec.decoded.map((c) => c.timestampUs)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => FRAME_US * i),
      FRAME_US * 30,
      FRAME_US * 31,
    ])
    expect(dec.resetCount).toBe(2) // once for A, once for B

    const readies = h.posts.filter((p) => p.type === 'frameReady')
    expect(readies).toHaveLength(1)
    expect(readies[0]).toMatchObject({ requestId: 200, drewFrame: true })

    // A's dropped chunks never became frames (reset discards them, like a
    // real decoder); B's two frames exist, alive in the cache.
    expect(h.frames).toHaveLength(2)
    expect(h.frames.every((f) => !f.closed)).toBe(true)
  })

  test('backward step onto a cached frame skips the decoder entirely', async () => {
    const h = makeHarness()
    await setup(h)
    const dec = h.decoder()

    // Decode a 5-frame GOP, land on frame 2.
    await h.core.handleMessage(seekMsg(50, FRAME_US * 2, gop()))
    expect(dec.decoded).toHaveLength(5)
    expect(h.drawSpy).toHaveBeenCalledTimes(1)

    // Step BACK to frame 1: it is in the cache — no new decodes allowed.
    await h.core.handleMessage(seekMsg(51, FRAME_US, gop()))

    expect(dec.decoded).toHaveLength(5) // unchanged: nothing re-decoded
    expect(h.drawSpy).toHaveBeenCalledTimes(2)
    const ready = h.posts.filter(
      (p) => p.type === 'frameReady' && p.requestId === 51,
    )
    expect(ready).toHaveLength(1)
    expect(ready[0]).toMatchObject({
      drewFrame: true,
      frameTimestampUs: FRAME_US,
    })
    // The cached frame survived the round-trip (take → draw → put back).
    expect(h.frames.every((f) => !f.closed)).toBe(true)
  })

  test('re-configuring clears the cache (frames of the old stream close)', async () => {
    const h = makeHarness()
    await setup(h)
    await h.core.handleMessage(seekMsg(60, FRAME_US, gop()))
    expect(h.frames.every((f) => !f.closed)).toBe(true)

    await h.core.handleMessage(configureMsg)

    expect(h.frames.every((f) => f.closed)).toBe(true)
  })

  test('close() tears down the decoder and later seeks error cleanly', async () => {
    const h = makeHarness()
    await setup(h)
    await h.core.handleMessage({ type: 'close' })
    expect(h.decoder().isClosed).toBe(true)

    await h.core.handleMessage(seekMsg(300, 0, gop()))
    expect(h.posts.at(-1)).toMatchObject({ type: 'error', requestId: 300 })
  })
})
