import { describe, expect, test, vi } from 'vitest'
import {
  createPluginSessionSafety,
  createStaleActivationAcknowledgement,
  PLUGIN_ACTIVATION_SENTINEL_KEY,
  readPluginStartupSafety,
  runPluginActivationBatch,
  type PluginActivationCoordinationLock,
  type PluginSafetyStorage,
} from './pluginSafetyController'

function storage(order: string[]): PluginSafetyStorage & {
  readonly values: Map<string, string>
} {
  const values = new Map<string, string>()
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      order.push('sentinel-written')
      values.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      order.push('sentinel-cleared')
      values.delete(key)
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function record(owners: ReadonlyArray<{ readonly ownerId: string; readonly batchId: string }>) {
  return JSON.stringify({
    version: 2,
    owners: [...owners].sort((left, right) => (
      left.ownerId < right.ownerId ? -1 : left.ownerId > right.ownerId ? 1 : 0
    )),
  })
}

function exclusiveLock(): PluginActivationCoordinationLock & {
  readonly heldDuringActivate: () => boolean
  markActivate(): void
} {
  let held = 0
  let heldDuringActivate = false
  return {
    heldDuringActivate: () => heldDuringActivate,
    markActivate() {
      heldDuringActivate = held > 0
    },
    async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
      if (held !== 0) throw new Error('activation record lock is not exclusive')
      held++
      try {
        return await work()
      } finally {
        held--
      }
    },
  }
}

function queueingLock(): PluginActivationCoordinationLock & {
  readonly isHeld: () => boolean
} {
  let chain = Promise.resolve()
  let held = 0
  return {
    isHeld: () => held > 0,
    async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
      const run = chain.then(async () => {
        held++
        try {
          return await work()
        } finally {
          held--
        }
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
  }
}

describe('plugin activation safety', () => {
  test('brackets successful third-party registration with a durable sentinel', async () => {
    const order: string[] = []
    const backing = storage(order)

    await expect(runPluginActivationBatch({
      storage: backing,
      ownerId: 'owner-1',
      batchId: 'batch-1',
      activate: async () => {
        order.push('activate')
        expect(backing.values.get(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(record([
          { ownerId: 'owner-1', batchId: 'batch-1' },
        ]))
        return 'ready'
      },
    })).resolves.toBe('ready')

    expect(order).toEqual(['sentinel-written', 'activate', 'sentinel-cleared'])
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
  })

  test('offers safe mode when the previous activation sentinel remains', () => {
    const backing = storage([])
    backing.values.set(
      PLUGIN_ACTIVATION_SENTINEL_KEY,
      JSON.stringify({ version: 1, batchId: 'crashed-batch' }),
    )

    const startupSafety = readPluginStartupSafety(backing)
    expect(startupSafety).toEqual({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'crashed-batch',
    })
    const sessionSafety = createPluginSessionSafety(startupSafety)
    expect(sessionSafety.startupMode()).toBe('review-required')
    expect(sessionSafety.isSafeMode()).toBe(false)
    expect(sessionSafety.thirdPartyInitializationAllowed()).toBe(false)

    expect(sessionSafety.continueWithReviewedNormalStartup()).toBe(true)
    expect(sessionSafety.startupMode()).toBe('normal')
    expect(sessionSafety.thirdPartyInitializationAllowed()).toBe(true)
  })

  test('offers safe mode when a multi-owner activation record remains', () => {
    const backing = storage([])
    backing.values.set(
      PLUGIN_ACTIVATION_SENTINEL_KEY,
      record([
        { ownerId: 'tab-b', batchId: 'batch-b' },
        { ownerId: 'tab-a', batchId: 'batch-a' },
      ]),
    )

    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'batch-a',
    })
  })

  test('fails safe when persisted activation sentinel data is invalid', () => {
    const backing = storage([])
    backing.values.set(PLUGIN_ACTIVATION_SENTINEL_KEY, '{broken')

    const startupSafety = readPluginStartupSafety(backing)
    expect(startupSafety).toEqual({
      status: 'invalid-sentinel',
      offerSafeMode: true,
    })
    const sessionSafety = createPluginSessionSafety(startupSafety)
    expect(sessionSafety.thirdPartyInitializationAllowed()).toBe(false)
    expect(sessionSafety.isSafeMode()).toBe(true)
    expect(sessionSafety.startupMode()).toBe('safe-mode')
    expect(sessionSafety.continueWithReviewedNormalStartup()).toBe(false)
  })

  test('fails safe when activation-sentinel storage is unavailable', () => {
    const unavailable: PluginSafetyStorage = {
      getItem: () => { throw new DOMException('denied', 'SecurityError') },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }

    expect(readPluginStartupSafety(unavailable)).toEqual({
      status: 'storage-unavailable',
      offerSafeMode: true,
    })
    const sessionSafety = createPluginSessionSafety(readPluginStartupSafety(unavailable))
    expect(sessionSafety.startupMode()).toBe('safe-mode')
    expect(sessionSafety.continueWithReviewedNormalStartup()).toBe(false)
  })

  test('safe mode suppresses third-party initialization for the complete session', () => {
    const safety = createPluginSessionSafety(readPluginStartupSafety(storage([])))
    expect(safety.startupMode()).toBe('normal')
    expect(safety.thirdPartyInitializationAllowed()).toBe(true)

    safety.enterSafeMode()

    expect(safety.thirdPartyInitializationAllowed()).toBe(false)
    expect(safety.isSafeMode()).toBe(true)
    expect(safety.continueWithReviewedNormalStartup()).toBe(false)
    expect(safety.startupMode()).toBe('safe-mode')
  })

  test('safe mode is a one-way choice from a stale activation review', () => {
    const safety = createPluginSessionSafety({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'crashed-batch',
    })

    safety.enterSafeMode()

    expect(safety.startupMode()).toBe('safe-mode')
    expect(safety.continueWithReviewedNormalStartup()).toBe(false)
    expect(safety.thirdPartyInitializationAllowed()).toBe(false)
  })

  test('rejects an unbounded activation id before touching durable storage', async () => {
    const backing = storage([])

    await expect(runPluginActivationBatch({
      storage: backing,
      batchId: 'x'.repeat(129),
      activate: vi.fn(),
    })).rejects.toThrow('must contain 1-128 characters')

    expect(backing.setItem).not.toHaveBeenCalled()
  })

  test('a successful peer cannot clear an interrupted origin activation owner', async () => {
    const backing = storage([])
    const startedA = deferred<void>()
    const holdB = deferred<string>()

    const finishedA = runPluginActivationBatch({
      storage: backing,
      ownerId: 'tab-a',
      batchId: 'batch-a',
      activate: async () => {
        startedA.resolve()
        return 'ready-a'
      },
    })
    const interruptedB = runPluginActivationBatch({
      storage: backing,
      ownerId: 'tab-b',
      batchId: 'batch-b',
      activate: async () => {
        await startedA.promise
        return holdB.promise
      },
    })

    await finishedA
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'batch-b',
    })
    expect(backing.values.get(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(record([
      { ownerId: 'tab-b', batchId: 'batch-b' },
    ]))

    holdB.resolve('ready-b')
    await expect(interruptedB).resolves.toBe('ready-b')
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'clean',
      offerSafeMode: false,
    })
  })

  test('a later success by the same owner clears its interrupted activation', async () => {
    const backing = storage([])

    await expect(runPluginActivationBatch({
      storage: backing,
      ownerId: 'tab-a',
      batchId: 'batch-1',
      activate: async () => {
        throw new Error('activation interrupted')
      },
    })).rejects.toThrow('activation interrupted')
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'batch-1',
    })

    await expect(runPluginActivationBatch({
      storage: backing,
      ownerId: 'tab-a',
      batchId: 'batch-2',
      activate: async () => 'ready',
    })).resolves.toBe('ready')
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'clean',
      offerSafeMode: false,
    })
  })

  test('a later success leaves a failed peer owner for next-launch review', async () => {
    const backing = storage([])
    const startedA = deferred<void>()

    const failedA = runPluginActivationBatch({
      storage: backing,
      ownerId: 'tab-a',
      batchId: 'batch-a',
      activate: async () => {
        startedA.resolve()
        throw new Error('activation interrupted')
      },
    })
    const finishedB = runPluginActivationBatch({
      storage: backing,
      ownerId: 'tab-b',
      batchId: 'batch-b',
      activate: async () => {
        await startedA.promise
        return 'ready-b'
      },
    })

    await expect(failedA).rejects.toThrow('activation interrupted')
    await expect(finishedB).resolves.toBe('ready-b')
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'batch-a',
    })
  })

  test('coordinates record mutations without holding the lock during activation', async () => {
    const backing = storage([])
    const lock = exclusiveLock()

    await expect(runPluginActivationBatch({
      storage: backing,
      ownerId: 'owner-1',
      batchId: 'batch-1',
      coordinationLock: lock,
      activate: async () => {
        lock.markActivate()
        return 'ready'
      },
    })).resolves.toBe('ready')

    expect(lock.heldDuringActivate()).toBe(false)
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
  })

  test('reviewed continue drops leftover owners so a later unique owner can proceed', async () => {
    const backing = storage([])
    backing.values.set(
      PLUGIN_ACTIVATION_SENTINEL_KEY,
      record(Array.from({ length: 32 }, (_, index) => ({
        ownerId: `leftover-${String(index)}`,
        batchId: `batch-${String(index)}`,
      }))),
    )
    const acknowledge = createStaleActivationAcknowledgement(backing)

    await expect(runPluginActivationBatch({
      storage: backing,
      ownerId: 'fresh',
      batchId: 'fresh-batch',
      activate: async () => 'ready',
    })).rejects.toThrow('Plugin activation owner limit exceeded')

    await acknowledge()
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)

    await expect(runPluginActivationBatch({
      storage: backing,
      ownerId: 'fresh',
      batchId: 'fresh-batch',
      activate: async () => 'ready',
    })).resolves.toBe('ready')
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'clean',
      offerSafeMode: false,
    })
  })

  test('reviewed continue keeps a live peer written after the leftover snapshot', async () => {
    const backing = storage([])
    backing.values.set(
      PLUGIN_ACTIVATION_SENTINEL_KEY,
      record([{ ownerId: 'crashed', batchId: 'crashed-batch' }]),
    )
    const acknowledge = createStaleActivationAcknowledgement(backing)
    const holdLive = deferred<string>()

    const live = runPluginActivationBatch({
      storage: backing,
      ownerId: 'tab-live',
      batchId: 'live-batch',
      activate: async () => holdLive.promise,
    })
    await vi.waitFor(() => {
      expect(backing.values.get(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(record([
        { ownerId: 'crashed', batchId: 'crashed-batch' },
        { ownerId: 'tab-live', batchId: 'live-batch' },
      ]))
    })

    await acknowledge()
    expect(backing.values.get(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(record([
      { ownerId: 'tab-live', batchId: 'live-batch' },
    ]))
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'live-batch',
    })

    holdLive.resolve('ready')
    await expect(live).resolves.toBe('ready')
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
  })

  test('reviewed continue clears a leftover v1 sentinel', async () => {
    const backing = storage([])
    backing.values.set(
      PLUGIN_ACTIVATION_SENTINEL_KEY,
      JSON.stringify({ version: 1, batchId: 'crashed-batch' }),
    )
    const acknowledge = createStaleActivationAcknowledgement(backing)

    await acknowledge()
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'clean',
      offerSafeMode: false,
    })
  })

  test('reviewed continue holds the activation lock across leftover read and write', async () => {
    const backing = storage([])
    backing.values.set(
      PLUGIN_ACTIVATION_SENTINEL_KEY,
      record([{ ownerId: 'crashed', batchId: 'crashed-batch' }]),
    )
    const lock = queueingLock()
    let getWhileHeld = false
    let removeWhileHeld = false
    const observing: PluginSafetyStorage = {
      getItem(key) {
        getWhileHeld = lock.isHeld()
        return backing.getItem(key)
      },
      setItem: (key, value) => backing.setItem(key, value),
      removeItem(key) {
        removeWhileHeld = lock.isHeld()
        backing.removeItem(key)
      },
    }

    await createStaleActivationAcknowledgement(observing, lock)()
    expect(getWhileHeld).toBe(true)
    expect(removeWhileHeld).toBe(true)
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
  })

  test('reviewed continue cannot wipe a live owner written during leftover acknowledgement', async () => {
    const backing = storage([])
    backing.values.set(
      PLUGIN_ACTIVATION_SENTINEL_KEY,
      record([{ ownerId: 'crashed', batchId: 'crashed-batch' }]),
    )
    const lock = queueingLock()
    const holdLive = deferred<string>()
    let peer: Promise<string> | undefined
    const racing: PluginSafetyStorage = {
      getItem(key) {
        const raw = backing.getItem(key)
        if (peer === undefined && raw !== null) {
          peer = runPluginActivationBatch({
            storage: backing,
            ownerId: 'tab-live',
            batchId: 'live-batch',
            coordinationLock: lock,
            activate: async () => holdLive.promise,
          })
        }
        return raw
      },
      setItem: (key, value) => backing.setItem(key, value),
      removeItem: (key) => backing.removeItem(key),
    }

    await createStaleActivationAcknowledgement(racing, lock)()
    expect(peer).toBeDefined()
    await vi.waitFor(() => {
      expect(backing.values.get(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(record([
        { ownerId: 'tab-live', batchId: 'live-batch' },
      ]))
    })

    holdLive.resolve('ready')
    await expect(peer).resolves.toBe('ready')
    expect(backing.values.has(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(false)
  })
})
