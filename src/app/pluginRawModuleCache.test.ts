import { describe, expect, test } from 'vitest'
import {
  PLUGIN_RAW_MODULE_MAX_BYTES,
  createPluginRawModuleCache,
  type PluginRawModuleCacheKey,
} from './pluginRawModuleCache'

function key(
  pluginId: string,
  moduleSha256 = 'sha256:module',
  overrides: Partial<PluginRawModuleCacheKey> = {},
): PluginRawModuleCacheKey {
  return {
    pluginId,
    pluginVersion: '1.0.0',
    packageDigest: 'sha256:package',
    signerFingerprint: 'sha256:signer',
    modulePath: 'runtime/plugin.wasm',
    moduleSha256,
    moduleByteLength: 3,
    hostApiVersion: 1,
    selectedCapabilities: [{ id: 'myrelith.effect.video-frame.rgba8', version: 1 }],
    memoryMaximumPages: 258,
    policy: { binaryPolicyVersion: 1, profileId: 'myrelith-wasm-render-general-v1' },
    opcodeTableDigest: 'sha256:table',
    contributionIdentityKey: 'contributions-v1',
    ...overrides,
  }
}

describe('plugin raw-module cache', () => {
  test('copies on insertion and every read', () => {
    const cache = createPluginRawModuleCache()
    const source = Uint8Array.of(1, 2, 3)
    expect(cache.put(key('com.example.effect'), source)).toBe(true)
    source[0] = 99

    const first = cache.get(key('com.example.effect'))!
    first[1] = 88
    expect([...cache.get(key('com.example.effect'))!]).toEqual([1, 2, 3])
  })

  test('uses deterministic LRU eviction at eight entries', () => {
    const cache = createPluginRawModuleCache()
    for (let index = 0; index < 8; index++) {
      cache.put(key(`com.example.${index}`, undefined, { moduleByteLength: 1 }), Uint8Array.of(index))
    }
    expect(cache.get(key('com.example.0', undefined, { moduleByteLength: 1 }))).toBeDefined()
    cache.put(key('com.example.8', undefined, { moduleByteLength: 1 }), Uint8Array.of(8))

    expect(cache.get(key('com.example.1', undefined, { moduleByteLength: 1 }))).toBeUndefined()
    expect(cache.get(key('com.example.0', undefined, { moduleByteLength: 1 }))).toBeDefined()
    expect(cache.getSnapshot()).toMatchObject({ entryCount: 8, evictionCount: 1 })
  })

  test('bypasses an empty or oversized raw module without retaining it', () => {
    const cache = createPluginRawModuleCache()
    expect(cache.put(key('empty'), new Uint8Array())).toBe(false)
    expect(cache.put(key('large', undefined, {
      moduleByteLength: PLUGIN_RAW_MODULE_MAX_BYTES + 1,
    }), new Uint8Array(PLUGIN_RAW_MODULE_MAX_BYTES + 1))).toBe(false)
    expect(cache.getSnapshot()).toEqual({
      entryCount: 0,
      byteLength: 0,
      bypassCount: 2,
      evictionCount: 0,
    })
  })

  test('isolates exact activation identities and invalidates one plugin only', () => {
    const cache = createPluginRawModuleCache()
    cache.put(key('one', 'sha256:a', { moduleByteLength: 1 }), Uint8Array.of(1))
    cache.put(key('one', 'sha256:b', { moduleByteLength: 1 }), Uint8Array.of(2))
    cache.put(key('two', 'sha256:c', { moduleByteLength: 1 }), Uint8Array.of(3))

    cache.invalidatePlugin('one')
    expect(cache.get(key('one', 'sha256:a', { moduleByteLength: 1 }))).toBeUndefined()
    expect(cache.get(key('one', 'sha256:b', { moduleByteLength: 1 }))).toBeUndefined()
    expect([...cache.get(key('two', 'sha256:c', { moduleByteLength: 1 }))!]).toEqual([3])
  })

  test('isolates identical bytes at different normalized signed module paths', () => {
    const cache = createPluginRawModuleCache()
    const bytes = Uint8Array.of(1, 2, 3)
    cache.put(key('path', undefined, { modulePath: 'runtime/one.wasm' }), bytes)
    cache.put(key('path', undefined, { modulePath: 'runtime/two.wasm' }), bytes)

    expect(cache.getSnapshot().entryCount).toBe(2)
    expect(cache.get(key('path', undefined, { modulePath: 'runtime/one.wasm' }))).toBeDefined()
    expect(cache.get(key('path', undefined, { modulePath: 'runtime/two.wasm' }))).toBeDefined()
  })

  test('rejects a signed expanded-length mismatch without disturbing the exact entry', () => {
    const cache = createPluginRawModuleCache()
    const exact = key('length')
    expect(cache.put(exact, Uint8Array.of(1, 2, 3))).toBe(true)
    expect(cache.put(key('length', undefined, { moduleByteLength: 4 }), Uint8Array.of(1, 2, 3)))
      .toBe(false)

    expect([...cache.get(exact)!]).toEqual([1, 2, 3])
    expect(cache.getSnapshot()).toMatchObject({ entryCount: 1, bypassCount: 1 })
  })

  test('normalizes the complete selected capability order in the exact key', () => {
    const cache = createPluginRawModuleCache()
    const frame = { id: 'myrelith.effect.video-frame.rgba8', version: 1 }
    const second = { id: 'myrelith.example.second', version: 2 }
    cache.put(key('capabilities', undefined, {
      selectedCapabilities: [second, frame],
    }), Uint8Array.of(1, 2, 3))

    expect(cache.get(key('capabilities', undefined, {
      selectedCapabilities: [frame, second],
    }))).toBeDefined()
    expect(cache.getSnapshot().entryCount).toBe(1)
  })
})
