/**
 * Origin-local project capabilities and crash-recovery snapshots.
 *
 * A portable `.myrelith` file remains plain validated JSON. Opaque browser file
 * handles and recovery history live beside it in IndexedDB, never in domain or
 * Zustand state. The adapter boundary below also keeps storage deterministic in
 * tests without pretending that file handles are JSON-serializable.
 */

import {
  LEGACY_PROJECT_FILE_EXTENSION,
  parseProjectFile,
  PROJECT_FILE_EXTENSION,
  PROJECT_FILE_LIMITS,
} from '../domain/projectFile'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from '../domain/projectLimits'
import {
  legacyLocalProjectBindingId,
} from './localProjectProvenance'
import { isLocalProjectBindingId } from '../domain/localProjectBinding'

export const LOCAL_PROJECT_RECORD_VERSION = 1 as const

export interface LocalProjectStorageLimits {
  maxRecentProjects: number
  maxRecoveryGenerations: number
  maxRecoveryJournals: number
  maxRecoverySerializedCharacters: number
}

export const LOCAL_PROJECT_STORAGE_LIMITS: LocalProjectStorageLimits = {
  maxRecentProjects: 12,
  maxRecoveryGenerations: 3,
  maxRecoveryJournals: 8,
  maxRecoverySerializedCharacters: 30_000_000,
} as const

export type LocalProjectPermission = 'granted' | 'denied' | 'prompt'

interface LocalProjectPermissionDescriptor {
  mode: 'read'
}

export interface LocalProjectWritableFileStream {
  write(data: string): Promise<void>
  close(): Promise<void>
}

/** Structural subset shared by open-picker and save-picker project handles. */
export interface LocalProjectFileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<File>
  isSameEntry?(other: FileSystemHandle): Promise<boolean>
  createWritable?: () => Promise<LocalProjectWritableFileStream>
  queryPermission?: (
    descriptor?: LocalProjectPermissionDescriptor,
  ) => Promise<LocalProjectPermission>
  requestPermission?: (
    descriptor?: LocalProjectPermissionDescriptor,
  ) => Promise<LocalProjectPermission>
}

export interface LocalProjectSelection {
  file: File
  handle: LocalProjectFileHandle
}

export interface RecentProjectRecord {
  version: typeof LOCAL_PROJECT_RECORD_VERSION
  documentId: string
  projectName: string
  fileName: string
  lastOpenedAt: number
  handle: LocalProjectFileHandle
  /** Origin-local capability namespace; legacy raw records gain one on read. */
  projectBindingId: string
}

export interface RecoveryGeneration {
  snapshotId: string
  capturedAt: number
  serializedProject: string
}

export interface RecoveryJournalRecord {
  version: typeof LOCAL_PROJECT_RECORD_VERSION
  journalId: string
  documentId: string
  projectName: string
  projectFileName: string | null
  updatedAt: number
  generations: RecoveryGeneration[]
  /** Origin-local capability namespace; legacy raw records gain one on read. */
  projectBindingId: string
}

export interface RecoverySnapshotInput {
  journalId: string
  snapshotId: string
  documentId: string
  projectName: string
  projectFileName: string | null
  serializedProject: string
  /** Defaults to the adapter clock. Primarily injectable for deterministic tests. */
  capturedAt?: number
  projectBindingId: string
}

export interface LocalProjectStorage {
  listRecentProjects(): Promise<RecentProjectRecord[]>
  rememberRecentProject(record: RecentProjectRecord): Promise<void>
  forgetRecentProject(documentId: string): Promise<void>
  listRecoveryJournals(): Promise<RecoveryJournalRecord[]>
  getRecoveryJournal(journalId: string): Promise<RecoveryJournalRecord | null>
  appendRecoverySnapshot(
    input: RecoverySnapshotInput,
  ): Promise<RecoveryJournalRecord>
  deleteRecoveryJournal(journalId: string): Promise<void>
}

export type LocalProjectStoreName = 'recent-projects' | 'recovery-journals'

export interface LocalProjectStorageBackend {
  get(storeName: LocalProjectStoreName, key: string): Promise<unknown>
  getAll(storeName: LocalProjectStoreName): Promise<unknown[]>
  set(
    storeName: LocalProjectStoreName,
    key: string,
    value: unknown,
  ): Promise<void>
  delete(storeName: LocalProjectStoreName, key: string): Promise<void>
}

export interface MapLocalProjectStorageBackend extends LocalProjectStorageBackend {
  stores: Record<LocalProjectStoreName, Map<string, unknown>>
}

export interface LocalProjectStorageOptions {
  now?: () => number
  limits?: Partial<LocalProjectStorageLimits>
}

// This origin-local database name is a durable compatibility identifier.
// Keeping it lets an upgraded installation see Recents and recovery journals
// created before the Myrelith rebrand.
const DATABASE_NAME = 'webcut-local-projects'
const DATABASE_VERSION = 1
const RECENT_STORE = 'recent-projects' as const
const RECOVERY_STORE = 'recovery-journals' as const
const MAX_FILE_NAME_CHARACTERS = PROJECT_FILE_LIMITS.maxFileNameCharacters
const MAX_JOURNAL_ID_CHARACTERS = MAX_DOCUMENT_ID_CHARACTERS
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isBoundedString(
  value: unknown,
  maximumCharacters: number,
  allowEmpty = false,
): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximumCharacters
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_TIMESTAMP
}

function isProjectFileHandle(value: unknown): value is LocalProjectFileHandle {
  if (typeof value !== 'object' || value === null) return false
  if (!('kind' in value) || value.kind !== 'file') return false
  if (!('name' in value) || !isBoundedString(value.name, MAX_FILE_NAME_CHARACTERS)) {
    return false
  }
  if (!('getFile' in value) || typeof value.getFile !== 'function') return false
  if (
    'createWritable' in value
    && value.createWritable !== undefined
    && typeof value.createWritable !== 'function'
  ) {
    return false
  }
  if (
    'queryPermission' in value
    && value.queryPermission !== undefined
    && typeof value.queryPermission !== 'function'
  ) {
    return false
  }
  return !(
    'requestPermission' in value
    && value.requestPermission !== undefined
    && typeof value.requestPermission !== 'function'
  )
}

function normalizeRecentProject(value: unknown): RecentProjectRecord | null {
  if (!isRecord(value) || value.version !== LOCAL_PROJECT_RECORD_VERSION) {
    return null
  }
  if (!isBoundedString(value.documentId, MAX_DOCUMENT_ID_CHARACTERS)) return null
  if (!isBoundedString(value.projectName, MAX_PROJECT_NAME_CHARACTERS)) return null
  if (!isBoundedString(value.fileName, MAX_FILE_NAME_CHARACTERS)) return null
  if (!isTimestamp(value.lastOpenedAt)) return null
  if (!isProjectFileHandle(value.handle)) return null
  const projectBindingId = value.projectBindingId === undefined
    ? legacyLocalProjectBindingId(value.documentId)
    : isLocalProjectBindingId(value.projectBindingId)
      ? value.projectBindingId
      : null
  if (!projectBindingId) return null
  return {
    version: LOCAL_PROJECT_RECORD_VERSION,
    documentId: value.documentId,
    projectName: value.projectName,
    fileName: value.fileName,
    lastOpenedAt: value.lastOpenedAt,
    handle: value.handle,
    projectBindingId,
  }
}

function cloneRecoveryJournal(
  record: RecoveryJournalRecord,
): RecoveryJournalRecord {
  return {
    ...record,
    generations: record.generations.map((generation) => ({ ...generation })),
  }
}

function normalizeRecoveryGeneration(
  value: unknown,
  documentId: string,
): RecoveryGeneration | null {
  if (
    !isRecord(value)
    || !isBoundedString(value.snapshotId, MAX_JOURNAL_ID_CHARACTERS)
    || !isTimestamp(value.capturedAt)
  ) {
    return null
  }
  if (
    !isBoundedString(
      value.serializedProject,
      PROJECT_FILE_LIMITS.maxSerializedCharacters,
    )
  ) {
    return null
  }
  try {
    const project = parseProjectFile(value.serializedProject)
    if (project.document.id !== documentId) return null
  } catch {
    return null
  }
  return {
    snapshotId: value.snapshotId,
    capturedAt: value.capturedAt,
    serializedProject: value.serializedProject,
  }
}

function normalizeRecoveryJournal(
  value: unknown,
  maximumGenerations: number,
): RecoveryJournalRecord | null {
  if (!isRecord(value) || value.version !== LOCAL_PROJECT_RECORD_VERSION) {
    return null
  }
  if (!isBoundedString(value.journalId, MAX_JOURNAL_ID_CHARACTERS)) return null
  if (!isBoundedString(value.documentId, MAX_DOCUMENT_ID_CHARACTERS)) return null
  if (!isBoundedString(value.projectName, MAX_PROJECT_NAME_CHARACTERS)) return null
  if (
    value.projectFileName !== null
    && !isBoundedString(value.projectFileName, MAX_FILE_NAME_CHARACTERS)
  ) {
    return null
  }
  if (!isTimestamp(value.updatedAt) || !Array.isArray(value.generations)) return null
  if (value.generations.length === 0 || value.generations.length > maximumGenerations) {
    return null
  }

  const generations: RecoveryGeneration[] = []
  for (const candidate of value.generations) {
    const generation = normalizeRecoveryGeneration(candidate, value.documentId)
    // A partially corrupted newest entry must not hide an older complete
    // recovery point. IndexedDB writes are atomic, but this also makes manual
    // storage damage and future record migrations fail safely.
    if (!generation) continue
    const previous = generations.at(-1)
    if (previous && generation.capturedAt < previous.capturedAt) continue
    generations.push(generation)
  }
  const latest = generations.at(-1)
  if (!latest) return null
  let latestProjectName: string
  try {
    const latestProject = parseProjectFile(latest.serializedProject)
    latestProjectName = latestProject.document.name
  } catch {
    return null
  }

  const projectBindingId = value.projectBindingId === undefined
    ? legacyLocalProjectBindingId(value.documentId)
    : isLocalProjectBindingId(value.projectBindingId)
      ? value.projectBindingId
      : null
  if (!projectBindingId) return null

  return {
    version: LOCAL_PROJECT_RECORD_VERSION,
    journalId: value.journalId,
    documentId: value.documentId,
    projectName: latestProjectName,
    projectFileName: value.projectFileName,
    updatedAt: latest.capturedAt,
    generations,
    projectBindingId,
  }
}

function assertRecentProject(value: unknown): RecentProjectRecord {
  const record = normalizeRecentProject(value)
  if (!record) throw new TypeError('Recent project record is invalid')
  return record
}

function validateSnapshotInput(
  input: RecoverySnapshotInput,
  now: () => number,
): RecoverySnapshotInput & { capturedAt: number } {
  if (!isBoundedString(input.journalId, MAX_JOURNAL_ID_CHARACTERS)) {
    throw new TypeError('Recovery journal id is invalid')
  }
  if (!isBoundedString(input.snapshotId, MAX_JOURNAL_ID_CHARACTERS)) {
    throw new TypeError('Recovery snapshot id is invalid')
  }
  if (!isBoundedString(input.documentId, MAX_DOCUMENT_ID_CHARACTERS)) {
    throw new TypeError('Recovery document id is invalid')
  }
  if (!isBoundedString(input.projectName, MAX_PROJECT_NAME_CHARACTERS)) {
    throw new TypeError('Recovery project name is invalid')
  }
  if (
    input.projectFileName !== null
    && !isBoundedString(input.projectFileName, MAX_FILE_NAME_CHARACTERS)
  ) {
    throw new TypeError('Recovery project file name is invalid')
  }
  if (
    !isBoundedString(
      input.serializedProject,
      PROJECT_FILE_LIMITS.maxSerializedCharacters,
    )
  ) {
    throw new TypeError('Recovery project snapshot is invalid')
  }
  const capturedAt = input.capturedAt ?? now()
  if (!isTimestamp(capturedAt)) {
    throw new TypeError('Recovery snapshot timestamp is invalid')
  }
  const projectBindingId = input.projectBindingId
  if (!isLocalProjectBindingId(projectBindingId)) {
    throw new TypeError('Recovery project binding is invalid')
  }

  let project
  try {
    project = parseProjectFile(input.serializedProject)
  } catch (cause) {
    throw new TypeError('Recovery snapshot is not a portable Myrelith project', {
      cause,
    })
  }
  if (project.document.id !== input.documentId) {
    throw new TypeError('Recovery snapshot document id does not match its metadata')
  }
  if (project.document.name !== input.projectName) {
    throw new TypeError('Recovery snapshot project name does not match its metadata')
  }
  return { ...input, capturedAt, projectBindingId }
}

function recoveryCharacterCount(record: RecoveryJournalRecord): number {
  return record.generations.reduce(
    (total, generation) => total + generation.serializedProject.length,
    0,
  )
}

function descendingRecent(
  left: RecentProjectRecord,
  right: RecentProjectRecord,
): number {
  return right.lastOpenedAt - left.lastOpenedAt
    || left.documentId.localeCompare(right.documentId)
}

function descendingRecovery(
  left: RecoveryJournalRecord,
  right: RecoveryJournalRecord,
): number {
  return right.updatedAt - left.updatedAt
    || left.journalId.localeCompare(right.journalId)
}

function resolvedLimits(
  options: LocalProjectStorageOptions,
): LocalProjectStorageLimits {
  const limits = {
    ...LOCAL_PROJECT_STORAGE_LIMITS,
    ...options.limits,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  return limits
}

/**
 * Test seam backed by two ordinary Maps. Values deliberately stay `unknown`
 * so tests can seed malformed records and verify that the public adapter
 * rejects them safely.
 */
export function createMapLocalProjectStorageBackend(
  initial?: Partial<Record<LocalProjectStoreName, Map<string, unknown>>>,
): MapLocalProjectStorageBackend {
  const stores: Record<LocalProjectStoreName, Map<string, unknown>> = {
    [RECENT_STORE]: initial?.[RECENT_STORE] ?? new Map<string, unknown>(),
    [RECOVERY_STORE]: initial?.[RECOVERY_STORE] ?? new Map<string, unknown>(),
  }
  return {
    stores,
    async get(storeName, key) {
      return stores[storeName].get(key)
    },
    async getAll(storeName) {
      return [...stores[storeName].values()]
    },
    async set(storeName, key, value) {
      stores[storeName].set(key, value)
    },
    async delete(storeName, key) {
      stores[storeName].delete(key)
    },
  }
}

/** Build the race-safe, quota-bounded facade over an injected storage backend. */
export function createLocalProjectStorage(
  backend: LocalProjectStorageBackend,
  options: LocalProjectStorageOptions = {},
): LocalProjectStorage {
  const now = options.now ?? (() => Date.now())
  const limits = resolvedLimits(options)
  const tails = new Map<string, Promise<void>>()

  function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
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

  function withRecentKey<T>(
    documentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return enqueue(`recent:${documentId}`, () => (
      enqueue('recent:all', operation)
    ))
  }

  function withRecoveryKey<T>(
    journalId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return enqueue(`recovery:${journalId}`, () => (
      enqueue('recovery:all', operation)
    ))
  }

  async function readRecentProjects(): Promise<RecentProjectRecord[]> {
    const values = await backend.getAll(RECENT_STORE)
    return values
      .map(normalizeRecentProject)
      .filter((record): record is RecentProjectRecord => record !== null)
      .sort(descendingRecent)
  }

  async function readRecoveryJournals(): Promise<RecoveryJournalRecord[]> {
    const values = await backend.getAll(RECOVERY_STORE)
    return values
      .map((value) => normalizeRecoveryJournal(
        value,
        limits.maxRecoveryGenerations,
      ))
      .filter((record): record is RecoveryJournalRecord => record !== null)
      .sort(descendingRecovery)
  }

  async function pruneRecentProjects(): Promise<void> {
    const records = await readRecentProjects()
    await Promise.all(records
      .slice(limits.maxRecentProjects)
      .map((record) => backend.delete(RECENT_STORE, record.documentId)))
  }

  async function pruneRecoveryJournals(
    preferredJournalId: string,
  ): Promise<void> {
    const records = await readRecoveryJournals()
    records.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
      if (left.journalId === preferredJournalId) return -1
      if (right.journalId === preferredJournalId) return 1
      return left.journalId.localeCompare(right.journalId)
    })

    let keptJournals = 0
    let keptCharacters = 0
    const removals: Promise<void>[] = []
    for (const record of records) {
      const characters = recoveryCharacterCount(record)
      const fits = keptJournals < limits.maxRecoveryJournals
        && keptCharacters + characters
          <= limits.maxRecoverySerializedCharacters
      if (fits) {
        keptJournals++
        keptCharacters += characters
      } else {
        removals.push(backend.delete(RECOVERY_STORE, record.journalId))
      }
    }
    await Promise.all(removals)
  }

  return {
    listRecentProjects() {
      return enqueue('recent:all', readRecentProjects)
    },

    async rememberRecentProject(record) {
      const normalized = assertRecentProject(record)
      await withRecentKey(normalized.documentId, async () => {
        await backend.set(
          RECENT_STORE,
          normalized.documentId,
          normalized,
        )
        await pruneRecentProjects()
      })
    },

    forgetRecentProject(documentId) {
      if (!isBoundedString(documentId, MAX_DOCUMENT_ID_CHARACTERS)) {
        return Promise.reject(new TypeError('Recent project document id is invalid'))
      }
      return withRecentKey(documentId, () => (
        backend.delete(RECENT_STORE, documentId)
      ))
    },

    listRecoveryJournals() {
      return enqueue('recovery:all', async () => (
        (await readRecoveryJournals()).map(cloneRecoveryJournal)
      ))
    },

    getRecoveryJournal(journalId) {
      if (!isBoundedString(journalId, MAX_JOURNAL_ID_CHARACTERS)) {
        return Promise.resolve(null)
      }
      return withRecoveryKey(journalId, async () => {
        const value = await backend.get(RECOVERY_STORE, journalId)
        const record = normalizeRecoveryJournal(
          value,
          limits.maxRecoveryGenerations,
        )
        if (!record || record.journalId !== journalId) return null
        return cloneRecoveryJournal(record)
      })
    },

    async appendRecoverySnapshot(input) {
      const snapshot = validateSnapshotInput(input, now)
      return await withRecoveryKey(snapshot.journalId, async () => {
        const stored = normalizeRecoveryJournal(
          await backend.get(RECOVERY_STORE, snapshot.journalId),
          limits.maxRecoveryGenerations,
        )
        if (stored && stored.documentId !== snapshot.documentId) {
          throw new Error('Recovery journal belongs to a different document')
        }
        const previousGenerations = stored?.generations ?? []
        const previousTimestamp = previousGenerations.at(-1)?.capturedAt ?? 0
        const capturedAt = Math.max(snapshot.capturedAt, previousTimestamp)
        const generations = [
          ...previousGenerations,
          {
            snapshotId: snapshot.snapshotId,
            capturedAt,
            serializedProject: snapshot.serializedProject,
          },
        ].slice(-limits.maxRecoveryGenerations)
        const record: RecoveryJournalRecord = {
          version: LOCAL_PROJECT_RECORD_VERSION,
          journalId: snapshot.journalId,
          documentId: snapshot.documentId,
          projectName: snapshot.projectName,
          projectFileName: snapshot.projectFileName,
          updatedAt: capturedAt,
          generations,
          projectBindingId: snapshot.projectBindingId,
        }

        // One put stores the complete bounded generation array. IndexedDB
        // commits it atomically, so a failed/interrupted write leaves the
        // previously committed journal intact.
        await backend.set(RECOVERY_STORE, snapshot.journalId, record)
        await pruneRecoveryJournals(snapshot.journalId)
        return cloneRecoveryJournal(record)
      })
    },

    deleteRecoveryJournal(journalId) {
      if (!isBoundedString(journalId, MAX_JOURNAL_ID_CHARACTERS)) {
        return Promise.reject(new TypeError('Recovery journal id is invalid'))
      }
      return withRecoveryKey(journalId, () => (
        backend.delete(RECOVERY_STORE, journalId)
      ))
    },
  }
}

class IndexedDbLocalProjectStorageBackend implements LocalProjectStorageBackend {
  private database: Promise<IDBDatabase> | null = null

  get(storeName: LocalProjectStoreName, key: string): Promise<unknown> {
    return this.withStore(storeName, 'readonly', (store) => store.get(key))
  }

  getAll(storeName: LocalProjectStoreName): Promise<unknown[]> {
    return this.withStore(storeName, 'readonly', (store) => store.getAll())
  }

  async set(
    storeName: LocalProjectStoreName,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.withStore(storeName, 'readwrite', (store) => store.put(value, key))
  }

  async delete(storeName: LocalProjectStoreName, key: string): Promise<void> {
    await this.withStore(storeName, 'readwrite', (store) => store.delete(key))
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
        for (const storeName of [RECENT_STORE, RECOVERY_STORE]) {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName)
          }
        }
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(
        request.error ?? new Error('Could not open local project storage'),
      )
      request.onblocked = () => reject(
        new Error('Local project storage is blocked by another Myrelith tab'),
      )
    })
    void this.database.catch(() => {
      this.database = null
    })
    return this.database
  }

  private async withStore<T>(
    storeName: LocalProjectStoreName,
    mode: IDBTransactionMode,
    requestFor: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode)
      const request = requestFor(transaction.objectStore(storeName))
      let result: T
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => reject(
        request.error ?? new Error('Could not access local project storage'),
      )
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(
        transaction.error ?? new Error('Local project storage was aborted'),
      )
    })
  }
}

export const localProjectStorage = createLocalProjectStorage(
  new IndexedDbLocalProjectStorageBackend(),
)

interface LocalProjectOpenFilePickerOptions {
  id: string
  multiple: false
  excludeAcceptAllOption: boolean
  types: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

type LocalProjectPickerWindow = Window & {
  showOpenFilePicker?: (
    options: LocalProjectOpenFilePickerOptions,
  ) => Promise<LocalProjectFileHandle[]>
}

function pickerWindow(): LocalProjectPickerWindow | null {
  return typeof window === 'undefined'
    ? null
    : window as LocalProjectPickerWindow
}

export function supportsLocalProjectFiles(): boolean {
  return typeof pickerWindow()?.showOpenFilePicker === 'function'
}

export async function pickLocalProjectFile(): Promise<LocalProjectSelection> {
  const browserWindow = pickerWindow()
  const picker = browserWindow?.showOpenFilePicker
  if (!browserWindow || !picker) {
    throw new Error('This browser cannot remember local project files')
  }

  // Keep the picker invocation before the first await so it retains the
  // transient user activation from the Open/Resume click.
  const handles = await picker.call(browserWindow, {
    id: 'myrelith-project',
    multiple: false,
    excludeAcceptAllOption: true,
    types: [{
      description: 'Myrelith project',
      accept: {
        'application/json': [
          PROJECT_FILE_EXTENSION,
          LEGACY_PROJECT_FILE_EXTENSION,
        ],
      },
    }],
  })
  const handle = handles[0]
  if (!isProjectFileHandle(handle)) {
    throw new Error('The project picker did not return a readable file')
  }
  return {
    handle,
    file: await handle.getFile(),
  }
}

export function queryLocalProjectPermission(
  handle: LocalProjectFileHandle,
): Promise<LocalProjectPermission> {
  return handle.queryPermission?.({ mode: 'read' })
    ?? Promise.resolve('granted')
}

export function requestLocalProjectPermission(
  handle: LocalProjectFileHandle,
): Promise<LocalProjectPermission> {
  return handle.requestPermission?.({ mode: 'read' })
    ?? Promise.resolve('granted')
}

export function isLocalProjectPickerCancellation(cause: unknown): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && cause.name === 'AbortError'
}
