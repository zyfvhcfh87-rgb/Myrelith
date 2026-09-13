import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  InventoryWorkerRequest,
  InventoryWorkerResponse,
  WorkerProbeEvidence,
} from './compatibilityInventoryContract'
import {
  raceInventoryProbe,
  runInventoryWorkerProbe,
} from './compatibilityInventoryGate'

const workerEvidence: WorkerProbeEvidence = Object.freeze({
  moduleWorker: true,
  offscreenCanvas2d: true,
  transferredCanvas2d: false,
  webgl2: false,
  videoDecoderPresent: true,
  videoDecoderConfigSupported: true,
  reason: null,
})

class SuccessfulWorker extends EventTarget {
  static instances: SuccessfulWorker[] = []
  readonly messages: InventoryWorkerRequest[] = []
  terminateCalls = 0

  constructor(_url: URL, _options: WorkerOptions) {
    super()
    SuccessfulWorker.instances.push(this)
  }

  postMessage(message: InventoryWorkerRequest): void {
    this.messages.push(message)
    queueMicrotask(() => this.reply({ type: 'result', worker: workerEvidence }))
  }

  terminate(): void {
    this.terminateCalls += 1
  }

  private reply(data: InventoryWorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

afterEach(() => {
  SuccessfulWorker.instances = []
  vi.unstubAllGlobals()
})

describe('Issue #208 inventory worker ownership', () => {
  test('terminates the inventory worker after it records facts', async () => {
    vi.stubGlobal('Worker', SuccessfulWorker)
    const result = await runInventoryWorkerProbe()

    expect(result.worker).toEqual(workerEvidence)
    expect(result.lifecycle).toEqual({
      workersCreated: 1,
      workersTerminated: 1,
      activeWorkers: 0,
    })
    expect(SuccessfulWorker.instances).toHaveLength(1)
    expect(SuccessfulWorker.instances[0]?.terminateCalls).toBe(1)
    expect(SuccessfulWorker.instances[0]?.messages).toEqual([
      { type: 'run', canvas: null },
    ])
  })

  test('terminates and rejects when a worker response cannot be deserialized', async () => {
    class MessageErrorWorker extends SuccessfulWorker {
      override postMessage(message: InventoryWorkerRequest): void {
        this.messages.push(message)
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('messageerror')))
      }
    }
    vi.stubGlobal('Worker', MessageErrorWorker)

    await expect(runInventoryWorkerProbe()).rejects.toThrow(/could not be deserialized/)
    expect(SuccessfulWorker.instances).toHaveLength(1)
    expect(SuccessfulWorker.instances[0]?.terminateCalls).toBe(1)
  })

  test('terminates and preserves a synchronous initial post failure', async () => {
    class ThrowingWorker extends SuccessfulWorker {
      override postMessage(message: InventoryWorkerRequest): void {
        this.messages.push(message)
        throw new DOMException('worker startup failed', 'InvalidStateError')
      }
    }
    vi.stubGlobal('Worker', ThrowingWorker)

    await expect(runInventoryWorkerProbe()).rejects.toMatchObject({
      name: 'InvalidStateError',
      message: 'worker startup failed',
    })
    expect(SuccessfulWorker.instances).toHaveLength(1)
    expect(SuccessfulWorker.instances[0]?.terminateCalls).toBe(1)
  })
})

describe('Issue #208 inventory probe budget', () => {
  test('returns the work result when it settles inside the budget', async () => {
    await expect(
      raceInventoryProbe('demo', 50, async () => (
        Object.freeze({ supported: true, reason: null })
      )),
    ).resolves.toEqual({ supported: true, reason: null })
  })

  test('prefers a late work result that arrives during drain', async () => {
    await expect(
      raceInventoryProbe('demo', 20, async () => {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 40)
        })
        return Object.freeze({ supported: true, reason: null })
      }),
    ).resolves.toEqual({ supported: true, reason: null })
  })

  test('keeps the timeout when work never settles', async () => {
    await expect(
      raceInventoryProbe('demo', 20, () => new Promise(() => {})),
    ).resolves.toEqual({ supported: false, reason: 'demo-timeout' })
  }, 10_000)
})
