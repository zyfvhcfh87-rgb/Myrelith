import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_CACHE_SCHEMA_VERSION,
  type AnalysisCacheEntry,
} from '../domain/analysisCache'
import {
  AnalysisStorage,
  AnalysisStorageCorruptError,
  AnalysisStorageQuotaError,
  AnalysisStorageUnavailableError,
} from './analysisStorage'

function missing(name: string): DOMException {
  return new DOMException(`${name} was not found`, 'NotFoundError')
}

async function chunkBytes(chunk: FileSystemWriteChunkType): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer())
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) {
    return Uint8Array.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  throw new TypeError('Unsupported memory OPFS write')
}

class MemoryFileHandle {
  readonly kind = 'file' as const
  readonly name: string
  readonly events: string[]
  bytes = new Uint8Array(new ArrayBuffer(0))
  failNextWrite = false

  constructor(name: string, events: string[]) {
    this.name = name
    this.events = events
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name)
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let staged = new Uint8Array(new ArrayBuffer(0))
    return {
      write: async (chunk: FileSystemWriteChunkType) => {
        if (this.failNextWrite) {
          this.failNextWrite = false
          throw new Error('manifest-write-failed')
        }
        staged = await chunkBytes(chunk)
      },
      close: async () => {
        this.bytes = staged
        this.events.push(`${this.name}:committed`)
      },
      abort: async () => undefined,
    } as unknown as FileSystemWritableFileStream
  }
}

class MemoryDirectory {
  readonly kind = 'directory' as const
  readonly name: string
  readonly events: string[]
  readonly directories = new Map<string, MemoryDirectory>()
  readonly files = new Map<string, MemoryFileHandle>()

  constructor(name = 'root', events: string[] = []) {
    this.name = name
    this.events = events
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
    const current = this.directories.get(name)
    if (current) return current as unknown as FileSystemDirectoryHandle
    if (!options?.create) throw missing(name)
    const created = new MemoryDirectory(name, this.events)
    this.directories.set(name, created)
    return created as unknown as FileSystemDirectoryHandle
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
    const current = this.files.get(name)
    if (current) return current as unknown as FileSystemFileHandle
    if (!options?.create) throw missing(name)
    const created = new MemoryFileHandle(name, this.events)
    this.files.set(name, created)
    return created as unknown as FileSystemFileHandle
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions) {
    if (this.files.delete(name)) {
      this.events.push(`${name}:removed`)
      return
    }
    const directory = this.directories.get(name)
    if (directory && (options?.recursive || directory.files.size + directory.directories.size === 0)) {
      this.directories.delete(name)
      this.events.push(`${name}:removed`)
      return
    }
    throw missing(name)
  }
}

function fixture(usage = 0, quota = 1024 ** 3) {
  const events: string[] = []
  const root = new MemoryDirectory('root', events)
  let now = 10_000
  let token = 0
  let originUsage = usage
  let originQuota = quota
  const storage = new AnalysisStorage({
    getRoot: async () => root as unknown as FileSystemDirectoryHandle,
    estimate: async () => ({ usage: originUsage, quota: originQuota }),
    persisted: async () => false,
    now: () => ++now,
    createToken: () => (++token).toString(16).padStart(32, '0'),
  })
  return {
    events,
    root,
    storage,
    setEstimate(nextUsage: number, nextQuota: number) {
      originUsage = nextUsage
      originQuota = nextQuota
    },
  }
}

function entry(
  cacheDigit: string,
  fileName: string,
  overrides: Partial<AnalysisCacheEntry> = {},
): AnalysisCacheEntry {
  const cacheKey = cacheDigit.repeat(64)
  return {
    cacheKey,
    projectBindingId: 'local-project:test',
    assetId: 'asset-1',
    source: {
      fingerprint: {
        algorithm: 'sha256-sampled-v1',
        digest: 'b'.repeat(64),
        fileName: 'source.mp4',
        size: 123,
        lastModified: 456,
      },
      videoStreamIndex: 0,
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sourceStartMicroseconds: 0,
      sourceEndMicroseconds: 1_000_000,
      samplingIntervalFrames: 1,
    },
    attachment: {
      clipId: 'clip-1',
      sourceMappingDigest: 'c'.repeat(64),
      projectionDigest: 'd'.repeat(64),
    },
    algorithm: {
      kind: 'stabilization',
      algorithmId: 'global-similarity',
      algorithmVersion: 'v1',
      parametersDigest: 'e'.repeat(64),
    },
    resultFileName: fileName,
    resultBytes: 4,
    sampleCount: 2,
    createdAt: 1_000,
    lastUsedAt: 1_000,
    ...overrides,
  }
}

function directory(root: MemoryDirectory): MemoryDirectory {
  return root.directories.get('myrelith-derived')!.directories.get('analysis-cache-v1')!
}

async function stage(
  storage: AnalysisStorage,
  digit: string,
  bytes = new Uint8Array(new ArrayBuffer(4)).fill(7),
) {
  return storage.stageResult(digit.repeat(64), bytes)
}

describe('AnalysisStorage', () => {
  it('classifies an origin-private filesystem denial as unavailable', async () => {
    const storage = new AnalysisStorage({
      getRoot: async () => {
        throw new DOMException('blocked by policy', 'SecurityError')
      },
      estimate: async () => ({}),
      persisted: async () => false,
      now: () => 0,
      createToken: () => '0'.repeat(32),
    })

    await expect(storage.readManifest()).rejects.toBeInstanceOf(
      AnalysisStorageUnavailableError,
    )
  })

  it('writes result first, commits manifest last, and reads exact bytes', async () => {
    const { events, root, storage } = fixture()
    const staged = await stage(storage, 'a')
    expect(events).toEqual([`${staged.fileName}:committed`])
    const candidate = entry('a', staged.fileName)
    const transaction = await storage.commitEntry(candidate)
    await transaction.finalize()

    expect(events).toEqual([
      `${staged.fileName}:committed`,
      'manifest.json:committed',
    ])
    expect(await storage.readManifest()).toEqual({
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      entries: [candidate],
    })
    expect([...await storage.readResult(candidate)]).toEqual([7, 7, 7, 7])
    expect(directory(root).files.has(staged.fileName)).toBe(true)
  })

  it('classifies a missing manifest-owned result as disposable cache corruption', async () => {
    const { root, storage } = fixture()
    const staged = await stage(storage, 'a')
    const candidate = entry('a', staged.fileName)
    await (await storage.commitEntry(candidate)).finalize()
    await directory(root).removeEntry(staged.fileName)

    await expect(storage.readResult(candidate)).rejects.toBeInstanceOf(
      AnalysisStorageCorruptError,
    )
  })

  it('rolls a late replacement back without losing the previous result', async () => {
    const { root, storage } = fixture()
    const firstStage = await stage(storage, 'a')
    const first = entry('a', firstStage.fileName)
    await (await storage.commitEntry(first)).finalize()

    const secondStage = await stage(storage, 'a', new Uint8Array(new ArrayBuffer(5)).fill(9))
    const second = entry('a', secondStage.fileName, { resultBytes: 5, lastUsedAt: 2_000 })
    const transaction = await storage.commitEntry(second)
    expect((await storage.readManifest()).entries).toEqual([second])
    await transaction.rollback()

    expect((await storage.readManifest()).entries).toEqual([first])
    expect(directory(root).files.has(first.resultFileName)).toBe(true)
    expect(directory(root).files.has(second.resultFileName)).toBe(false)
  })

  it('fails closed on hostile manifests and preserves staged-result ownership', async () => {
    const { root, storage } = fixture()
    const staged = await stage(storage, 'a')
    const analysis = directory(root)
    const manifest = await analysis.getFileHandle('manifest.json', { create: true }) as unknown as MemoryFileHandle
    manifest.bytes = new TextEncoder().encode(JSON.stringify({
      schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
      entries: [],
      surprise: true,
    }))
    await expect(storage.readManifest()).rejects.toThrow(/exact object/)
    await staged.discard()
    expect(analysis.files.has(staged.fileName)).toBe(false)
  })

  it('evicts least-recently-used cache truth to the origin-aware ceiling', async () => {
    const quota = 300 * 1024 * 1024
    const { root, storage, setEstimate } = fixture()
    const oldStage = await stage(storage, 'a')
    const old = entry('a', oldStage.fileName, {
      resultBytes: 80 * 1024 * 1024,
      lastUsedAt: 1_000,
    })
    directory(root).files.get(oldStage.fileName)!.bytes = new Uint8Array(new ArrayBuffer(1))
    await (await storage.commitEntry(old)).finalize()

    setEstimate(200 * 1024 * 1024, quota)
    await storage.ensureCapacity(10 * 1024 * 1024)
    expect((await storage.readManifest()).entries).toEqual([])
    expect(directory(root).files.has(old.resultFileName)).toBe(false)
    await expect(storage.ensureCapacity(90 * 1024 * 1024)).rejects.toBeInstanceOf(
      AnalysisStorageQuotaError,
    )
  })

  it('removes exact clip and asset sidecars without touching sibling entries', async () => {
    const { storage } = fixture()
    const firstStage = await stage(storage, 'a')
    const secondStage = await stage(storage, 'b')
    const first = entry('a', firstStage.fileName)
    const second = entry('b', secondStage.fileName, {
      assetId: 'asset-2',
      attachment: {
        clipId: 'clip-2',
        sourceMappingDigest: '1'.repeat(64),
        projectionDigest: '2'.repeat(64),
      },
    })
    await (await storage.commitEntry(first)).finalize()
    await (await storage.commitEntry(second)).finalize()

    await storage.removeAttachment('local-project:test', 'clip-1')
    expect((await storage.readManifest()).entries).toEqual([second])
    await storage.removeAsset('local-project:test', 'asset-2')
    expect((await storage.readManifest()).entries).toEqual([])
  })
})
