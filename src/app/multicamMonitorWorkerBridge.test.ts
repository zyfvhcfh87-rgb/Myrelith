import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMulticamMonitorWorkerBridge, type MulticamMonitorWorkerLike } from './multicamMonitorWorkerBridge'
import type { MulticamMonitorLedger, MulticamMonitorReply, MulticamMonitorRequest } from '../pipeline/multicamMonitorProtocol'

const zero: MulticamMonitorLedger = { inputs: 0, nativeDecoders: 0, nativeFrames: 0, createdDecoders: 1, closedDecoders: 1, frameBytes: 0, peakDecoders: 1, peakFrames: 2, peakFrameBytes: 7372800, scratchSurfaces: 0, scratchBytes: 0 }
function harness(onFrame = vi.fn()) {
  const messages: MulticamMonitorRequest[] = []
  const worker: MulticamMonitorWorkerLike = { postMessage: (message) => { messages.push(message) }, terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null }
  const onFailure = vi.fn()
  const bridge = createMulticamMonitorWorkerBridge({ sources: [{ id: 'angle', blob: new Blob(['video']), width: 1280, height: 720, representation: 'proxy', firstTimestampUs: 0, endTimestampUs: 1_000_000 }], width: 320, height: 180, onFrame, onFailure, createWorker: () => worker })
  void bridge.ready.catch(() => {})
  const reply = (data: MulticamMonitorReply) => worker.onmessage?.({ data } as MessageEvent<MulticamMonitorReply>)
  return { bridge, worker, messages, reply, onFrame, onFailure }
}
afterEach(() => vi.useRealTimers())
describe('multicam worker bridge', () => {
  test('holds one request per lane and closes borrowed and late bitmaps exactly once', async () => {
    const h = harness(); h.reply({ type: 'ready', ledger: zero }); await h.bridge.ready
    expect(h.bridge.request('angle', 1, 0)).toBe(true)
    expect(h.bridge.request('angle', 2, 0)).toBe(false)
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    h.reply({ type: 'frame', id: 'angle', requestId: 1, timestampUs: 0, bitmap, ledger: zero })
    expect(h.onFrame).toHaveBeenCalledOnce(); expect(bitmap.close).toHaveBeenCalledOnce()
    h.bridge.terminate('preempted')
    const late = { close: vi.fn() } as unknown as ImageBitmap
    h.reply({ type: 'frame', id: 'angle', requestId: 2, timestampUs: 0, bitmap: late, ledger: zero })
    expect(late.close).toHaveBeenCalledOnce(); expect(h.onFrame).toHaveBeenCalledOnce()
    expect(h.bridge.snapshot()).toMatchObject({ workers: 0, pending: 0, received: 2, closedBitmaps: 2 })
  })
  test('rejects a false native-zero acknowledgement and terminates before releasing a close waiter', async () => {
    const h = harness(); h.reply({ type: 'ready', ledger: zero }); await h.bridge.ready
    const close = h.bridge.close()
    h.reply({ type: 'closed', ledger: { ...zero, nativeDecoders: 1 } })
    expect(h.worker.terminate).toHaveBeenCalledOnce()
    expect(await close).toMatchObject({ forced: true, ledger: { nativeDecoders: 1 }, workers: 0 })
  })
  test('cooperatively closes and shares duplicate close calls', async () => {
    const h = harness(); h.reply({ type: 'ready', ledger: zero }); await h.bridge.ready
    const close = h.bridge.close(); expect(h.bridge.close()).toBe(close)
    h.reply({ type: 'closed', ledger: zero })
    expect(await close).toMatchObject({ forced: false, workers: 0, pending: 0, unclosedReceivedBitmaps: 0 })
  })
  test('bounds startup, request and close deadlines with actual worker termination', async () => {
    vi.useFakeTimers()
    const opening = harness(); await vi.advanceTimersByTimeAsync(5000)
    expect(opening.worker.terminate).toHaveBeenCalledOnce()
    const running = harness(); running.reply({ type: 'ready', ledger: zero }); await running.bridge.ready
    running.bridge.request('angle', 1, 0); await vi.advanceTimersByTimeAsync(750)
    expect(running.worker.terminate).toHaveBeenCalledOnce()
    const closing = harness(); closing.reply({ type: 'ready', ledger: zero }); await closing.bridge.ready
    const promise = closing.bridge.close(); await vi.advanceTimersByTimeAsync(100)
    expect(await promise).toMatchObject({ forced: true, reason: 'close-deadline' })
  })
  test('synchronous preemption inside a presentation callback closes that borrowed frame before returning', async () => {
    const h = harness(vi.fn(() => { expect(h.bridge.terminate('source-priority').unclosedReceivedBitmaps).toBe(0) }))
    h.reply({ type: 'ready', ledger: zero }); await h.bridge.ready; h.bridge.request('angle', 1, 0)
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    h.reply({ type: 'frame', id: 'angle', requestId: 1, timestampUs: 0, bitmap, ledger: zero })
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
