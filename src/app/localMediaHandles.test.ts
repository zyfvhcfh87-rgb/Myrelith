import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createLocalMediaHandleRegistry,
  enumerateLocalMediaFolder,
  isLocalMediaPickerCancellation,
  LocalMediaFolderTraversalError,
  pickLocalMediaFolder,
  queryLocalMediaPermission,
  requestLocalMediaPermission,
  supportsLocalMediaFolders,
  type LocalMediaDirectoryHandle,
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

function makeDirectory(
  name: string,
  entries: Array<LocalMediaFileHandle | LocalMediaDirectoryHandle>,
): LocalMediaDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const entry of entries) yield entry
    },
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'showDirectoryPicker')
})

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

describe('local media folder picker', () => {
  test('recursively returns supported files in deterministic relative-path order', async () => {
    const unsupported = makeHandle('notes.txt')
    const upperCaseVideo = makeHandle('TRAILER.MP4')
    const nestedAudio = makeHandle('voice.wav')
    const nestedVideo = makeHandle('clip.mov')
    const root = makeDirectory('media', [
      upperCaseVideo,
      makeDirectory('z-folder', [nestedAudio]),
      unsupported,
      makeDirectory('a-folder', [nestedVideo]),
    ])

    const selections = await enumerateLocalMediaFolder(root)

    expect(selections.map((selection) => selection.relativePath)).toEqual([
      'TRAILER.MP4',
      'a-folder/clip.mov',
      'z-folder/voice.wav',
    ])
    expect(selections.map((selection) => selection.handle)).toEqual([
      upperCaseVideo,
      nestedVideo,
      nestedAudio,
    ])
    expect(unsupported.getFile).not.toHaveBeenCalled()
  })

  test('bounds total entries and media files instead of silently truncating', async () => {
    const root = makeDirectory('media', [
      makeHandle('one.mp4'),
      makeHandle('two.mp4'),
      makeHandle('three.mp4'),
    ])

    await expect(enumerateLocalMediaFolder(root, { maxEntries: 2 }))
      .rejects.toThrow('limited to 2 entries')
    await expect(enumerateLocalMediaFolder(root, { maxFiles: 2 }))
      .rejects.toThrow('limited to 2 media files')
  })

  test('bounds recursion depth and rejects directory cycles', async () => {
    const tooDeep = makeDirectory('root', [
      makeDirectory('one', [
        makeDirectory('two', [makeHandle('deep.mp4')]),
      ]),
    ])
    await expect(enumerateLocalMediaFolder(tooDeep, { maxDepth: 1 }))
      .rejects.toBeInstanceOf(LocalMediaFolderTraversalError)
    await expect(enumerateLocalMediaFolder(tooDeep, { maxDepth: 1 }))
      .rejects.toThrow('limited to 1 nested levels')

    const cycle = makeDirectory('cycle', [])
    cycle.values = async function * cycleValues() {
      yield cycle
    }
    await expect(enumerateLocalMediaFolder(cycle)).rejects.toThrow(
      'directory cycle',
    )
  })

  test('invokes the Chrome folder picker and leaves cancellation distinguishable', async () => {
    const root = makeDirectory('media', [makeHandle('source.webm')])
    const picker = vi.fn(async () => root)
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: picker,
    })

    expect(supportsLocalMediaFolders()).toBe(true)
    await expect(pickLocalMediaFolder()).resolves.toMatchObject([{
      relativePath: 'source.webm',
    }])
    expect(picker).toHaveBeenCalledWith({
      id: 'webcut-media-folder',
      mode: 'read',
    })

    const cancellation = new DOMException('cancelled', 'AbortError')
    picker.mockRejectedValueOnce(cancellation)
    let caught: unknown
    try {
      await pickLocalMediaFolder()
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBe(cancellation)
    expect(isLocalMediaPickerCancellation(caught)).toBe(true)
  })
})
