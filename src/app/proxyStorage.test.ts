import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PROXY_PARAMETERS,
  PROXY_CACHE_SCHEMA_VERSION,
  PROXY_GENERATOR_VERSION,
  type ProxyCacheEntry,
} from '../domain/proxyCache'
import { ProxyQuotaError, ProxyStorage } from './proxyStorage'

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
  throw new TypeError('The memory OPFS fixture only accepts direct write chunks')
}

class MemoryFileHandle {
  readonly kind = 'file' as const
  bytes = new Uint8Array()
  failNextWrite = false
  closeGate: Promise<void> | null = null
  readonly events: string[]
  readonly name: string

  constructor(name: string, events: string[]) {
    this.name = name
    this.events = events
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { type: this.name.endsWith('.mp4') ? 'video/mp4' : '' })
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let staged = new Uint8Array()
    return {
      write: async (chunk: FileSystemWriteChunkType) => {
        if (this.failNextWrite) {
          this.failNextWrite = false
          throw new Error('simulated manifest write failure')
        }
        staged = await chunkBytes(chunk)
      },
      close: async () => {
        this.events.push(`${this.name}:closing`)
        if (this.closeGate) {
          await this.closeGate
          this.closeGate = null
        }
        this.bytes = staged
        this.events.push(`${this.name}:committed`)
      },
      async abort() {},
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

function entry(
  assetId: string,
  digit: string,
  lastUsedAt: number,
  fileName: string,
  byteSize = 10,
): ProxyCacheEntry {
  const cacheKey = digit.repeat(64)
  return {
    cacheKey,
    assetId,
    original: {
      algorithm: 'sha256-sampled-v1',
      digest: (digit === 'f' ? 'e' : 'f').repeat(64),
      fileName: `${assetId}.mp4`,
      size: 1_000,
      lastModified: 2_000,
    },
    parameters: DEFAULT_PROXY_PARAMETERS,
    generatorVersion: PROXY_GENERATOR_VERSION,
    fileName,
    mimeType: 'video/mp4',
    byteSize,
    width: 640,
    height: 360,
    frameRate: { num: 30, den: 1 },
    durationMicroseconds: 1_000_000,
    createdAt: lastUsedAt,
    lastUsedAt,
  }
}

function fixture(usage = 0, quota = 1_000_000_000) {
  const events: string[] = []
  const root = new MemoryDirectory('root', events)
  const storage = new ProxyStorage({
    getRoot: async () => root as unknown as FileSystemDirectoryHandle,
    estimate: async () => ({ usage, quota }),
    persisted: async () => false,
    now: () => 9_000,
    createToken: (() => {
      let counter = 0
      return () => (++counter).toString(16).padStart(32, '0')
    })(),
  })
  return { root, storage, events }
}

async function writeStaged(storage: ProxyStorage, cacheKey: string, size: number): Promise<string> {
  const capability = await storage.prepareFileCapability(cacheKey)
  const writable = await capability.takeFileHandle().createWritable()
  await writable.write(new Blob([new Uint8Array(size)]))
  await writable.close()
  return capability.fileName
}

async function commit(storage: ProxyStorage, candidate: ProxyCacheEntry): Promise<void> {
  const transaction = await storage.commitEntry(candidate)
  await transaction.finalize()
}

function proxyDirectory(root: MemoryDirectory): MemoryDirectory {
  return root.directories.get('myrelith-derived')!.directories.get('proxy-cache-v1')!
}

describe('ProxyStorage', () => {
  it('keeps a committed proxy intact when a same-provenance regeneration is discarded', async () => {
    const { root, storage } = fixture()
    const cacheKey = 'a'.repeat(64)
    const committedFileName = await writeStaged(storage, cacheKey, 10)
    const committed = entry('asset', 'a', 1, committedFileName)
    await commit(storage, committed)

    const replacementFileName = await writeStaged(storage, cacheKey, 12)
    expect(replacementFileName).not.toBe(committedFileName)
    await storage.discardFile(replacementFileName)

    expect((await storage.readManifest()).entries).toEqual([committed])
    await expect(storage.readEntryFile(committed)).resolves.toHaveProperty('size', 10)
    expect(proxyDirectory(root).files.has(replacementFileName)).toBe(false)
  })

  it('keeps manifest provenance authoritative and removes replaced bytes only after commit', async () => {
    const { root, storage, events } = fixture()
    const firstKey = 'a'.repeat(64)
    const firstFileName = await writeStaged(storage, firstKey, 10)
    const first = entry('asset', 'a', 1, firstFileName)
    await commit(storage, first)

    const secondKey = firstKey
    const secondFileName = await writeStaged(storage, secondKey, 12)
    const second = entry('asset', 'a', 2, secondFileName, 12)
    events.length = 0
    await commit(storage, second)

    expect(await storage.readManifest()).toEqual({
      schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
      entries: [second],
    })
    expect(events).toEqual([
      'manifest.json:closing',
      'manifest.json:committed',
      `${first.fileName}:removed`,
    ])
    await expect(storage.readEntryFile(second)).resolves.toHaveProperty('size', 12)
    expect(proxyDirectory(root).files.has(first.fileName)).toBe(false)
  })

  it('can roll back a late commit before replaced bytes are reclaimed', async () => {
    const { root, storage } = fixture()
    const firstFileName = await writeStaged(storage, 'a'.repeat(64), 10)
    const first = entry('asset', 'a', 1, firstFileName)
    await commit(storage, first)

    const secondFileName = await writeStaged(storage, 'b'.repeat(64), 12)
    const second = entry('asset', 'b', 2, secondFileName, 12)
    const transaction = await storage.commitEntry(second)
    expect((await storage.readManifest()).entries).toEqual([second])
    expect(proxyDirectory(root).files.has(first.fileName)).toBe(true)

    await transaction.rollback()

    expect((await storage.readManifest()).entries).toEqual([first])
    expect(proxyDirectory(root).files.has(first.fileName)).toBe(true)
    expect(proxyDirectory(root).files.has(second.fileName)).toBe(false)
  })

  it('preserves the previous manifest and bytes when replacement commit fails', async () => {
    const { root, storage } = fixture()
    const firstKey = 'a'.repeat(64)
    const firstFileName = await writeStaged(storage, firstKey, 10)
    const first = entry('asset', 'a', 1, firstFileName)
    await commit(storage, first)
    const directory = proxyDirectory(root)

    const secondKey = 'b'.repeat(64)
    const secondFileName = await writeStaged(storage, secondKey, 10)
    const second = entry('asset', 'b', 2, secondFileName)
    directory.files.get('manifest.json')!.failNextWrite = true
    await expect(storage.commitEntry(second)).rejects.toThrow('simulated manifest write failure')

    expect((await storage.readManifest()).entries).toEqual([first])
    expect(directory.files.has(first.fileName)).toBe(true)
  })

  it('serializes clear behind an in-flight manifest commit', async () => {
    const { root, storage, events } = fixture()
    const firstFileName = await writeStaged(storage, 'a'.repeat(64), 10)
    await commit(storage, entry('first', 'a', 1, firstFileName))
    const fileName = await writeStaged(storage, 'b'.repeat(64), 10)
    const candidate = entry('second', 'b', 2, fileName)
    const directory = proxyDirectory(root)
    let releaseClose!: () => void
    const manifestHandle = directory.files.get('manifest.json')!
    manifestHandle.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    events.length = 0

    const commitPromise = storage.commitEntry(candidate)
    await vi.waitFor(() => expect(events).toContain('manifest.json:closing'))
    const clearPromise = storage.clear()
    expect(root.directories.has('myrelith-derived')).toBe(true)

    releaseClose()
    const transaction = await commitPromise
    await transaction.finalize()
    await clearPromise

    expect(events.indexOf('manifest.json:committed'))
      .toBeLessThan(events.indexOf('proxy-cache-v1:removed'))
    expect(root.directories.get('myrelith-derived')?.directories.has('proxy-cache-v1')).toBe(false)
  })

  it('evicts least-recently-used owned proxies and refuses to evict the protected asset', async () => {
    const { root, storage } = fixture(750_000_000, 1_000_000_000)
    const oldKey = 'a'.repeat(64)
    const oldFileName = await writeStaged(storage, oldKey, 40_000_000)
    const old = entry('old', 'a', 1, oldFileName, 40_000_000)
    await commit(storage, old)
    const recentKey = 'b'.repeat(64)
    const recentFileName = await writeStaged(storage, recentKey, 40_000_000)
    const recent = entry('recent', 'b', 2, recentFileName, 40_000_000)
    await commit(storage, recent)

    await storage.ensureCapacity(80_000_000, 'recent')
    expect((await storage.readManifest()).entries).toEqual([recent])
    expect(proxyDirectory(root).files.has(old.fileName)).toBe(false)
    await expect(storage.ensureCapacity(100_000_000, 'recent')).rejects.toBeInstanceOf(ProxyQuotaError)
  })
})
