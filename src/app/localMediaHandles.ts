/**
 * Browser-local media capabilities.
 *
 * Portable project files keep durable metadata only. Chromium file handles
 * are opaque, origin-local capabilities, so they live in IndexedDB and are
 * keyed by the stable document + asset ids instead of entering Zustand or
 * the serialized `.webcut` contract.
 */

export type LocalMediaPermission = 'granted' | 'denied' | 'prompt'

interface LocalMediaPermissionDescriptor {
  mode: 'read'
}

export type LocalMediaFileHandle = FileSystemFileHandle & {
  queryPermission?: (
    descriptor?: LocalMediaPermissionDescriptor,
  ) => Promise<LocalMediaPermission>
  requestPermission?: (
    descriptor?: LocalMediaPermissionDescriptor,
  ) => Promise<LocalMediaPermission>
}

export interface LocalMediaSelection {
  file: File
  handle: LocalMediaFileHandle
}

interface LocalOpenFilePickerOptions {
  id?: string
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

type LocalMediaPickerWindow = Window & {
  showOpenFilePicker?: (
    options?: LocalOpenFilePickerOptions,
  ) => Promise<LocalMediaFileHandle[]>
}

export interface LocalMediaHandleStore {
  get(key: string): Promise<unknown>
  set(key: string, value: LocalMediaFileHandle): Promise<void>
  delete(key: string): Promise<void>
}

export interface LocalMediaHandleRegistry {
  load(documentId: string, assetId: string): Promise<LocalMediaFileHandle | null>
  remember(
    documentId: string,
    assetId: string,
    handle: LocalMediaFileHandle,
  ): Promise<void>
  forget(documentId: string, assetId: string): Promise<void>
}

const DATABASE_NAME = 'webcut-local-media'
const DATABASE_VERSION = 1
const STORE_NAME = 'file-handles'

function registryKey(documentId: string, assetId: string): string {
  return JSON.stringify([documentId, assetId])
}

function isFileHandle(value: unknown): value is LocalMediaFileHandle {
  return typeof value === 'object'
    && value !== null
    && 'kind' in value
    && value.kind === 'file'
    && 'name' in value
    && typeof value.name === 'string'
    && 'getFile' in value
    && typeof value.getFile === 'function'
}

export function createLocalMediaHandleRegistry(
  store: LocalMediaHandleStore,
): LocalMediaHandleRegistry {
  const tails = new Map<string, Promise<void>>()

  function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // IndexedDB requests are individually atomic, but a late put could still
    // overtake a later forget at the app layer. One non-rejecting tail per
    // key preserves call order while allowing unrelated assets to proceed in
    // parallel. The final action for a document+asset pair therefore wins.
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }

  return {
    async load(documentId, assetId) {
      const key = registryKey(documentId, assetId)
      const value = await enqueue(key, () => store.get(key))
      return isFileHandle(value) ? value : null
    },
    remember(documentId, assetId, handle) {
      const key = registryKey(documentId, assetId)
      return enqueue(key, () => store.set(key, handle))
    },
    forget(documentId, assetId) {
      const key = registryKey(documentId, assetId)
      return enqueue(key, () => store.delete(key))
    },
  }
}

class IndexedDbMediaHandleStore implements LocalMediaHandleStore {
  private database: Promise<IDBDatabase> | null = null

  get(key: string): Promise<unknown> {
    return this.withStore('readonly', (store) => store.get(key))
  }

  async set(key: string, value: LocalMediaFileHandle): Promise<void> {
    await this.withStore('readwrite', (store) => store.put(value, key))
  }

  async delete(key: string): Promise<void> {
    await this.withStore('readwrite', (store) => store.delete(key))
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable in this browser'))
        return
      }
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(
        request.error ?? new Error('Could not open the local media registry'),
      )
      request.onblocked = () => reject(
        new Error('The local media registry is blocked by another WebCut tab'),
      )
    })
    void this.database.catch(() => {
      this.database = null
    })
    return this.database
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    requestFor: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode)
      const request = requestFor(transaction.objectStore(STORE_NAME))
      let result: T
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => reject(
        request.error ?? new Error('Could not access remembered media'),
      )
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(
        transaction.error ?? new Error('Remembered media access was aborted'),
      )
    })
  }
}

export const localMediaHandleRegistry = createLocalMediaHandleRegistry(
  new IndexedDbMediaHandleStore(),
)

function pickerWindow(): LocalMediaPickerWindow {
  return window as LocalMediaPickerWindow
}

export function supportsLocalMediaHandles(): boolean {
  return typeof pickerWindow().showOpenFilePicker === 'function'
}

export async function pickLocalMediaFiles(
  multiple: boolean,
): Promise<LocalMediaSelection[]> {
  const picker = pickerWindow().showOpenFilePicker
  if (!picker) throw new Error('This browser cannot remember local media files')

  // This picker call must remain before the first await so transient user
  // activation from the button click is still available.
  const handles = await picker.call(window, {
    id: 'webcut-media',
    multiple,
    excludeAcceptAllOption: false,
    types: [{
      description: 'Video and audio',
      accept: {
        'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.m4v'],
        'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
      },
    }],
  })
  return Promise.all(handles.map(async (handle) => ({
    handle,
    file: await handle.getFile(),
  })))
}

export function queryLocalMediaPermission(
  handle: LocalMediaFileHandle,
): Promise<LocalMediaPermission> {
  return handle.queryPermission?.({ mode: 'read' })
    ?? Promise.resolve('granted')
}

export function requestLocalMediaPermission(
  handle: LocalMediaFileHandle,
): Promise<LocalMediaPermission> {
  return handle.requestPermission?.({ mode: 'read' })
    ?? Promise.resolve('granted')
}

export function isLocalMediaPickerCancellation(cause: unknown): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && cause.name === 'AbortError'
}
