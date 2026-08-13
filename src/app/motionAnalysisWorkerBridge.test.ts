import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaJobContext } from './mediaJobScheduler'
import {
  getMotionAnalysisWorkerDiagnostics,
  probeMotionAnalysisWorker,
  resetMotionAnalysisWorkerDiagnostics,
  runMotionAnalysisWorker,
  type MotionAnalysisWorkerLike,
} from './motionAnalysisWorkerBridge'
import type {
  MotionAnalysisWorkerMessage,
  MotionAnalysisWorkerReply,
  MotionAnalysisWorkerRunMessage,
  MotionAnalysisWorkerWindowReply,
} from '../pipeline/motionAnalysisProtocol'

class FakeWorker implements MotionAnalysisWorkerLike {
  readonly listeners = new Map<string, Set<(event: never) => void>>()
  readonly messages: MotionAnalysisWorkerMessage[] = []
  terminated = false
  postError: unknown = null

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: MotionAnalysisWorkerMessage): void {
    if (this.postError) throw this.postError
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  dispatch(reply: MotionAnalysisWorkerReply): void {
    const event = new MessageEvent('message', { data: reply })
    for (const listener of this.listeners.get('message') ?? []) listener(event as never)
  }

  dispatchMessageError(): void {
    const event = new MessageEvent('messageerror')
    for (const listener of this.listeners.get('messageerror') ?? []) listener(event as never)
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
  }
}

function request(): MotionAnalysisWorkerRunMessage {
  return {
    type: 'run',
    requestId: 1,
    blob: new Blob(['video']),
    sourceId: 'asset-1',
    videoStreamIndex: 0,
    budget: {
      fileBytes: 5,
      durationMicroseconds: 1_000_000,
      width: 1920,
      height: 1080,
      framesPerSecond: 30,
    },
    startTimestampUs: 0,
    endTimestampUs: 1_000_000,
    samplingIntervalFrames: 1,
  }
}

function context(controller = new AbortController()) {
  let activeDecoderCount = 0
  const mediaContext: MediaJobContext = {
    signal: controller.signal,
    reportProgress: vi.fn(),
    setActiveDecoderCount: vi.fn((count: number) => {
      activeDecoderCount = count
    }),
  }
  return { controller, mediaContext, activeDecoderCount: () => activeDecoderCount }
}

function frame(value = 7) {
  return {
    timestampUs: 0,
    width: 2,
    height: 2,
    pixels: new Uint8Array(new ArrayBuffer(4)).fill(value),
  }
}

describe('runMotionAnalysisWorker', () => {
  beforeEach(() => resetMotionAnalysisWorkerDiagnostics())

  it('probes the exact production worker and always terminates it', async () => {
    const worker = new FakeWorker()
    const pending = probeMotionAnalysisWorker(undefined, () => worker)
    expect(worker.messages).toEqual([{ type: 'probe', requestId: 0 }])
    worker.dispatch({ type: 'ready', requestId: 0 })
    await expect(pending).resolves.toBe(true)
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount()).toBe(0)
  })

  it('keeps one bounded window in flight until its consumer acknowledges it', async () => {
    const worker = new FakeWorker()
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const consume = vi.fn(async () => gate)
    const h = context()
    const pending = runMotionAnalysisWorker(request(), consume, h.mediaContext, () => worker)
    expect(worker.messages).toHaveLength(1)
    expect(h.activeDecoderCount()).toBe(1)

    worker.dispatch({
      type: 'window',
      requestId: 1,
      windowIndex: 0,
      sampleOffset: 0,
      frames: [frame()],
      retainedBytes: 4,
    })
    expect(consume).toHaveBeenCalledOnce()
    expect(worker.messages).toHaveLength(1)
    releaseGate()
    await vi.waitFor(() => expect(worker.messages).toHaveLength(2))
    expect(worker.messages[1]).toEqual({ type: 'continue', requestId: 1, windowIndex: 0 })

    worker.dispatch({
      type: 'complete',
      requestId: 1,
      decodedFrameCount: 1,
      sampledFrameCount: 1,
      windowCount: 1,
      maxRetainedFrames: 1,
      maxRetainedBytes: 4,
    })
    await expect(pending).resolves.toMatchObject({ sampledFrameCount: 1 })
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount()).toBe(0)
    expect(h.activeDecoderCount()).toBe(0)
    expect(getMotionAnalysisWorkerDiagnostics()).toEqual({
      workersCreated: 1,
      workersTerminated: 1,
      activeWorkers: 0,
      maxActiveWorkers: 1,
    })
  })

  it('detaches transferred grayscale planes after the consumer releases a window', async () => {
    const worker = new FakeWorker()
    let retained: Uint8Array<ArrayBuffer> | null = null
    const consume = vi.fn(async (window: MotionAnalysisWorkerWindowReply) => {
      retained = window.frames[0]!.pixels
    })
    const pending = runMotionAnalysisWorker(request(), consume, context().mediaContext, () => worker)
    worker.dispatch({
      type: 'window',
      requestId: 1,
      windowIndex: 0,
      sampleOffset: 0,
      frames: [frame()],
      retainedBytes: 4,
    })
    await vi.waitFor(() => expect(worker.messages).toHaveLength(2))
    expect(retained!.byteLength).toBe(0)

    worker.dispatch({
      type: 'complete',
      requestId: 1,
      decodedFrameCount: 1,
      sampledFrameCount: 1,
      windowCount: 1,
      maxRetainedFrames: 1,
      maxRetainedBytes: 4,
    })
    await expect(pending).resolves.toMatchObject({ sampledFrameCount: 1 })
  })

  it('holds cancellation settlement until an in-flight window is released', async () => {
    const worker = new FakeWorker()
    const h = context()
    let releaseConsumer!: () => void
    const consumerGate = new Promise<void>((resolve) => {
      releaseConsumer = resolve
    })
    let retained: Uint8Array<ArrayBuffer> | null = null
    let settled = false
    const pending = runMotionAnalysisWorker(
      request(),
      async (window) => {
        retained = window.frames[0]!.pixels
        await consumerGate
      },
      h.mediaContext,
      () => worker,
    )
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )
    worker.dispatch({
      type: 'window',
      requestId: 1,
      windowIndex: 0,
      sampleOffset: 0,
      frames: [frame()],
      retainedBytes: 4,
    })
    await vi.waitFor(() => expect(retained).not.toBeNull())

    h.controller.abort()
    await Promise.resolve()
    expect(worker.terminated).toBe(true)
    expect(h.activeDecoderCount()).toBe(0)
    expect(settled).toBe(false)
    expect(retained!.byteLength).toBe(4)

    releaseConsumer()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(settled).toBe(true)
    expect(retained!.byteLength).toBe(0)
    expect(worker.listenerCount()).toBe(0)
    expect(getMotionAnalysisWorkerDiagnostics().activeWorkers).toBe(0)
  })

  it('terminates and releases decoder ownership before cancellation settles', async () => {
    const worker = new FakeWorker()
    const h = context()
    const pending = runMotionAnalysisWorker(request(), vi.fn(async () => undefined), h.mediaContext, () => worker)
    h.controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount()).toBe(0)
    expect(h.activeDecoderCount()).toBe(0)
    expect(getMotionAnalysisWorkerDiagnostics().activeWorkers).toBe(0)
  })

  it('rejects invalid windows and message deserialization failures through common cleanup', async () => {
    const invalidWorker = new FakeWorker()
    const invalidPixels = new Uint8Array(new ArrayBuffer(5))
    const invalid = runMotionAnalysisWorker(
      request(),
      vi.fn(async () => undefined),
      context().mediaContext,
      () => invalidWorker,
    )
    invalidWorker.dispatch({
      type: 'window',
      requestId: 1,
      windowIndex: 0,
      sampleOffset: 0,
      frames: [{ ...frame(), pixels: invalidPixels }],
      retainedBytes: 5,
    })
    await expect(invalid).rejects.toMatchObject({ code: 'resource-limit' })
    expect(invalidPixels.byteLength).toBe(0)
    expect(invalidWorker.terminated).toBe(true)

    const messageErrorWorker = new FakeWorker()
    const messageError = runMotionAnalysisWorker(
      request(),
      vi.fn(async () => undefined),
      context().mediaContext,
      () => messageErrorWorker,
    )
    messageErrorWorker.dispatchMessageError()
    await expect(messageError).rejects.toMatchObject({ code: 'unexpected' })
    expect(messageErrorWorker.terminated).toBe(true)
    expect(getMotionAnalysisWorkerDiagnostics()).toMatchObject({
      workersCreated: 2,
      workersTerminated: 2,
      activeWorkers: 0,
    })
  })

  it('rejects inconsistent progress, overlap, and completion facts', async () => {
    const progressWorker = new FakeWorker()
    const invalidProgress = runMotionAnalysisWorker(
      request(),
      vi.fn(async () => undefined),
      context().mediaContext,
      () => progressWorker,
    )
    progressWorker.dispatch({
      type: 'progress',
      requestId: 1,
      decodedFrameCount: 1,
      sampledFrameCount: 2,
      progress: 0.5,
    })
    await expect(invalidProgress).rejects.toMatchObject({ code: 'resource-limit' })

    const overlapWorker = new FakeWorker()
    const invalidOverlap = runMotionAnalysisWorker(
      request(),
      vi.fn(async () => undefined),
      context().mediaContext,
      () => overlapWorker,
    )
    overlapWorker.dispatch({
      type: 'window',
      requestId: 1,
      windowIndex: 0,
      sampleOffset: 0,
      frames: [frame()],
      retainedBytes: 4,
    })
    await vi.waitFor(() => expect(overlapWorker.messages).toHaveLength(2))
    overlapWorker.dispatch({
      type: 'window',
      requestId: 1,
      windowIndex: 1,
      sampleOffset: 0,
      frames: [frame()],
      retainedBytes: 4,
    })
    await expect(invalidOverlap).rejects.toMatchObject({ code: 'unexpected' })

    const completionWorker = new FakeWorker()
    const invalidCompletion = runMotionAnalysisWorker(
      request(),
      vi.fn(async () => undefined),
      context().mediaContext,
      () => completionWorker,
    )
    completionWorker.dispatch({
      type: 'window',
      requestId: 1,
      windowIndex: 0,
      sampleOffset: 0,
      frames: [frame()],
      retainedBytes: 4,
    })
    await vi.waitFor(() => expect(completionWorker.messages).toHaveLength(2))
    completionWorker.dispatch({
      type: 'complete',
      requestId: 1,
      decodedFrameCount: 2,
      sampledFrameCount: 2,
      windowCount: 1,
      maxRetainedFrames: 1,
      maxRetainedBytes: 4,
    })
    await expect(invalidCompletion).rejects.toMatchObject({ code: 'resource-limit' })
    expect(completionWorker.terminated).toBe(true)
  })

  it('preserves a source-open resource-unavailable worker failure', async () => {
    const worker = new FakeWorker()
    const pending = runMotionAnalysisWorker(
      request(),
      vi.fn(async () => undefined),
      context().mediaContext,
      () => worker,
    )
    worker.dispatch({
      type: 'failure',
      requestId: 1,
      code: 'resource-unavailable',
      detail: 'decoder service is unavailable',
    })
    await expect(pending).rejects.toMatchObject({
      code: 'resource-unavailable',
      message: 'decoder service is unavailable',
    })
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount()).toBe(0)
  })

  it('cleans up a synchronous initial postMessage failure', async () => {
    const worker = new FakeWorker()
    worker.postError = new DOMException('cannot clone', 'DataCloneError')
    const h = context()
    await expect(runMotionAnalysisWorker(
      request(),
      vi.fn(async () => undefined),
      h.mediaContext,
      () => worker,
    )).rejects.toMatchObject({ name: 'DataCloneError' })
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount()).toBe(0)
    expect(h.activeDecoderCount()).toBe(0)
  })
})
