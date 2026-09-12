import { describe, expect, it } from 'vitest'
import {
  COLLECT_STREAM_CHUNK_BYTES,
  inspectCollectDestination,
  loadCollectedArchive,
  prepareCollectDestination,
  readFileAtRelativePath,
  streamCopyBlob,
  writeBlobAtRelativePath,
  writeCollectManifest,
  type CollectMediaDirectoryHandle,
} from './collectMediaArchive'

function missing(name: string): DOMException {
  return new DOMException(`${name} was not found`, 'NotFoundError')
}

async function chunkBytes(chunk: FileSystemWriteChunkType): Promise<Uint8Array> {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer())
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) {
    return Uint8Array.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  throw new TypeError('unsupported chunk')
}

class MemoryFileHandle {
  readonly kind = 'file' as const
  bytes = new Uint8Array()
  quotaExceeded = false
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name)
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let staged = new Uint8Array()
    const file = this
    return {
      write: async (chunk: FileSystemWriteChunkType) => {
        if (file.quotaExceeded) {
          throw new DOMException('quota', 'QuotaExceededError')
        }
        const bytes = await chunkBytes(chunk)
        const next = new Uint8Array(staged.byteLength + bytes.byteLength)
        next.set(staged)
        next.set(bytes, staged.byteLength)
        staged = next
      },
      close: async () => {
        file.bytes = staged
      },
      abort: async () => {},
    } as unknown as FileSystemWritableFileStream
  }
}

class MemoryDirectory {
  readonly kind = 'directory' as const
  readonly name: string
  readonly directories = new Map<string, MemoryDirectory>()
  readonly files = new Map<string, MemoryFileHandle>()

  constructor(name = 'archive') {
    this.name = name
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
    const current = this.directories.get(name)
    if (current) return current
    if (!options?.create) throw missing(name)
    const created = new MemoryDirectory(name)
    this.directories.set(name, created)
    return created
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
    const current = this.files.get(name)
    if (current) return current
    if (!options?.create) throw missing(name)
    const created = new MemoryFileHandle(name)
    this.files.set(name, created)
    return created
  }

  async removeEntry(name: string) {
    if (this.files.delete(name) || this.directories.delete(name)) return
    throw missing(name)
  }

  async *values() {
    for (const directory of this.directories.values()) yield directory
    for (const file of this.files.values()) yield file
  }
}

function root(): CollectMediaDirectoryHandle {
  return new MemoryDirectory() as unknown as CollectMediaDirectoryHandle
}

describe('collect-media archive I/O', () => {
  it('streams copies in chunks instead of one buffered write', async () => {
    const writes: number[] = []
    const writable = {
      write: async (chunk: Blob | BufferSource | string) => {
        if (typeof chunk === 'string') writes.push(chunk.length)
        else if (chunk instanceof Blob) writes.push(chunk.size)
        else if (ArrayBuffer.isView(chunk)) writes.push(chunk.byteLength)
        else writes.push((chunk as ArrayBuffer).byteLength)
      },
      close: async () => {},
    }
    const blob = {
      size: COLLECT_STREAM_CHUNK_BYTES * 2 + 10,
      slice(start: number, end: number) {
        return new Blob([new Uint8Array(Math.max(0, end - start))])
      },
    } as Blob
    await streamCopyBlob(blob, writable, new AbortController().signal)
    expect(writes.length).toBeGreaterThan(1)
    expect(writes.reduce((sum, size) => sum + size, 0)).toBe(blob.size)
  })

  it('refuses occupied destinations and marks incomplete archives', async () => {
    const occupied = new MemoryDirectory()
    occupied.files.set('photos', new MemoryFileHandle('photos'))
    await expect(prepareCollectDestination(
      occupied as unknown as CollectMediaDirectoryHandle,
    )).rejects.toThrow(/empty folder/)

    const destination = root()
    await prepareCollectDestination(destination)
    const inspection = await inspectCollectDestination(destination)
    expect(inspection.hasIncompleteMarker).toBe(true)
    expect(inspection.kind).toBe('incomplete')
  })

  it('rejects relative paths that escape the chosen folder', async () => {
    const destination = root()
    await prepareCollectDestination(destination)
    await expect(writeBlobAtRelativePath(
      destination,
      '../secret.mp4',
      new Blob(['x']),
      new AbortController().signal,
    )).rejects.toThrow(/relative POSIX/)
    await expect(readFileAtRelativePath(destination, 'media/../x.mp4'))
      .rejects.toThrow(/relative POSIX/)
  })

  it('does not present a partial copy as complete', async () => {
    const destination = root()
    await prepareCollectDestination(destination)
    await writeBlobAtRelativePath(
      destination,
      'media/clip.mp4',
      new Blob(['abcd']),
      new AbortController().signal,
    )
    await writeCollectManifest(destination, {
      format: 'myrelith-collect-media',
      formatVersion: 1,
      status: 'partial',
      createdAt: 1,
      projectFileName: 'Edit.myrelith',
      inclusionPolicy: { includeProxies: false, includeTitleTemplates: false },
      items: [{
        id: 'asset-1',
        kind: 'asset',
        disposition: 'included',
        originalFileName: 'clip.mp4',
        collectedRelativePath: 'media/clip.mp4',
        size: 4,
        lastModified: 1,
        mimeType: 'video/mp4',
        fingerprint: null,
        reason: 'copied',
        error: null,
      }],
      errors: ['cancelled'],
    })
    await writeTextFileSafe(destination, 'Edit.myrelith', '{"format":"myrelith-project"}')
    const loaded = await loadCollectedArchive(destination)
    expect(loaded.complete).toBe(false)
    const inspection = await inspectCollectDestination(destination)
    expect(inspection.hasIncompleteMarker).toBe(true)
    expect(inspection.kind).toBe('incomplete')
  })
})

async function writeTextFileSafe(
  destination: CollectMediaDirectoryHandle,
  name: string,
  text: string,
): Promise<void> {
  const handle = await destination.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}
