import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  LensRemapRunEvidence,
  LensRemapWorkerRequest,
  LensRemapWorkerResponse,
} from './lensRemapContract'
import { runLensRemapBrowserGate } from './lensRemapGate'

const goEvidence = Object.freeze({
  fixtureVersion: 'issue-111-lens-fixtures-v1',
  backendVersion: 'webgl2-rgba8-manual-bilinear-v1',
  sourceStageOrder: [],
  fallbackPolicy: 'explicit-unavailable-no-cpu-substitution',
  support: {
    webgl2: true,
    rgba8Upload: true,
    rgba8Readback: true,
    manualBilinear: true,
    contextLossExtension: true,
    maximumTextureSize: 16_384,
  } as const,
  coldSetupMs: 1,
  warmModelSetupMs: 1,
  parity: [],
  timings: [],
  invalidFoldingRejected: true,
  contextLoss: { currentOwnerFailed: true, freshOwnerSucceeded: true },
  resources: { backendsCreated: 2, backendsDisposed: 2, retainedBytesAfterDispose: 0 },
  decision: 'go',
  reasons: [],
}) satisfies LensRemapRunEvidence

class SuccessfulWorker extends EventTarget {
  static instances: SuccessfulWorker[] = []
  readonly messages: LensRemapWorkerRequest[] = []
  terminateCalls = 0

  constructor(_url: URL, _options: WorkerOptions) {
    super()
    SuccessfulWorker.instances.push(this)
  }

  postMessage(message: LensRemapWorkerRequest): void {
    this.messages.push(message)
    if (message.type === 'run') {
      queueMicrotask(() => this.reply({ type: 'result', evidence: goEvidence }))
    } else if (message.type === 'cancel-probe') {
      queueMicrotask(() => this.reply({ type: 'cancel-ready' }))
    } else {
      queueMicrotask(() => this.reply({ type: 'cancelled', name: 'AbortError' }))
    }
  }

  terminate(): void {
    this.terminateCalls++
  }

  private reply(data: LensRemapWorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

afterEach(() => {
  SuccessfulWorker.instances = []
  vi.unstubAllGlobals()
})

describe('Issue #111 lens-remap gate worker ownership', () => {
  test('terminates the full and cancellation workers after exact success', async () => {
    vi.stubGlobal('Worker', SuccessfulWorker)
    const evidence = await runLensRemapBrowserGate()

    expect(evidence.workerLifecycle).toEqual({
      workersCreated: 2,
      workersTerminated: 2,
      activeWorkers: 0,
    })
    expect(evidence.cancellation.name).toBe('AbortError')
    expect(SuccessfulWorker.instances).toHaveLength(2)
    expect(SuccessfulWorker.instances.map((worker) => worker.terminateCalls)).toEqual([1, 1])
    expect(SuccessfulWorker.instances[0]?.messages).toEqual([{ type: 'run' }])
    expect(SuccessfulWorker.instances[1]?.messages).toEqual([
      { type: 'cancel-probe' },
      { type: 'cancel' },
    ])
  })

  test('terminates and rejects when a worker response cannot be deserialized', async () => {
    class MessageErrorWorker extends SuccessfulWorker {
      override postMessage(message: LensRemapWorkerRequest): void {
        this.messages.push(message)
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('messageerror')))
      }
    }
    vi.stubGlobal('Worker', MessageErrorWorker)

    await expect(runLensRemapBrowserGate()).rejects.toThrow(/could not be deserialized/)
    expect(SuccessfulWorker.instances).toHaveLength(1)
    expect(SuccessfulWorker.instances[0]?.terminateCalls).toBe(1)
  })

  test('terminates and preserves a synchronous initial post failure', async () => {
    class ThrowingWorker extends SuccessfulWorker {
      override postMessage(message: LensRemapWorkerRequest): void {
        this.messages.push(message)
        throw new DOMException('worker startup failed', 'InvalidStateError')
      }
    }
    vi.stubGlobal('Worker', ThrowingWorker)

    await expect(runLensRemapBrowserGate()).rejects.toMatchObject({
      name: 'InvalidStateError',
      message: 'worker startup failed',
    })
    expect(SuccessfulWorker.instances).toHaveLength(1)
    expect(SuccessfulWorker.instances[0]?.terminateCalls).toBe(1)
  })
})
