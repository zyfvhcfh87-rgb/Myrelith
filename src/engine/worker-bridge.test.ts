/**
 * engine/worker-bridge.test.ts — Phase 2.4. A scripted fake worker plays
 * the other side of the protocol; a controllable fake chunk provider lets
 * tests freeze the async chunk fetch mid-flight.
 */

import { describe, expect, test, vi } from 'vitest'
import type { FrameRate } from '../domain/schema'
import type { ChunkPayload, FromDecodeWorker, ToDecodeWorker } from '../workers/decode-protocol'
import type { ChunkProvider, WorkerLike } from './worker-bridge'
import { DecodeWorkerBridge } from './worker-bridge'

const NTSC: FrameRate = { num: 30000, den: 1001 }

class FakeWorker implements WorkerLike {
  sent: Array<{ msg: ToDecodeWorker; transfer: Transferable[] }> = []
  terminate = vi.fn()
  private listener: ((event: MessageEvent) => void) | null = null

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.sent.push({ msg: message as ToDecodeWorker, transfer })
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') this.listener = listener as (event: MessageEvent) => void
  }

  /** Worker side of the wire replies. */
  emit(msg: FromDecodeWorker): void {
    this.listener?.({ data: msg } as MessageEvent)
  }

  lastSeek(): Extract<ToDecodeWorker, { type: 'seek' }> {
    const seeks = this.sent.filter((s) => s.msg.type === 'seek')
    if (seeks.length === 0) throw new Error('no seek posted')
    return seeks.at(-1)?.msg as Extract<ToDecodeWorker, { type: 'seek' }>
  }
}

function chunkBatch(): ChunkPayload[] {
  return [
    { type: 'key', timestampUs: 0, durationUs: 33367, data: new ArrayBuffer(8) },
    { type: 'delta', timestampUs: 33367, durationUs: 33367, data: new ArrayBuffer(8) },
  ]
}

/** Chunk provider whose promises the test resolves by hand when needed. */
function makeProvider(auto = true) {
  const calls: Array<{
    targetSec: number
    toleranceSec: number
    resolve: (chunks: ChunkPayload[]) => void
  }> = []
  const provider: ChunkProvider = {
    chunksForTimestamp: (targetSec, toleranceSec) =>
      new Promise((resolve) => {
        calls.push({ targetSec, toleranceSec, resolve })
        if (auto) resolve(chunkBatch())
      }),
  }
  return { provider, calls }
}

function makeBridge(auto = true) {
  const worker = new FakeWorker()
  const { provider, calls } = makeProvider(auto)
  const bridge = new DecodeWorkerBridge(worker)
  bridge.setSource(NTSC, provider)
  return { bridge, worker, calls }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('message construction', () => {
  test('init transfers the canvas', () => {
    const { bridge, worker } = makeBridge()
    const canvas = {} as OffscreenCanvas
    bridge.init(canvas)
    expect(worker.sent[0].msg).toEqual({ type: 'init', canvas })
    expect(worker.sent[0].transfer).toEqual([canvas])
  })

  test('renderFrameAt converts frames to µs with the NTSC rate', async () => {
    const { bridge, worker } = makeBridge()
    const resultPromise = bridge.renderFrameAt(100)
    await flush()

    const seek = worker.lastSeek()
    // 100 frames at 30000/1001 fps = 3.336666...s
    expect(seek.targetTimestampUs).toBe(3336667)
    expect(seek.toleranceUs).toBe(16683) // half a frame
    expect(seek.requestId).toBe(1)
    // Chunk buffers ride the transfer list.
    expect(worker.sent.at(-1)?.transfer).toEqual(seek.chunks.map((c) => c.data))

    worker.emit({
      type: 'frameReady',
      requestId: 1,
      drewFrame: true,
      frameTimestampUs: 3336667,
      decodeMs: 5,
    })
    expect(await resultPromise).toEqual({
      status: 'drawn',
      frameTimestampUs: 3336667,
      decodeMs: 5,
    })
  })

  test('provider receives seconds + half-frame tolerance', async () => {
    const { bridge, calls } = makeBridge()
    void bridge.renderFrameAt(30)
    await flush()
    expect(calls[0].targetSec).toBeCloseTo(1.001, 9)
    expect(calls[0].toleranceSec).toBeCloseTo(1001 / 30000 / 2, 9)
  })
})

describe('configure', () => {
  test('resolves on configured ack', async () => {
    const { bridge, worker } = makeBridge()
    const done = bridge.configure({ codec: 'avc1.640028' })
    worker.emit({ type: 'configured' })
    await expect(done).resolves.toBeUndefined()
  })

  test('rejects on a config-level error', async () => {
    const { bridge, worker } = makeBridge()
    const done = bridge.configure({ codec: 'weird' })
    worker.emit({ type: 'error', message: 'codec not supported' })
    await expect(done).rejects.toThrow('codec not supported')
  })
})

describe('render result mapping', () => {
  test('drewFrame=false maps to missed', async () => {
    const { bridge, worker } = makeBridge()
    const p = bridge.renderFrameAt(5)
    await flush()
    worker.emit({
      type: 'frameReady',
      requestId: 1,
      drewFrame: false,
      frameTimestampUs: -1,
      decodeMs: 2,
    })
    expect((await p).status).toBe('missed')
  })

  test('error with requestId settles that request as error', async () => {
    const { bridge, worker } = makeBridge()
    const p = bridge.renderFrameAt(5)
    await flush()
    worker.emit({ type: 'error', requestId: 1, message: 'draw failed: boom' })
    expect(await p).toMatchObject({ status: 'error', message: 'draw failed: boom' })
  })

  test('request-less errors reach onWorkerError', () => {
    const { bridge, worker } = makeBridge()
    const spy = vi.fn()
    bridge.onWorkerError = spy
    worker.emit({ type: 'error', message: 'decoder: mid-stream fault' })
    expect(spy).toHaveBeenCalledWith('decoder: mid-stream fault')
  })

  test('provider failure returns an error result without posting', async () => {
    const worker = new FakeWorker()
    const provider: ChunkProvider = {
      chunksForTimestamp: () => Promise.reject(new Error('no keyframe')),
    }
    const bridge = new DecodeWorkerBridge(worker)
    bridge.setSource(NTSC, provider)
    const result = await bridge.renderFrameAt(3)
    expect(result).toMatchObject({ status: 'error', message: 'no keyframe' })
    expect(worker.sent).toHaveLength(0)
  })

  test('renderFrameAt before setSource fails soft with an error result', async () => {
    const bridge = new DecodeWorkerBridge(new FakeWorker())
    const result = await bridge.renderFrameAt(3)
    expect(result.status).toBe('error')
    expect(result.message).toMatch(/no source/)
  })

  test('swapping the source mid-fetch supersedes the stale request', async () => {
    const { bridge, worker, calls } = makeBridge(false) // manual provider
    const stale = bridge.renderFrameAt(10)
    await flush()

    // Asset switch happens while the old fetch is still pending.
    const { provider: newProvider } = makeProvider(true)
    bridge.setSource(NTSC, newProvider)
    calls[0].resolve(chunkBatch()) // stale fetch finally resolves
    await flush()

    expect((await stale).status).toBe('superseded')
    expect(worker.sent.filter((s) => s.msg.type === 'seek')).toHaveLength(0)
  })

  test('late frameReady for an unknown request is ignored', () => {
    const { worker } = makeBridge()
    expect(() =>
      worker.emit({
        type: 'frameReady',
        requestId: 999,
        drewFrame: true,
        frameTimestampUs: 0,
        decodeMs: 1,
      }),
    ).not.toThrow()
  })
})

describe('latest-wins supersession', () => {
  test('a newer call settles the older in-flight one as superseded', async () => {
    const { bridge, worker } = makeBridge()
    const first = bridge.renderFrameAt(10)
    await flush()
    const second = bridge.renderFrameAt(20)
    await flush()

    expect((await first).status).toBe('superseded')

    worker.emit({
      type: 'frameReady',
      requestId: 2,
      drewFrame: true,
      frameTimestampUs: 667334,
      decodeMs: 4,
    })
    expect((await second).status).toBe('drawn')
  })

  test('a call overtaken DURING chunk fetch never posts its seek', async () => {
    const { bridge, worker, calls } = makeBridge(false) // manual resolution
    const first = bridge.renderFrameAt(10)
    await flush()
    const second = bridge.renderFrameAt(20)
    await flush()
    expect(calls).toHaveLength(2)

    // Resolve the SECOND fetch first, then the stale first one.
    calls[1].resolve(chunkBatch())
    await flush()
    calls[0].resolve(chunkBatch())
    await flush()

    expect((await first).status).toBe('superseded')
    // Exactly ONE seek went to the worker — the newest.
    const seeks = worker.sent.filter((s) => s.msg.type === 'seek')
    expect(seeks).toHaveLength(1)
    expect(worker.lastSeek().requestId).toBe(2)

    worker.emit({
      type: 'frameReady',
      requestId: 2,
      drewFrame: true,
      frameTimestampUs: 667334,
      decodeMs: 4,
    })
    expect((await second).status).toBe('drawn')
  })
})

describe('dispose', () => {
  test('posts close and terminates the worker', () => {
    const { bridge, worker } = makeBridge()
    bridge.dispose()
    expect(worker.sent.at(-1)?.msg).toEqual({ type: 'close' })
    expect(worker.terminate).toHaveBeenCalled()
  })
})
