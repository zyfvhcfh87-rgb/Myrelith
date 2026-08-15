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

    expect(readPluginStartupSafety(backing)).toEqual({
      status: 'stale-activation',
      offerSafeMode: true,
      batchId: 'crashed-batch',
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
  })

  test('safe mode suppresses third-party initialization for the complete session', () => {
    const safety = createPluginSessionSafety(readPluginStartupSafety(storage([])))
    expect(safety.thirdPartyInitializationAllowed()).toBe(true)

    safety.enterSafeMode()

    expect(safety.thirdPartyInitializationAllowed()).toBe(false)
    expect(safety.isSafeMode()).toBe(true)
  })
})
