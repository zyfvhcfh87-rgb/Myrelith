/** Origin-local, transactional plugin package storage. Never import from project state. */

import { PLUGIN_MANIFEST_LIMITS } from '../domain/pluginManifest'
import { PLUGIN_PACKAGE_LIMITS } from './pluginPackage'
import {
  PLUGIN_DIAGNOSTIC_CODES,
  PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
  PLUGIN_REGISTRY_LIMITS,
  isSha256Identity,
  type InstalledPluginRecord,
  type PluginActivationState,
  type PluginDiagnosticCode,
  type PluginDiagnosticEvent,
  type PluginPermissionGrant,
  type PluginTrustDecision,
  type PersistedPluginTrustPolicy,
  type PluginTrustPolicyStore,
} from './pluginTrustRegistry'

const DATABASE_NAME = 'myrelith-local-plugins'
const DATABASE_VERSION = 3
const STORE_NAME = 'installations'
const TRUST_POLICY_STORE_NAME = 'trust-policy'
const MANAGEMENT_STORE_NAME = 'management'
const TRUST_POLICY_KEY = 'current'
const MANAGEMENT_GENERATION_KEY = 'catalog-generation'
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

const RECORD_KEYS = [
  'schemaVersion',
  'revision',
  'pluginId',
  'name',
  'catalogContributionCount',
  'version',
  'packageDigest',
  'signerFingerprint',
  'modulePath',
  'moduleSha256',
  'moduleByteLength',
  'installedAt',
  'updatedAt',
  'activationState',
  'trust',
  'grants',
  'diagnostics',
  'archiveBytes',
] as const
const TRUST_KEYS = ['kind', 'trustedAt'] as const
const GRANT_KEYS = [
  'id',
  'minVersion',
  'maxVersion',
  'required',
  'negotiatedVersion',
  'grantedAt',
  'pluginId',
  'signerFingerprint',
  'packageDigest',
] as const
const DIAGNOSTIC_KEYS = ['code', 'occurredAt'] as const
const ACTIVATION_STATES = new Set<PluginActivationState>([
  'enabled',
  'disabled',
  'quarantined',
  'revoked',
])
const DIAGNOSTIC_CODES = new Set<PluginDiagnosticCode>(PLUGIN_DIAGNOSTIC_CODES)
const BARE_SHA256 = /^[0-9a-f]{64}$/
const PLUGIN_ID = /^(?:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u
const CAPABILITY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/u
const PACKAGE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export class LocalPluginStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPluginStorageError'
  }
}

export interface LocalPluginStorageBackend {
  getWithGeneration(pluginId: string): Promise<RawPluginRecordSnapshot>
  listWithGeneration(): Promise<RawPluginCatalogSnapshot>
  getGeneration(): Promise<unknown>
  compareAndSwap(
    pluginId: string,
    expected: PluginStorageRevision | null,
    next: InstalledPluginRecord,
    catalogAffecting: boolean,
  ): Promise<boolean>
  removeIf(
    pluginId: string,
    expected: PluginStorageRevision,
    catalogAffecting: boolean,
  ): Promise<boolean>
}

export interface RawPluginRecordSnapshot {
  readonly generation: unknown
  readonly value: unknown
}

export interface RawPluginCatalogSnapshot {
  readonly generation: unknown
  readonly values: readonly unknown[]
}

export interface PluginStorageRevision {
  readonly packageDigest: string
  readonly revision: number
}

export interface PluginRecordSnapshot {
  readonly generation: number
  readonly record: InstalledPluginRecord | null
}

export interface PluginCatalogStorageSnapshot {
  readonly generation: number
  readonly records: readonly InstalledPluginRecord[]
}

export interface LocalPluginStorage {
  load(pluginId: string): Promise<InstalledPluginRecord | null>
  list(): Promise<readonly InstalledPluginRecord[]>
  loadSnapshot(pluginId: string): Promise<PluginRecordSnapshot>
  catalogSnapshot(): Promise<PluginCatalogStorageSnapshot>
  generation(): Promise<number>
  replace(
    pluginId: string,
    expected: PluginStorageRevision | null,
    next: InstalledPluginRecord,
    catalogAffecting?: boolean,
  ): Promise<boolean>
  remove(
    pluginId: string,
    expected: PluginStorageRevision,
    catalogAffecting?: boolean,
  ): Promise<boolean>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseManagementGeneration(value: unknown): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LocalPluginStorageError('Plugin management generation is invalid')
  }
  return value as number
}

function nextManagementGeneration(value: unknown): number {
  const generation = parseManagementGeneration(value)
  if (generation === Number.MAX_SAFE_INTEGER) {
    throw new LocalPluginStorageError('Plugin management generation is exhausted')
  }
  return generation + 1
}

function versionNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= PLUGIN_MANIFEST_LIMITS.maxApiVersion
}

function parseTrust(value: unknown): PluginTrustDecision | null {
  if (!isRecord(value) || !hasExactKeys(value, TRUST_KEYS)) return null
  if ((value.kind !== 'built-in' && value.kind !== 'user') || !timestamp(value.trustedAt)) {
    return null
  }
  return Object.freeze({ kind: value.kind, trustedAt: value.trustedAt })
}

function parseGrant(value: unknown, record: {
  readonly pluginId: string
  readonly signerFingerprint: string
  readonly packageDigest: string
}): PluginPermissionGrant | null {
  if (!isRecord(value) || !hasExactKeys(value, GRANT_KEYS)) return null
  if (!boundedString(value.id, 1, PLUGIN_MANIFEST_LIMITS.maxPluginIdCharacters)
    || !CAPABILITY_ID.test(value.id)
    || !versionNumber(value.minVersion)
    || !versionNumber(value.maxVersion)
    || value.minVersion > value.maxVersion
    || typeof value.required !== 'boolean'
    || !versionNumber(value.negotiatedVersion)
    || value.negotiatedVersion < value.minVersion
    || value.negotiatedVersion > value.maxVersion
    || !timestamp(value.grantedAt)
    || value.pluginId !== record.pluginId
    || value.signerFingerprint !== record.signerFingerprint
    || value.packageDigest !== record.packageDigest
    || !isSha256Identity(value.signerFingerprint)
    || !isSha256Identity(value.packageDigest)) {
    return null
  }
  return Object.freeze({
    id: value.id,
    minVersion: value.minVersion,
    maxVersion: value.maxVersion,
    required: value.required,
    negotiatedVersion: value.negotiatedVersion,
    grantedAt: value.grantedAt,
    pluginId: value.pluginId,
    signerFingerprint: value.signerFingerprint,
    packageDigest: value.packageDigest,
  })
}

function parseDiagnostic(value: unknown): PluginDiagnosticEvent | null {
  if (!isRecord(value) || !hasExactKeys(value, DIAGNOSTIC_KEYS)) return null
  if (typeof value.code !== 'string'
    || !DIAGNOSTIC_CODES.has(value.code as PluginDiagnosticCode)
    || !timestamp(value.occurredAt)) return null
  return Object.freeze({
    code: value.code as PluginDiagnosticCode,
    occurredAt: value.occurredAt,
  })
}

export function parseInstalledPluginRecord(value: unknown): InstalledPluginRecord {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) {
    throw new LocalPluginStorageError('Stored plugin record has an invalid shape')
  }
  if (value.schemaVersion !== PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || !boundedString(value.pluginId, 1, PLUGIN_MANIFEST_LIMITS.maxPluginIdCharacters)
    || !PLUGIN_ID.test(value.pluginId)
    || !boundedString(value.name, 1, PLUGIN_MANIFEST_LIMITS.maxNameCharacters)
    || !Number.isSafeInteger(value.catalogContributionCount)
    || (value.catalogContributionCount as number) < 0
    || (value.catalogContributionCount as number) > PLUGIN_MANIFEST_LIMITS.maxContributions
    || !boundedString(value.version, 1, PLUGIN_MANIFEST_LIMITS.maxVersionCharacters)
    || !SEMVER.test(value.version)
    || !isSha256Identity(value.packageDigest)
    || !isSha256Identity(value.signerFingerprint)
    || !boundedString(value.modulePath, 1, PLUGIN_MANIFEST_LIMITS.maxEntryPathCharacters)
    || value.modulePath.startsWith('/')
    || !value.modulePath.endsWith('.wasm')
    || value.modulePath.includes('\\')
    || value.modulePath.split('/').some(
      (segment) => segment === '.' || segment === '..' || !PACKAGE_PATH_SEGMENT.test(segment),
    )
    || typeof value.moduleSha256 !== 'string'
    || !BARE_SHA256.test(value.moduleSha256)
    || !Number.isSafeInteger(value.moduleByteLength)
    || (value.moduleByteLength as number) <= 0
    || (value.moduleByteLength as number) > PLUGIN_PACKAGE_LIMITS.maxExpandedEntryBytes
    || !timestamp(value.installedAt)
    || !timestamp(value.updatedAt)
    || value.updatedAt < value.installedAt
    || typeof value.activationState !== 'string'
    || !ACTIVATION_STATES.has(value.activationState as PluginActivationState)
    || !Array.isArray(value.grants)
    || value.grants.length > PLUGIN_MANIFEST_LIMITS.maxPermissions
    || !Array.isArray(value.diagnostics)
    || value.diagnostics.length > PLUGIN_REGISTRY_LIMITS.maxDiagnosticsPerPlugin
    || !(value.archiveBytes instanceof Uint8Array)
    || value.archiveBytes.byteLength === 0
    || value.archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new LocalPluginStorageError('Stored plugin record failed bounded validation')
  }
  const trust = parseTrust(value.trust)
  if (!trust) throw new LocalPluginStorageError('Stored plugin trust decision is invalid')
  const identity = {
    pluginId: value.pluginId,
    signerFingerprint: value.signerFingerprint,
    packageDigest: value.packageDigest,
  }
  const grants = value.grants.map((grant) => parseGrant(grant, identity))
  if (grants.some((grant) => grant === null)) {
    throw new LocalPluginStorageError('Stored plugin permission grant is invalid')
  }
  if (new Set(grants.map((grant) => grant?.id)).size !== grants.length) {
    throw new LocalPluginStorageError('Stored plugin permission grants contain duplicate ids')
  }
  const diagnostics = value.diagnostics.map(parseDiagnostic)
  if (diagnostics.some((event) => event === null)) {
    throw new LocalPluginStorageError('Stored plugin diagnostic is invalid')
  }
  const record: InstalledPluginRecord = {
    schemaVersion: PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
    revision: value.revision as number,
    pluginId: value.pluginId,
    name: value.name,
    catalogContributionCount: value.catalogContributionCount as number,
    version: value.version,
    packageDigest: value.packageDigest,
    signerFingerprint: value.signerFingerprint,
    modulePath: value.modulePath,
    moduleSha256: value.moduleSha256,
    moduleByteLength: value.moduleByteLength as number,
    installedAt: value.installedAt,
    updatedAt: value.updatedAt,
    activationState: value.activationState as PluginActivationState,
    trust,
    grants: Object.freeze(grants as PluginPermissionGrant[]),
    diagnostics: Object.freeze(diagnostics as PluginDiagnosticEvent[]),
    archiveBytes: value.archiveBytes.slice(),
  }
  return Object.freeze(record)
}

function cloneRecord(record: InstalledPluginRecord): InstalledPluginRecord {
  return parseInstalledPluginRecord({
    ...record,
    trust: { ...record.trust },
    grants: record.grants.map((grant) => ({ ...grant })),
    diagnostics: record.diagnostics.map((event) => ({ ...event })),
    archiveBytes: record.archiveBytes.slice(),
  })
}

export function createLocalPluginStorage(backend: LocalPluginStorageBackend): LocalPluginStorage {
  const tails = new Map<string, Promise<void>>()

  function enqueue<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(pluginId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    tails.set(pluginId, tail)
    void tail.then(() => {
      if (tails.get(pluginId) === tail) tails.delete(pluginId)
    })
    return result
  }

  function parseRecordSnapshot(
    pluginId: string,
    snapshot: RawPluginRecordSnapshot,
  ): PluginRecordSnapshot {
    const generation = parseManagementGeneration(snapshot.generation)
    if (snapshot.value === undefined) return Object.freeze({ generation, record: null })
    const record = parseInstalledPluginRecord(snapshot.value)
    if (record.pluginId !== pluginId) {
      throw new LocalPluginStorageError('Stored plugin key does not match the record id')
    }
    return Object.freeze({ generation, record })
  }

  function parseCatalogSnapshot(snapshot: RawPluginCatalogSnapshot): PluginCatalogStorageSnapshot {
    const generation = parseManagementGeneration(snapshot.generation)
    if (snapshot.values.length > PLUGIN_REGISTRY_LIMITS.maxInstalledPlugins) {
      throw new LocalPluginStorageError('The local plugin registry exceeds its entry limit')
    }
    const records = snapshot.values.map(parseInstalledPluginRecord)
    const ids = new Set(records.map((record) => record.pluginId))
    const aggregateBytes = records.reduce((sum, record) => sum + record.archiveBytes.byteLength, 0)
    const aggregateContributions = records.reduce(
      (sum, record) => sum + record.catalogContributionCount,
      0,
    )
    if (ids.size !== records.length
      || aggregateBytes > PLUGIN_REGISTRY_LIMITS.maxAggregateArchiveBytes
      || aggregateContributions > PLUGIN_REGISTRY_LIMITS.maxAggregateContributions) {
      throw new LocalPluginStorageError('The local plugin registry failed aggregate validation')
    }
    return Object.freeze({ generation, records: Object.freeze(records) })
  }

  return {
    async loadSnapshot(pluginId) {
      const snapshot = await enqueue(pluginId, () => backend.getWithGeneration(pluginId))
      return parseRecordSnapshot(pluginId, snapshot)
    },
    async load(pluginId) {
      const snapshot = await enqueue(pluginId, () => backend.getWithGeneration(pluginId))
      const { record } = parseRecordSnapshot(pluginId, snapshot)
      return record
    },
    async catalogSnapshot() {
      return parseCatalogSnapshot(await backend.listWithGeneration())
    },
    async generation() {
      return parseManagementGeneration(await backend.getGeneration())
    },
    async list() {
      return (await this.catalogSnapshot()).records
    },
    replace(pluginId, expected, next, catalogAffecting = true) {
      return enqueue(pluginId, async () => {
        if (pluginId !== next.pluginId) {
          throw new LocalPluginStorageError('Plugin registry key does not match the record id')
        }
        const retained = cloneRecord(next)
        return backend.compareAndSwap(pluginId, expected, retained, catalogAffecting)
      })
    },
    remove(pluginId, expected, catalogAffecting = true) {
      return enqueue(pluginId, () => backend.removeIf(pluginId, expected, catalogAffecting))
    },
  }
}

let pluginDatabase: Promise<IDBDatabase> | null = null

function openPluginDatabase(): Promise<IDBDatabase> {
  if (pluginDatabase) return pluginDatabase
  pluginDatabase = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new LocalPluginStorageError('IndexedDB is unavailable in this browser'))
      return
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
      if (!request.result.objectStoreNames.contains(TRUST_POLICY_STORE_NAME)) {
        request.result.createObjectStore(TRUST_POLICY_STORE_NAME)
      }
      if (!request.result.objectStoreNames.contains(MANAGEMENT_STORE_NAME)) {
        request.result.createObjectStore(MANAGEMENT_STORE_NAME)
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        pluginDatabase = null
      }
      resolve(database)
    }
    request.onerror = () => reject(
      request.error ?? new LocalPluginStorageError('Could not open the local plugin registry'),
    )
    request.onblocked = () => reject(
      new LocalPluginStorageError('The local plugin registry is blocked by another tab'),
    )
  })
  void pluginDatabase.catch(() => { pluginDatabase = null })
  return pluginDatabase
}

class IndexedDbPluginStorageBackend implements LocalPluginStorageBackend {
  async getGeneration(): Promise<unknown> {
    const database = await openPluginDatabase()
    return new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(MANAGEMENT_STORE_NAME, 'readonly')
      const request = transaction
        .objectStore(MANAGEMENT_STORE_NAME)
        .get(MANAGEMENT_GENERATION_KEY)
      let generation: unknown
      request.onsuccess = () => { generation = request.result }
      request.onerror = () => reject(
        request.error ?? new LocalPluginStorageError('Plugin generation read failed'),
      )
      transaction.oncomplete = () => resolve(generation)
      transaction.onabort = () => reject(
        transaction.error ?? new LocalPluginStorageError('Plugin generation read aborted'),
      )
    })
  }

  async getWithGeneration(pluginId: string): Promise<RawPluginRecordSnapshot> {
    const database = await openPluginDatabase()
    return new Promise<RawPluginRecordSnapshot>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, MANAGEMENT_STORE_NAME], 'readonly')
      const valueRequest = transaction.objectStore(STORE_NAME).get(pluginId)
      const generationRequest = transaction
        .objectStore(MANAGEMENT_STORE_NAME)
        .get(MANAGEMENT_GENERATION_KEY)
      let value: unknown
      let generation: unknown
      valueRequest.onsuccess = () => { value = valueRequest.result }
      generationRequest.onsuccess = () => { generation = generationRequest.result }
      valueRequest.onerror = () => reject(
        valueRequest.error ?? new LocalPluginStorageError('Plugin registry read failed'),
      )
      generationRequest.onerror = () => reject(
        generationRequest.error ?? new LocalPluginStorageError('Plugin generation read failed'),
      )
      transaction.oncomplete = () => resolve({ value, generation })
      transaction.onabort = () => reject(
        transaction.error ?? new LocalPluginStorageError('Plugin registry read aborted'),
      )
    })
  }

  async listWithGeneration(): Promise<RawPluginCatalogSnapshot> {
    const database = await openPluginDatabase()
    return new Promise<RawPluginCatalogSnapshot>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, MANAGEMENT_STORE_NAME], 'readonly')
      const valuesRequest = transaction.objectStore(STORE_NAME).getAll()
      const generationRequest = transaction
        .objectStore(MANAGEMENT_STORE_NAME)
        .get(MANAGEMENT_GENERATION_KEY)
      let values: readonly unknown[] = []
      let generation: unknown
      valuesRequest.onsuccess = () => { values = valuesRequest.result }
      generationRequest.onsuccess = () => { generation = generationRequest.result }
      valuesRequest.onerror = () => reject(
        valuesRequest.error ?? new LocalPluginStorageError('Plugin registry read failed'),
      )
      generationRequest.onerror = () => reject(
        generationRequest.error ?? new LocalPluginStorageError('Plugin generation read failed'),
      )
      transaction.oncomplete = () => resolve({ values, generation })
      transaction.onabort = () => reject(
        transaction.error ?? new LocalPluginStorageError('Plugin registry read aborted'),
      )
    })
  }

  async compareAndSwap(
    pluginId: string,
    expected: PluginStorageRevision | null,
    next: InstalledPluginRecord,
    catalogAffecting: boolean,
  ): Promise<boolean> {
    const database = await openPluginDatabase()
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(
        [STORE_NAME, MANAGEMENT_STORE_NAME],
        'readwrite',
      )
      const store = transaction.objectStore(STORE_NAME)
      const read = store.getAll()
      const generationStore = transaction.objectStore(MANAGEMENT_STORE_NAME)
      const generationRead = generationStore.get(MANAGEMENT_GENERATION_KEY)
      let committed = false
      let recordsReady = false
      let generationReady = false
      const commitIfReady = () => {
        if (!recordsReady || !generationReady) return
        try {
          const records = read.result.map(parseInstalledPluginRecord)
          const current = records.find((record) => record.pluginId === pluginId)
          if ((current?.packageDigest ?? null) !== (expected?.packageDigest ?? null)
            || (current?.revision ?? null) !== (expected?.revision ?? null)) return
          const retained = records.filter((record) => record.pluginId !== pluginId)
          if (retained.length + 1 > PLUGIN_REGISTRY_LIMITS.maxInstalledPlugins) {
            throw new LocalPluginStorageError('The local plugin registry entry limit was reached')
          }
          const aggregateBytes = retained.reduce(
            (sum, record) => sum + record.archiveBytes.byteLength,
            next.archiveBytes.byteLength,
          )
          if (aggregateBytes > PLUGIN_REGISTRY_LIMITS.maxAggregateArchiveBytes) {
            throw new LocalPluginStorageError('The local plugin registry byte limit was reached')
          }
          const aggregateContributions = retained.reduce(
            (sum, record) => sum + record.catalogContributionCount,
            next.catalogContributionCount,
          )
          if (aggregateContributions > PLUGIN_REGISTRY_LIMITS.maxAggregateContributions) {
            throw new LocalPluginStorageError('The plugin declaration catalog limit was reached')
          }
          store.put(cloneRecord(next), pluginId)
          if (catalogAffecting) {
            generationStore.put(
              nextManagementGeneration(generationRead.result),
              MANAGEMENT_GENERATION_KEY,
            )
          }
          committed = true
        } catch (cause) {
          transaction.abort()
          reject(cause)
        }
      }
      read.onsuccess = () => {
        recordsReady = true
        commitIfReady()
      }
      generationRead.onsuccess = () => {
        generationReady = true
        commitIfReady()
      }
      read.onerror = () => reject(read.error ?? new LocalPluginStorageError('Plugin registry read failed'))
      generationRead.onerror = () => reject(
        generationRead.error ?? new LocalPluginStorageError('Plugin generation read failed'),
      )
      transaction.oncomplete = () => resolve(committed)
      transaction.onabort = () => reject(
        transaction.error ?? new LocalPluginStorageError('Plugin registry transaction aborted'),
      )
    })
  }

  async removeIf(
    pluginId: string,
    expected: PluginStorageRevision,
    catalogAffecting: boolean,
  ): Promise<boolean> {
    const database = await openPluginDatabase()
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(
        [STORE_NAME, MANAGEMENT_STORE_NAME],
        'readwrite',
      )
      const store = transaction.objectStore(STORE_NAME)
      const read = store.get(pluginId)
      const generationStore = transaction.objectStore(MANAGEMENT_STORE_NAME)
      const generationRead = generationStore.get(MANAGEMENT_GENERATION_KEY)
      let removed = false
      let recordReady = false
      let generationReady = false
      const removeIfReady = () => {
        if (!recordReady || !generationReady) return
        try {
          if (read.result === undefined) return
          const current = parseInstalledPluginRecord(read.result)
          if (current.packageDigest !== expected.packageDigest
            || current.revision !== expected.revision) return
          store.delete(pluginId)
          if (catalogAffecting) {
            generationStore.put(
              nextManagementGeneration(generationRead.result),
              MANAGEMENT_GENERATION_KEY,
            )
          }
          removed = true
        } catch (cause) {
          transaction.abort()
          reject(cause)
        }
      }
      read.onsuccess = () => {
        recordReady = true
        removeIfReady()
      }
      generationRead.onsuccess = () => {
        generationReady = true
        removeIfReady()
      }
      read.onerror = () => reject(read.error ?? new LocalPluginStorageError('Plugin registry read failed'))
      generationRead.onerror = () => reject(
        generationRead.error ?? new LocalPluginStorageError('Plugin generation read failed'),
      )
      transaction.oncomplete = () => resolve(removed)
      transaction.onabort = () => reject(
        transaction.error ?? new LocalPluginStorageError('Plugin registry transaction aborted'),
      )
    })
  }

}

class IndexedDbPluginTrustPolicyStore implements PluginTrustPolicyStore {
  async load(): Promise<unknown> {
    const database = await openPluginDatabase()
    return new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(TRUST_POLICY_STORE_NAME, 'readonly')
      const request = transaction.objectStore(TRUST_POLICY_STORE_NAME).get(TRUST_POLICY_KEY)
      let result: unknown
      request.onsuccess = () => { result = request.result }
      request.onerror = () => reject(
        request.error ?? new LocalPluginStorageError('Plugin trust policy read failed'),
      )
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(
        transaction.error ?? new LocalPluginStorageError('Plugin trust policy read aborted'),
      )
    })
  }

  async compareAndSwap(
    expectedRevision: number | null,
    next: PersistedPluginTrustPolicy,
  ): Promise<boolean> {
    const database = await openPluginDatabase()
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(
        [TRUST_POLICY_STORE_NAME, MANAGEMENT_STORE_NAME],
        'readwrite',
      )
      const store = transaction.objectStore(TRUST_POLICY_STORE_NAME)
      const request = store.get(TRUST_POLICY_KEY)
      const generationStore = transaction.objectStore(MANAGEMENT_STORE_NAME)
      const generationRequest = generationStore.get(MANAGEMENT_GENERATION_KEY)
      let committed = false
      let policyReady = false
      let generationReady = false
      const commitIfReady = () => {
        if (!policyReady || !generationReady) return
        try {
          const value = request.result as { revision?: unknown } | undefined
          const actualRevision = value === undefined ? 0 : value.revision
          if (actualRevision !== expectedRevision) return
          store.put(next, TRUST_POLICY_KEY)
          generationStore.put(
            nextManagementGeneration(generationRequest.result),
            MANAGEMENT_GENERATION_KEY,
          )
          committed = true
        } catch (cause) {
          transaction.abort()
          reject(cause)
        }
      }
      request.onsuccess = () => {
        policyReady = true
        commitIfReady()
      }
      generationRequest.onsuccess = () => {
        generationReady = true
        commitIfReady()
      }
      request.onerror = () => reject(
        request.error ?? new LocalPluginStorageError('Plugin trust policy read failed'),
      )
      generationRequest.onerror = () => reject(
        generationRequest.error ?? new LocalPluginStorageError('Plugin generation read failed'),
      )
      transaction.oncomplete = () => resolve(committed)
      transaction.onabort = () => reject(
        transaction.error ?? new LocalPluginStorageError('Plugin trust policy update aborted'),
      )
    })
  }
}

export const localPluginStorage = createLocalPluginStorage(
  new IndexedDbPluginStorageBackend(),
)

export const localPluginTrustPolicyStore: PluginTrustPolicyStore =
  new IndexedDbPluginTrustPolicyStore()
