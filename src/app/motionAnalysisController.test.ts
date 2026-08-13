import { describe, expect, it, vi } from 'vitest'
import type { AnalysisCacheEntry } from '../domain/analysisCache'
import type { MediaAsset } from '../domain/schema'
import type {
  MotionAnalysisWorkerFailureCode,
  MotionAnalysisWorkerMessage,
  MotionAnalysisWorkerReply,
} from '../pipeline/motionAnalysisProtocol'
import { AnalysisStorage } from './analysisStorage'
import { MediaJobScheduler } from './mediaJobScheduler'
import {
  MotionAnalysisController,
  type MotionAnalysisControllerDeps,
  type MotionAnalysisRunRequest,
} from './motionAnalysisController'
import type { MotionAnalysisWorkerLike } from './motionAnalysisWorkerBridge'

class FakeWorker implements MotionAnalysisWorkerLike {
  readonly listeners = new Map<string, Set<(event: never) => void>>()
  readonly messages: MotionAnalysisWorkerMessage[] = []
  terminated = false
  holdCompletion = false
  emptyCompletion = false
  failureCode: MotionAnalysisWorkerFailureCode | null = null

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: MotionAnalysisWorkerMessage): void {
    this.messages.push(message)
    if (message.type === 'run') {
      if (this.failureCode) queueMicrotask(() => this.dispatch({
        type: 'failure',
        requestId: message.requestId,
        code: this.failureCode!,
        detail: `${this.failureCode} detail`,
      }))
      else if (this.emptyCompletion) queueMicrotask(() => this.dispatch({
        type: 'complete',
        requestId: message.requestId,
        decodedFrameCount: 0,
        sampledFrameCount: 0,
        windowCount: 0,
        maxRetainedFrames: 0,
        maxRetainedBytes: 0,
      }))
      else queueMicrotask(() => this.dispatch({
        type: 'window',
        requestId: message.requestId,
        windowIndex: 0,
        sampleOffset: 0,
        frames: [{
          timestampUs: 0,
          width: 2,
          height: 2,
          pixels: new Uint8Array(new ArrayBuffer(4)).fill(3),
        }],
        retainedBytes: 4,
      }))
    } else if (!this.holdCompletion) {
      queueMicrotask(() => this.complete(message.requestId))
    }
  }

  complete(requestId = 1): void {
    this.dispatch({
      type: 'complete',
      requestId,
      decodedFrameCount: 1,
      sampledFrameCount: 1,
      windowCount: 1,
      maxRetainedFrames: 1,
      maxRetainedBytes: 4,
    })
  }

  terminate(): void {
    this.terminated = true
  }

  dispatch(reply: MotionAnalysisWorkerReply): void {
    const event = new MessageEvent('message', { data: reply })
    for (const listener of this.listeners.get('message') ?? []) listener(event as never)
  }
}

function asset(id = 'asset-1'): MediaAsset {
  return {
    id,
    fileName: `${id}.mp4`,
    mimeType: 'video/mp4',
    size: 5,
    lastModified: 10,
    objectUrl: `blob:${id}`,
    kind: 'video',
    durationFrames: 30,
    durationMicroseconds: 1_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1_000_000 },
      audio: null,
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: false,
    audioSampleRate: null,
    audioChannels: null,
    decoderConfigB64: null,
  }
}

function request(
  currentFailure: MotionAnalysisRunRequest['currentFailure'] = () => null,
  assetValue = asset(),
  clipId = 'clip-1',
): MotionAnalysisRunRequest {
  return {
    projectBindingId: 'local-project:test',
    asset: assetValue,
    source: {
      videoStreamIndex: 0,
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sourceStartMicroseconds: 0,
      sourceEndMicroseconds: 1_000_000,
      samplingIntervalFrames: 1,
    },
    attachment: {
      clipId,
      sourceMappingDigest: 'c'.repeat(64),
      projectionDigest: 'd'.repeat(64),
    },
    algorithm: {
      kind: 'stabilization',
      algorithmId: 'test',
      algorithmVersion: 'v1',
      parametersDigest: 'e'.repeat(64),
    },
    processor: {
      consumeWindow: vi.fn(async () => undefined),
      finish: vi.fn(async () => new TextEncoder().encode('{"ok":true}')),
    },
    currentFailure,
  }
}

function storageFixture(cached: AnalysisCacheEntry | null = null) {
  const staged = {
    fileName: `${'a'.repeat(64)}.${'f'.repeat(32)}.bin`,
    discard: vi.fn(async () => undefined),
  }
  const transaction = {
    finalize: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  }
  const stageResult = vi.fn(async () => staged)
  const commitEntry = vi.fn(async () => transaction)
  const readResult = vi.fn(async () => new TextEncoder().encode('{"cached":true}'))
  const storage = {
    findFreshEntry: vi.fn(async () => cached),
    readResult,
    touch: vi.fn(async () => undefined),
    stageResult,
    commitEntry,
    removeAttachment: vi.fn(async () => undefined),
    removeAsset: vi.fn(async () => undefined),
  } as unknown as AnalysisStorage
  return { commitEntry, readResult, staged, stageResult, storage, transaction }
}

function deps(
  storage: AnalysisStorage,
  workerFactory: () => FakeWorker,
): MotionAnalysisControllerDeps {
  return {
    storage,
    scheduler: new MediaJobScheduler({
      budget: { maxConcurrentJobs: 1, maxDecoderSlots: 1 },
      yieldControl: async () => undefined,
    }),
    fetchBlob: vi.fn(async () => new Blob(['video'])),
    fingerprint: vi.fn(async (_blob, identity) => ({
      algorithm: 'sha256-sampled-v1' as const,
      digest: 'b'.repeat(64),
      fileName: identity.fileName,
      size: identity.size,
      lastModified: identity.lastModified,
    })),
    workerFactory,
    now: () => 1_000,
  }
}

function cachedEntry(): AnalysisCacheEntry {
  return {
    cacheKey: 'a'.repeat(64),
    projectBindingId: 'local-project:test',
    assetId: 'asset-1',
    source: {
      fingerprint: {
        algorithm: 'sha256-sampled-v1',
        digest: 'b'.repeat(64),
        fileName: 'asset-1.mp4',
        size: 5,
        lastModified: 10,
      },
      videoStreamIndex: 0,
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sourceStartMicroseconds: 0,
      sourceEndMicroseconds: 1_000_000,
      samplingIntervalFrames: 1,
    },
    attachment: {
      clipId: 'clip-1',
      sourceMappingDigest: 'c'.repeat(64),
      projectionDigest: 'd'.repeat(64),
    },
    algorithm: {
      kind: 'stabilization',
      algorithmId: 'test',
      algorithmVersion: 'v1',
      parametersDigest: 'e'.repeat(64),
    },
    resultFileName: `${'a'.repeat(64)}.${'f'.repeat(32)}.bin`,
    resultBytes: 15,
    sampleCount: 1,
    createdAt: 1_000,
    lastUsedAt: 1_000,
  }
}

describe('MotionAnalysisController', () => {
  it('streams a worker result through result-first/manifest-last commit', async () => {
    const storage = storageFixture()
    const workers: FakeWorker[] = []
    const controller = new MotionAnalysisController(deps(storage.storage, () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }))
    const snapshots: ReturnType<MotionAnalysisController['snapshot']>[] = []
    controller.subscribe((snapshot) => snapshots.push(snapshot))
    const analysis = { ...request(), sampleTimestampsUs: [0] }

    const result = await controller.analyze(analysis)

    expect(result.fromCache).toBe(false)
    expect(result.completion).toMatchObject({ sampledFrameCount: 1 })
    expect(analysis.processor.consumeWindow).toHaveBeenCalledOnce()
    expect(storage.stageResult).toHaveBeenCalledBefore(storage.commitEntry)
    expect(storage.transaction.finalize).toHaveBeenCalledOnce()
    expect(storage.transaction.rollback).not.toHaveBeenCalled()
    expect(workers).toHaveLength(1)
    expect(workers[0]?.messages[0]).toMatchObject({
      videoStreamIndex: 0,
      sampleTimestampsUs: [0],
    })
    expect(workers[0]?.terminated).toBe(true)
    expect(snapshots.at(-1)?.jobs[0]).toMatchObject({ phase: 'ready', progress: 1 })
    expect(snapshots.at(-1)?.scheduler.maxActiveJobCount).toBe(1)
    expect(snapshots.at(-1)?.scheduler.maxActiveDecoderCount).toBe(1)
  })

  it('returns an exact fresh cache entry without creating a worker', async () => {
    const cached = cachedEntry()
    const storage = storageFixture(cached)
    const workerFactory = vi.fn(() => new FakeWorker())
    const controller = new MotionAnalysisController(deps(storage.storage, workerFactory))

    const result = await controller.analyze(request())

    expect(result).toMatchObject({ entry: cached, fromCache: true, completion: null })
    expect(workerFactory).not.toHaveBeenCalled()
    expect(storage.storage.readResult).toHaveBeenCalledWith(cached)
    expect(storage.storage.touch).toHaveBeenCalledWith(cached.cacheKey)
    expect(storage.storage.stageResult).not.toHaveBeenCalled()
  })

  it('rejects zero-sample completion before result finalization or cache staging', async () => {
    const storage = storageFixture()
    const worker = new FakeWorker()
    worker.emptyCompletion = true
    const controller = new MotionAnalysisController(deps(storage.storage, () => worker))
    const analysis = request()

    await expect(controller.analyze(analysis)).rejects.toMatchObject({
      code: 'decode-readback',
      message: 'Motion analysis decoded no samples for the requested source range',
    })

    expect(analysis.processor.consumeWindow).not.toHaveBeenCalled()
    expect(analysis.processor.finish).not.toHaveBeenCalled()
    expect(storage.stageResult).not.toHaveBeenCalled()
    expect(storage.commitEntry).not.toHaveBeenCalled()
    expect(worker.terminated).toBe(true)
    expect(controller.snapshot().jobs[0]).toMatchObject({
      phase: 'error',
      failure: {
        code: 'decode-readback',
        detail: 'Motion analysis decoded no samples for the requested source range',
      },
    })
  })

  it.each([
    ['unsupported-codec', 'unsupported-codec', 'unsupported-codec'],
    ['resource-limit', 'resource-limit', 'resource-limit'],
    ['resource-unavailable', 'unsupported-runtime', 'resource-unavailable'],
    ['decode-readback', 'decode-readback', 'decode-failed'],
    ['unexpected', 'unexpected', 'unexpected'],
  ] as const)(
    'keeps %s typed in public status and scheduler failure history',
    async (workerCode, publicCode, schedulerCode) => {
      const storage = storageFixture()
      const worker = new FakeWorker()
      worker.failureCode = workerCode
      const controller = new MotionAnalysisController(deps(storage.storage, () => worker))

      await expect(controller.analyze(request())).rejects.toMatchObject({ code: publicCode })
      await vi.waitFor(() => expect(controller.snapshot().scheduler.activeJobCount).toBe(0))

      expect(controller.snapshot()).toMatchObject({
        jobs: [{
          phase: 'error',
          failure: { code: publicCode, detail: `${workerCode} detail` },
        }],
        scheduler: {
          failedCount: 1,
          lastFailures: [{
            code: schedulerCode,
            detail: `${workerCode} detail`,
          }],
        },
      })
      expect(worker.terminated).toBe(true)
    },
  )

  it('rejects non-primary stream provenance before worker or cache access', () => {
    const storage = storageFixture()
    const workerFactory = vi.fn(() => new FakeWorker())
    const controller = new MotionAnalysisController(deps(storage.storage, workerFactory))
    const base = request()
    const analysis: MotionAnalysisRunRequest = {
      ...base,
      source: { ...base.source, videoStreamIndex: 1 },
    }

    expect(() => controller.analyze(analysis)).toThrowError(expect.objectContaining({
      code: 'unsupported-runtime',
      message: 'Motion analysis currently supports only primary video stream index 0',
    }))
    expect(workerFactory).not.toHaveBeenCalled()
    expect(storage.storage.findFreshEntry).not.toHaveBeenCalled()
  })

  it('detaches cache and processor result buffers that arrive after cancellation', async () => {
    const cached = cachedEntry()
    const cachedStorage = storageFixture(cached)
    let resolveCached!: (value: Uint8Array<ArrayBuffer>) => void
    cachedStorage.readResult.mockImplementation(() => new Promise((resolve) => {
      resolveCached = resolve
    }))
    const cachedController = new MotionAnalysisController(deps(
      cachedStorage.storage,
      () => new FakeWorker(),
    ))
    const cachedPending = cachedController.analyze(request())
    const cachedRejected = expect(cachedPending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(cachedStorage.readResult).toHaveBeenCalledOnce())
    cachedController.cancelClip('clip-1')
    await cachedRejected
    const lateCachedBytes = new Uint8Array(new ArrayBuffer(32))
    resolveCached(lateCachedBytes)
    await vi.waitFor(() => expect(lateCachedBytes.byteLength).toBe(0))

    const resultStorage = storageFixture()
    const analysis = request()
    let resolveResult!: (value: Uint8Array<ArrayBuffer>) => void
    vi.mocked(analysis.processor.finish).mockImplementation(() => new Promise((resolve) => {
      resolveResult = resolve
    }))
    const resultController = new MotionAnalysisController(deps(
      resultStorage.storage,
      () => new FakeWorker(),
    ))
    const resultPending = resultController.analyze(analysis)
    const resultRejected = expect(resultPending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(analysis.processor.finish).toHaveBeenCalledOnce())
    resultController.cancelClip('clip-1')
    await resultRejected
    const lateResultBytes = new Uint8Array(new ArrayBuffer(64))
    resolveResult(lateResultBytes)
    await vi.waitFor(() => expect(lateResultBytes.byteLength).toBe(0))
    expect(resultStorage.stageResult).not.toHaveBeenCalled()
  })

  it('does not cancel a completed generation when the same analysis starts again', async () => {
    const storage = storageFixture()
    const workers: FakeWorker[] = []
    const controller = new MotionAnalysisController(deps(storage.storage, () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }))

    await controller.analyze(request())
    await controller.analyze(request())
    await controller.removeAttachment('local-project:test', 'clip-1')

    expect(workers).toHaveLength(2)
    expect(controller.snapshot().scheduler).toMatchObject({
      queueDepth: 0,
      activeJobCount: 0,
      activeDecoderCount: 0,
      completedCount: 2,
      cancelledCount: 0,
      failedCount: 0,
      jobs: [],
    })
  })

  it('rolls back a manifest commit when the clip changes at the late recheck', async () => {
    const storage = storageFixture()
    let checks = 0
    const analysis = request(() => (++checks >= 8 ? 'replaced-source' : null))
    const controller = new MotionAnalysisController(deps(storage.storage, () => new FakeWorker()))

    await expect(controller.analyze(analysis)).rejects.toMatchObject({
      code: 'replaced-source',
    })
    expect(storage.storage.commitEntry).toHaveBeenCalledOnce()
    expect(storage.transaction.rollback).toHaveBeenCalledOnce()
    expect(storage.transaction.finalize).not.toHaveBeenCalled()
  })

  it('keeps manifest ownership and scheduler admission until a cancelled commit rolls back', async () => {
    const storage = storageFixture()
    let resolveCommit!: (value: typeof storage.transaction) => void
    const pendingCommit = new Promise<typeof storage.transaction>((resolve) => {
      resolveCommit = resolve
    })
    storage.commitEntry
      .mockImplementationOnce(async () => pendingCommit)
      .mockResolvedValue(storage.transaction)
    const workers: FakeWorker[] = []
    const controller = new MotionAnalysisController(deps(storage.storage, () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }))
    const first = controller.analyze(request())
    await vi.waitFor(() => expect(storage.commitEntry).toHaveBeenCalledOnce())

    controller.cancelClip('clip-1')
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    const second = controller.analyze(request(() => null, asset('asset-2'), 'clip-2'))
    await Promise.resolve()

    expect(storage.transaction.rollback).not.toHaveBeenCalled()
    expect(storage.staged.discard).not.toHaveBeenCalled()
    expect(workers).toHaveLength(1)
    expect(controller.snapshot().scheduler).toMatchObject({
      activeJobCount: 1,
      queueDepth: 1,
    })

    resolveCommit(storage.transaction)
    await expect(second).resolves.toMatchObject({ fromCache: false })

    expect(storage.transaction.rollback).toHaveBeenCalledOnce()
    expect(storage.transaction.finalize).toHaveBeenCalledOnce()
    expect(storage.staged.discard).not.toHaveBeenCalled()
    expect(workers).toHaveLength(2)
    expect(controller.snapshot().scheduler).toMatchObject({
      activeJobCount: 0,
      queueDepth: 0,
      maxActiveJobCount: 1,
    })
  })

  it('keeps a timed-out manifest commit admitted until its rollback finishes', async () => {
    vi.useFakeTimers()
    try {
      const storage = storageFixture()
      let resolveCommit!: (value: typeof storage.transaction) => void
      storage.commitEntry.mockImplementationOnce(() => new Promise((resolve) => {
        resolveCommit = resolve
      }))
      const controller = new MotionAnalysisController(deps(
        storage.storage,
        () => new FakeWorker(),
      ))
      const pending = controller.analyze(request())
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'storage-corrupt',
        message: 'Analysis manifest commit timed out',
      })
      await vi.waitFor(() => expect(storage.commitEntry).toHaveBeenCalledOnce())

      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      const second = controller.analyze(request(() => null, asset('asset-2'), 'clip-2'))
      await Promise.resolve()

      expect(storage.transaction.rollback).not.toHaveBeenCalled()
      expect(storage.staged.discard).not.toHaveBeenCalled()
      expect(controller.snapshot().scheduler).toMatchObject({
        activeJobCount: 1,
        queueDepth: 1,
      })

      resolveCommit(storage.transaction)
      await expect(second).resolves.toMatchObject({ fromCache: false })

      expect(storage.transaction.rollback).toHaveBeenCalledOnce()
      expect(storage.transaction.finalize).toHaveBeenCalledOnce()
      expect(storage.staged.discard).not.toHaveBeenCalled()
      expect(controller.snapshot().scheduler).toMatchObject({
        activeJobCount: 0,
        queueDepth: 0,
        maxActiveJobCount: 1,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a running source promptly and allows the next clip to run', async () => {
    const firstStorage = storageFixture()
    let failure: 'offline-source' | null = null
    const firstWorker = new FakeWorker()
    firstWorker.holdCompletion = true
    const secondWorker = new FakeWorker()
    const workers = [firstWorker, secondWorker]
    const controller = new MotionAnalysisController(deps(
      firstStorage.storage,
      () => workers.shift()!,
    ))
    const first = controller.analyze(request(() => failure))
    await vi.waitFor(() => expect(firstWorker.messages[0]?.type).toBe('run'))
    failure = 'offline-source'
    controller.reconcile()
    await expect(first).rejects.toMatchObject({ code: 'offline-source' })
    expect(firstWorker.terminated).toBe(true)

    const second = request(() => null, asset('asset-2'), 'clip-2')
    const result = await controller.analyze(second)
    expect(result.fromCache).toBe(false)
    expect(secondWorker.terminated).toBe(true)
    expect(controller.snapshot().scheduler.maxActiveJobCount).toBe(1)
    expect(controller.snapshot().scheduler.maxActiveDecoderCount).toBe(1)
  })

  it('drains the worker before removing an attachment sidecar', async () => {
    const storage = storageFixture()
    const worker = new FakeWorker()
    worker.holdCompletion = true
    const controller = new MotionAnalysisController(deps(storage.storage, () => worker))
    const pending = controller.analyze(request())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(worker.messages[0]?.type).toBe('run'))

    await controller.removeAttachment('local-project:test', 'clip-1')
    await rejected

    expect(worker.terminated).toBe(true)
    expect(storage.storage.removeAttachment).toHaveBeenCalledWith(
      'local-project:test',
      'clip-1',
    )
    expect(controller.snapshot().scheduler).toMatchObject({
      queueDepth: 0,
      activeJobCount: 0,
      activeDecoderCount: 0,
      jobs: [],
    })
    expect(controller.snapshot().jobs).toEqual([])
  })

  it('drains a running worker and scheduler during controller disposal', async () => {
    const storage = storageFixture()
    const worker = new FakeWorker()
    worker.holdCompletion = true
    const controller = new MotionAnalysisController(deps(storage.storage, () => worker))
    const pending = controller.analyze(request())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(worker.messages[0]?.type).toBe('run'))

    await controller.dispose()
    await rejected

    expect(worker.terminated).toBe(true)
    expect(controller.snapshot().scheduler).toMatchObject({
      queueDepth: 0,
      activeJobCount: 0,
      activeDecoderCount: 0,
      jobs: [],
    })
  })

  it('detaches the result and discards a staged sidecar after source replacement', async () => {
    const storage = storageFixture()
    let resolveStage!: (value: typeof storage.staged) => void
    const lateStage = new Promise<typeof storage.staged>((resolve) => {
      resolveStage = resolve
    })
    storage.stageResult.mockImplementation(async () => lateStage)
    let failure: 'replaced-source' | null = null
    const controller = new MotionAnalysisController(deps(storage.storage, () => new FakeWorker()))
    const analysis = request(() => failure)
    const resultBytes = new Uint8Array(new ArrayBuffer(64))
    vi.mocked(analysis.processor.finish).mockResolvedValue(resultBytes)
    const pending = controller.analyze(analysis)
    await vi.waitFor(() => expect(storage.stageResult).toHaveBeenCalledOnce())

    failure = 'replaced-source'
    controller.reconcile()
    await expect(pending).rejects.toMatchObject({ code: 'replaced-source' })
    resolveStage(storage.staged)
    await vi.waitFor(() => expect(storage.staged.discard).toHaveBeenCalledOnce())
    expect(resultBytes.byteLength).toBe(0)
    expect(storage.commitEntry).not.toHaveBeenCalled()
  })
})
