import { afterEach, describe, expect, test, vi } from 'vitest'
import { runMotionAnalysisResearch } from '../domain/motionAnalysisResearch'
import type { MotionResearchRunMessage } from '../workers/motion-analysis-research-protocol'
import {
  motionAnalysisResearchDiagnostics,
  runBrowserMotionAnalysisResearch,
} from './motionAnalysisResearchController'

class ResearchWorkerStub extends EventTarget {
  readonly behavior: 'success' | 'pending' | 'failure'
  terminated = false

  constructor(behavior: 'success' | 'pending' | 'failure') {
    super()
    this.behavior = behavior
  }

  postMessage(message: MotionResearchRunMessage): void {
    queueMicrotask(() => {
      if (this.terminated) return
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

function installWorker(behavior: 'success' | 'pending' | 'failure'): void {
  vi.stubGlobal('Worker', class extends ResearchWorkerStub {
    constructor() {
      super(behavior)
    }
  })
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
