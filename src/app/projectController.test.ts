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
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import {
  activateResumedProject,
  chooseProjectMedia,
  connectProjectMedia,
  createNewProject,
  leaveActiveProject,
  openProjectFile,
  resetProjectController,
  returnToProjectHome,
  type ProjectControllerDeps,
} from './projectController'
import type { LocalMediaFileHandle } from './localMediaHandles'

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
  return {
    createDocumentId: vi.fn(() => 'doc-new'),
    readText: vi.fn(async () => ''),
    inspectMedia: vi.fn(async () => makeAsset()),
    disposeExport: vi.fn(async () => undefined),
    disposeTransport: vi.fn(async () => undefined),
    disposePreview: vi.fn(),
    disposeMediaVisuals: vi.fn(),
    resetMediaImport: vi.fn(),
    pauseProjectPersistence: vi.fn(async () => undefined),
    resumeProjectPersistence: vi.fn(),
    startProjectPersistence: vi.fn(),
    suspendProjectPersistence: vi.fn(),
    loadMediaHandle: vi.fn(async () => null),
    rememberMediaHandle: vi.fn(async () => undefined),
    forgetMediaHandle: vi.fn(async () => undefined),
    queryMediaPermission: vi.fn(async () => 'granted' as const),
    requestMediaPermission: vi.fn(async () => 'granted' as const),
    pickMediaFiles: vi.fn(async () => []),
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

beforeEach(() => {
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  resetProjectController({ revokeObjectURL: URL.revokeObjectURL })
  useDocumentStore.getState().setDoc(createTimelineDoc(
    'Current project',
    DEFAULT_PROJECT_SETTINGS,
    'doc-current',
  ))
  useMediaStore.setState({ assets: new Map(), visuals: new Map() })
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
      inspectMedia: vi.fn(async () => analyzed),
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
    expect(deps.requestMediaPermission).not.toHaveBeenCalled()
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
      inspectMedia: vi.fn(async () => analyzed),
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
      inspectMedia: vi.fn(async () => changed),
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
    })
    const descriptor = descriptorFrom(analyzed, {
      id: 'asset-stable',
      fileName: 'original.mp4',
    })
    const serialized = serializeProjectFile(makeProject([descriptor]))
    const inspectMedia = vi.fn(async () => analyzed)
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
      durationFrames: 60,
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
      inspectMedia: vi.fn(async () => analyzed),
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
      inspectMedia: vi.fn(async () => mismatch),
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
    const secondGate = deferred<MediaAsset>()
    const inspectMedia = vi.fn<ProjectControllerDeps['inspectMedia']>()
      .mockResolvedValueOnce(first)
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

    secondGate.resolve(second)
    await expect(connecting).resolves.toEqual({ status: 'ready' })
    expect(useProjectSessionStore.getState().phase).toBe('idle')
  })

  test('leaving during analysis revokes its late URL and cannot reopen the screen', async () => {
    const analyzedGate = deferred<MediaAsset>()
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
    analyzedGate.resolve(makeAsset({ objectUrl: 'blob:late' }))

    await expect(connecting).resolves.toEqual({ status: 'cancelled' })
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:late')
    expect(useProjectSessionStore.getState().screen).toBe('home')
  })
})
