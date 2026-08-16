import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  disposeLoadedExport,
  registerLoadedExportDisposer,
  resetLoadedExportDisposer,
} from './exportLifecycle'

beforeEach(() => {
  resetLoadedExportDisposer()
})

describe('lazy export lifecycle', () => {
  test('does not load or invoke an export that has never registered', async () => {
    await expect(disposeLoadedExport()).resolves.toBeUndefined()
  })

  test('awaits every owner newest-first through one shared terminal boundary', async () => {
    let releasePrepared!: () => void
    const preparedSettled = new Promise<void>((resolve) => { releasePrepared = resolve })
    const calls: string[] = []
    const activeExport = vi.fn(async () => { calls.push('active-export') })
    const prepared = vi.fn(async () => {
      calls.push('prepared-start')
      await preparedSettled
      calls.push('prepared-end')
    })
    registerLoadedExportDisposer(activeExport)
    registerLoadedExportDisposer(prepared)

    const first = disposeLoadedExport()
    const second = disposeLoadedExport()

    expect(second).toBe(first)
    await Promise.resolve()
    expect(calls).toEqual(['prepared-start'])
    expect(activeExport).not.toHaveBeenCalled()
    releasePrepared()
    await first

    expect(calls).toEqual(['prepared-start', 'prepared-end', 'active-export'])
    expect(prepared).toHaveBeenCalledOnce()
    expect(activeExport).toHaveBeenCalledOnce()
  })

  test('joins a late registration to the active drain before the boundary settles', async () => {
    let releaseExisting!: () => void
    let releaseLate!: () => void
    const existingGate = new Promise<void>((resolve) => { releaseExisting = resolve })
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve })
    const calls: string[] = []
    registerLoadedExportDisposer(async () => {
      calls.push('existing-start')
      await existingGate
      calls.push('existing-end')
    })

    const disposal = disposeLoadedExport()
    await Promise.resolve()
    const lateRegistration = registerLoadedExportDisposer(async () => {
      calls.push('late-start')
      await lateGate
      calls.push('late-end')
    })

    expect(lateRegistration.joinedDisposal).toBe(disposal)
    expect(calls).toEqual(['existing-start'])
    releaseExisting()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['existing-start', 'existing-end', 'late-start'])

    let settled = false
    void disposal.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseLate()
    await disposal
    expect(calls).toEqual([
      'existing-start',
      'existing-end',
      'late-start',
      'late-end',
    ])
  })

  test('aggregates a late joined cleanup failure after the active owner fails', async () => {
    let releaseExisting!: () => void
    const existingGate = new Promise<void>((resolve) => { releaseExisting = resolve })
    const existingFailure = new Error('existing export close failed')
    const lateFailure = new Error('late prepared close failed')
    registerLoadedExportDisposer(async () => {
      await existingGate
      throw existingFailure
    })

    const disposal = disposeLoadedExport()
    await Promise.resolve()
    const late = registerLoadedExportDisposer(async () => { throw lateFailure })
    expect(late.joinedDisposal).toBe(disposal)
    releaseExisting()

    const failure = await disposal.catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      existingFailure,
      lateFailure,
    ])
  })

  test('unregisters one exact owner idempotently without disturbing siblings', async () => {
    const retained = vi.fn(async () => undefined)
    const removed = vi.fn(async () => undefined)
    registerLoadedExportDisposer(retained)
    const unregister = registerLoadedExportDisposer(removed)

    unregister()
    unregister()
    await disposeLoadedExport()

    expect(removed).not.toHaveBeenCalled()
    expect(retained).toHaveBeenCalledOnce()
  })

  test('continues cleanup after one failure and preserves that exact error', async () => {
    const failure = new Error('prepared close failed')
    const activeExport = vi.fn(async () => undefined)
    registerLoadedExportDisposer(activeExport)
    registerLoadedExportDisposer(async () => { throw failure })

    await expect(disposeLoadedExport()).rejects.toBe(failure)

    expect(activeExport).toHaveBeenCalledOnce()
  })

  test('aggregates failures only after every owner has settled', async () => {
    const activeFailure = new Error('active export close failed')
    const preparedFailure = new Error('prepared close failed')
    const settled: string[] = []
    registerLoadedExportDisposer(async () => {
      settled.push('active')
      throw activeFailure
    })
    registerLoadedExportDisposer(async () => {
      settled.push('prepared')
      throw preparedFailure
    })

    const failure = await disposeLoadedExport().catch((cause: unknown) => cause)

    expect(settled).toEqual(['prepared', 'active'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      preparedFailure,
      activeFailure,
    ])
  })

  test('reset removes every registered owner for the next HMR generation', async () => {
    const dispose = vi.fn(async () => undefined)
    registerLoadedExportDisposer(dispose)

    resetLoadedExportDisposer()
    await disposeLoadedExport()

    expect(dispose).not.toHaveBeenCalled()
  })
})
