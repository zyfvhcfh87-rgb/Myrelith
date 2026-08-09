/**
 * Browser-local media capabilities.
 *
 * Portable project files keep durable metadata only. Chromium file handles
 * are opaque, origin-local capabilities, so they live in IndexedDB and are
 * keyed by the stable document + asset ids instead of entering Zustand or
 * the serialized `.myrelith` contract.
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

/** Structural Chrome directory handle; kept app-local like file handles. */
export interface LocalMediaDirectoryHandle {
  readonly kind: 'directory'
  readonly name: string
  values(): AsyncIterableIterator<
    LocalMediaFileHandle | LocalMediaDirectoryHandle
  >
}

export interface LocalMediaFolderSelection {
  file: File
  /** Null for a one-session folder input that must not be remembered. */
  handle: LocalMediaFileHandle | null
  /** Forward-slash path relative to the chosen folder, for display only. */
  relativePath: string
}

export interface LocalMediaFolderLimits {
  maxDepth: number
  maxDirectories: number
  maxEntries: number
  maxFiles: number
  maxRelativePathCharacters: number
}

export const LOCAL_MEDIA_FOLDER_LIMITS: LocalMediaFolderLimits = {
  maxDepth: 20,
  maxDirectories: 512,
  maxEntries: 10_000,
  maxFiles: 5_000,
  maxRelativePathCharacters: 4_096,
}

export class LocalMediaFolderTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalMediaFolderTraversalError'
  }
}

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v'] as const
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'] as const
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.avif'] as const
const SUPPORTED_MEDIA_EXTENSIONS = new Set<string>([
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
])

export const MEDIA_FILE_INPUT_ACCEPT = [
  'video/*',
  'audio/*',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
].join(',')

interface LocalOpenFilePickerOptions {
  id?: string
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

interface LocalDirectoryPickerOptions {
  id?: string
  mode?: 'read'
}

type LocalMediaPickerWindow = Window & {
  showOpenFilePicker?: (
    options?: LocalOpenFilePickerOptions,
  ) => Promise<LocalMediaFileHandle[]>
  showDirectoryPicker?: (
    options?: LocalDirectoryPickerOptions,
  ) => Promise<LocalMediaDirectoryHandle>
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

// Stable legacy database identity: changing it would orphan remembered grants.
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
        new Error('The local media registry is blocked by another Myrelith tab'),
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

export function supportsLocalMediaFolders(): boolean {
  return typeof pickerWindow().showDirectoryPicker === 'function'
}

export async function pickLocalMediaFiles(
  multiple: boolean,
): Promise<LocalMediaSelection[]> {
  const picker = pickerWindow().showOpenFilePicker
  if (!picker) throw new Error('This browser cannot remember local media files')

  // This picker call must remain before the first await so transient user
  // activation from the button click is still available.
  const handles = await picker.call(window, {
    id: 'myrelith-media',
    multiple,
    excludeAcceptAllOption: false,
    types: [{
      description: 'Video, audio, and still images',
      accept: {
        'video/*': [...VIDEO_EXTENSIONS],
        'audio/*': [...AUDIO_EXTENSIONS],
        'image/png': ['.png'],
        'image/jpeg': ['.jpg', '.jpeg'],
        'image/webp': ['.webp'],
        'image/avif': ['.avif'],
      },
    }],
  })
  return Promise.all(handles.map(async (handle) => ({
    handle,
    file: await handle.getFile(),
  })))
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function resolveFolderLimits(
  overrides: Partial<LocalMediaFolderLimits>,
): LocalMediaFolderLimits {
  const limits: LocalMediaFolderLimits = {
    ...LOCAL_MEDIA_FOLDER_LIMITS,
    ...overrides,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!isPositiveSafeInteger(value)) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  return limits
}

function isSupportedMediaName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && SUPPORTED_MEDIA_EXTENSIONS.has(
    name.slice(dot).toLowerCase(),
  )
}

/**
 * Normalize a native directory-input FileList without manufacturing reusable
 * handles. The same traversal bounds as remembered folders apply.
 */
export function localMediaFolderSelectionsFromFiles(
  files: readonly File[],
  limitOverrides: Partial<LocalMediaFolderLimits> = {},
): LocalMediaFolderSelection[] {
  const limits = resolveFolderLimits(limitOverrides)
  if (files.length > limits.maxEntries) {
    throw new LocalMediaFolderTraversalError(
      `Folder relink is limited to ${limits.maxEntries} entries`,
    )
  }
  const selections: LocalMediaFolderSelection[] = []
  for (const file of files) {
    if (!isSupportedMediaName(file.name)) continue
    if (selections.length >= limits.maxFiles) {
      throw new LocalMediaFolderTraversalError(
        `Folder relink is limited to ${limits.maxFiles} media files`,
      )
    }
    const relativePath = file.webkitRelativePath || file.name
    if (relativePath.length > limits.maxRelativePathCharacters) {
      throw new LocalMediaFolderTraversalError(
        'A selected folder path is too long',
      )
    }
    for (const segment of relativePath.split('/')) assertSafeEntryName(segment)
    selections.push({ file, handle: null, relativePath })
  }
  return selections.toSorted(compareRelativePath)
}

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    throw new LocalMediaFolderTraversalError(
      'The selected folder contains an unsafe entry name',
    )
  }
}

function compareRelativePath(
  left: LocalMediaFolderSelection,
  right: LocalMediaFolderSelection,
): number {
  if (left.relativePath < right.relativePath) return -1
  if (left.relativePath > right.relativePath) return 1
  return 0
}

/**
 * Recursively enumerate a previously granted folder without leaking its path
 * into domain/state. Unsupported extensions are skipped before `getFile()`.
 */
export async function enumerateLocalMediaFolder(
  root: LocalMediaDirectoryHandle,
  limitOverrides: Partial<LocalMediaFolderLimits> = {},
): Promise<LocalMediaFolderSelection[]> {
  const limits = resolveFolderLimits(limitOverrides)
  const selections: LocalMediaFolderSelection[] = []
  const visitedDirectories = new Set<LocalMediaDirectoryHandle>()
  let directoryCount = 0
  let entryCount = 0

  async function visit(
    directory: LocalMediaDirectoryHandle,
    parentPath: string,
    depth: number,
  ): Promise<void> {
    if (
      typeof directory !== 'object'
      || directory === null
      || directory.kind !== 'directory'
      || typeof directory.name !== 'string'
      || typeof directory.values !== 'function'
    ) {
      throw new LocalMediaFolderTraversalError(
        'The selected folder contains an unreadable directory',
      )
    }
    if (visitedDirectories.has(directory)) {
      throw new LocalMediaFolderTraversalError(
        'The selected folder contains a directory cycle',
      )
    }
    visitedDirectories.add(directory)
    directoryCount++
    if (directoryCount > limits.maxDirectories) {
      throw new LocalMediaFolderTraversalError(
        `Folder import is limited to ${limits.maxDirectories} directories`,
      )
    }

    for await (const entry of directory.values()) {
      entryCount++
      if (entryCount > limits.maxEntries) {
        throw new LocalMediaFolderTraversalError(
          `Folder import is limited to ${limits.maxEntries} entries`,
        )
      }
      if (
        typeof entry !== 'object'
        || entry === null
        || typeof entry.name !== 'string'
      ) {
        throw new LocalMediaFolderTraversalError(
          'The selected folder contains an unreadable entry',
        )
      }
      assertSafeEntryName(entry.name)
      const relativePath = parentPath
        ? `${parentPath}/${entry.name}`
        : entry.name
      if (relativePath.length > limits.maxRelativePathCharacters) {
        throw new LocalMediaFolderTraversalError(
          `Folder paths are limited to ${limits.maxRelativePathCharacters} characters`,
        )
      }

      if (entry.kind === 'directory') {
        if (depth >= limits.maxDepth) {
          throw new LocalMediaFolderTraversalError(
            `Folder import is limited to ${limits.maxDepth} nested levels`,
          )
        }
        await visit(entry, relativePath, depth + 1)
        continue
      }
      if (entry.kind !== 'file' || typeof entry.getFile !== 'function') {
        throw new LocalMediaFolderTraversalError(
          'The selected folder contains an unreadable file',
        )
      }
      if (!isSupportedMediaName(entry.name)) continue
      if (selections.length >= limits.maxFiles) {
        throw new LocalMediaFolderTraversalError(
          `Folder import is limited to ${limits.maxFiles} media files`,
        )
      }
      selections.push({
        file: await entry.getFile(),
        handle: entry,
        relativePath,
      })
    }
  }

  await visit(root, '', 0)
  return selections.sort(compareRelativePath)
}

export async function pickLocalMediaFolder(
  limitOverrides: Partial<LocalMediaFolderLimits> = {},
): Promise<LocalMediaFolderSelection[]> {
  const picker = pickerWindow().showDirectoryPicker
  if (!picker) throw new Error('This browser cannot choose a local media folder')

  // This picker call must remain before the first await so transient user
  // activation from the button click is still available.
  const directory = await picker.call(window, {
    id: 'myrelith-media-folder',
    mode: 'read',
  })
  return enumerateLocalMediaFolder(directory, limitOverrides)
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
