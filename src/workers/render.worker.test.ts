/**
 * workers/render.worker.test.ts — Phase 4.1b.
 *
 * Drives the render worker core with fake decoders/canvases and asserts
 * the properties multi-track preview depends on:
 *   1. one decoder per asset; per-asset batches are serialized, assets
 *      run independently; every VideoFrame closes on every path;
 *   2. double buffering: only the newest composite blits to the visible
 *      canvas — superseded composites answer 'superseded' and never blit;
 *   3. loans: a bitmap being composited cannot be evicted-and-closed by a
 *      later batch in the same composite (the PiP case), and returns to
 *      its cache afterwards;
 *   4. failures stay contained: bad batches, dead decoders and missing
 *      assets turn into missingClipIds, never crashes.
 *
 * Fakes model REAL WebCodecs semantics (queue growth, reset-unconfigures,
 * flush-emits, closed-bitmap draws throw) — see HANDOFF.md lessons.
 */

import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from '../domain/schema'
import type { Composite2D } from '../pipeline/render'
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
import type { RenderCanvasLike, RenderWorkerEnv } from './render.worker'
import { createRenderWorkerCore } from './render.worker'

/* ------------------------------------------------------------------ */
/* Timebase: 10 fps doc + assets → one frame = 100_000 µs exactly       */
/* ------------------------------------------------------------------ */

const FRAME_US = 100_000
const TOL_US = FRAME_US / 2

/* ------------------------------------------------------------------ */
/* Fakes                                                                */
/* ------------------------------------------------------------------ */

interface TrackedFrame extends DecodableFrame {
  closed: boolean
}

interface TrackedBitmap extends BitmapLike {
  sourceTimestamp: number
  closed: boolean
}

interface FakeOptions {
  supported?: boolean
  /** Drain one queue slot per microtask after each decode, like a live decoder. */
  autoDrain?: boolean
  /** decode() of the chunk at this timestamp fires the error callback. */
  errorOnUs?: number
}

/** Same real-semantics fake as decode.worker.test.ts, plus an error hook. */
class FakeDecoder implements VideoDecoderLike {
  decodeQueueSize = 0
  ondequeue: (() => void) | null = null
  decoded: ChunkPayload[] = []
  resetCount = 0
  configureCount = 0
  isClosed = false
  private isConfigured = false
  private pending: ChunkPayload[] = []

  private readonly output: (frame: DecodableFrame) => void
  private readonly errorCb: (e: { message: string }) => void
  private readonly opts: FakeOptions
  private readonly frames: TrackedFrame[]

  constructor(
    output: (frame: DecodableFrame) => void,
    errorCb: (e: { message: string }) => void,
    opts: FakeOptions,
    frames: TrackedFrame[],
  ) {
    this.output = output
    this.errorCb = errorCb
    this.opts = opts
    this.frames = frames
  }

  configure(): void {
    this.configureCount++
    this.isConfigured = true
  }

  decode(chunk: unknown): void {
    if (this.isClosed || !this.isConfigured) {
      throw new DOMException(
        "Cannot call 'decode' on an unconfigured codec.",
        'InvalidStateError',
      )
    }
    const payload = chunk as ChunkPayload
    if (this.opts.errorOnUs === payload.timestampUs) {
      this.isClosed = true // a faulted decoder is closed, like Chrome
      this.errorCb({ message: 'hardware decode fault' })
      return
    }
    this.decoded.push(payload)
    this.pending.push(payload)
    this.decodeQueueSize++
    if (this.opts.autoDrain) queueMicrotask(() => this.drain(1))
  }

  drain(count: number): void {
    this.decodeQueueSize = Math.max(0, this.decodeQueueSize - count)
    this.ondequeue?.()
  }

  async flush(): Promise<void> {
    this.decodeQueueSize = 0
    for (const payload of this.pending.splice(0)) {
      const frame: TrackedFrame = {
        timestamp: payload.timestampUs,
        displayWidth: 320,
        displayHeight: 180,
        closed: false,
        close() {
          frame.closed = true
        },
      }
      this.frames.push(frame)
      this.output(frame)
    }
  }

  reset(): void {
    this.resetCount++
    this.decodeQueueSize = 0
    this.pending = []
    this.isConfigured = false // per spec: reset() unconfigures the codec
  }

  close(): void {
    this.isClosed = true
  }
}

interface CtxOp {
  surface: 'visible' | 'scratch'
  name: string
  args: unknown[]
}

interface FakeSurface {
  canvas: RenderCanvasLike
  raw: { width: number; height: number }
}

/** A canvas whose 2D ctx logs ops; drawing a closed bitmap THROWS (real). */
function makeSurface(surface: CtxOp['surface'], log: CtxOp[]): FakeSurface {
  let alpha = 1
  let fill: Composite2D['fillStyle'] = ''
  const ctx: Composite2D = {
    get globalAlpha() {
      return alpha
    },
    set globalAlpha(v) {
      alpha = v
      log.push({ surface, name: 'alpha', args: [v] })
    },
    get fillStyle() {
      return fill
    },
    set fillStyle(v) {
      fill = v
      log.push({ surface, name: 'fillStyle', args: [v] })
    },
    save: () => log.push({ surface, name: 'save', args: [] }),
    restore: () => log.push({ surface, name: 'restore', args: [] }),
    translate: (x, y) => log.push({ surface, name: 'translate', args: [x, y] }),
    rotate: (a) => log.push({ surface, name: 'rotate', args: [a] }),
    scale: (x, y) => log.push({ surface, name: 'scale', args: [x, y] }),
    fillRect: (x, y, w, h) => log.push({ surface, name: 'fillRect', args: [x, y, w, h] }),
    drawImage: (image, dx, dy) => {
      if ((image as Partial<TrackedBitmap>).closed === true) {
        throw new DOMException('bitmap was closed', 'InvalidStateError')
      }
      log.push({ surface, name: 'drawImage', args: [image, dx, dy] })
    },
  }
  const raw = { width: 0, height: 0 }
  const canvas: RenderCanvasLike = {
    get width() {
      return raw.width
    },
    set width(v) {
      raw.width = v
    },
    get height() {
      return raw.height
    },
    set height(v) {
      raw.height = v
    },
    getContext: () => ctx,
  }
  return { canvas, raw }
}

interface Harness {
  core: ReturnType<typeof createRenderWorkerCore>
  posts: FromRenderWorker[]
  frames: TrackedFrame[]
  bitmaps: TrackedBitmap[]
  decoders: FakeDecoder[]
  ops: CtxOp[]
  visible: FakeSurface
  scratch: () => FakeSurface | null
  blits: () => CtxOp[]
  scratchDraws: () => CtxOp[]
}

function makeHarness(opts: FakeOptions = {}): Harness {
  const posts: FromRenderWorker[] = []
  const frames: TrackedFrame[] = []
  const bitmaps: TrackedBitmap[] = []
  const decoders: FakeDecoder[] = []
  const ops: CtxOp[] = []
  const visible = makeSurface('visible', ops)
  let scratch: FakeSurface | null = null

  const env: RenderWorkerEnv = {
    post: (msg) => posts.push(msg),
    createDecoder: (init) => {
      const decoder = new FakeDecoder(init.output, init.error, opts, frames)
      decoders.push(decoder)
      return decoder
    },
    isConfigSupported: async () => ({ supported: opts.supported ?? true }),
    createChunk: (payload) => payload,
    createBitmap: async (frame) => {
      const bitmap: TrackedBitmap = {
        width: frame.displayWidth,
        height: frame.displayHeight,
        sourceTimestamp: frame.timestamp,
        closed: false,
        close() {
          bitmap.closed = true
        },
      }
      bitmaps.push(bitmap)
      return bitmap
    },
    createCanvas: (width, height) => {
      scratch = makeSurface('scratch', ops)
      scratch.canvas.width = width
      scratch.canvas.height = height
      return scratch.canvas
    },
    now: () => 0,
  }

  return {
    core: createRenderWorkerCore(env),
    posts,
    frames,
    bitmaps,
    decoders,
    ops,
    visible,
    scratch: () => scratch,
    blits: () => ops.filter((op) => op.surface === 'visible' && op.name === 'drawImage'),
    scratchDraws: () =>
      ops.filter((op) => op.surface === 'scratch' && op.name === 'drawImage'),
  }
}

/* ------------------------------------------------------------------ */
/* Doc + message builders                                               */
/* ------------------------------------------------------------------ */

function makeClip(
  id: string,
  assetId: string,
  tlStart: number,
  duration: number,
  sourceStart = 0,
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceRange: { startFrame: sourceStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, clips: Clip[]): Track {
  return { id, kind: 'video', name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked: false }
}

function makeDoc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc',
    name: 'doc',
    frameRate: { num: 10, den: 1 },
    width: 320,
    height: 180,
    audioSampleRate: 48000,
    tracks,
  }
}

function chunkAt(frame: number, type: 'key' | 'delta'): ChunkPayload {
  return { type, timestampUs: frame * FRAME_US, durationUs: FRAME_US, data: new ArrayBuffer(4) }
}

/** An n-chunk GOP starting at `startFrame`: one keyframe, then deltas. */
function gop(startFrame: number, n: number): ChunkPayload[] {
  return Array.from({ length: n }, (_, i) =>
    chunkAt(startFrame + i, i === 0 ? 'key' : 'delta'),
  )
}

/** Entry the way the 4.1c bridge will build it (assets conformed, 10 fps). */
function entry(
  assetId: string,
  sourceFrame: number,
  chunks: ChunkPayload[] = [],
): CompositeSourceEntry {
  return {
    assetId,
    sourceFrame,
    targetTimestampUs: sourceFrame * FRAME_US,
    toleranceUs: TOL_US,
    chunks,
  }
}

const initMsg = (h: Harness): ToRenderWorker => ({
  type: 'init',
  canvas: h.visible.canvas as unknown as OffscreenCanvas,
})

const docMsg = (doc: TimelineDoc): ToRenderWorker => ({ type: 'setDoc', doc })

const cfgMsg = (assetId: string): ToRenderWorker => ({
  type: 'configureAsset',
  assetId,
  config: { codec: 'avc1.640028' },
})

function compMsg(
  requestId: number,
  frame: number,
  sources: CompositeSourceEntry[],
): ToRenderWorker {
  return { type: 'composite', requestId, frame, sources }
}

async function setup(h: Harness, doc: TimelineDoc, assetIds: string[]): Promise<void> {
  await h.core.handleMessage(initMsg(h))
  await h.core.handleMessage(docMsg(doc))
  for (const assetId of assetIds) await h.core.handleMessage(cfgMsg(assetId))
}

const microtasks = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function doneFor(h: Harness, requestId: number) {
  const replies = h.posts.filter(
    (p) => p.type === 'compositeDone' && p.requestId === requestId,
  )
  expect(replies).toHaveLength(1) // exactly one reply per composite
  return replies[0] as Extract<FromRenderWorker, { type: 'compositeDone' }>
}

/** Two stacked one-clip tracks on assets A (bottom) and B (top). */
const twoTrackDoc = () =>
  makeDoc([
    makeTrack('V1', [makeClip('a', 'A', 0, 10)]),
    makeTrack('V2', [makeClip('b', 'B', 0, 10)]),
  ])

/* ------------------------------------------------------------------ */
/* Happy path                                                           */
/* ------------------------------------------------------------------ */

describe('composite happy path', () => {
  test('two assets decode in their own decoders, draw bottom-to-top, blit once', async () => {
    const h = makeHarness()
    await setup(h, twoTrackDoc(), ['A', 'B'])
    expect(h.posts.filter((p) => p.type === 'assetConfigured')).toHaveLength(2)
    // Canvases adopted the doc size.
    expect(h.visible.raw).toEqual({ width: 320, height: 180 })
    expect(h.scratch()?.raw).toEqual({ width: 320, height: 180 })

    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )

    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: ['a', 'b'],
      missingClipIds: [],
    })

    // One decoder per asset, each fed its own batch.
    expect(h.decoders).toHaveLength(2)
    expect(h.decoders[0].decoded).toHaveLength(5)
    expect(h.decoders[1].decoded).toHaveLength(5)

    // Compositing happened on the SCRATCH surface, newest-frame blit on the
    // visible one — and strictly after the clips were drawn.
    const draws = h.scratchDraws()
    expect(draws).toHaveLength(2)
    expect((draws[0].args[0] as TrackedBitmap).sourceTimestamp).toBe(2 * FRAME_US)
    expect((draws[1].args[0] as TrackedBitmap).sourceTimestamp).toBe(2 * FRAME_US)
    const blits = h.blits()
    expect(blits).toHaveLength(1)
    expect(blits[0].args[0]).toBe(h.scratch()?.canvas) // scratch → visible
    expect(h.ops.indexOf(blits[0])).toBeGreaterThan(h.ops.indexOf(draws[1]))

    // Every VideoFrame closed; pixels live on as cached bitmaps.
    expect(h.frames).toHaveLength(10)
    expect(h.frames.every((f) => f.closed)).toBe(true)
    expect(h.bitmaps.filter((b) => !b.closed)).toHaveLength(10)

    // close() proves the caches (and returned loans) own every bitmap.
    await h.core.handleMessage({ type: 'close' })
    expect(h.bitmaps.every((b) => b.closed)).toBe(true)
  })

  test('a repeat composite is served from the caches: zero new decodes', async () => {
    const h = makeHarness()
    await setup(h, twoTrackDoc(), ['A', 'B'])
    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )

    // Same frame again — this time WITHOUT chunks (bridge cold-path spare).
    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2), entry('B', 2)]))

    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['a', 'b'] })
    expect(h.decoders[0].decoded).toHaveLength(5) // unchanged
    expect(h.decoders[1].decoded).toHaveLength(5)
    expect(h.blits()).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ */
/* Latest-wins + double buffering                                       */
/* ------------------------------------------------------------------ */

describe('supersession', () => {
  test('a newer composite supersedes a parked one; only the newest blits', async () => {
    const h = makeHarness() // no autoDrain: request 1 parks on backpressure
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])]), ['A'])

    const first = h.core.handleMessage(compMsg(1, 11, [entry('A', 11, gop(0, 12))]))
    await microtasks()
    expect(h.decoders[0].decoded).toHaveLength(8) // parked at the high-water mark

    const second = h.core.handleMessage(compMsg(2, 5, [entry('A', 5, gop(4, 3))]))
    await Promise.all([first, second])

    expect(doneFor(h, 1).status).toBe('superseded')
    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['a'] })

    // Request 1 never reached the visible canvas.
    expect(h.blits()).toHaveLength(1)
    // Fed: 8 of request 1's chunks, then (after a reset) request 2's 3.
    expect(h.decoders[0].decoded.map((c) => c.timestampUs)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => i * FRAME_US),
      4 * FRAME_US,
      5 * FRAME_US,
      6 * FRAME_US,
    ])
    await microtasks()
    expect(h.frames.every((f) => f.closed)).toBe(true)
  })

  test('setDoc supersedes an in-flight composite (it rendered a stale doc)', async () => {
    const h = makeHarness()
    const doc = makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 20)])])
    await setup(h, doc, ['A'])

    const inflight = h.core.handleMessage(compMsg(1, 11, [entry('A', 11, gop(0, 12))]))
    await microtasks()
    await h.core.handleMessage(docMsg(doc))
    await inflight

    expect(doneFor(h, 1).status).toBe('superseded')
    expect(h.blits()).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* Loans + per-asset serialization (the PiP case)                       */
/* ------------------------------------------------------------------ */

describe('same-asset entries in one composite', () => {
  test('batches run sequentially; the first bitmap survives the second batch flooding the cache', async () => {
    const h = makeHarness({ autoDrain: true })
    // Two clips of the SAME asset at different source offsets (PiP).
    const doc = makeDoc([
      makeTrack('V1', [makeClip('x', 'A', 0, 10, 0)]),
      makeTrack('V2', [makeClip('y', 'A', 0, 10, 20)]),
    ])
    await setup(h, doc, ['A'])

    // Frame 0 → x needs source frame 0, y needs source frame 20.
    // y's 13-chunk batch overflows the 12-slot cache — without the loan,
    // x's bitmap would be evicted+closed mid-composite and drawImage would
    // throw (the fake models that).
    await h.core.handleMessage(
      compMsg(1, 0, [entry('A', 0, gop(0, 2)), entry('A', 20, gop(8, 13))]),
    )

    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: ['x', 'y'],
      missingClipIds: [],
    })
    // One decoder; strictly sequential batches (x's fully before y's).
    expect(h.decoders).toHaveLength(1)
    expect(h.decoders[0].decoded.map((c) => c.timestampUs)).toEqual([
      0,
      FRAME_US,
      ...Array.from({ length: 13 }, (_, i) => (8 + i) * FRAME_US),
    ])
    const drawnTs = h.scratchDraws().map((op) => (op.args[0] as TrackedBitmap).sourceTimestamp)
    expect(drawnTs).toEqual([0, 20 * FRAME_US])

    // The loan went back into the cache: repeating frame 0 with NO chunks
    // still draws x from cache (no new decodes for source frame 0).
    const fedBefore = h.decoders[0].decoded.length
    await h.core.handleMessage(
      compMsg(2, 0, [entry('A', 0), entry('A', 20)]),
    )
    expect(doneFor(h, 2)).toMatchObject({ status: 'drawn', drawnClipIds: ['x', 'y'] })
    expect(h.decoders[0].decoded).toHaveLength(fedBefore)

    // Teardown still owns every bitmap exactly once.
    await h.core.handleMessage({ type: 'close' })
    expect(h.bitmaps.every((b) => b.closed)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* Failure containment                                                  */
/* ------------------------------------------------------------------ */

describe('failure containment', () => {
  test('one missing shared transition key reports both render layers', async () => {
    const from = makeClip('from', 'A', 0, 1)
    const to = makeClip('to', 'A', 1, 1)
    const track = {
      ...makeTrack('V1', [from, to]),
      transitions: [{
        id: 'dissolve',
        type: 'crossfade' as const,
        fromClipId: from.id,
        toClipId: to.id,
        durationFrames: 1,
      }],
    }
    const h = makeHarness()
    await setup(h, makeDoc([track]), [])

    await h.core.handleMessage(compMsg(1, 1, []))

    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['from', 'to'],
    })
    expect(h.decoders).toHaveLength(0)
  })

  test('an unconfigured asset turns into missingClipIds, not an error', async () => {
    const h = makeHarness()
    await setup(h, twoTrackDoc(), ['A']) // B never configured
    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )
    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: ['a'],
      missingClipIds: ['b'],
    })
  })

  test('cold cache + empty chunks → missing (no decode, no crash)', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(compMsg(1, 3, [entry('A', 3)]))
    expect(doneFor(h, 1)).toMatchObject({ drawnClipIds: [], missingClipIds: ['a'] })
    expect(h.decoders[0].decoded).toHaveLength(0)
  })

  test('a non-keyframe-first batch posts an error and the clip goes missing', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(
      compMsg(1, 3, [entry('A', 3, [chunkAt(2, 'delta'), chunkAt(3, 'delta')])]),
    )
    expect(h.posts).toContainEqual({
      type: 'error',
      requestId: 1,
      assetId: 'A',
      message: 'composite batch must start with a keyframe chunk',
    })
    expect(doneFor(h, 1).missingClipIds).toEqual(['a'])
    expect(h.decoders[0].decoded).toHaveLength(0)
  })

  test('a decoder fault marks the asset dead: error posted, later composites just miss', async () => {
    const h = makeHarness({ errorOnUs: 2 * FRAME_US })
    await setup(h, twoTrackDoc(), ['A', 'B'])

    await h.core.handleMessage(
      compMsg(1, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]),
    )
    // Both decoders hit the poisoned timestamp — but nothing crashed and
    // the composite still completed with both clips missing.
    expect(
      h.posts.filter((p) => p.type === 'error' && p.message === 'decoder: hardware decode fault'),
    ).toHaveLength(2)
    expect(doneFor(h, 1)).toMatchObject({
      status: 'drawn',
      drawnClipIds: [],
      missingClipIds: ['a', 'b'],
    })

    // Dead assets stay dead (fast-miss) until reconfigured.
    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2, gop(0, 5)), entry('B', 2, gop(0, 5))]))
    expect(doneFor(h, 2).missingClipIds).toEqual(['a', 'b'])

    await microtasks()
    expect(h.frames.every((f) => f.closed)).toBe(true)
  })

  test('composite before init/setDoc posts an error tied to the request', async () => {
    const h = makeHarness()
    await h.core.handleMessage(compMsg(9, 0, []))
    expect(h.posts).toContainEqual({
      type: 'error',
      requestId: 9,
      message: 'composite before init/setDoc',
    })
  })

  test('an unsupported codec posts an error and the asset never exists', async () => {
    const h = makeHarness({ supported: false })
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    expect(h.posts[0]).toMatchObject({ type: 'error', assetId: 'A' })
    expect(h.decoders).toHaveLength(0)

    await h.core.handleMessage(compMsg(1, 3, [entry('A', 3, gop(0, 5))]))
    expect(doneFor(h, 1).missingClipIds).toEqual(['a'])
  })
})

/* ------------------------------------------------------------------ */
/* Asset lifecycle                                                      */
/* ------------------------------------------------------------------ */

describe('asset lifecycle', () => {
  test('re-configuring an asset closes the old decoder and its cached bitmaps', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(compMsg(1, 2, [entry('A', 2, gop(0, 5))]))
    expect(h.bitmaps.filter((b) => !b.closed)).toHaveLength(5)

    await h.core.handleMessage(cfgMsg('A'))

    expect(h.decoders[0].isClosed).toBe(true)
    expect(h.bitmaps.every((b) => b.closed)).toBe(true) // old stream released
    expect(h.decoders).toHaveLength(2)

    // The fresh decoder serves the same frame again (cache was cleared).
    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2, gop(0, 5))]))
    expect(doneFor(h, 2).drawnClipIds).toEqual(['a'])
    expect(h.decoders[1].decoded).toHaveLength(5)
  })

  test('releaseAsset frees everything; later composites miss cleanly', async () => {
    const h = makeHarness()
    await setup(h, makeDoc([makeTrack('V1', [makeClip('a', 'A', 0, 10)])]), ['A'])
    await h.core.handleMessage(compMsg(1, 2, [entry('A', 2, gop(0, 5))]))

    await h.core.handleMessage({ type: 'releaseAsset', assetId: 'A' })

    expect(h.decoders[0].isClosed).toBe(true)
    expect(h.bitmaps.every((b) => b.closed)).toBe(true)

    await h.core.handleMessage(compMsg(2, 2, [entry('A', 2, gop(0, 5))]))
    expect(doneFor(h, 2).missingClipIds).toEqual(['a'])
  })
})
