import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  CURRENT_PROJECT_FORMAT_VERSION,
  PROJECT_FILE_FORMAT,
  serializeProjectFile,
  type PortableAssetDescriptor,
  type ProjectFile,
} from '../domain/projectFile'
import {
  DEFAULT_PROJECT_SETTINGS,
  createTimelineDoc,
} from '../domain/projectSettings'
import type { MediaAsset } from '../domain/schema'
import type { MediaCompatibilityReport } from '../domain/mediaCompatibility'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import {
  activateResumedProject,
  openLoadedCollectedArchive,
  resetProjectController,
  type ProjectControllerDeps,
} from './projectController'
import type { LoadedCollectedArchive } from './collectMediaArchive'
import type { CollectMediaDirectoryHandle } from './collectMediaArchive'

function missing(name: string): DOMException {
  return new DOMException(`${name} was not found`, 'NotFoundError')
}

class MemoryFileHandle {
  readonly kind = 'file' as const
  bytes: Uint8Array<ArrayBuffer>
  readonly name: string

  constructor(name: string, bytes: Uint8Array<ArrayBuffer> = new Uint8Array()) {
    this.name = name
    this.bytes = bytes
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { type: 'video/mp4', lastModified: 9_999 })
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    return {
      write: async () => {},
      close: async () => {},
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
  const asset: MediaAsset = {
    id: 'asset-1',
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
  const exact = {
    status: 'exact' as const,
    firstTimestampUs: 0,
    endTimestampUs: asset.durationMicroseconds,
  }
  return {
    ...asset,
    sourceBounds: {
      video: asset.kind === 'video' ? exact : null,
      audio: asset.hasAudio ? exact : null,
    },
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

function readyReport(asset: MediaAsset): MediaCompatibilityReport {
  return {
    status: 'ready',
    container: {
      name: 'MP4',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4',
    },
    durationMicroseconds: asset.durationMicroseconds,
    tracks: [],
    reason: null,
    detail: null,
  }
}

function readyInspection(asset: MediaAsset): MediaProbeResult {
  return { status: 'ready', asset, compatibility: readyReport(asset) }
}

function makeProject(assets: PortableAssetDescriptor[]): ProjectFile {
  const document = createTimelineDoc('Collected', DEFAULT_PROJECT_SETTINGS, 'doc-collected')
  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    id: document.id,
    name: 'Collected',
    rootSequenceId: document.id,
    sequences: [document],
    multicams: [],
    colorLuts: [],
    assets,
    collections: [],
  }
}

function makeDeps(overrides: Partial<ProjectControllerDeps> = {}): ProjectControllerDeps {
  let compatibilityRequestId = 0
  return {
    createDocumentId: vi.fn(() => 'doc-new'),
    createProjectBindingId: vi.fn(() => 'local-project:collected'),
    createCompatibilityRequestId: vi.fn(() => `compat-${++compatibilityRequestId}`),
    now: vi.fn(() => 1_234),
    readText: vi.fn(async (file) => file.text()),
    inspectMedia: vi.fn(async () => readyInspection(makeAsset({ objectUrl: 'blob:collected' }))),
    disposeExport: vi.fn(async () => undefined),
    disposeTransport: vi.fn(async () => undefined),
    disposePreview: vi.fn(async () => undefined),
    disposePlugins: vi.fn(async () => undefined),
    disposeMediaVisuals: vi.fn(),
    resetMediaImport: vi.fn(),
    pauseProjectPersistence: vi.fn(async () => undefined),
    discardProjectRecovery: vi.fn(async () => undefined),
    resumeProjectPersistence: vi.fn(),
    startProjectPersistence: vi.fn(),
    suspendProjectPersistence: vi.fn(),
    loadMediaHandle: vi.fn(async () => null),
    rememberMediaHandle: vi.fn(async () => undefined),
    forgetMediaHandle: vi.fn(async () => undefined),
    queryMediaPermission: vi.fn(async () => 'granted' as const),
    requestMediaPermission: vi.fn(async () => 'granted' as const),
    pickMediaFiles: vi.fn(async () => []),
    pickMediaFolder: vi.fn(async () => []),
    pickProjectFile: vi.fn(async () => {
      throw new DOMException('cancelled', 'AbortError')
    }),
    requestProjectPermission: vi.fn(async () => 'granted' as const),
    getRecentProject: vi.fn(() => null),
    getRecoveryJournal: vi.fn(() => null),
    rememberRecentProject: vi.fn(async () => undefined),
    revokeObjectURL: vi.fn(),
    ...overrides,
  }
}

beforeEach(async () => {
  await resetProjectController()
  useProjectSessionStore.setState({ ...INITIAL_PROJECT_SESSION_STATE, screen: 'resume' })
  useMediaStore.getState().clearAssets()
})

describe('collected archive reopen', () => {
  test('resolves collected media without the original file location', async () => {
    const original = makeAsset()
    const serialized = serializeProjectFile(makeProject([descriptorFor(original)]))
    const root = new MemoryDirectory()
    const media = new MemoryDirectory()
    root.directories.set('media', media)
    media.files.set('source.mp4', new MemoryFileHandle('source.mp4', new Uint8Array(8)))
    const projectHandle = new MemoryFileHandle(
      'Collected.myrelith',
      new TextEncoder().encode(serialized),
    )
    root.files.set('Collected.myrelith', projectHandle)
    const archive: LoadedCollectedArchive = {
      root: root as unknown as CollectMediaDirectoryHandle,
      complete: true,
      projectFile: await projectHandle.getFile(),
      projectHandle,
      manifest: {
        format: 'myrelith-collect-media',
        formatVersion: 1,
        status: 'complete',
        createdAt: 1,
        projectFileName: 'Collected.myrelith',
        inclusionPolicy: { includeProxies: false, includeTitleTemplates: false },
        items: [{
          id: original.id,
          kind: 'asset',
          disposition: 'included',
          originalFileName: 'source.mp4',
          collectedRelativePath: 'media/source.mp4',
          size: 8,
          lastModified: 111,
          mimeType: 'video/mp4',
          fingerprint: null,
          reason: 'copied',
          error: null,
        }],
        errors: [],
      },
    }
    const deps = makeDeps()
    await expect(openLoadedCollectedArchive(archive, deps)).resolves.toEqual({
      status: 'ready',
    })
    const candidate = useProjectSessionStore.getState().candidate
    expect(candidate?.origin).toBe('collected-archive')
    expect(candidate?.collectedArchiveStatus).toBe('complete')
    expect(candidate?.assets[0]?.status).toBe('ready')
    await expect(activateResumedProject(deps)).resolves.toEqual({ status: 'activated' })
    expect(useMediaStore.getState().assets.has(original.id)).toBe(true)
    expect(deps.loadMediaHandle).not.toHaveBeenCalled()
    expect(deps.rememberMediaHandle).toHaveBeenCalledTimes(1)
  })

  test('never presents a partial archive as complete', async () => {
    const original = makeAsset()
    const serialized = serializeProjectFile(makeProject([descriptorFor(original)]))
    const root = new MemoryDirectory()
    const projectHandle = new MemoryFileHandle(
      'Collected.myrelith',
      new TextEncoder().encode(serialized),
    )
    root.files.set('Collected.myrelith', projectHandle)
    const archive: LoadedCollectedArchive = {
      root: root as unknown as CollectMediaDirectoryHandle,
      complete: false,
      projectFile: await projectHandle.getFile(),
      projectHandle,
      manifest: {
        format: 'myrelith-collect-media',
        formatVersion: 1,
        status: 'partial',
        createdAt: 1,
        projectFileName: 'Collected.myrelith',
        inclusionPolicy: { includeProxies: false, includeTitleTemplates: false },
        items: [{
          id: original.id,
          kind: 'asset',
          disposition: 'offline',
          originalFileName: 'source.mp4',
          collectedRelativePath: null,
          size: 8,
          lastModified: 111,
          mimeType: 'video/mp4',
          fingerprint: null,
          reason: 'offline',
          error: 'cancelled',
        }],
        errors: ['cancelled'],
      },
    }
    await expect(openLoadedCollectedArchive(archive, makeDeps())).resolves.toEqual({
      status: 'ready',
    })
    const session = useProjectSessionStore.getState()
    expect(session.candidate?.collectedArchiveStatus).toBe('partial')
    expect(session.error).toMatch(/incomplete/)
    expect(session.candidate?.assets[0]?.status).toBe('missing')
  })
})
