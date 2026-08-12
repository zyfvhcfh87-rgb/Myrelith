import { afterEach, describe, expect, test, vi } from 'vitest'
import { runMotionAnalysisResearch } from '../domain/motionAnalysisResearch'
import type {
  MotionResearchWorkerMessage,
} from '../workers/motion-analysis-research-protocol'
import {
  motionAnalysisResearchDiagnostics,
  probeMotionAnalysisSupport,
  runBrowserMotionAnalysisResearch,
} from './motionAnalysisResearchController'

class ResearchWorkerStub extends EventTarget {
  readonly behavior: ResearchWorkerBehavior
  readonly messages: MotionResearchWorkerMessage[] = []
  terminated = false

  constructor(behavior: ResearchWorkerBehavior) {
    super()
    this.behavior = behavior
  }

  postMessage(message: MotionResearchWorkerMessage): void {
    this.messages.push(message)
    queueMicrotask(() => {
      if (this.terminated) return
      if (message.type === 'probe') {
        if (this.behavior === 'probe-pending') return
        if (this.behavior === 'module-error') {
          this.dispatchEvent(new ErrorEvent('error', {
            message: 'Synthetic module worker load failure',
            cancelable: true,
          }))
          return
        }
        this.dispatchEvent(new MessageEvent('message', { data: {
          type: 'ready',
          requestId: message.requestId,
        } }))
        return
      }
      this.dispatchEvent(new MessageEvent('message', { data: {
        type: 'progress',
        requestId: message.requestId,
        progress: { stage: 'stabilization', progress: 0.25 },
      } }))
      if (this.behavior === 'pending' || this.terminated) return
      if (this.behavior === 'failure') {
        this.dispatchEvent(new MessageEvent('message', { data: {
          type: 'error',
          requestId: message.requestId,
          code: 'quality-fixture-failed',
          message: 'fixture failed',
        } }))
        return
      }
      this.dispatchEvent(new MessageEvent('message', { data: {
        type: 'result',
        requestId: message.requestId,
        evidence: runMotionAnalysisResearch(),
      } }))
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

type ResearchWorkerBehavior =
  | 'success'
  | 'pending'
  | 'failure'
  | 'probe-pending'
  | 'module-error'

function installWorker(behavior: ResearchWorkerBehavior): ResearchWorkerStub[] {
  const workers: ResearchWorkerStub[] = []
  vi.stubGlobal('Worker', class extends ResearchWorkerStub {
    constructor() {
      super(behavior)
      workers.push(this)
    }
  })
  return workers
}

afterEach(() => vi.unstubAllGlobals())

describe('motion analysis research controller', () => {
  test('runs one bounded worker job and terminates the worker after success', async () => {
    installWorker('success')
    const before = motionAnalysisResearchDiagnostics()
    const progress = vi.fn()
    const result = await runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
      onProgress: progress,
    })
    expect(result.evidence.decision).toEqual({
      stabilization: 'go',
      pointTracking: 'go',
      boxTracking: 'go',
    })
    expect(result.scheduler).toMatchObject({
      maxActiveJobCount: 1,
      maxActiveDecoderCount: 0,
      completedCount: 1,
      failedCount: 0,
      queueDepth: 0,
      activeJobCount: 0,
    })
    expect(progress).toHaveBeenCalled()
    expect(result.diagnostics.workersCreated - before.workersCreated).toBe(1)
    expect(result.diagnostics.workersTerminated - before.workersTerminated).toBe(1)
    expect(result.diagnostics.activeWorkers).toBe(0)
  })

  test('rejects queued pre-abort without creating a worker', async () => {
    installWorker('pending')
    const controller = new AbortController()
    controller.abort()
    const before = motionAnalysisResearchDiagnostics()
    await expect(runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    const after = motionAnalysisResearchDiagnostics()
    expect(after.workersCreated).toBe(before.workersCreated)
    expect(after.activeWorkers).toBe(0)
  })

  test('terminates active work when cancellation arrives after progress', async () => {
    installWorker('pending')
    const controller = new AbortController()
    const before = motionAnalysisResearchDiagnostics()
    await expect(runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' })
    const after = motionAnalysisResearchDiagnostics()
    expect(after.workersCreated - before.workersCreated).toBe(1)
    expect(after.workersTerminated - before.workersTerminated).toBe(1)
    expect(after.activeWorkers).toBe(0)
  })

  test('rejects a second controller run while the shared admission slot is active', async () => {
    installWorker('pending')
    const controller = new AbortController()
    let observeProgress!: () => void
    const progress = new Promise<void>((resolve) => {
      observeProgress = resolve
    })
    const firstRun = runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
      signal: controller.signal,
      onProgress: observeProgress,
    })
    await progress
    const beforeSecondRun = motionAnalysisResearchDiagnostics()

    await expect(runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
    })).rejects.toMatchObject({
      name: 'MediaJobExecutionError',
      code: 'resource-unavailable',
      message: 'A motion-analysis research run is already active.',
    })
    expect(motionAnalysisResearchDiagnostics()).toMatchObject({
      workersCreated: beforeSecondRun.workersCreated,
      activeWorkers: 1,
    })

    controller.abort()
    await expect(firstRun).rejects.toMatchObject({ name: 'AbortError' })
    expect(motionAnalysisResearchDiagnostics().activeWorkers).toBe(0)
  })

  test('waits for the module worker ready handshake before reporting support', async () => {
    const workers = installWorker('probe-pending')
    let settled = false
    const supportPromise = probeMotionAnalysisSupport().then((support) => {
      settled = true
      return support
    })
    await Promise.resolve()

    expect(workers).toHaveLength(1)
    expect(workers[0]!.messages).toHaveLength(1)
    expect(workers[0]!.messages[0]).toMatchObject({ type: 'probe' })
    expect(settled).toBe(false)

    const probe = workers[0]!.messages[0]!
    workers[0]!.dispatchEvent(new MessageEvent('message', { data: {
      type: 'ready',
      requestId: probe.requestId,
    } }))
    const support = await supportPromise

    expect(support.worker).toBe(true)
    expect(workers[0]!.terminated).toBe(true)
  })

  test('times out and terminates a module worker that never becomes ready', async () => {
    vi.useFakeTimers()
    try {
      const workers = installWorker('probe-pending')
      let settleCount = 0
      const supportPromise = probeMotionAnalysisSupport().then((support) => {
        settleCount++
        return support
      })

      await vi.advanceTimersByTimeAsync(4_999)
      expect(settleCount).toBe(0)
      expect(workers[0]!.terminated).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      const support = await supportPromise
      expect(support.worker).toBe(false)
      expect(workers[0]!.terminated).toBe(true)

      const probe = workers[0]!.messages[0]!
      workers[0]!.dispatchEvent(new MessageEvent('message', { data: {
        type: 'ready',
        requestId: probe.requestId,
      } }))
      workers[0]!.dispatchEvent(new ErrorEvent('error', { cancelable: true }))
      await Promise.resolve()
      expect(settleCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('aborts a pending worker probe immediately and releases run admission', async () => {
    vi.useFakeTimers()
    try {
      const workers = installWorker('probe-pending')
      const controller = new AbortController()
      const run = runBrowserMotionAnalysisResearch({ signal: controller.signal })
      await Promise.resolve()

      expect(workers).toHaveLength(1)
      expect(workers[0]!.terminated).toBe(false)
      controller.abort()

      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      expect(workers[0]!.terminated).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }

    await expect(runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
    })).resolves.toMatchObject({
      evidence: { decision: { stabilization: 'go' } },
    })
  })

  test('reports asynchronous module worker load failure through the typed unsupported path', async () => {
    const workers = installWorker('module-error')
    const before = motionAnalysisResearchDiagnostics()

    const support = await probeMotionAnalysisSupport()
    expect(support.worker).toBe(false)
    expect(support.failures).toContain('Dedicated module workers are unavailable.')
    await expect(runBrowserMotionAnalysisResearch()).rejects.toMatchObject({
      name: 'MediaJobExecutionError',
      code: 'resource-unavailable',
      message: expect.stringContaining('Dedicated module workers are unavailable.'),
    })

    expect(workers).toHaveLength(2)
    expect(workers.every((worker) => worker.terminated)).toBe(true)
    expect(motionAnalysisResearchDiagnostics()).toMatchObject({
      workersCreated: before.workersCreated,
      activeWorkers: 0,
    })
  })

  test('reports OPFS probe cleanup failure through the typed unsupported path', async () => {
    installWorker('success')
    const removeEntry = vi.fn().mockRejectedValue(new DOMException(
      'Synthetic removal failure',
      'OperationError',
    ))
    const getFileHandle = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      getFile: vi.fn().mockResolvedValue({ size: 2 }),
    })
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({ getFileHandle, removeEntry }),
      },
    })
    const before = motionAnalysisResearchDiagnostics()

    const support = await probeMotionAnalysisSupport()
    expect(support).toMatchObject({ supported: false, opfs: false })
    expect(support.failures).toContain(
      'Origin-private file storage probe cleanup failed.',
    )
    await expect(runBrowserMotionAnalysisResearch()).rejects.toMatchObject({
      name: 'MediaJobExecutionError',
      code: 'resource-unavailable',
      message: expect.stringContaining(
        'Origin-private file storage probe cleanup failed.',
      ),
    })

    const after = motionAnalysisResearchDiagnostics()
    expect(after.opfsProbeFilesCreated - before.opfsProbeFilesCreated).toBe(2)
    expect(after.opfsProbeFilesRemoved).toBe(before.opfsProbeFilesRemoved)
    expect(after.workersCreated).toBe(before.workersCreated)
    expect(after.activeWorkers).toBe(0)
    expect(removeEntry).toHaveBeenCalledTimes(2)
  })

  test('uses distinct OPFS files for overlapping support probes', async () => {
    installWorker('success')
    let nonce = 0
    vi.stubGlobal('crypto', {
      getRandomValues: (values: Uint32Array) => {
        values.fill(0)
        values[values.length - 1] = ++nonce
        return values
      },
      subtle: { digest: vi.fn() },
    })
    const fileNames: string[] = []
    const removedNames: string[] = []
    const getFileHandle = vi.fn(async (fileName: string) => {
      fileNames.push(fileName)
      return {
        createWritable: vi.fn().mockResolvedValue({
          write: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        getFile: vi.fn().mockResolvedValue({ size: 2 }),
      }
    })
    const removeEntry = vi.fn(async (fileName: string) => {
      removedNames.push(fileName)
    })
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({ getFileHandle, removeEntry }),
      },
    })
    const before = motionAnalysisResearchDiagnostics()

    const results = await Promise.all([
      probeMotionAnalysisSupport(),
      probeMotionAnalysisSupport(),
    ])

    expect(results.map((result) => result.opfs)).toEqual([true, true])
    expect(fileNames).toHaveLength(2)
    expect(new Set(fileNames)).toHaveLength(2)
    expect(fileNames.every((fileName) => (
      fileName.startsWith('issue-44-motion-analysis-support-probe-')
      && fileName.endsWith('.tmp')
    ))).toBe(true)
    expect(removedNames).toEqual(expect.arrayContaining(fileNames))
    expect(new Set(removedNames)).toEqual(new Set(fileNames))
    const after = motionAnalysisResearchDiagnostics()
    expect(after.opfsProbeFilesCreated - before.opfsProbeFilesCreated).toBe(2)
    expect(after.opfsProbeFilesRemoved - before.opfsProbeFilesRemoved).toBe(2)
  })

  test('preserves a typed quality failure and still terminates the worker', async () => {
    installWorker('failure')
    const before = motionAnalysisResearchDiagnostics()
    await expect(runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
    })).rejects.toMatchObject({
      name: 'MediaJobExecutionError',
      code: 'resource-limit',
      message: 'fixture failed',
    })
    const after = motionAnalysisResearchDiagnostics()
    expect(after.workersTerminated - before.workersTerminated).toBe(1)
    expect(after.activeWorkers).toBe(0)
  })
})
