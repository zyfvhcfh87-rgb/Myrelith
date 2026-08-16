import { describe, expect, test, vi } from 'vitest'
import {
  createPluginSessionSafety,
  PLUGIN_ACTIVATION_SENTINEL_KEY,
  readPluginStartupSafety,
  runPluginActivationBatch,
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

describe('plugin activation safety', () => {
  test('brackets successful third-party registration with a durable sentinel', async () => {
    const order: string[] = []
    const backing = storage(order)

    await expect(runPluginActivationBatch({
      storage: backing,
      batchId: 'batch-1',
      activate: async () => {
        order.push('activate')
        expect(backing.values.get(PLUGIN_ACTIVATION_SENTINEL_KEY)).toBe(
          JSON.stringify({ version: 1, batchId: 'batch-1' }),
        )
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
})
