import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_CACHE_SCHEMA_VERSION,
  type AnalysisCacheEntry,
  type AudioFeatureCacheEntry,
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
    cacheKind: 'motion',
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

  it('rejects an impossible allocation before evicting usable cache entries', async () => {
    const quota = 300 * 1024 * 1024
    const { root, storage, setEstimate } = fixture()
    const oldStage = await stage(storage, 'a')
    const old = entry('a', oldStage.fileName, {
      resultBytes: 80 * 1024 * 1024,
      lastUsedAt: 1_000,
    })
    await (await storage.commitEntry(old)).finalize()
    setEstimate(200 * 1024 * 1024, quota)

    await expect(storage.ensureCapacity(90 * 1024 * 1024)).rejects.toBeInstanceOf(
      AnalysisStorageQuotaError,
    )

    expect((await storage.readManifest()).entries).toEqual([old])
    expect(directory(root).files.has(old.resultFileName)).toBe(true)
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

function audioEntry(index = 1, binding = 'local-project:audio'): AudioFeatureCacheEntry {
  const key = index.toString(16).padStart(64, '0')
  return { cacheKind: 'audio-feature', cacheKey: key, projectBindingId: binding, assetId: 'audio-asset',
    sourceFingerprint: { algorithm: 'sha256-sampled-v1', digest: 'a'.repeat(64), fileName: 'angle.mov', size: 1, lastModified: 0 },
    audioStreamIndex: 0, audioTrackId: '2', decodePolicyDigest: 'b'.repeat(64), timestampOrigin: 'source-presentation-zero-continuous-v1',
    inputSampleRate: 48000, channels: 2, startSample: 0, sourceSampleCount: 1440000, binCount: 6000,
    resultFileName: `${key}.${'a'.repeat(32)}.bin`, resultBytes: 24000, createdAt: index, lastUsedAt: index }
}
it('keeps audio separate from motion attachment deletion and rolls back a replacement', async () => {
  const { storage } = fixture()
  const audio = audioEntry()
  const staged = await storage.stageResult(audio.cacheKey, new Uint8Array(24000))
  const first = { ...audio, resultFileName: staged.fileName }
  await (await storage.commitEntry(first)).finalize()
  expect(await storage.findAudioFeature(audio.cacheKey)).toEqual(first)
  await storage.removeAttachment(audio.projectBindingId, 'anything')
  expect((await storage.readManifest()).entries).toEqual([first])
  const replacement = await storage.stageResult(audio.cacheKey, new Uint8Array(24000))
  const transaction = await storage.commitEntry({ ...audio, resultFileName: replacement.fileName })
  await transaction.rollback()
  expect((await storage.readManifest()).entries).toEqual([first])
  await storage.removeAsset(audio.projectBindingId, audio.assetId)
  expect((await storage.readManifest()).entries).toEqual([])
})
it('enforces the audio project LRU ceiling without evicting motion entries', async () => {
  const { storage, root } = fixture()
  const derived = await root.getDirectoryHandle('myrelith-derived', { create: true })
  const directory = await derived.getDirectoryHandle('analysis-cache-v1', { create: true })
  const file = await directory.getFileHandle('manifest.json', { create: true })
  const write = await file.createWritable()
  const motion = entry('f', `${'f'.repeat(64)}.${'a'.repeat(32)}.bin`)
  const audio = Array.from({ length: 699 }, (_, i) => audioEntry(i + 1))
  await write.write(JSON.stringify({ schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries: [motion, ...audio] }))
  await write.close()
  const transaction = await storage.commitEntry(audioEntry(700))
  const committed = (await storage.readManifest()).entries
  expect(committed).toHaveLength(700)
  expect(committed).toContainEqual(motion)
  expect(committed.some((item) => item.cacheKey === audio[0].cacheKey)).toBe(false)
  expect(committed.filter((item) => item.cacheKind === 'audio-feature').reduce((n, item) => n + item.resultBytes, 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
  await transaction.rollback()
  expect((await storage.readManifest()).entries).toHaveLength(700)
})
it('rejects audio byte inflation before any shared eviction or write', async () => {
  const { storage, events } = fixture()
  await expect(storage.commitEntry({ ...audioEntry(), resultBytes: 2 * 1024 * 1024 })).rejects.toThrow()
  expect(events).toEqual([])
})
it('rolls back audio eviction within shared limits when motion commits during the transaction', async () => {
  const { storage, root } = fixture()
  const derived = await root.getDirectoryHandle('myrelith-derived', { create: true })
  const directory = await derived.getDirectoryHandle('analysis-cache-v1', { create: true })
  const manifest = await directory.getFileHandle('manifest.json', { create: true })
  const write = await manifest.createWritable()
  // 1,024 entries and 16,776,000 audio bytes: the new 30-second window evicts six 5-second windows.
  const audio = Array.from({ length: 1024 }, (_, i) => i < 390
    ? { ...audioEntry(i + 1), binCount: 1000, sourceSampleCount: 240000, resultBytes: 4000 }
    : audioEntry(i + 1))
  await write.write(JSON.stringify({ schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries: audio }))
  await write.close()
  const incoming = audioEntry(1025)
  const transaction = await storage.commitEntry(incoming)
  const motion = entry('f', `${'f'.repeat(64)}.${'a'.repeat(32)}.bin`)
  await (await storage.commitEntry(motion)).finalize()
  await transaction.rollback()
  const entries = (await storage.readManifest()).entries
  expect(entries).toHaveLength(1024)
  expect(entries).toContainEqual(motion)
  expect(entries.some((item) => item.cacheKey === incoming.cacheKey)).toBe(false)
  expect(entries.filter((item) => item.cacheKind === 'audio-feature').reduce((sum, item) => sum + item.resultBytes, 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
})
