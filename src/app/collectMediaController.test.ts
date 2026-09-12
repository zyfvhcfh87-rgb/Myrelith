import { beforeEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_PROJECT_SETTINGS,
  createTimelineDoc,
} from '../domain/projectSettings'
import type { PortableAssetDescriptor } from '../domain/projectFile'
import type { SequenceProject } from '../domain/projectSequences'
import type { MediaAsset } from '../domain/schema'
import type { TitleTemplateLibraryView } from '../domain/titleTemplates'
import {
  collectActiveProject,
  cancelCollectMedia,
  preflightCollectMedia,
  type CollectMediaControllerDeps,
} from './collectMediaController'
import {
  finalizeCollectArchive,
  inspectCollectDestination,
  loadCollectedArchive,
  prepareCollectDestination,
  writeBlobAtRelativePath,
  writeTextFile,
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
  readonly name = 'archive'
  readonly directories = new Map<string, MemoryDirectory>()
  readonly files = new Map<string, MemoryFileHandle>()

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
    const current = this.directories.get(name)
    if (current) return current
    if (!options?.create) throw missing(name)
    const created = new MemoryDirectory()
    Object.defineProperty(created, 'name', { value: name })
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

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-video',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 8,
    lastModified: 111,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 60,
    durationMicroseconds: 2_000_000,
    sourceBounds: {
      video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
      audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 },
    },
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"avc1"}',
    ...overrides,
  }
}

function descriptorFor(asset: MediaAsset): PortableAssetDescriptor {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    durationMicroseconds: asset.durationMicroseconds,
    sourceBounds: asset.sourceBounds,
    nativeFrameRate: asset.frameRate,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
  }
}

function emptyLibrary(): TitleTemplateLibraryView {
  return { templates: [], unavailable: [], readOnlyReason: null }
}

function projectFixture(): SequenceProject {
  const document = createTimelineDoc('Collect', DEFAULT_PROJECT_SETTINGS, 'seq-collect')
  return {
    id: 'doc-collect',
    name: 'Collect',
    rootSequenceId: document.id,
    sequences: [document],
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function createDeps(
  assets: MediaAsset[],
  extras: Partial<CollectMediaControllerDeps> = {},
): CollectMediaControllerDeps {
  const descriptors = assets.map(descriptorFor)
  const connected = new Map(assets.map((asset) => [asset.id, asset]))
  const blobs = new Map(assets.map((asset) => [
    asset.objectUrl,
    new Blob([new Uint8Array(asset.size).fill(7)]),
  ]))
  const project = extras.getProject?.() ?? projectFixture()
  return {
    now: () => 1_700_000_000_000,
    getBindingId: () => 'local-project:collect',
    getProject: () => project,
    getDescriptors: () => descriptors,
    getCollections: () => [],
    getConnectedAsset: (id) => connected.get(id),
    loadMediaHandle: async () => null,
    queryMediaPermission: async () => 'granted',
    readHandleFile: async () => new File([], 'missing'),
    fetchBlob: async (url) => blobs.get(url) ?? new Blob([]),
    listProxyStates: () => [],
    readProxyFile: async () => new File([], 'proxy.mp4'),
    loadTitleLibrary: async () => emptyLibrary(),
    readTitleTemplate: async () => {
      throw new Error('no template')
    },
    fingerprint: async () => ({
      algorithm: 'sha256-sampled-v1',
      digest: 'a'.repeat(64),
    }),
    prepareDestination: prepareCollectDestination,
    writeBlob: writeBlobAtRelativePath,
    writeProjectFile: writeTextFile,
    finalize: finalizeCollectArchive,
    ...extras,
  }
}

beforeEach(() => {
  cancelCollectMedia()
})

describe('collect-media controller', () => {
  test('preflight reports included and offline sources before copying', async () => {
    const online = makeAsset()
    const offline = makeAsset({
      id: 'asset-offline',
      fileName: 'offline.mp4',
      objectUrl: 'blob:offline',
    })
    const deps = createDeps([online], {
      getDescriptors: () => [descriptorFor(online), descriptorFor(offline)],
      getConnectedAsset: (id) => (id === online.id ? online : undefined),
    })
    const preflight = await preflightCollectMedia({
      includeProxies: false,
      includeTitleTemplates: false,
    }, deps)
    expect(preflight.includedCount).toBe(1)
    expect(preflight.offlineCount).toBe(1)
    expect(preflight.items.find((item) => item.id === online.id)?.plannedRelativePath)
      .toBe('media/source.mp4')
  })

  test('writes a complete archive with collision-safe paths', async () => {
    const first = makeAsset({ id: 'asset-a', fileName: 'Clip.mp4', objectUrl: 'blob:a', size: 12 })
    const second = makeAsset({ id: 'asset-b', fileName: 'clip.mp4', objectUrl: 'blob:b', size: 12 })
    const destination = new MemoryDirectory() as unknown as CollectMediaDirectoryHandle
    const result = await collectActiveProject(
      destination,
      { includeProxies: false, includeTitleTemplates: false },
      undefined,
      createDeps([first, second]),
    )
    expect(result.status).toBe('complete')
    if (result.status !== 'complete') return
    expect(result.projectFileName).toBe('Collect.myrelith')
    const paths = result.manifest.items
      .filter((item) => item.kind === 'asset')
      .map((item) => item.collectedRelativePath)
    expect(paths[0]).toBe('media/Clip.mp4')
    expect(paths[1]).toBe('media/clip-b.mp4')
    const loaded = await loadCollectedArchive(destination)
    expect(loaded.complete).toBe(true)
    const inspection = await inspectCollectDestination(destination)
    expect(inspection.hasIncompleteMarker).toBe(false)
    const copied = await (await destination.getDirectoryHandle('media')).getFileHandle('Clip.mp4')
    expect((await copied.getFile()).size).toBe(12)
  })

  test('cancellation leaves a marked partial archive', async () => {
    const first = makeAsset({ id: 'asset-a', fileName: 'one.mp4', objectUrl: 'blob:a', size: 4 })
    const second = makeAsset({ id: 'asset-b', fileName: 'two.mp4', objectUrl: 'blob:b', size: 4 })
    const destination = new MemoryDirectory() as unknown as CollectMediaDirectoryHandle
    const started = deferred()
    let copies = 0
    const deps = createDeps([first, second], {
      writeBlob: async (root, relativePath, blob, signal, onChunk) => {
        copies += 1
        if (copies === 2) {
          started.resolve()
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        return writeBlobAtRelativePath(root, relativePath, blob, signal, onChunk)
      },
    })
    const pending = collectActiveProject(
      destination,
      { includeProxies: false, includeTitleTemplates: false },
      undefined,
      deps,
    )
    await started.promise
    cancelCollectMedia()
    const result = await pending
    expect(result.status).toBe('partial')
    if (result.status !== 'partial') return
    expect(result.manifest.status).toBe('partial')
    const inspection = await inspectCollectDestination(destination)
    expect(inspection.hasIncompleteMarker).toBe(true)
    expect(inspection.kind).toBe('incomplete')
  })

  test('quota failure is partial and never reported complete', async () => {
    const first = makeAsset({ id: 'asset-a', fileName: 'ok.mp4', objectUrl: 'blob:a', size: 4 })
    const second = makeAsset({ id: 'asset-b', fileName: 'big.mp4', objectUrl: 'blob:b', size: 4 })
    const destination = new MemoryDirectory() as unknown as CollectMediaDirectoryHandle
    const deps = createDeps([first, second], {
      writeBlob: async (root, relativePath, blob, signal, onChunk) => {
        if (relativePath.endsWith('big.mp4')) {
          throw new DOMException('quota', 'QuotaExceededError')
        }
        return writeBlobAtRelativePath(root, relativePath, blob, signal, onChunk)
      },
    })
    const result = await collectActiveProject(
      destination,
      { includeProxies: false, includeTitleTemplates: false },
      undefined,
      deps,
    )
    expect(result.status).toBe('partial')
    if (result.status !== 'partial') return
    expect(result.message).toMatch(/quota|disk/i)
    expect(result.manifest.status).toBe('partial')
    expect(result.manifest.items.find((item) => item.id === 'asset-b')?.disposition)
      .toBe('excluded')
    const loaded = await loadCollectedArchive(destination)
    expect(loaded.complete).toBe(false)
  })

  test('permission loss is partial and never reported complete', async () => {
    const first = makeAsset({ id: 'asset-a', fileName: 'ok.mp4', objectUrl: 'blob:a', size: 4 })
    const second = makeAsset({ id: 'asset-b', fileName: 'locked.mp4', objectUrl: 'blob:b', size: 4 })
    const destination = new MemoryDirectory() as unknown as CollectMediaDirectoryHandle
    const deps = createDeps([first, second], {
      writeBlob: async (root, relativePath, blob, signal, onChunk) => {
        if (relativePath.endsWith('locked.mp4')) {
          throw new DOMException('denied', 'NotAllowedError')
        }
        return writeBlobAtRelativePath(root, relativePath, blob, signal, onChunk)
      },
    })
    const result = await collectActiveProject(
      destination,
      { includeProxies: false, includeTitleTemplates: false },
      undefined,
      deps,
    )
    expect(result.status).toBe('partial')
    if (result.status !== 'partial') return
    expect(result.message).toMatch(/permission/)
    expect(result.manifest.status).toBe('partial')
    expect(result.manifest.items.find((item) => item.id === 'asset-b')?.disposition)
      .toBe('excluded')
    const loaded = await loadCollectedArchive(destination)
    expect(loaded.complete).toBe(false)
  })

  test('occupied destinations fail without a complete archive', async () => {
    const asset = makeAsset()
    const destination = new MemoryDirectory()
    destination.files.set('notes.txt', new MemoryFileHandle('notes.txt'))
    const result = await collectActiveProject(
      destination as unknown as CollectMediaDirectoryHandle,
      { includeProxies: false, includeTitleTemplates: false },
      undefined,
      createDeps([asset]),
    )
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.message).toMatch(/empty folder/)
  })
})
