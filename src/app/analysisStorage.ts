import {
  ANALYSIS_CACHE_MINIMUM_HEADROOM_BYTES,
  ANALYSIS_CACHE_ROOT,
  ANALYSIS_CACHE_SCHEMA_VERSION,
  ANALYSIS_CACHE_TARGET_BYTES,
  ANALYSIS_CACHE_TARGET_ORIGIN_USAGE_RATIO,
  MAX_ANALYSIS_CACHE_ENTRIES,
  MAX_ANALYSIS_RESULT_BYTES,
  analysisCacheByteSize,
  analysisCacheFreshness,
  parseAnalysisCacheManifest,
  type AnalysisCacheEntry,
  type AnalysisCacheIdentity,
  type AnalysisCacheManifest,
} from '../domain/analysisCache'

const DERIVED_DIRECTORY = 'myrelith-derived'
const ANALYSIS_DIRECTORY = 'analysis-cache-v1'
const MANIFEST_FILE = 'manifest.json'
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export interface AnalysisStorageEstimate {
  readonly cacheBytes: number
  readonly itemCount: number
  readonly originUsageBytes: number | null
  readonly originQuotaBytes: number | null
  readonly persisted: boolean | null
}

export interface AnalysisStorageDeps {
  getRoot(): Promise<FileSystemDirectoryHandle>
  estimate(): Promise<StorageEstimate>
  persisted(): Promise<boolean>
  now(): number
  createToken(): string
}

export interface StagedAnalysisResult {
  readonly fileName: string
  discard(): Promise<void>
}

export interface AnalysisStorageEntryCommit {
  finalize(): Promise<void>
  rollback(): Promise<void>
}

const realDeps: AnalysisStorageDeps = {
  getRoot: () => navigator.storage.getDirectory(),
  estimate: () => navigator.storage.estimate(),
  persisted: () => navigator.storage.persisted(),
  now: () => Date.now(),
  createToken: () => crypto.randomUUID().replaceAll('-', ''),
}

export class AnalysisStorageUnavailableError extends Error {
  constructor(
    message = 'Origin-private analysis storage is unavailable in this browser',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AnalysisStorageUnavailableError'
  }
}

export class AnalysisStorageQuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalysisStorageQuotaError'
  }
}

export class AnalysisStorageCorruptError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AnalysisStorageCorruptError'
  }
}

function emptyManifest(): AnalysisCacheManifest {
  return { schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries: [] }
}

function notFound(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'NotFoundError'
}

function unavailable(cause: unknown): boolean {
  return cause instanceof DOMException && (
    cause.name === 'SecurityError'
    || cause.name === 'NotAllowedError'
    || cause.name === 'InvalidStateError'
    || cause.name === 'NotSupportedError'
  )
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function exactResultFileName(value: string): boolean {
  return /^[a-f0-9]{64}\.[a-f0-9]{32}\.bin$/.test(value)
}

export class AnalysisStorage {
  private readonly deps: AnalysisStorageDeps
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(deps: AnalysisStorageDeps = realDeps) {
    this.deps = deps
  }

  supported(): boolean {
    return typeof navigator !== 'undefined'
      && typeof navigator.storage?.getDirectory === 'function'
  }

  private async directory(create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!this.supported() && this.deps === realDeps) {
      throw new AnalysisStorageUnavailableError()
    }
    try {
      const root = await this.deps.getRoot()
      const derived = await root.getDirectoryHandle(DERIVED_DIRECTORY, { create })
      return derived.getDirectoryHandle(ANALYSIS_DIRECTORY, { create })
    } catch (cause) {
      if (unavailable(cause)) throw new AnalysisStorageUnavailableError(undefined, { cause })
      throw cause
    }
  }

  async readManifest(): Promise<AnalysisCacheManifest> {
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
      if (file.size > MAX_MANIFEST_BYTES) {
        throw new TypeError('Analysis cache manifest exceeds the 4 MiB safety limit')
      }
      return parseAnalysisCacheManifest(JSON.parse(await file.text()))
    } catch (cause) {
      if (notFound(cause)) return emptyManifest()
      throw new AnalysisStorageCorruptError(
        `Could not read the analysis cache manifest: ${errorMessage(cause)}`,
        cause,
      )
    }
  }

  private async writeManifest(manifest: AnalysisCacheManifest): Promise<void> {
    const serialized = JSON.stringify(manifest)
    if (new TextEncoder().encode(serialized).byteLength > MAX_MANIFEST_BYTES) {
      throw new AnalysisStorageQuotaError(
        'Analysis cache manifest exceeds the reviewed 4 MiB limit',
      )
    }
    const directory = await this.directory(true)
    const handle = await directory.getFileHandle(MANIFEST_FILE, { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    try {
      await writable.write(serialized)
      await writable.close()
    } catch (cause) {
      try {
        await writable.abort(cause)
      } catch {
        // Preserve the manifest write failure.
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
    mutation: (manifest: AnalysisCacheManifest) => Promise<AnalysisCacheManifest>,
    afterCommit?: (previous: AnalysisCacheManifest, committed: AnalysisCacheManifest) => Promise<void>,
  ): Promise<void> {
    return this.serialize(async () => {
      const previous = await this.readManifest()
      const committed = parseAnalysisCacheManifest(await mutation(previous))
      await this.writeManifest(committed)
      await afterCommit?.(previous, committed)
    })
  }

  async stageResult(
    cacheKey: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<StagedAnalysisResult> {
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw new TypeError('Invalid analysis cache key')
    if (
      bytes.byteOffset !== 0
      || bytes.byteLength !== bytes.buffer.byteLength
      || bytes.byteLength <= 0
      || bytes.byteLength > MAX_ANALYSIS_RESULT_BYTES
    ) {
      throw new RangeError('Analysis result must be a tight non-empty buffer within the reviewed limit')
    }
    await this.ensureCapacity(bytes.byteLength)
    const token = this.deps.createToken()
    if (!/^[a-f0-9]{32}$/.test(token)) throw new TypeError('Invalid analysis staging token')
    const fileName = `${cacheKey}.${token}.bin`
    const directory = await this.directory(true)
    const handle = await directory.getFileHandle(fileName, { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    try {
      await writable.write(bytes)
      await writable.close()
    } catch (cause) {
      try {
        await writable.abort(cause)
      } catch {
        // Preserve the result write failure.
      }
      await this.removeFile(fileName).catch(() => undefined)
      throw cause
    }
    let discarded = false
    return {
      fileName,
      discard: async () => {
        if (discarded) return
        discarded = true
        await this.removeFile(fileName)
      },
    }
  }

  async commitEntry(entry: AnalysisCacheEntry): Promise<AnalysisStorageEntryCommit> {
    parseAnalysisCacheManifest({
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      entries: [entry],
    })
    const obsoleteFiles = new Set<string>()
    const replacedEntries: AnalysisCacheEntry[] = []
    await this.mutate(async (manifest) => {
      const entries = manifest.entries.filter((candidate) => candidate.cacheKey !== entry.cacheKey)
      for (const candidate of manifest.entries) {
        if (!entries.includes(candidate) && candidate.resultFileName !== entry.resultFileName) {
          replacedEntries.push(candidate)
          obsoleteFiles.add(candidate.resultFileName)
        }
      }
      entries.push(entry)
      if (entries.length > MAX_ANALYSIS_CACHE_ENTRIES) {
        const candidates = entries.filter((candidate) => candidate !== entry).sort((left, right) => (
          left.lastUsedAt - right.lastUsedAt || left.cacheKey.localeCompare(right.cacheKey)
        ))
        const evicted = candidates.slice(0, entries.length - MAX_ANALYSIS_CACHE_ENTRIES)
        const evictedKeys = new Set(evicted.map((candidate) => candidate.cacheKey))
        for (const candidate of evicted) {
          if (candidate.resultFileName !== entry.resultFileName) {
            replacedEntries.push(candidate)
            obsoleteFiles.add(candidate.resultFileName)
          }
        }
        entries.splice(0, entries.length, ...entries.filter((candidate) => (
          !evictedKeys.has(candidate.cacheKey)
        )))
      }
      return { schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries }
    })
    let settlement: Promise<void> | null = null
    return {
      finalize: () => {
        settlement ??= this.serialize(async () => {
          for (const fileName of obsoleteFiles) await this.removeFile(fileName).catch(() => undefined)
        })
        return settlement
      },
      rollback: () => {
        settlement ??= this.mutate(async (manifest) => {
          const committed = manifest.entries.some((candidate) => (
            candidate.cacheKey === entry.cacheKey
            && candidate.resultFileName === entry.resultFileName
          ))
          if (!committed) return manifest
          const entries = manifest.entries.filter((candidate) => !(
            candidate.cacheKey === entry.cacheKey
            && candidate.resultFileName === entry.resultFileName
          ))
          for (const previous of replacedEntries) {
            if (entries.some((candidate) => (
              candidate.cacheKey === previous.cacheKey
              || candidate.resultFileName === previous.resultFileName
            ))) continue
            entries.push(previous)
          }
          return { schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries }
        }, async () => this.removeFile(entry.resultFileName))
        return settlement
      },
    }
  }

  async findFreshEntry(identity: AnalysisCacheIdentity): Promise<AnalysisCacheEntry | null> {
    const manifest = await this.readManifest()
    return manifest.entries.find((entry) => (
      analysisCacheFreshness(entry, identity).state === 'fresh'
    )) ?? null
  }

  async readResult(entry: AnalysisCacheEntry): Promise<Uint8Array<ArrayBuffer>> {
    try {
      const directory = await this.directory(false)
      const handle = await directory.getFileHandle(entry.resultFileName)
      const file = await handle.getFile()
      if (file.size !== entry.resultBytes || file.size <= 0) {
        throw new TypeError('Cached analysis byte length does not match its manifest')
      }
      return new Uint8Array(await file.arrayBuffer())
    } catch (cause) {
      if (cause instanceof AnalysisStorageCorruptError) throw cause
      throw new AnalysisStorageCorruptError(
        `Could not read cached analysis bytes: ${errorMessage(cause)}`,
        cause,
      )
    }
  }

  async touch(cacheKey: string): Promise<void> {
    const now = this.deps.now()
    await this.mutate(async (manifest) => ({
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      entries: manifest.entries.map((entry) => entry.cacheKey === cacheKey
        ? { ...entry, lastUsedAt: Math.max(entry.createdAt, entry.lastUsedAt, now) }
        : entry),
    }))
  }

  async removeAttachment(projectBindingId: string, clipId: string): Promise<void> {
    const obsoleteFiles: string[] = []
    await this.mutate(async (manifest) => {
      obsoleteFiles.push(...manifest.entries
        .filter((entry) => (
          entry.projectBindingId === projectBindingId && entry.attachment.clipId === clipId
        ))
        .map((entry) => entry.resultFileName))
      return {
        schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
        entries: manifest.entries.filter((entry) => !(
          entry.projectBindingId === projectBindingId && entry.attachment.clipId === clipId
        )),
      }
    }, async () => {
      for (const fileName of obsoleteFiles) await this.removeFile(fileName).catch(() => undefined)
    })
  }

  async removeAsset(projectBindingId: string, assetId: string): Promise<void> {
    const obsoleteFiles: string[] = []
    await this.mutate(async (manifest) => {
      obsoleteFiles.push(...manifest.entries
        .filter((entry) => entry.projectBindingId === projectBindingId && entry.assetId === assetId)
        .map((entry) => entry.resultFileName))
      return {
        schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
        entries: manifest.entries.filter((entry) => !(
          entry.projectBindingId === projectBindingId && entry.assetId === assetId
        )),
      }
    }, async () => {
      for (const fileName of obsoleteFiles) await this.removeFile(fileName).catch(() => undefined)
    })
  }

  private async removeFile(fileName: string): Promise<void> {
    if (!exactResultFileName(fileName)) return
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
        const derived = await root.getDirectoryHandle(DERIVED_DIRECTORY)
        await derived.removeEntry(ANALYSIS_DIRECTORY, { recursive: true })
      } catch (cause) {
        if (!notFound(cause)) throw cause
      }
    })
  }

  async estimate(): Promise<AnalysisStorageEstimate> {
    const originPromise = Promise.resolve().then(() => this.deps.estimate())
      .catch((): StorageEstimate => ({}))
    const persistedPromise = Promise.resolve().then(() => this.deps.persisted())
      .catch(() => null)
    const [manifest, origin, persisted] = await Promise.all([
      this.readManifest(),
      originPromise,
      persistedPromise,
    ])
    return {
      cacheBytes: analysisCacheByteSize(manifest.entries),
      itemCount: manifest.entries.length,
      originUsageBytes: Number.isSafeInteger(origin.usage) ? origin.usage! : null,
      originQuotaBytes: Number.isSafeInteger(origin.quota) ? origin.quota! : null,
      persisted,
    }
  }

  async ensureCapacity(requiredBytes: number): Promise<void> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) {
      throw new RangeError('Required analysis capacity must be a positive safe integer')
    }
    const [manifest, origin] = await Promise.all([
      this.readManifest(),
      this.deps.estimate().catch((): StorageEstimate => ({})),
    ])
    const cacheBytes = analysisCacheByteSize(manifest.entries)
    let ceiling = ANALYSIS_CACHE_TARGET_BYTES
    if (Number.isSafeInteger(origin.quota) && Number.isSafeInteger(origin.usage)) {
      const quota = origin.quota!
      const usage = origin.usage!
      const nonCacheUsage = Math.max(0, usage - cacheBytes)
      ceiling = Math.max(0, Math.min(
        ceiling,
        Math.floor(quota * ANALYSIS_CACHE_TARGET_ORIGIN_USAGE_RATIO) - nonCacheUsage,
        quota - ANALYSIS_CACHE_MINIMUM_HEADROOM_BYTES - nonCacheUsage,
      ))
    }
    let reclaim = cacheBytes + requiredBytes - ceiling
    if (reclaim <= 0) return

    const obsoleteFiles: string[] = []
    await this.mutate(async (current) => {
      const candidates = [...current.entries].sort((left, right) => (
        left.lastUsedAt - right.lastUsedAt || left.cacheKey.localeCompare(right.cacheKey)
      ))
      const evicted = new Set<string>()
      for (const entry of candidates) {
        if (reclaim <= 0) break
        reclaim -= entry.resultBytes
        evicted.add(entry.cacheKey)
        obsoleteFiles.push(entry.resultFileName)
      }
      return {
        schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
        entries: current.entries.filter((entry) => !evicted.has(entry.cacheKey)),
      }
    }, async () => {
      for (const fileName of obsoleteFiles) await this.removeFile(fileName)
    })
    if (reclaim > 0) {
      throw new AnalysisStorageQuotaError(
        'Not enough browser storage is available. Clear disposable analysis data or free site storage, then retry.',
      )
    }
  }
}

export const analysisStorage = new AnalysisStorage()

if (ANALYSIS_CACHE_ROOT !== `${DERIVED_DIRECTORY}/${ANALYSIS_DIRECTORY}`) {
  throw new Error('Analysis storage directory drifted from the domain cache root')
}
