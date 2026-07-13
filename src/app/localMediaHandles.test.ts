import { describe, expect, test, vi } from 'vitest'
import {
  createLocalMediaHandleRegistry,
  queryLocalMediaPermission,
  requestLocalMediaPermission,
  type LocalMediaFileHandle,
  type LocalMediaHandleStore,
} from './localMediaHandles'

function makeHandle(name = 'source.mp4'): LocalMediaFileHandle {
  return {
    kind: 'file',
    name,
    getFile: vi.fn(async () => new File(['source'], name)),
    isSameEntry: vi.fn(async () => false),
  } as unknown as LocalMediaFileHandle
}

function makeStore(): LocalMediaHandleStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    },
  }
}

describe('local media handle registry', () => {
  test('scopes opaque handles by document and stable asset id', async () => {
    const store = makeStore()
    const registry = createLocalMediaHandleRegistry(store)
    const first = makeHandle('first.mp4')
    const second = makeHandle('second.mp4')

    await registry.remember('doc-a', 'asset-1', first)
    await registry.remember('doc-b', 'asset-1', second)

    await expect(registry.load('doc-a', 'asset-1')).resolves.toBe(first)
    await expect(registry.load('doc-b', 'asset-1')).resolves.toBe(second)
    await expect(registry.load('doc-a', 'asset-2')).resolves.toBeNull()

    await registry.forget('doc-a', 'asset-1')
    await expect(registry.load('doc-a', 'asset-1')).resolves.toBeNull()
    await expect(registry.load('doc-b', 'asset-1')).resolves.toBe(second)
  })

  test('rejects malformed IndexedDB values instead of trusting them as handles', async () => {
    const store = makeStore()
    const registry = createLocalMediaHandleRegistry(store)
    store.values.set(JSON.stringify(['doc-a', 'asset-1']), {
      kind: 'file',
      name: 'not-callable.mp4',
      getFile: 'broken',
    })

    await expect(registry.load('doc-a', 'asset-1')).resolves.toBeNull()
  })

  test('serializes one key so a later forget wins over a pending remember', async () => {
    const store = makeStore()
    let releaseWrite!: () => void
    const writeCanFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    store.set = vi.fn(async (key, value) => {
      await writeCanFinish
      store.values.set(key, value)
    })
    store.delete = vi.fn(async (key) => {
      store.values.delete(key)
    })
    const registry = createLocalMediaHandleRegistry(store)

    const remember = registry.remember('doc-a', 'asset-1', makeHandle())
    const forget = registry.forget('doc-a', 'asset-1')
    expect(store.delete).not.toHaveBeenCalled()

    releaseWrite()
    await Promise.all([remember, forget])

    expect(store.set).toHaveBeenCalledOnce()
    expect(store.delete).toHaveBeenCalledOnce()
    await expect(registry.load('doc-a', 'asset-1')).resolves.toBeNull()
  })

  test('queries or requests read permission and supports older granted handles', async () => {
    const modern = makeHandle()
    modern.queryPermission = vi.fn(async () => 'prompt' as const)
    modern.requestPermission = vi.fn(async () => 'granted' as const)

    await expect(queryLocalMediaPermission(modern)).resolves.toBe('prompt')
    await expect(requestLocalMediaPermission(modern)).resolves.toBe('granted')
    expect(modern.queryPermission).toHaveBeenCalledWith({ mode: 'read' })
    expect(modern.requestPermission).toHaveBeenCalledWith({ mode: 'read' })

    const legacy = makeHandle()
    await expect(queryLocalMediaPermission(legacy)).resolves.toBe('granted')
    await expect(requestLocalMediaPermission(legacy)).resolves.toBe('granted')
  })
})
