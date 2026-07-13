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
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useTransportStore } from '../state/transportStore'
import {
  activateResumedProject,
  connectProjectMedia,
  createNewProject,
  openProjectFile,
  resetProjectController,
  returnToProjectHome,
  type ProjectControllerDeps,
} from './projectController'

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
    revokeObjectURL: vi.fn((url) => URL.revokeObjectURL(url)),
    ...overrides,
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
