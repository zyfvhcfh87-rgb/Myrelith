import {
  MAX_PROXY_CACHE_ENTRIES,
  PROXY_CACHE_SCHEMA_VERSION,
  isProxyCacheFileName,
  parseProxyCacheManifest,
  proxyCacheByteSize,
  type ProxyCacheEntry,
  type ProxyCacheManifest,
} from '../domain/proxyCache'
import type { PreparedExportFileCapability } from '../pipeline/export-file-target'

const CACHE_ROOT_DIRECTORY = 'myrelith-derived'
const PROXY_DIRECTORY = 'proxy-cache-v1'
const MANIFEST_FILE = 'manifest.json'
const MAX_ORIGIN_USAGE_RATIO = 0.8
const MIN_QUOTA_HEADROOM_BYTES = 64 * 1024 * 1024

export interface ProxyStorageEstimate {
  readonly cacheBytes: number
  readonly itemCount: number
  readonly originUsageBytes: number | null
  readonly originQuotaBytes: number | null
  readonly persisted: boolean | null
}

export interface ProxyStorageDeps {
  getRoot(): Promise<FileSystemDirectoryHandle>
  estimate(): Promise<StorageEstimate>
  persisted(): Promise<boolean>
  now(): number
  createToken(): string
}

export interface ProxyStorageEntryCommit {
  /** Keep the committed entry and reclaim only the bytes it replaced. */
  finalize(): Promise<void>
  /** Restore the prior manifest entry and delete the unaccepted output bytes. */
  rollback(): Promise<void>
}

const realDeps: ProxyStorageDeps = {
  getRoot: () => navigator.storage.getDirectory(),
  estimate: () => navigator.storage.estimate(),
  persisted: () => navigator.storage.persisted(),
  now: () => Date.now(),
  createToken: () => crypto.randomUUID().replaceAll('-', ''),
}

export class ProxyStorageUnavailableError extends Error {
  constructor(message = 'Origin-private file storage is unavailable in this browser') {
    super(message)
    this.name = 'ProxyStorageUnavailableError'
  }
}

export class ProxyQuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyQuotaError'
  }
}

function emptyManifest(): ProxyCacheManifest {
  return { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries: [] }
}

function notFound(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'NotFoundError'
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export class ProxyStorage {
  private readonly deps: ProxyStorageDeps
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(deps: ProxyStorageDeps = realDeps) {
    this.deps = deps
  }

  supported(): boolean {
    return typeof navigator !== 'undefined'
      && typeof navigator.storage?.getDirectory === 'function'
  }

  private async directory(create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!this.supported() && this.deps === realDeps) {
      throw new ProxyStorageUnavailableError()
    }
    const root = await this.deps.getRoot()
    const derived = await root.getDirectoryHandle(CACHE_ROOT_DIRECTORY, { create })
    return derived.getDirectoryHandle(PROXY_DIRECTORY, { create })
  }

  async readManifest(): Promise<ProxyCacheManifest> {
    let directory: FileSystemDirectoryHandle
    try {
      directory = await this.directory(false)
    } catch (cause) {
      if (notFound(cause)) return emptyManifest()
      throw cause
    }
    try {
      const handle = await directory.getFileHandle(MANIFEST_FILE)
      const file = await handle.getFile()
      if (file.size > 2 * 1024 * 1024) {
        throw new TypeError('Proxy cache manifest exceeds the 2 MiB safety limit')
      }
      return parseProxyCacheManifest(JSON.parse(await file.text()))
    } catch (cause) {
      if (notFound(cause)) return emptyManifest()
      throw new TypeError(`Could not read the proxy cache manifest: ${errorMessage(cause)}`)
    }
  }

  private async writeManifest(manifest: ProxyCacheManifest): Promise<void> {
    const directory = await this.directory(true)
    const handle = await directory.getFileHandle(MANIFEST_FILE, { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    try {
      await writable.write(JSON.stringify(manifest))
      await writable.close()
    } catch (cause) {
      try {
        await writable.abort(cause)
      } catch {
        // Preserve the manifest write failure; the previous committed file is intact.
      }
      throw cause
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private mutate(
    mutation: (manifest: ProxyCacheManifest) => Promise<ProxyCacheManifest>,
    afterCommit?: (
      previous: ProxyCacheManifest,
      committed: ProxyCacheManifest,
    ) => Promise<void>,
  ): Promise<void> {
    return this.serialize(async () => {
      const current = await this.readManifest()
      const next = await mutation(current)
      const validated = parseProxyCacheManifest(next)
      await this.writeManifest(validated)
      await afterCommit?.(current, validated)
    })
  }

  async prepareFileCapability(cacheKey: string): Promise<PreparedExportFileCapability> {
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
      throw new TypeError('Invalid proxy cache key')
    }
    const directory = await this.directory(true)
    const token = this.deps.createToken()
    if (!/^[a-f0-9]{32}$/.test(token)) {
      throw new TypeError('Invalid proxy staging token')
    }
    const fileName = `${cacheKey}.${token}.mp4`
    const handle = await directory.getFileHandle(fileName, { create: true })
    let taken = false
    return {
      fileName,
      takeFileHandle() {
        if (taken) throw new Error('Proxy output file capability was already consumed')
        taken = true
        return handle
      },
    }
  }

  async commitEntry(entry: ProxyCacheEntry): Promise<ProxyStorageEntryCommit> {
    parseProxyCacheManifest({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      entries: [entry],
    })
    const obsoleteFiles = new Set<string>()
    const replacedEntries: ProxyCacheEntry[] = []
    await this.mutate(async (manifest) => {
      const entries = manifest.entries.filter((candidate) => (
        candidate.assetId !== entry.assetId && candidate.cacheKey !== entry.cacheKey
      ))
      for (const candidate of manifest.entries) {
        if (!entries.includes(candidate) && candidate.fileName !== entry.fileName) {
          replacedEntries.push(candidate)
          obsoleteFiles.add(candidate.fileName)
        }
      }
      entries.push(entry)
      if (entries.length > MAX_PROXY_CACHE_ENTRIES) {
        entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.cacheKey.localeCompare(b.cacheKey))
        const evicted = entries.splice(0, entries.length - MAX_PROXY_CACHE_ENTRIES)
        for (const candidate of evicted) {
          if (candidate.fileName !== entry.fileName) {
            replacedEntries.push(candidate)
            obsoleteFiles.add(candidate.fileName)
          }
        }
      }
      return { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries }
    })
    let settlement: Promise<void> | null = null
    return {
      finalize: () => {
        settlement ??= this.serialize(async () => {
          for (const fileName of obsoleteFiles) {
            try {
              await this.removeFile(fileName)
            } catch {
              // The committed manifest stays authoritative; clear-all may reclaim an orphan.
            }
          }
        })
        return settlement
      },
      rollback: () => {
        settlement ??= this.mutate(async (manifest) => {
          const committed = manifest.entries.some((candidate) => (
            candidate.assetId === entry.assetId
            && candidate.cacheKey === entry.cacheKey
            && candidate.fileName === entry.fileName
          ))
          if (!committed) return manifest
          const entries = manifest.entries.filter((candidate) => !(
            candidate.assetId === entry.assetId
            && candidate.cacheKey === entry.cacheKey
            && candidate.fileName === entry.fileName
          ))
          for (const previous of replacedEntries) {
            if (entries.some((candidate) => (
              candidate.assetId === previous.assetId
              || candidate.cacheKey === previous.cacheKey
            ))) continue
            entries.push(previous)
          }
          return { schemaVersion: PROXY_CACHE_SCHEMA_VERSION, entries }
        }, async () => {
          await this.removeFile(entry.fileName)
        })
        return settlement
      },
    }
  }

  async readEntryFile(entry: ProxyCacheEntry): Promise<File> {
    const directory = await this.directory(false)
    const handle = await directory.getFileHandle(entry.fileName)
    const file = await handle.getFile()
    if (file.size !== entry.byteSize || file.size <= 0) {
      throw new Error('Cached proxy bytes do not match their manifest provenance')
    }
    return file
  }

  async touch(cacheKey: string): Promise<void> {
    const now = this.deps.now()
    await this.mutate(async (manifest) => ({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      entries: manifest.entries.map((entry) => (
        entry.cacheKey === cacheKey
          ? { ...entry, lastUsedAt: Math.max(entry.createdAt, entry.lastUsedAt, now) }
          : entry
      )),
    }))
  }

  async removeAsset(assetId: string): Promise<void> {
    const obsoleteFiles: string[] = []
    await this.mutate(async (manifest) => {
      obsoleteFiles.push(...manifest.entries
        .filter((entry) => entry.assetId === assetId)
        .map((entry) => entry.fileName))
      return {
        schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
        entries: manifest.entries.filter((entry) => entry.assetId !== assetId),
      }
    }, async () => {
      for (const fileName of obsoleteFiles) {
        try {
          await this.removeFile(fileName)
        } catch {
          // The item is removed from cache truth even if browser cleanup must retry later.
        }
      }
    })
  }

  async discardFile(fileName: string): Promise<void> {
    if (!isProxyCacheFileName(fileName)) return
    await this.removeFile(fileName)
  }

  private async removeFile(fileName: string): Promise<void> {
    try {
      const directory = await this.directory(false)
      await directory.removeEntry(fileName)
    } catch (cause) {
      if (!notFound(cause)) throw cause
    }
  }

  async clear(): Promise<void> {
    await this.serialize(async () => {
      try {
        const root = await this.deps.getRoot()
        const derived = await root.getDirectoryHandle(CACHE_ROOT_DIRECTORY)
        await derived.removeEntry(PROXY_DIRECTORY, { recursive: true })
      } catch (cause) {
        if (!notFound(cause)) throw cause
      }
    })
  }

  async estimate(): Promise<ProxyStorageEstimate> {
    // Defer dependency calls so a synchronous browser-API failure cannot
    // strand readManifest() as an unobserved rejected promise while the
    // Promise.all input array is still being constructed.
    const originPromise = Promise.resolve()
      .then(() => this.deps.estimate())
      .catch((): StorageEstimate => ({}))
    const persistedPromise = Promise.resolve()
      .then(() => this.deps.persisted())
      .catch(() => null)
    const [manifest, origin, persisted] = await Promise.all([
      this.readManifest(),
      originPromise,
      persistedPromise,
    ])
    return {
      cacheBytes: proxyCacheByteSize(manifest.entries),
      itemCount: manifest.entries.length,
      originUsageBytes: Number.isSafeInteger(origin.usage) ? origin.usage! : null,
      originQuotaBytes: Number.isSafeInteger(origin.quota) ? origin.quota! : null,
      persisted,
    }
  }

  /** LRU eviction touches only manifest-owned proxy files, never project data. */
  async ensureCapacity(requiredBytes: number, protectedAssetId?: string): Promise<void> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) {
      throw new RangeError('Required proxy capacity must be a positive safe integer')
    }
    const origin = await this.deps.estimate().catch((): StorageEstimate => ({}))
    if (!Number.isSafeInteger(origin.quota) || !Number.isSafeInteger(origin.usage)) return
    const quota = origin.quota!
    const usage = origin.usage!
    const ceiling = Math.max(
      0,
      Math.min(
        Math.floor(quota * MAX_ORIGIN_USAGE_RATIO),
        quota - MIN_QUOTA_HEADROOM_BYTES,
      ),
    )
    let reclaim = usage + requiredBytes - ceiling
    if (reclaim <= 0) return

    const obsoleteFiles: string[] = []
    await this.mutate(async (manifest) => {
      const entries = [...manifest.entries]
      const candidates = entries
        .filter((entry) => entry.assetId !== protectedAssetId)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.cacheKey.localeCompare(b.cacheKey))
      const evicted = new Set<string>()
      for (const entry of candidates) {
        if (reclaim <= 0) break
        reclaim -= entry.byteSize
        evicted.add(entry.cacheKey)
        obsoleteFiles.push(entry.fileName)
      }
      return {
        schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
        entries: entries.filter((entry) => !evicted.has(entry.cacheKey)),
      }
    }, async () => {
      for (const fileName of obsoleteFiles) await this.removeFile(fileName)
    })
    if (reclaim > 0) {
      throw new ProxyQuotaError(
        'Not enough browser storage is available. Clear disposable proxies or free site storage, then retry.',
      )
    }
  }
}

export const proxyStorage = new ProxyStorage()
