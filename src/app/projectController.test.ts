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
  type ProjectSettings,
} from '../domain/projectSettings'
import type { MediaAsset } from '../domain/schema'
import type { MediaCompatibilityReport } from '../domain/mediaCompatibility'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import {
  activateResumedProject,
  cancelActiveMediaRelink,
  chooseActiveAssetMedia,
  chooseActiveMediaFolder,
  chooseProjectFile,
  chooseProjectMedia,
  connectActiveMediaFolder,
  connectProjectMedia,
  createNewProject,
  leaveActiveProject,
  openProjectFile,
  openRecentProject,
  openRecoveryProject,
  resetProjectController,
  resolveActiveMediaAmbiguity,
  returnToProjectHome,
  skipActiveMediaAmbiguity,
  type ProjectControllerDeps,
} from './projectController'
import type {
  LocalMediaFileHandle,
  LocalMediaFolderSelection,
} from './localMediaHandles'
import {
  LOCAL_PROJECT_RECORD_VERSION,
  type LocalProjectFileHandle,
  type RecentProjectRecord,
  type RecoveryJournalRecord,
} from './localProjectStorage'

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-temp',
    fileName: 'source.mp4',
    mimeType: 'video/mp4',
    size: 8,
    lastModified: 111,
    objectUrl: 'blob:source',
    kind: 'video',
    durationFrames: 60,
    durationMicroseconds: 2_000_000,
    frameRate: { num: 60, den: 1 },
    width: 1920,
    height: 1080,
    hasAudio: true,
    audioSampleRate: 48_000,
    audioChannels: 2,
    decoderConfigB64: '{"codec":"avc1.64042a"}',
    ...overrides,
  }
}

function readyReport(
  overrides: Partial<MediaCompatibilityReport> = {},
): MediaCompatibilityReport {
  return {
    status: 'ready',
    container: {
      name: 'MP4',
      mimeType: 'video/mp4',
      fullMimeType: 'video/mp4; codecs="avc1.64042a, mp4a.40.2"',
    },
    durationMicroseconds: 2_000_000,
    tracks: [],
    reason: null,
    detail: null,
    ...overrides,
  }
}

function readyInspection(asset: MediaAsset): MediaProbeResult {
  return {
    status: 'ready',
    asset,
    compatibility: readyReport({
      durationMicroseconds: asset.durationMicroseconds,
    }),
  }
}

function unsupportedInspection(
  detail = 'The primary video codec is not supported in this browser.',
  asset = makeAsset(),
): MediaProbeResult {
  const tracks: MediaCompatibilityReport['tracks'] = []
  if (asset.kind === 'video') {
    tracks.push({
      kind: 'video',
      number: 1,
      primary: true,
      codec: 'prores',
      codecParameter: 'ap4h',
      internalCodecId: 'ap4h',
      decoderConfig: null,
      decodable: false,
      reason: 'unsupported-codec',
      detail,
      width: asset.width,
      height: asset.height,
      codedWidth: asset.width,
      codedHeight: asset.height,
      frameRate: asset.frameRate,
      sampleRate: null,
      channels: null,
    })
  }
  if (asset.hasAudio) {
    tracks.push({
      kind: 'audio',
      number: 1,
      primary: true,
      codec: 'aac',
      codecParameter: 'mp4a.40.2',
      internalCodecId: 'mp4a',
      decoderConfig: null,
      decodable: true,
      reason: null,
      detail: null,
      width: null,
      height: null,
      codedWidth: null,
      codedHeight: null,
      frameRate: null,
      sampleRate: asset.audioSampleRate,
      channels: asset.audioChannels,
    })
  }
  return {
    status: 'unsupported',
    asset: null,
    compatibility: {
      ...readyReport(),
      status: 'unsupported',
      durationMicroseconds: asset.durationMicroseconds,
      tracks,
      reason: 'unsupported-codec',
      detail,
    },
  }
}

function descriptorFrom(
  asset: MediaAsset,
  overrides: Partial<PortableAssetDescriptor> = {},
): PortableAssetDescriptor {
  return {
    id: 'asset-stable',
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    kind: asset.kind,
    durationMicroseconds: asset.durationMicroseconds,
    nativeFrameRate: asset.frameRate,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    audioSampleRate: asset.audioSampleRate,
    audioChannels: asset.audioChannels,
    ...overrides,
  }
}

function makeProject(
  assets: PortableAssetDescriptor[] = [],
  name = 'Saved project',
): ProjectFile {
  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document: createTimelineDoc(
      name,
      DEFAULT_PROJECT_SETTINGS,
      'doc-saved',
    ),
    assets,
  }
}

function makeDeps(
  overrides: Partial<ProjectControllerDeps> = {},
): ProjectControllerDeps {
  let compatibilityRequestId = 0
  return {
    createDocumentId: vi.fn(() => 'doc-new'),
    createCompatibilityRequestId: vi.fn(
      () => `compat-test-${++compatibilityRequestId}`,
    ),
    now: vi.fn(() => 1_234),
    readText: vi.fn(async () => ''),
    inspectMedia: vi.fn(async () => readyInspection(makeAsset())),
    disposeExport: vi.fn(async () => undefined),
    disposeTransport: vi.fn(async () => undefined),
    disposePreview: vi.fn(),
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
    revokeObjectURL: vi.fn((url) => URL.revokeObjectURL(url)),
    ...overrides,
  }
}

function makeHandle(file: File): LocalMediaFileHandle {
  return {
    kind: 'file',
    name: file.name,
    getFile: vi.fn(async () => file),
    isSameEntry: vi.fn(async () => false),
  } as unknown as LocalMediaFileHandle
}

function makeProjectHandle(file: File): LocalProjectFileHandle {
  return {
    kind: 'file',
    name: file.name,
    getFile: vi.fn(async () => file),
    isSameEntry: vi.fn(async () => false),
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

function makeFolderSelection(
  fileName: string,
  relativePath = `media/${fileName}`,
  lastModified = 999,
): LocalMediaFolderSelection {
  const file = new File(['12345678'], fileName, {
    type: 'video/mp4',
    lastModified,
  })
  return { file, handle: makeHandle(file), relativePath }
}

async function activateSavedProject(
  descriptors: readonly PortableAssetDescriptor[],
  overrides: Partial<ProjectControllerDeps> = {},
): Promise<ProjectControllerDeps> {
  const serialized = serializeProjectFile(makeProject([...descriptors]))
  const deps = makeDeps({
    readText: vi.fn(async () => serialized),
    ...overrides,
  })
  await expect(openProjectFile(
    new File([serialized], 'offline.webcut'),
    deps,
  )).resolves.toEqual({ status: 'ready' })
  await expect(activateResumedProject(deps)).resolves.toEqual({
    status: 'activated',
  })
  return deps
}

function installOfflineCompatibility(
  descriptor: PortableAssetDescriptor,
  report: MediaCompatibilityReport,
): void {
  const requestId = 'previous-compatibility'
  const media = useMediaStore.getState()
  expect(media.startCompatibility({
    id: descriptor.id,
    requestId,
    fileName: descriptor.fileName,
    declaredMimeType: descriptor.mimeType,
    size: descriptor.size,
    lastModified: descriptor.lastModified,
    status: 'checking',
    report: null,
  })).toBe(true)
  expect(useMediaStore.getState().setCompatibility(
    descriptor.id,
    requestId,
    report.status,
    report,
  )).toBe(true)
}

beforeEach(() => {
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  resetProjectController({ revokeObjectURL: URL.revokeObjectURL })
  useDocumentStore.getState().setDoc(createTimelineDoc(
    'Current project',
    DEFAULT_PROJECT_SETTINGS,
    'doc-current',
  ))
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
  })
  useTransportStore.getState().resetTransport()
})

describe('new-project activation', () => {
  test('waits for old consumers, resets the full session, and keeps exact settings', async () => {
    const oldAsset = makeAsset({
      id: 'asset-old',
      objectUrl: 'blob:old-source',
    })
    useMediaStore.getState().addAsset(oldAsset)
    useMediaStore.getState().setAssetVisuals(oldAsset.id, {
      filmstrip: {
        url: 'blob:old-strip',
        tiles: 2,
        tileWidth: 80,
        tileHeight: 45,
      },
      waveform: null,
    })
    useTransportStore.setState({
      playheadFrame: 90,
      isPlaying: true,
      zoom: 4,
      tool: 'slide',
      selectedClipId: 'clip-old',
    })

    const cleanupGate = deferred<void>()
    const disposeTransport = vi.fn(() => cleanupGate.promise)
    const deps = makeDeps({ disposeTransport })
    const settings: ProjectSettings = {
      width: 3840,
      height: 2160,
      frameRate: { num: 60, den: 1 },
      audioSampleRate: 96_000,
    }

    const result = createNewProject('Cinema', settings, deps)
    await flush()
    expect(disposeTransport).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    cleanupGate.resolve()
    await expect(result).resolves.toEqual({ status: 'activated' })

    expect(useDocumentStore.getState().doc).toMatchObject({
      id: 'doc-new',
      name: 'Cinema',
      width: 3840,
      height: 2160,
      frameRate: { num: 60, den: 1 },
      audioSampleRate: 96_000,
    })
    expect(useDocumentStore.getState().past).toEqual([])
    expect(useMediaStore.getState().assets.size).toBe(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-source')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-strip')
    expect(useTransportStore.getState()).toMatchObject({
      playheadFrame: 0,
      isPlaying: false,
      zoom: 1,
      tool: 'select',
      selectedClipId: null,
    })
    expect(useProjectSessionStore.getState()).toMatchObject({
      screen: 'editor',
      activeProjectName: 'Cinema',
      activeProjectFileName: null,
    })
    expect(deps.suspendProjectPersistence).toHaveBeenCalledOnce()
    expect(deps.pauseProjectPersistence).toHaveBeenCalledOnce()
    expect(deps.resumeProjectPersistence).not.toHaveBeenCalled()
    expect(deps.startProjectPersistence).toHaveBeenCalledWith({
      fileName: null,
      persisted: false,
    })
  })

  test('invalid settings preserve the current document and never start cleanup', async () => {
    const current = useDocumentStore.getState().doc
    const deps = makeDeps()

    await expect(
      createNewProject('   ', DEFAULT_PROJECT_SETTINGS, deps),
    ).resolves.toMatchObject({ status: 'failed' })

    expect(useDocumentStore.getState().doc).toBe(current)
    expect(deps.disposeExport).not.toHaveBeenCalled()
    expect(deps.disposeTransport).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState()).toMatchObject({
      screen: 'new-project',
      phase: 'error',
    })
  })
})

describe('active-project cleanup', () => {
  test('waits for Blob consumers before revoking media and returning Home', async () => {
    const asset = makeAsset({
      id: 'asset-active',
      objectUrl: 'blob:active-source',
    })
    useMediaStore.getState().addAsset(asset)
    useMediaStore.getState().setAssetVisuals(asset.id, {
      filmstrip: {
        url: 'blob:active-strip',
        tiles: 2,
        tileWidth: 80,
        tileHeight: 45,
      },
      waveform: null,
    })
    useTransportStore.setState({ isPlaying: true, playheadFrame: 42 })
    useProjectSessionStore.setState({
      screen: 'editor',
      activeProjectName: 'Leaving safely',
      hasUnsavedChanges: true,
    })

    const persistenceGate = deferred<void>()
    const transportGate = deferred<void>()
    const deps = makeDeps({
      pauseProjectPersistence: vi.fn(() => persistenceGate.promise),
      disposeTransport: vi.fn(() => transportGate.promise),
    })

    const leaving = leaveActiveProject(deps)
    await flush()
    expect(deps.pauseProjectPersistence).toHaveBeenCalledOnce()
    expect(useProjectSessionStore.getState().phase).toBe('closing')
    expect(deps.disposeExport).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    persistenceGate.resolve()
    await flush()
    expect(deps.discardProjectRecovery).toHaveBeenCalledOnce()
    expect(deps.disposeExport).toHaveBeenCalledOnce()
    expect(deps.disposeTransport).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(deps.suspendProjectPersistence).not.toHaveBeenCalled()

    transportGate.resolve()
    await expect(leaving).resolves.toEqual({ status: 'ready' })

    expect(deps.disposePreview).toHaveBeenCalledOnce()
    expect(deps.disposeMediaVisuals).toHaveBeenCalledOnce()
    expect(deps.resetMediaImport).toHaveBeenCalledOnce()
    expect(deps.suspendProjectPersistence).toHaveBeenCalledOnce()
    expect(deps.resumeProjectPersistence).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:active-source')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:active-strip')
    expect(useMediaStore.getState().assets.size).toBe(0)
    expect(useTransportStore.getState()).toMatchObject({
      isPlaying: false,
      playheadFrame: 0,
    })
    expect(useProjectSessionStore.getState()).toEqual(
      INITIAL_PROJECT_SESSION_STATE,
    )
  })

  test('a late leave cannot clear a newer editor session', async () => {
    const oldAsset = makeAsset({
      id: 'asset-old-session',
      objectUrl: 'blob:old-session',
    })
    useMediaStore.getState().addAsset(oldAsset)
    useProjectSessionStore.setState({ screen: 'editor' })

    const leaveGate = deferred<void>()
    const leaveDeps = makeDeps({
      disposeTransport: vi.fn(() => leaveGate.promise),
    })
    const leaving = leaveActiveProject(leaveDeps)
    await flush()

    const createDeps = makeDeps({ createDocumentId: vi.fn(() => 'doc-newer') })
    await expect(createNewProject(
      'Newer project',
      DEFAULT_PROJECT_SETTINGS,
      createDeps,
    )).resolves.toEqual({ status: 'activated' })
    const newerAsset = makeAsset({
      id: 'asset-new-session',
      objectUrl: 'blob:new-session',
    })
    useMediaStore.getState().addAsset(newerAsset)

    leaveGate.resolve()
    await expect(leaving).resolves.toEqual({ status: 'cancelled' })

    expect(leaveDeps.disposePreview).not.toHaveBeenCalled()
    expect(leaveDeps.suspendProjectPersistence).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().doc).toMatchObject({
      id: 'doc-newer',
      name: 'Newer project',
    })
    expect(useMediaStore.getState().assets.get(newerAsset.id)).toBe(newerAsset)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:new-session')
    expect(useProjectSessionStore.getState().screen).toBe('editor')
  })

  test('a failed consumer drain keeps the active editor and its media intact', async () => {
    const asset = makeAsset({
      id: 'asset-still-active',
      objectUrl: 'blob:still-active',
    })
    useMediaStore.getState().addAsset(asset)
    useProjectSessionStore.setState({
      screen: 'editor',
      activeProjectName: 'Still active',
    })
    const deps = makeDeps({
      disposeTransport: vi.fn(async () => {
        throw new Error('audio drain failed')
      }),
    })

    await expect(leaveActiveProject(deps)).resolves.toEqual({
      status: 'failed',
      message: 'Could not return to Projects: audio drain failed',
    })

    expect(deps.disposePreview).not.toHaveBeenCalled()
    expect(deps.suspendProjectPersistence).not.toHaveBeenCalled()
    expect(deps.resumeProjectPersistence).toHaveBeenCalledOnce()
    expect(useMediaStore.getState().assets.get(asset.id)).toBe(asset)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:still-active')
    expect(useProjectSessionStore.getState()).toMatchObject({
      screen: 'editor',
      phase: 'error',
      activeProjectName: 'Still active',
      error: 'Could not return to Projects: audio drain failed',
    })
  })

  test('a failed recovery discard keeps the editor intact before Blob cleanup', async () => {
    const asset = makeAsset({
      id: 'asset-recovery-retained',
      objectUrl: 'blob:recovery-retained',
    })
    useMediaStore.getState().addAsset(asset)
    useProjectSessionStore.setState({
      screen: 'editor',
      activeProjectName: 'Still recoverable',
    })
    const deps = makeDeps({
      discardProjectRecovery: vi.fn(async () => {
        throw new Error('local storage unavailable')
      }),
    })

    await expect(leaveActiveProject(deps)).resolves.toEqual({
      status: 'failed',
      message: 'Could not return to Projects: local storage unavailable',
    })

    expect(deps.disposeExport).not.toHaveBeenCalled()
    expect(deps.disposeTransport).not.toHaveBeenCalled()
    expect(deps.resumeProjectPersistence).toHaveBeenCalledOnce()
    expect(useMediaStore.getState().assets.get(asset.id)).toBe(asset)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(
      'blob:recovery-retained',
    )
  })
})

describe('portable project resume', () => {
  test('a corrupt candidate never replaces the active session', async () => {
    const current = useDocumentStore.getState().doc
    const oldAsset = makeAsset({ id: 'old', objectUrl: 'blob:old' })
    useMediaStore.getState().addAsset(oldAsset)
    const deps = makeDeps({ readText: vi.fn(async () => '{broken') })
    const file = new File(['x'], 'broken.webcut')

    await expect(openProjectFile(file, deps)).resolves.toMatchObject({
      status: 'failed',
    })

    expect(useDocumentStore.getState().doc).toBe(current)
    expect(useMediaStore.getState().assets.get('old')).toBe(oldAsset)
    expect(deps.disposeExport).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState()).toMatchObject({
      screen: 'resume',
      phase: 'error',
      candidate: null,
    })
  })

  test('valid projects without media wait for explicit confirmation', async () => {
    const current = useDocumentStore.getState().doc
    const serialized = serializeProjectFile(makeProject([], 'Empty saved work'))
    const deps = makeDeps({ readText: vi.fn(async () => serialized) })
    const file = new File([serialized], 'empty.webcut')

    await expect(openProjectFile(file, deps)).resolves.toEqual({ status: 'ready' })
    expect(useDocumentStore.getState().doc).toBe(current)
    expect(useProjectSessionStore.getState().candidate).toMatchObject({
      projectName: 'Empty saved work',
      assets: [],
    })

    await expect(activateResumedProject(deps)).resolves.toEqual({
      status: 'activated',
    })
    expect(useDocumentStore.getState().doc.name).toBe('Empty saved work')
    expect(useProjectSessionStore.getState()).toMatchObject({
      screen: 'editor',
      activeProjectFileName: 'empty.webcut',
    })
    expect(deps.startProjectPersistence).toHaveBeenCalledWith({
      fileName: 'empty.webcut',
      persisted: true,
    })
  })

  test('the Chrome project picker remembers a validated reusable handle', async () => {
    const serialized = serializeProjectFile(makeProject([], 'Picker project'))
    const file = new File([serialized], 'picker.webcut')
    const handle = makeProjectHandle(file)
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      pickProjectFile: vi.fn(async () => ({ file, handle })),
    })

    await expect(chooseProjectFile(deps)).resolves.toEqual({ status: 'ready' })
    await flush()

    expect(useProjectSessionStore.getState().candidate).toMatchObject({
      origin: 'file',
      projectName: 'Picker project',
    })
    expect(deps.rememberRecentProject).toHaveBeenCalledWith({
      documentId: 'doc-saved',
      projectName: 'Picker project',
      fileName: 'picker.webcut',
      lastOpenedAt: 1_234,
      handle,
    })
  })

  test('a Recent click starts permission synchronously and verifies document identity', async () => {
    const serialized = serializeProjectFile(makeProject([], 'Recent project'))
    const file = new File([serialized], 'recent.webcut')
    const handle = makeProjectHandle(file)
    const permission = deferred<'granted'>()
    const record: RecentProjectRecord = {
      version: LOCAL_PROJECT_RECORD_VERSION,
      documentId: 'doc-saved',
      projectName: 'Recent project',
      fileName: 'recent.webcut',
      lastOpenedAt: 10,
      handle,
    }
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      getRecentProject: vi.fn(() => record),
      requestProjectPermission: vi.fn(() => permission.promise),
    })

    const opening = openRecentProject('doc-saved', deps)
    expect(deps.requestProjectPermission).toHaveBeenCalledWith(handle)
    expect(handle.getFile).not.toHaveBeenCalled()
    permission.resolve('granted')

    await expect(opening).resolves.toEqual({ status: 'ready' })
    expect(useProjectSessionStore.getState().candidate).toMatchObject({
      origin: 'recent',
      projectName: 'Recent project',
    })

    const staleDeps = makeDeps({
      readText: vi.fn(async () => serialized),
      getRecentProject: vi.fn(() => ({
        ...record,
        documentId: 'different-document',
      })),
    })
    await expect(openRecentProject('different-document', staleDeps))
      .resolves.toMatchObject({ status: 'failed' })
    expect(useProjectSessionStore.getState().error)
      .toContain('points to a different project')
  })

  test('recovery falls back to a valid generation and activates as unsaved', async () => {
    const serialized = serializeProjectFile(makeProject([], 'Recovered project'))
    const record: RecoveryJournalRecord = {
      version: LOCAL_PROJECT_RECORD_VERSION,
      journalId: 'journal-recovery',
      documentId: 'doc-saved',
      projectName: 'Recovered project',
      projectFileName: 'Recovered.webcut',
      updatedAt: 200,
      generations: [{
        snapshotId: 'snapshot-good',
        capturedAt: 100,
        serializedProject: serialized,
      }, {
        snapshotId: 'snapshot-corrupt',
        capturedAt: 200,
        serializedProject: '{broken',
      }],
    }
    const deps = makeDeps({
      getRecoveryJournal: vi.fn(() => record),
    })

    await expect(openRecoveryProject('journal-recovery', deps))
      .resolves.toEqual({ status: 'ready' })
    expect(useProjectSessionStore.getState().candidate).toMatchObject({
      origin: 'recovery',
      projectName: 'Recovered project',
    })

    await expect(activateResumedProject(deps)).resolves.toEqual({
      status: 'activated',
    })
    expect(deps.startProjectPersistence).toHaveBeenCalledWith({
      fileName: 'Recovered.webcut',
      persisted: false,
      recoveryJournalId: 'journal-recovery',
      recoveryCapturedAt: 100,
    })
  })

  test('image-source projects fail honestly before entering an unusable relink state', async () => {
    const image = makeAsset({
      kind: 'image',
      frameRate: null,
      width: 800,
      height: 600,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
      decoderConfigB64: null,
    })
    const serialized = serializeProjectFile(
      makeProject([descriptorFrom(image)]),
    )
    const deps = makeDeps({ readText: vi.fn(async () => serialized) })

    await expect(
      openProjectFile(new File([serialized], 'image.webcut'), deps),
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('cannot reconnect yet'),
    })
    expect(useProjectSessionStore.getState().candidate).toBeNull()
    expect(deps.inspectMedia).not.toHaveBeenCalled()
  })

  test('automatically reconnects a remembered source whose read grant persists', async () => {
    const analyzed = makeAsset({
      id: 'session-id',
      objectUrl: 'blob:auto-restored',
    })
    const descriptor = descriptorFrom(analyzed)
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const source = new File(['12345678'], 'source.mp4', {
      type: 'video/mp4',
      lastModified: analyzed.lastModified,
    })
    const handle = makeHandle(source)
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      loadMediaHandle: vi.fn(async () => handle),
      queryMediaPermission: vi.fn(async () => 'granted' as const),
      inspectMedia: vi.fn(async () => readyInspection(analyzed)),
    })

    await expect(
      openProjectFile(new File([serialized], 'remembered.webcut'), deps),
    ).resolves.toEqual({ status: 'ready' })

    expect(deps.loadMediaHandle).toHaveBeenCalledWith(
      'doc-saved',
      'asset-stable',
    )
    expect(deps.queryMediaPermission).toHaveBeenCalledWith(handle)
    expect(deps.inspectMedia).toHaveBeenCalledOnce()
    expect(useProjectSessionStore.getState().candidate?.assets).toEqual([{
      id: 'asset-stable',
      fileName: 'source.mp4',
      kind: 'video',
      status: 'ready',
    }])

    await expect(activateResumedProject(deps)).resolves.toEqual({
      status: 'activated',
    })
    expect(useMediaStore.getState().assets.get('asset-stable')).toMatchObject({
      id: 'asset-stable',
      objectUrl: 'blob:auto-restored',
    })
    expect(useMediaStore.getState().compatibility.get('asset-stable'))
      .toMatchObject({
        id: 'asset-stable',
        status: 'ready',
        report: { status: 'ready', container: { name: 'MP4' } },
      })
    expect(deps.requestMediaPermission).not.toHaveBeenCalled()
  })

  test('keeps an unchanged unsupported remembered handle and opens it offline with diagnostics', async () => {
    const expected = makeAsset()
    const descriptor = descriptorFrom(expected)
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const source = new File(['12345678'], descriptor.fileName, {
      type: descriptor.mimeType,
      lastModified: descriptor.lastModified,
    })
    const handle = makeHandle(source)
    const inspection = unsupportedInspection('Native ProRes decoding is unavailable.')
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      loadMediaHandle: vi.fn(async () => handle),
      queryMediaPermission: vi.fn(async () => 'granted' as const),
      inspectMedia: vi.fn(async () => inspection),
    })

    await expect(openProjectFile(
      new File([serialized], 'unsupported.webcut'),
      deps,
    )).resolves.toEqual({ status: 'ready' })
    expect(deps.forgetMediaHandle).not.toHaveBeenCalled()

    await expect(activateResumedProject(deps)).resolves.toEqual({
      status: 'activated',
    })
    const media = useMediaStore.getState()
    expect(media.assets.has(descriptor.id)).toBe(false)
    expect(media.compatibility.get(descriptor.id)).toEqual({
      id: descriptor.id,
      requestId: 'compat-test-1',
      fileName: descriptor.fileName,
      declaredMimeType: descriptor.mimeType,
      size: descriptor.size,
      lastModified: descriptor.lastModified,
      status: 'unsupported',
      report: inspection.compatibility,
    })
  })

  test('an incompatible manual handle supersedes an old permission-prompt handle', async () => {
    const expected = makeAsset()
    const descriptor = descriptorFrom(expected)
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const oldFile = new File(['12345678'], descriptor.fileName, {
      type: descriptor.mimeType,
      lastModified: descriptor.lastModified,
    })
    const replacement = new File(['abcdefgh'], descriptor.fileName, {
      type: descriptor.mimeType,
      lastModified: descriptor.lastModified + 1,
    })
    const oldHandle = makeHandle(oldFile)
    const replacementHandle = makeHandle(replacement)
    const inspection = unsupportedInspection(
      'The replacement codec is unavailable in this browser.',
    )
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      loadMediaHandle: vi.fn(async () => oldHandle),
      queryMediaPermission: vi.fn(async () => 'prompt' as const),
      pickMediaFiles: vi.fn(async () => [{
        file: replacement,
        handle: replacementHandle,
      }]),
      inspectMedia: vi.fn(async () => inspection),
    })

    await openProjectFile(new File([serialized], 'prompt.webcut'), deps)
    expect(useProjectSessionStore.getState().candidate?.assets[0].status)
      .toBe('remembered')

    await expect(chooseProjectMedia(deps)).resolves.toEqual({
      status: 'failed',
      message: inspection.compatibility.detail,
    })
    expect(deps.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-saved',
      descriptor.id,
      replacementHandle,
    )
    expect(useProjectSessionStore.getState().candidate?.assets[0].status)
      .toBe('missing')

    await expect(activateResumedProject(deps)).resolves.toEqual({
      status: 'activated',
    })
    expect(deps.requestMediaPermission).not.toHaveBeenCalled()
    expect(deps.inspectMedia).toHaveBeenCalledOnce()
    expect(useMediaStore.getState().assets.has(descriptor.id)).toBe(false)
    expect(useMediaStore.getState().compatibility.get(descriptor.id))
      .toMatchObject({ status: 'unsupported', report: inspection.compatibility })
  })

  test('does not attach or remember a non-Ready report that contradicts the descriptor', async () => {
    const expected = makeAsset()
    const descriptor = descriptorFrom(expected)
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const selected = new File(['abcdefgh'], descriptor.fileName, {
      type: descriptor.mimeType,
      lastModified: descriptor.lastModified,
    })
    const handle = makeHandle(selected)
    const inspection = unsupportedInspection(
      'The selected codec is unavailable.',
      makeAsset({
        durationMicroseconds: expected.durationMicroseconds + 1_000_000,
        width: 1280,
        height: 720,
      }),
    )
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      pickMediaFiles: vi.fn(async () => [{ file: selected, handle }]),
      inspectMedia: vi.fn(async () => inspection),
    })

    await openProjectFile(new File([serialized], 'mismatch.webcut'), deps)
    await expect(chooseProjectMedia(deps)).resolves.toEqual({
      status: 'failed',
      message: inspection.compatibility.detail,
    })

    expect(deps.rememberMediaHandle).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState().candidate?.assets[0].status)
      .toBe('missing')
    await expect(activateResumedProject(deps)).resolves.toEqual({
      status: 'activated',
    })
    expect(useMediaStore.getState().compatibility.has(descriptor.id)).toBe(false)
  })

  test('uses the Open click to grant a remembered source, then activates', async () => {
    const analyzed = makeAsset({ objectUrl: 'blob:permission-restored' })
    const descriptor = descriptorFrom(analyzed)
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const source = new File(['12345678'], 'source.mp4', {
      type: 'video/mp4',
      lastModified: analyzed.lastModified,
    })
    const handle = makeHandle(source)
    const requestMediaPermission = vi.fn(async () => 'granted' as const)
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      loadMediaHandle: vi.fn(async () => handle),
      queryMediaPermission: vi.fn(async () => 'prompt' as const),
      requestMediaPermission,
      inspectMedia: vi.fn(async () => readyInspection(analyzed)),
    })
    await openProjectFile(new File([serialized], 'permission.webcut'), deps)

    expect(useProjectSessionStore.getState().candidate?.assets[0].status)
      .toBe('remembered')
    expect(deps.inspectMedia).not.toHaveBeenCalled()

    const opening = activateResumedProject(deps)
    expect(requestMediaPermission).toHaveBeenCalledOnce()
    await expect(opening).resolves.toEqual({ status: 'activated' })
    expect(deps.inspectMedia).toHaveBeenCalledOnce()
    expect(useMediaStore.getState().assets.has('asset-stable')).toBe(true)
  })

  test('denied or changed remembered media falls back to manual relink', async () => {
    const expected = makeAsset()
    const descriptor = descriptorFrom(expected)
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const source = new File(['12345678'], 'source.mp4', {
      type: 'video/mp4',
      lastModified: expected.lastModified,
    })
    const handle = makeHandle(source)
    const deniedDeps = makeDeps({
      readText: vi.fn(async () => serialized),
      loadMediaHandle: vi.fn(async () => handle),
      queryMediaPermission: vi.fn(async () => 'denied' as const),
    })

    await openProjectFile(new File([serialized], 'denied.webcut'), deniedDeps)
    expect(useProjectSessionStore.getState().candidate?.assets[0].status)
      .toBe('missing')
    expect(deniedDeps.inspectMedia).not.toHaveBeenCalled()

    const changed = makeAsset({
      lastModified: expected.lastModified + 1,
      objectUrl: 'blob:changed',
    })
    const changedDeps = makeDeps({
      readText: vi.fn(async () => serialized),
      loadMediaHandle: vi.fn(async () => handle),
      queryMediaPermission: vi.fn(async () => 'granted' as const),
      inspectMedia: vi.fn(async () => readyInspection(changed)),
    })
    await openProjectFile(new File([serialized], 'changed.webcut'), changedDeps)

    expect(changedDeps.revokeObjectURL).toHaveBeenCalledWith('blob:changed')
    expect(changedDeps.forgetMediaHandle).toHaveBeenCalledWith(
      'doc-saved',
      'asset-stable',
    )
    expect(useProjectSessionStore.getState()).toMatchObject({
      phase: 'error',
      candidate: { assets: [expect.objectContaining({ status: 'missing' })] },
      error: expect.stringContaining('remembered file changed'),
    })
  })

  test('relinks a source after one analysis and restores its stable id', async () => {
    const analyzed = makeAsset({
      id: 'asset-random-session-id',
      objectUrl: 'blob:relinked-source',
      durationFrames: 999,
      durationMicroseconds: 1,
    })
    const descriptor = descriptorFrom(analyzed, {
      id: 'asset-stable',
      fileName: 'original.mp4',
    })
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const inspectMedia = vi.fn(async () => readyInspection(analyzed))
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      inspectMedia,
    })
    const projectFile = new File([serialized], 'edit.webcut')
    const sourceFile = new File(['12345678'], 'renamed-copy.mp4', {
      type: 'video/mp4',
      lastModified: 999,
    })

    await openProjectFile(projectFile, deps)
    await expect(connectProjectMedia([sourceFile], deps)).resolves.toEqual({
      status: 'ready',
    })

    expect(inspectMedia).toHaveBeenCalledOnce()
    expect(inspectMedia).toHaveBeenCalledWith(
      sourceFile,
      DEFAULT_PROJECT_SETTINGS.frameRate,
      expect.stringMatching(/^probe_compat-test-/),
      expect.any(AbortSignal),
    )
    expect(useProjectSessionStore.getState().candidate?.assets).toEqual([
      {
        id: 'asset-stable',
        fileName: 'original.mp4',
        kind: 'video',
        status: 'ready',
      },
    ])

    await activateResumedProject(deps)
    const restored = useMediaStore.getState().assets.get('asset-stable')
    expect(restored).toMatchObject({
      id: 'asset-stable',
      fileName: 'original.mp4',
      objectUrl: 'blob:relinked-source',
      durationFrames: 1,
    })
    expect(deps.revokeObjectURL).not.toHaveBeenCalled()
  })

  test('a handle-aware manual relink seeds automatic resume for next time', async () => {
    const analyzed = makeAsset({ objectUrl: 'blob:handle-relinked' })
    const descriptor = descriptorFrom(analyzed)
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const source = new File(['12345678'], 'source.mp4', {
      type: 'video/mp4',
      lastModified: analyzed.lastModified,
    })
    const handle = makeHandle(source)
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      pickMediaFiles: vi.fn(async () => [{ file: source, handle }]),
      inspectMedia: vi.fn(async () => readyInspection(analyzed)),
    })
    await openProjectFile(new File([serialized], 'legacy.webcut'), deps)

    await expect(chooseProjectMedia(deps)).resolves.toEqual({ status: 'ready' })

    expect(deps.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-saved',
      'asset-stable',
      handle,
    )
    expect(useProjectSessionStore.getState().candidate?.assets[0].status)
      .toBe('ready')
  })

  test('a metadata mismatch is revoked and leaves the active session untouched', async () => {
    const current = useDocumentStore.getState().doc
    const expected = makeAsset()
    const serialized = serializeProjectFile(
      makeProject([descriptorFrom(expected)]),
    )
    const mismatch = makeAsset({
      size: 99,
      objectUrl: 'blob:mismatch',
    })
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      inspectMedia: vi.fn(async () => readyInspection(mismatch)),
    })

    await openProjectFile(new File([serialized], 'edit.webcut'), deps)
    await expect(connectProjectMedia([
      new File(['12345678'], 'wrong.mp4'),
    ], deps)).resolves.toMatchObject({ status: 'failed' })

    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:mismatch')
    expect(useProjectSessionStore.getState().candidate?.assets[0].status).toBe('missing')
    expect(useDocumentStore.getState().doc).toBe(current)
    expect(deps.disposeExport).not.toHaveBeenCalled()
  })

  test('multi-file relink stays busy until the final selected file finishes', async () => {
    const first = makeAsset({
      id: 'temp-1',
      fileName: 'first.mp4',
      objectUrl: 'blob:first',
    })
    const second = makeAsset({
      id: 'temp-2',
      fileName: 'second.mp4',
      size: 9,
      durationFrames: 90,
      durationMicroseconds: 3_000_000,
      objectUrl: 'blob:second',
    })
    const serialized = serializeProjectFile(makeProject([
      descriptorFrom(first, { id: 'stable-1' }),
      descriptorFrom(second, { id: 'stable-2' }),
    ]))
    const secondGate = deferred<MediaProbeResult>()
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(readyInspection(first))
      .mockImplementationOnce(() => secondGate.promise)
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      inspectMedia,
    })
    await openProjectFile(new File([serialized], 'two.webcut'), deps)

    const connecting = connectProjectMedia([
      new File(['first'], 'first.mp4'),
      new File(['second'], 'second.mp4'),
    ], deps)
    await vi.waitFor(() => expect(inspectMedia).toHaveBeenCalledTimes(2))

    expect(useProjectSessionStore.getState()).toMatchObject({
      phase: 'relinking',
      candidate: {
        assets: [
          expect.objectContaining({ id: 'stable-1', status: 'ready' }),
          expect.objectContaining({ id: 'stable-2', status: 'missing' }),
        ],
      },
    })

    secondGate.resolve(readyInspection(second))
    await expect(connecting).resolves.toEqual({ status: 'ready' })
    expect(useProjectSessionStore.getState().phase).toBe('idle')
  })

  test('leaving during analysis revokes its late URL and cannot reopen the screen', async () => {
    const analyzedGate = deferred<MediaProbeResult>()
    const descriptor = descriptorFrom(makeAsset())
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const deps = makeDeps({
      readText: vi.fn(async () => serialized),
      inspectMedia: vi.fn(() => analyzedGate.promise),
    })
    await openProjectFile(new File([serialized], 'edit.webcut'), deps)

    const connecting = connectProjectMedia([
      new File(['12345678'], 'source.mp4'),
    ], deps)
    await flush()
    returnToProjectHome()
    analyzedGate.resolve(readyInspection(makeAsset({ objectUrl: 'blob:late' })))

    await expect(connecting).resolves.toEqual({ status: 'cancelled' })
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:late')
    expect(useProjectSessionStore.getState().screen).toBe('home')
  })
})

describe('active-project media relink', () => {
  test('activates with missing sources and preserves every descriptor', async () => {
    const first = descriptorFrom(makeAsset(), { id: 'offline-first' })
    const second = descriptorFrom(makeAsset({
      fileName: 'second.mp4',
      size: 9,
      durationFrames: 90,
      durationMicroseconds: 3_000_000,
    }), { id: 'offline-second' })

    await activateSavedProject([first, second])

    const media = useMediaStore.getState()
    expect([...media.descriptors.entries()]).toEqual([
      ['offline-first', first],
      ['offline-second', second],
    ])
    expect(media.assets.size).toBe(0)
    expect(useProjectSessionStore.getState()).toMatchObject({
      screen: 'editor',
      candidate: null,
    })
  })

  test('a denied remembered permission activates with the source offline', async () => {
    const descriptor = descriptorFrom(makeAsset())
    const source = new File(['12345678'], 'source.mp4', {
      type: 'video/mp4',
      lastModified: descriptor.lastModified,
    })
    const handle = makeHandle(source)
    const deps = await activateSavedProject([descriptor], {
      loadMediaHandle: vi.fn(async () => handle),
      queryMediaPermission: vi.fn(async () => 'prompt' as const),
      requestMediaPermission: vi.fn(async () => 'denied' as const),
    })

    expect(deps.requestMediaPermission).toHaveBeenCalledWith(handle)
    expect(deps.inspectMedia).not.toHaveBeenCalled()
    expect(useMediaStore.getState().descriptors.get(descriptor.id))
      .toEqual(descriptor)
    expect(useMediaStore.getState().assets.has(descriptor.id)).toBe(false)
    expect(useProjectSessionStore.getState()).toMatchObject({
      screen: 'editor',
      activeMediaRelink: {
        phase: 'complete',
        errors: [expect.stringContaining('was not granted')],
      },
    })
  })

  test('an individual picker reconnects the existing descriptor and remembers its handle', async () => {
    const descriptor = descriptorFrom(makeAsset())
    const selection = makeFolderSelection('renamed-copy.mp4')
    const analyzed = makeAsset({
      id: 'temporary-analysis-id',
      fileName: selection.file.name,
      lastModified: selection.file.lastModified,
      objectUrl: 'blob:individual-relink',
    })
    const deps = await activateSavedProject([descriptor], {
      inspectMedia: vi.fn(async () => readyInspection(analyzed)),
      pickMediaFiles: vi.fn(async () => [{
        file: selection.file,
        handle: selection.handle,
      }]),
    })
    const descriptorBefore = useMediaStore.getState().descriptors.get(
      descriptor.id,
    )

    await expect(chooseActiveAssetMedia(descriptor.id, deps)).resolves.toEqual({
      status: 'ready',
    })

    const media = useMediaStore.getState()
    expect(deps.pickMediaFiles).toHaveBeenCalledWith(false)
    expect(media.descriptors.get(descriptor.id)).toBe(descriptorBefore)
    expect(media.assets.get(descriptor.id)).toMatchObject({
      id: descriptor.id,
      fileName: descriptor.fileName,
      objectUrl: 'blob:individual-relink',
    })
    expect(deps.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-saved',
      descriptor.id,
      selection.handle,
    )
    expect(deps.revokeObjectURL).not.toHaveBeenCalledWith(
      'blob:individual-relink',
    )
    expect(useProjectSessionStore.getState().activeMediaRelink)
      .toMatchObject({ phase: 'complete', connectedCount: 1 })
  })

  test('an unsupported individual relink stays offline with its exact guarded report', async () => {
    const descriptor = descriptorFrom(makeAsset())
    const selection = makeFolderSelection(descriptor.fileName)
    const inspection = unsupportedInspection('The selected HEVC profile is unavailable.')
    const deps = await activateSavedProject([descriptor], {
      inspectMedia: vi.fn(async () => inspection),
      pickMediaFiles: vi.fn(async () => [{
        file: selection.file,
        handle: selection.handle,
      }]),
    })

    await expect(chooseActiveAssetMedia(descriptor.id, deps)).resolves.toEqual({
      status: 'failed',
      message: inspection.compatibility.detail,
    })

    const media = useMediaStore.getState()
    expect(media.assets.has(descriptor.id)).toBe(false)
    expect(media.compatibility.get(descriptor.id)).toMatchObject({
      id: descriptor.id,
      requestId: 'compat-test-1',
      status: 'unsupported',
      report: inspection.compatibility,
    })
    expect(deps.rememberMediaHandle).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState().activeMediaRelink).toMatchObject({
      phase: 'complete',
      connectedCount: 0,
      skippedCount: 1,
      errors: [inspection.compatibility.detail],
    })
  })

  test('a mismatched individual relink restores the prior settled report', async () => {
    const descriptor = descriptorFrom(makeAsset())
    const selection = makeFolderSelection(
      descriptor.fileName,
      `selected/${descriptor.fileName}`,
      descriptor.lastModified,
    )
    const analyzed = makeAsset({
      fileName: selection.file.name,
      size: selection.file.size,
      lastModified: selection.file.lastModified,
      durationFrames: 90,
      durationMicroseconds: 3_000_000,
      objectUrl: 'blob:mismatched-relink',
    })
    const deps = await activateSavedProject([descriptor], {
      inspectMedia: vi.fn(async () => readyInspection(analyzed)),
      pickMediaFiles: vi.fn(async () => [{
        file: selection.file,
        handle: selection.handle,
      }]),
    })
    const previousReport = unsupportedInspection(
      'The previous runtime check could not decode this source.',
    ).compatibility
    installOfflineCompatibility(descriptor, previousReport)

    await expect(chooseActiveAssetMedia(descriptor.id, deps)).resolves
      .toEqual({
        status: 'failed',
        message: `"${selection.file.name}" does not match "${descriptor.fileName}".`,
      })

    const media = useMediaStore.getState()
    expect(media.assets.has(descriptor.id)).toBe(false)
    expect(media.compatibility.get(descriptor.id)).toMatchObject({
      id: descriptor.id,
      requestId: 'compat-test-1',
      status: 'unsupported',
    })
    expect(media.compatibility.get(descriptor.id)?.report).toBe(previousReport)
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:mismatched-relink')
  })

  test('cancelling an in-flight individual relink restores the prior settled report', async () => {
    const descriptor = descriptorFrom(makeAsset())
    const selection = makeFolderSelection(
      descriptor.fileName,
      `selected/${descriptor.fileName}`,
      descriptor.lastModified,
    )
    const inspection = deferred<MediaProbeResult>()
    const deps = await activateSavedProject([descriptor], {
      inspectMedia: vi.fn(() => inspection.promise),
      pickMediaFiles: vi.fn(async () => [{
        file: selection.file,
        handle: selection.handle,
      }]),
    })
    const previousReport = unsupportedInspection(
      'The previous runtime check could not decode this source.',
    ).compatibility
    installOfflineCompatibility(descriptor, previousReport)

    const choosing = chooseActiveAssetMedia(descriptor.id, deps)
    await flush()
    expect(useMediaStore.getState().compatibility.get(descriptor.id))
      .toMatchObject({
        requestId: 'compat-test-1',
        status: 'checking',
        report: previousReport,
      })

    cancelActiveMediaRelink(deps)
    expect(useMediaStore.getState().compatibility.get(descriptor.id))
      .toMatchObject({
        requestId: 'compat-test-1',
        status: 'unsupported',
        report: previousReport,
      })

    inspection.resolve(readyInspection(makeAsset({
      fileName: selection.file.name,
      size: selection.file.size,
      lastModified: selection.file.lastModified,
      objectUrl: 'blob:cancelled-relink',
    })))
    await expect(choosing).resolves.toEqual({ status: 'cancelled' })
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:cancelled-relink')
    expect(useMediaStore.getState().compatibility.get(descriptor.id)?.report)
      .toBe(previousReport)
  })

  test('a folder scan connects unique matches while leaving other sources offline', async () => {
    const first = descriptorFrom(makeAsset(), {
      id: 'folder-first',
      fileName: 'first-original.mp4',
    })
    const second = descriptorFrom(makeAsset({
      fileName: 'second.mp4',
      size: 9,
      durationFrames: 90,
      durationMicroseconds: 3_000_000,
    }), { id: 'folder-second' })
    const matching = makeFolderSelection(
      'first-original.mp4',
      'chosen/first-original.mp4',
      first.lastModified,
    )
    const ignoredFile = new File(['nope'], 'notes.txt', {
      type: 'text/plain',
      lastModified: 555,
    })
    const ignored: LocalMediaFolderSelection = {
      file: ignoredFile,
      handle: makeHandle(ignoredFile),
      relativePath: 'chosen/notes.txt',
    }
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(readyInspection(makeAsset({
        id: 'folder-scan',
        fileName: matching.file.name,
        objectUrl: 'blob:folder-scan',
      })))
      .mockResolvedValueOnce(readyInspection(makeAsset({
        id: 'folder-analysis',
        fileName: matching.file.name,
        objectUrl: 'blob:folder-unique',
      })))
    const deps = await activateSavedProject([first, second], {
      inspectMedia,
    })

    await expect(connectActiveMediaFolder(
      [matching, ignored],
      deps,
    )).resolves.toEqual({ status: 'ready' })

    const media = useMediaStore.getState()
    expect(deps.inspectMedia).toHaveBeenCalledTimes(2)
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:folder-scan')
    expect(media.assets.get(first.id)).toMatchObject({
      id: first.id,
      objectUrl: 'blob:folder-unique',
    })
    expect(media.assets.has(second.id)).toBe(false)
    expect(media.descriptors.size).toBe(2)
    expect(deps.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-saved',
      first.id,
      matching.handle,
    )
    expect(useProjectSessionStore.getState().activeMediaRelink).toEqual({
      phase: 'complete',
      scannedFileCount: 2,
      connectedCount: 1,
      skippedCount: 1,
      errors: [],
      ambiguity: null,
    })
  })

  test('duplicate folder matches publish only a serializable ambiguity summary', async () => {
    const analyzed = makeAsset({ objectUrl: 'blob:ambiguous-summary' })
    const first = descriptorFrom(analyzed, { id: 'duplicate-first' })
    const second = descriptorFrom(analyzed, { id: 'duplicate-second' })
    const selection = makeFolderSelection(
      analyzed.fileName,
      `duplicates/${analyzed.fileName}`,
      analyzed.lastModified,
    )
    const deps = await activateSavedProject([first, second], {
      inspectMedia: vi.fn(async () => readyInspection(analyzed)),
    })

    await expect(connectActiveMediaFolder([selection], deps)).resolves.toEqual({
      status: 'ready',
    })

    const summary = useProjectSessionStore.getState().activeMediaRelink
    expect(summary).toEqual({
      phase: 'awaiting-choice',
      scannedFileCount: 1,
      connectedCount: 0,
      skippedCount: 0,
      errors: [],
      ambiguity: {
        token: expect.any(String),
        assetId: first.id,
        assetFileName: first.fileName,
        candidates: [{
          token: expect.any(String),
          fileName: analyzed.fileName,
          relativePath: `duplicates/${analyzed.fileName}`,
        }],
      },
    })
    const serializedSummary = JSON.stringify(summary)
    expect(JSON.parse(serializedSummary)).toEqual(summary)
    expect(serializedSummary).not.toContain('blob:ambiguous-summary')
    expect(serializedSummary).not.toContain('getFile')

    cancelActiveMediaRelink(deps)
  })

  test('confirming an ambiguity transfers the staged URL and handle to the chosen asset', async () => {
    const analyzed = makeAsset({ objectUrl: 'blob:confirmed-folder-scan' })
    const first = descriptorFrom(analyzed, { id: 'confirm-first' })
    const second = descriptorFrom(analyzed, { id: 'confirm-second' })
    const selection = makeFolderSelection(
      analyzed.fileName,
      `duplicates/${analyzed.fileName}`,
      analyzed.lastModified,
    )
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(readyInspection(analyzed))
      .mockResolvedValueOnce(readyInspection(makeAsset({
        objectUrl: 'blob:confirmed-folder-source',
      })))
    const deps = await activateSavedProject([first, second], {
      inspectMedia,
    })
    await connectActiveMediaFolder([selection], deps)
    const ambiguity = useProjectSessionStore.getState()
      .activeMediaRelink.ambiguity
    expect(ambiguity).not.toBeNull()

    await expect(resolveActiveMediaAmbiguity(
      ambiguity!.token,
      ambiguity!.candidates[0].token,
      deps,
    )).resolves.toEqual({ status: 'ready' })

    const media = useMediaStore.getState()
    expect(media.assets.get(first.id)).toMatchObject({
      id: first.id,
      objectUrl: 'blob:confirmed-folder-source',
    })
    expect(media.assets.has(second.id)).toBe(false)
    expect(deps.rememberMediaHandle).toHaveBeenCalledWith(
      'doc-saved',
      first.id,
      selection.handle,
    )
    expect(deps.revokeObjectURL).not.toHaveBeenCalledWith(
      'blob:confirmed-folder-source',
    )
    expect(deps.revokeObjectURL).toHaveBeenCalledWith(
      'blob:confirmed-folder-scan',
    )
    expect(useProjectSessionStore.getState().activeMediaRelink)
      .toMatchObject({ phase: 'complete', connectedCount: 1 })
  })

  test('skipping an ambiguity revokes every discarded staged URL once', async () => {
    const descriptor = descriptorFrom(makeAsset(), { id: 'skip-target' })
    const first = makeFolderSelection('skip-copy-a.mp4')
    const second = makeFolderSelection('skip-copy-b.mp4')
    const firstUrl = 'blob:skip-copy-a'
    const secondUrl = 'blob:skip-copy-b'
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(readyInspection(makeAsset({
        fileName: first.file.name,
        objectUrl: firstUrl,
      })))
      .mockResolvedValueOnce(readyInspection(makeAsset({
        fileName: second.file.name,
        objectUrl: secondUrl,
      })))
    const deps = await activateSavedProject([descriptor], { inspectMedia })
    await connectActiveMediaFolder([first, second], deps)
    const ambiguity = useProjectSessionStore.getState()
      .activeMediaRelink.ambiguity
    expect(ambiguity?.candidates).toHaveLength(2)

    await expect(skipActiveMediaAmbiguity(
      ambiguity!.token,
      deps,
    )).resolves.toEqual({ status: 'ready' })
    await expect(skipActiveMediaAmbiguity(
      ambiguity!.token,
      deps,
    )).resolves.toEqual({ status: 'cancelled' })

    const revocations = vi.mocked(deps.revokeObjectURL).mock.calls
      .map(([url]) => url)
    expect(revocations.filter((url) => url === firstUrl)).toHaveLength(1)
    expect(revocations.filter((url) => url === secondUrl)).toHaveLength(1)
    expect(useMediaStore.getState().assets.size).toBe(0)
    expect(useProjectSessionStore.getState().activeMediaRelink)
      .toMatchObject({
        phase: 'complete',
        connectedCount: 0,
        skippedCount: 2,
      })
  })

  test('cancelling an ambiguity revokes every staged URL once', async () => {
    const descriptor = descriptorFrom(makeAsset(), { id: 'cancel-target' })
    const first = makeFolderSelection('cancel-copy-a.mp4')
    const second = makeFolderSelection('cancel-copy-b.mp4')
    const firstUrl = 'blob:cancel-copy-a'
    const secondUrl = 'blob:cancel-copy-b'
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(readyInspection(makeAsset({
        fileName: first.file.name,
        objectUrl: firstUrl,
      })))
      .mockResolvedValueOnce(readyInspection(makeAsset({
        fileName: second.file.name,
        objectUrl: secondUrl,
      })))
    const deps = await activateSavedProject([descriptor], { inspectMedia })
    await connectActiveMediaFolder([first, second], deps)
    expect(useProjectSessionStore.getState().activeMediaRelink.phase)
      .toBe('awaiting-choice')

    cancelActiveMediaRelink(deps)
    cancelActiveMediaRelink(deps)

    const revocations = vi.mocked(deps.revokeObjectURL).mock.calls
      .map(([url]) => url)
    expect(revocations.filter((url) => url === firstUrl)).toHaveLength(1)
    expect(revocations.filter((url) => url === secondUrl)).toHaveLength(1)
    expect(useMediaStore.getState().assets.size).toBe(0)
    expect(useProjectSessionStore.getState().activeMediaRelink)
      .toMatchObject({ phase: 'complete', skippedCount: 2 })
  })

  test('superseding an ambiguity revokes the previous staged URLs once', async () => {
    const descriptor = descriptorFrom(makeAsset(), {
      id: 'superseded-target',
    })
    const first = makeFolderSelection('superseded-copy-a.mp4')
    const second = makeFolderSelection('superseded-copy-b.mp4')
    const firstUrl = 'blob:superseded-copy-a'
    const secondUrl = 'blob:superseded-copy-b'
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(readyInspection(makeAsset({
        fileName: first.file.name,
        objectUrl: firstUrl,
      })))
      .mockResolvedValueOnce(readyInspection(makeAsset({
        fileName: second.file.name,
        objectUrl: secondUrl,
      })))
    const deps = await activateSavedProject([descriptor], { inspectMedia })
    await connectActiveMediaFolder([first, second], deps)
    expect(useProjectSessionStore.getState().activeMediaRelink.phase)
      .toBe('awaiting-choice')

    await expect(connectActiveMediaFolder([], deps)).resolves.toEqual({
      status: 'ready',
    })
    await expect(connectActiveMediaFolder([], deps)).resolves.toEqual({
      status: 'ready',
    })

    const revocations = vi.mocked(deps.revokeObjectURL).mock.calls
      .map(([url]) => url)
    expect(revocations.filter((url) => url === firstUrl)).toHaveLength(1)
    expect(revocations.filter((url) => url === secondUrl)).toHaveLength(1)
    expect(useMediaStore.getState().assets.size).toBe(0)
  })

  test('a large folder keeps every unique match beyond the former staging cap', async () => {
    const descriptors: PortableAssetDescriptor[] = []
    const selections: LocalMediaFolderSelection[] = []
    for (let index = 0; index < 257; index++) {
      const fileName = `unique-${index}.mp4`
      const size = 8 + index
      const lastModified = 10_000 + index
      const durationMicroseconds = 2_000_000 + index
      const file = new File([new Uint8Array(size)], fileName, {
        type: 'video/mp4',
        lastModified,
      })
      descriptors.push(descriptorFrom(makeAsset({
        fileName,
        size,
        lastModified,
        durationMicroseconds,
      }), { id: `large-folder-${index}` }))
      selections.push({
        file,
        handle: makeHandle(file),
        relativePath: `large/${fileName}`,
      })
    }
    let inspectionId = 0
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>(
      async (file) => {
        const index = Number(file.name.slice('unique-'.length, -'.mp4'.length))
        return readyInspection(makeAsset({
          id: `temporary-${inspectionId}`,
          fileName: file.name,
          size: file.size,
          lastModified: file.lastModified,
          durationMicroseconds: 2_000_000 + index,
          objectUrl: `blob:large-folder-${inspectionId++}`,
        }))
      },
    )
    const deps = await activateSavedProject(descriptors, { inspectMedia })

    await expect(connectActiveMediaFolder(selections, deps)).resolves.toEqual({
      status: 'ready',
    })

    expect(useMediaStore.getState().assets.size).toBe(257)
    expect(inspectMedia).toHaveBeenCalledTimes(514)
    expect(useProjectSessionStore.getState().activeMediaRelink).toMatchObject({
      phase: 'complete',
      connectedCount: 257,
      skippedCount: 0,
      errors: [],
    })
  })

  test('a folder picker result cannot relink a project that was left meanwhile', async () => {
    const descriptor = descriptorFrom(makeAsset(), { id: 'picker-race' })
    const selection = makeFolderSelection(descriptor.fileName)
    const picker = deferred<LocalMediaFolderSelection[]>()
    const deps = await activateSavedProject([descriptor], {
      pickMediaFolder: vi.fn(() => picker.promise),
    })

    const choosing = chooseActiveMediaFolder(deps)
    await flush()
    expect(useProjectSessionStore.getState().activeMediaRelink.phase)
      .toBe('scanning')

    returnToProjectHome()
    picker.resolve([selection])

    await expect(choosing).resolves.toEqual({ status: 'cancelled' })
    expect(deps.inspectMedia).not.toHaveBeenCalled()
    expect(useMediaStore.getState().assets.size).toBe(0)
  })

  test('cancelling while a connected handle is being remembered reports cancellation without revoking the transferred URL', async () => {
    const descriptor = descriptorFrom(makeAsset(), { id: 'remember-race' })
    const selection = makeFolderSelection(descriptor.fileName)
    const remember = deferred<void>()
    const scanUrl = 'blob:remember-race-scan'
    const sourceUrl = 'blob:remember-race'
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(readyInspection(makeAsset({ objectUrl: scanUrl })))
      .mockResolvedValueOnce(readyInspection(makeAsset({ objectUrl: sourceUrl })))
    const deps = await activateSavedProject([descriptor], {
      inspectMedia,
      rememberMediaHandle: vi.fn(() => remember.promise),
    })

    const connecting = connectActiveMediaFolder([selection], deps)
    await flush()
    expect(useMediaStore.getState().assets.has(descriptor.id)).toBe(true)

    cancelActiveMediaRelink(deps)
    remember.resolve(undefined)

    await expect(connecting).resolves.toEqual({ status: 'cancelled' })
    expect(deps.revokeObjectURL).toHaveBeenCalledWith(scanUrl)
    expect(deps.revokeObjectURL).not.toHaveBeenCalledWith(sourceUrl)
    expect(useMediaStore.getState().assets.has(descriptor.id)).toBe(true)
  })
})
