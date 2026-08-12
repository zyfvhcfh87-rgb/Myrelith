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
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  terminated = false

  constructor(behavior: ResearchWorkerBehavior) {
    super()
    this.behavior = behavior
  }

  postMessage(message: MotionResearchWorkerMessage): void {
    this.messages.push(message)
    if (this.behavior === 'post-throw' && message.type === 'run') {
      throw new DOMException('Synthetic postMessage failure', 'InvalidStateError')
    }
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

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options)
    if (!callback) return
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(callback)
    this.listeners.set(type, listeners)
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback, options)
    if (!callback) return
    this.listeners.get(type)?.delete(callback)
  }

  activeListenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    )
  }
}

type ResearchWorkerBehavior =
  | 'success'
  | 'pending'
  | 'failure'
  | 'post-throw'
  | 'probe-pending'
  | 'module-error'

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value | PromiseLike<Value>) => void
  readonly reject: (cause?: unknown) => void
}

interface DeferredVideoFrameState {
  closed: boolean
  closeCalls: number
}

type OpfsProbeStep =
  | 'getDirectory'
  | 'getFileHandle'
  | 'createWritable'
  | 'write'
  | 'close'
  | 'getFile'
  | 'removeEntry'

const OPFS_PROBE_STEPS: readonly OpfsProbeStep[] = [
  'getDirectory',
  'getFileHandle',
  'createWritable',
  'write',
  'close',
  'getFile',
  'removeEntry',
]

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

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (cause?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function installDeferredVideoFrame(copy: Deferred<unknown>): {
  readonly copyStarted: Promise<void>
  readonly frames: DeferredVideoFrameState[]
} {
  let observeCopyStarted!: () => void
  const copyStarted = new Promise<void>((resolve) => {
    observeCopyStarted = resolve
  })
  const frames: DeferredVideoFrameState[] = []
  vi.stubGlobal('VideoFrame', class {
    readonly state: DeferredVideoFrameState

    constructor() {
      this.state = { closed: false, closeCalls: 0 }
      frames.push(this.state)
    }

    allocationSize(): number {
      if (this.state.closed) throw new DOMException('Frame is closed', 'InvalidStateError')
      return 16
    }

    copyTo(): Promise<unknown> {
      observeCopyStarted()
      return copy.promise
    }

    close(): void {
      this.state.closeCalls++
      this.state.closed = true
    }
  })
  return { copyStarted, frames }
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
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

  test.each(OPFS_PROBE_STEPS)(
    'aborts promptly during stalled OPFS %s and retires only its owned late work',
    async (stalledStep) => {
      installWorker('success')
      let nonce = 0
      const issuedNames: string[] = []
      vi.stubGlobal('crypto', {
        getRandomValues: (values: Uint32Array) => {
          values.fill(0)
          values[values.length - 1] = ++nonce
          const suffix = Array.from(
            values,
            (value) => value.toString(16).padStart(8, '0'),
          ).join('')
          issuedNames.push(`issue-44-motion-analysis-support-probe-${suffix}.tmp`)
          return values
        },
        subtle: { digest: vi.fn() },
      })

      let observeStall!: () => void
      const stallReached = new Promise<void>((resolve) => {
        observeStall = resolve
      })
      let releaseStall!: () => void
      const stallGate = new Promise<void>((resolve) => {
        releaseStall = resolve
      })
      let stalled = false
      let released = false
      const pause = async <Value>(step: OpfsProbeStep, value: Value): Promise<Value> => {
        if (!stalled && step === stalledStep) {
          stalled = true
          observeStall()
          await stallGate
        }
        return value
      }

      const openedNames: string[] = []
      const removalAttempts: string[] = []
      const removedNames: string[] = []
      const activeNames = new Set<string>()
      const getFileHandle = vi.fn(async (fileName: string) => {
        openedNames.push(fileName)
        const handle = {
          createWritable: vi.fn(async () => pause('createWritable', {
            write: vi.fn(async () => pause('write', undefined)),
            close: vi.fn(async () => pause('close', undefined)),
          })),
          getFile: vi.fn(async () => pause('getFile', { size: 2 })),
        }
        const resolvedHandle = await pause('getFileHandle', handle)
        activeNames.add(fileName)
        return resolvedHandle
      })
      const removeEntry = vi.fn(async (fileName: string) => {
        removalAttempts.push(fileName)
        await pause('removeEntry', undefined)
        if (!activeNames.delete(fileName)) {
          throw new DOMException('Synthetic missing probe file', 'NotFoundError')
        }
        removedNames.push(fileName)
      })
      const root = { getFileHandle, removeEntry }
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: vi.fn(async () => pause('getDirectory', root)),
        },
      })

      const controller = new AbortController()
      const before = motionAnalysisResearchDiagnostics()
      const firstRun = runBrowserMotionAnalysisResearch({ signal: controller.signal })
      const firstOutcome = firstRun.then(
        () => ({ status: 'fulfilled' as const, cause: null }),
        (cause: unknown) => ({ status: 'rejected' as const, cause }),
      )

      try {
        await stallReached
        controller.abort()

        await expect(firstOutcome).resolves.toMatchObject({
          status: 'rejected',
          cause: { name: 'AbortError' },
        })
        expect(released).toBe(false)
        await expect(runBrowserMotionAnalysisResearch({
          skipSupportProbe: true,
        })).resolves.toMatchObject({
          evidence: { decision: { stabilization: 'go' } },
        })

        const overlappingSupport = await probeMotionAnalysisSupport()
        expect(overlappingSupport.opfs).toBe(true)
        expect(issuedNames).toHaveLength(2)
        const [firstName, secondName] = issuedNames as [string, string]
        expect(firstName).not.toBe(secondName)
        expect(openedNames).toEqual(stalledStep === 'getDirectory'
          ? [secondName]
          : [firstName, secondName])
        expect(removalAttempts).toEqual(stalledStep === 'removeEntry'
          ? [firstName, secondName]
          : [secondName])
        expect(removedNames).toEqual([secondName])

        const beforeLateSettlement = motionAnalysisResearchDiagnostics()
        expect(
          beforeLateSettlement.opfsProbeFilesCreated - before.opfsProbeFilesCreated,
        ).toBe(1)
        expect(
          beforeLateSettlement.opfsProbeFilesRemoved - before.opfsProbeFilesRemoved,
        ).toBe(1)

        released = true
        releaseStall()
        await flushMicrotasks()
        await vi.waitFor(() => {
          expect(activeNames.size).toBe(0)
          expect(removedNames).toEqual(stalledStep === 'getDirectory'
            ? [secondName]
            : [secondName, firstName])
        })

        const afterLateSettlement = motionAnalysisResearchDiagnostics()
        expect(afterLateSettlement.opfsProbeFilesCreated).toBe(
          beforeLateSettlement.opfsProbeFilesCreated,
        )
        expect(afterLateSettlement.opfsProbeFilesRemoved).toBe(
          beforeLateSettlement.opfsProbeFilesRemoved,
        )
        expect(new Set(removalAttempts)).toEqual(new Set(removedNames))
      } finally {
        controller.abort()
        if (!released) releaseStall()
        await flushMicrotasks()
      }
    },
  )

  test.each(['resolve', 'reject'] as const)(
    'aborts stalled VideoFrame copyTo before settlement and observes a late %s',
    async (lateSettlement) => {
      const copy = deferred<unknown>()
      let copyReleased = false
      const controller = new AbortController()
      try {
        installWorker('success')
        const videoFrames = installDeferredVideoFrame(copy)
        const before = motionAnalysisResearchDiagnostics()
        const firstRun = runBrowserMotionAnalysisResearch({ signal: controller.signal })
        const firstOutcome = firstRun.then(
          () => ({ status: 'fulfilled' as const, cause: null, closed: false }),
          (cause: unknown) => ({
            status: 'rejected' as const,
            cause,
            closed: videoFrames.frames[0]?.closed ?? false,
          }),
        )

        await videoFrames.copyStarted
        expect(videoFrames.frames).toHaveLength(1)
        expect(videoFrames.frames[0]).toEqual({ closed: false, closeCalls: 0 })

        controller.abort()

        expect(videoFrames.frames[0]).toEqual({ closed: true, closeCalls: 1 })
        await expect(firstOutcome).resolves.toMatchObject({
          status: 'rejected',
          cause: { name: 'AbortError' },
          closed: true,
        })
        expect(copyReleased).toBe(false)
        const afterAbort = motionAnalysisResearchDiagnostics()
        expect(afterAbort.supportFramesCreated - before.supportFramesCreated).toBe(1)
        expect(afterAbort.supportFramesClosed - before.supportFramesClosed).toBe(1)

        await expect(runBrowserMotionAnalysisResearch({
          skipSupportProbe: true,
        })).resolves.toMatchObject({
          evidence: { decision: { stabilization: 'go' } },
        })

        const beforeLateSettlement = motionAnalysisResearchDiagnostics()
        copyReleased = true
        if (lateSettlement === 'resolve') copy.resolve([])
        else copy.reject(new DOMException('Synthetic late copy failure', 'OperationError'))
        await flushMicrotasks()

        expect(videoFrames.frames[0]).toEqual({ closed: true, closeCalls: 1 })
        expect(motionAnalysisResearchDiagnostics()).toEqual(beforeLateSettlement)
      } finally {
        controller.abort()
        if (!copyReleased) copy.resolve([])
        await flushMicrotasks()
      }
    },
    2_000,
  )

  test('bounds stalled VideoFrame copyTo and observes its late rejection', async () => {
    const copy = deferred<unknown>()
    let copyReleased = false
    const actualSetTimeout = globalThis.setTimeout
    const supportDeadlines: Array<() => void> = []
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout) => {
      if (timeout === 5_000 && typeof handler === 'function') {
        supportDeadlines.push(() => handler())
      }
      return actualSetTimeout(handler, timeout)
    })
    try {
      installWorker('success')
      const videoFrames = installDeferredVideoFrame(copy)
      const before = motionAnalysisResearchDiagnostics()
      let settleCount = 0
      const run = runBrowserMotionAnalysisResearch()
      const outcome = run.then(
        () => ({ status: 'fulfilled' as const, cause: null, closed: false }),
        (cause: unknown) => {
          settleCount++
          return {
            status: 'rejected' as const,
            cause,
            closed: videoFrames.frames[0]?.closed ?? false,
          }
        },
      )

      await videoFrames.copyStarted
      expect(settleCount).toBe(0)
      expect(videoFrames.frames[0]).toEqual({ closed: false, closeCalls: 0 })
      expect(supportDeadlines).toHaveLength(2)

      supportDeadlines[1]!()
      await expect(outcome).resolves.toMatchObject({
        status: 'rejected',
        cause: {
          name: 'MediaJobExecutionError',
          code: 'resource-unavailable',
          message: expect.stringContaining('VideoFrame RGBA copyTo is unavailable.'),
        },
        closed: true,
      })
      expect(settleCount).toBe(1)
      expect(videoFrames.frames[0]).toEqual({ closed: true, closeCalls: 1 })
      const afterTimeout = motionAnalysisResearchDiagnostics()
      expect(afterTimeout.supportFramesCreated - before.supportFramesCreated).toBe(1)
      expect(afterTimeout.supportFramesClosed - before.supportFramesClosed).toBe(1)

      await expect(runBrowserMotionAnalysisResearch({
        skipSupportProbe: true,
      })).resolves.toMatchObject({
        evidence: { decision: { stabilization: 'go' } },
      })

      const beforeLateSettlement = motionAnalysisResearchDiagnostics()
      copyReleased = true
      copy.reject(new DOMException('Synthetic late timeout failure', 'OperationError'))
      await flushMicrotasks()
      expect(settleCount).toBe(1)
      expect(videoFrames.frames[0]).toEqual({ closed: true, closeCalls: 1 })
      expect(motionAnalysisResearchDiagnostics()).toEqual(beforeLateSettlement)
    } finally {
      if (!copyReleased) copy.resolve([])
      await flushMicrotasks()
      timeoutSpy.mockRestore()
    }
  })

  test('terminates and releases admission when initial worker postMessage throws', async () => {
    const workers = installWorker('post-throw')
    const before = motionAnalysisResearchDiagnostics()
    const firstOutcome = runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
    }).then(
      () => ({ status: 'fulfilled' as const, cause: null, diagnostics: null }),
      (cause: unknown) => ({
        status: 'rejected' as const,
        cause,
        diagnostics: motionAnalysisResearchDiagnostics(),
      }),
    )

    await expect(firstOutcome).resolves.toMatchObject({
      status: 'rejected',
      cause: {
        name: 'InvalidStateError',
        message: 'Synthetic postMessage failure',
      },
      diagnostics: {
        workersCreated: before.workersCreated + 1,
        workersTerminated: before.workersTerminated + 1,
        activeWorkers: 0,
      },
    })
    expect(workers).toHaveLength(1)
    expect(workers[0]).toMatchObject({ terminated: true })
    expect(workers[0]!.messages).toHaveLength(1)
    expect(workers[0]!.activeListenerCount()).toBe(0)

    const retryWorkers = installWorker('success')
    await expect(runBrowserMotionAnalysisResearch({
      skipSupportProbe: true,
    })).resolves.toMatchObject({
      evidence: { decision: { stabilization: 'go' } },
    })

    const afterRetry = motionAnalysisResearchDiagnostics()
    expect(afterRetry.workersCreated - before.workersCreated).toBe(2)
    expect(afterRetry.workersTerminated - before.workersTerminated).toBe(2)
    expect(afterRetry.activeWorkers).toBe(0)
    expect(retryWorkers).toHaveLength(1)
    expect(retryWorkers[0]).toMatchObject({ terminated: true })
    expect(retryWorkers[0]!.activeListenerCount()).toBe(0)
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
