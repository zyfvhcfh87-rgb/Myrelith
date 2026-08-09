import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from 'vitest'
import { parseProjectFile } from '../domain/projectFile'
import {
  DEFAULT_PROJECT_SETTINGS,
  createTimelineDoc,
} from '../domain/projectSettings'
import type { MediaAsset } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_PROJECT_SESSION_STATE,
  useProjectSessionStore,
} from '../state/projectSessionStore'
import {
  LIVE_SAVE_DELAY_MS,
  RECOVERY_SAVE_DELAY_MS,
  ProjectPersistenceController,
  projectFileName,
  type ProjectPersistenceDeps,
  type ProjectWritableFileHandle,
  type ProjectWritableFileStream,
} from './projectPersistenceController'

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface FakeHandle extends ProjectWritableFileHandle {
  createWritable: Mock<() => Promise<ProjectWritableFileStream>>
  writes: string[]
  closes: Array<Mock<() => Promise<void>>>
}

function makeHandle(
  name = 'Edit.myrelith',
  streamFactory?: () => ProjectWritableFileStream,
): FakeHandle {
  const writes: string[] = []
  const closes: Array<Mock<() => Promise<void>>> = []
  const createWritable = vi.fn<() => Promise<ProjectWritableFileStream>>(async () => {
    if (streamFactory) return streamFactory()
    const close = vi.fn<() => Promise<void>>(async () => undefined)
    closes.push(close)
    return {
      write: vi.fn(async (data: string) => {
        writes.push(data)
      }),
      close,
      abort: vi.fn(async () => undefined),
    }
  })
  return { name, createWritable, writes, closes }
}

function makeDeps(
  handle: ProjectWritableFileHandle,
  overrides: Partial<ProjectPersistenceDeps> = {},
): ProjectPersistenceDeps {
  return {
    supportsSavePicker: vi.fn(() => true),
    pickSaveFile: vi.fn(async () => handle),
    download: vi.fn(),
    now: vi.fn(() => 1_234),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
    addBeforeUnload: vi.fn(),
    removeBeforeUnload: vi.fn(),
    createRecoveryJournalId: vi.fn(() => 'recovery-journal-test'),
    createRecoverySnapshotId: vi.fn(() => 'recovery-snapshot-test'),
    appendRecoverySnapshot: vi.fn(async () => undefined),
    deleteRecoveryJournal: vi.fn(async () => undefined),
    rememberRecentProject: vi.fn(async () => undefined),
    ...overrides,
  }
}

let controller: ProjectPersistenceController | null = null

beforeEach(() => {
  vi.useFakeTimers()
  useProjectSessionStore.setState({
    ...INITIAL_PROJECT_SESSION_STATE,
    screen: 'editor',
    activeProjectName: 'My edit',
  })
  useDocumentStore.getState().setDoc(createTimelineDoc(
    'My edit',
    DEFAULT_PROJECT_SETTINGS,
    'doc-save-test',
  ))
  useMediaStore.setState({
    descriptors: new Map(),
    assets: new Map(),
    visuals: new Map(),
    compatibility: new Map(),
    collections: [],
    collectionPast: [],
    collectionFuture: [],
  })
})

afterEach(() => {
  controller?.suspendSession()
  controller = null
  vi.useRealTimers()
})

describe('project persistence', () => {
  test('uses stable Windows-safe project filenames', () => {
    expect(projectFileName('  My edit.myrelith  ')).toBe('My edit.myrelith')
    expect(projectFileName('  Legacy edit.webcut  ')).toBe('Legacy edit.myrelith')
    expect(projectFileName('CON.txt')).toBe('myrelith-CON.txt.myrelith')
    expect(projectFileName('  ')).toBe('untitled-project.myrelith')
    expect(projectFileName('bad<name>|*')).toBe('bad-name---.myrelith')
  })

  test('new sessions start dirty while resumed sessions start clean and read-only', () => {
    const deps = makeDeps(makeHandle())
    controller = new ProjectPersistenceController(deps)

    controller.startSession({ fileName: null, persisted: false })
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      liveSaveEnabled: false,
    })
    expect(deps.addBeforeUnload).toHaveBeenCalledOnce()

    controller.startSession({ fileName: 'Opened.myrelith', persisted: true })
    expect(useProjectSessionStore.getState()).toMatchObject({
      activeProjectFileName: 'Opened.myrelith',
      hasUnsavedChanges: false,
      liveSaveEnabled: false,
    })
    expect(deps.removeBeforeUnload).toHaveBeenCalledOnce()
  })

  test('keeps an unsaved project recoverable without claiming it was saved', async () => {
    const deps = makeDeps(makeHandle())
    controller = new ProjectPersistenceController(deps)

    controller.startSession({ fileName: null, persisted: false })
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    expect(deps.appendRecoverySnapshot).toHaveBeenCalledOnce()
    const recovery = vi.mocked(deps.appendRecoverySnapshot).mock.calls[0][0]
    expect(recovery).toMatchObject({
      journalId: 'recovery-journal-test',
      documentId: 'doc-save-test',
      projectName: 'My edit',
      projectFileName: null,
    })
    expect(parseProjectFile(recovery.serializedProject).document.id)
      .toBe('doc-save-test')
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      savePhase: 'idle',
      lastSavedAt: null,
      recoveryPhase: 'idle',
      lastRecoveryAt: 1_234,
      recoveryError: null,
    })
  })

  test('a recovery failure stays separate from successful project-file saving', async () => {
    const deps = makeDeps(makeHandle(), {
      appendRecoverySnapshot: vi.fn(async () => {
        throw new Error('IndexedDB quota exceeded')
      }),
    })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      savePhase: 'idle',
      lastSavedAt: null,
      recoveryPhase: 'error',
      recoveryError: 'Could not update the recovery copy: IndexedDB quota exceeded',
    })

    await expect(controller.saveAs()).resolves.toMatchObject({ status: 'saved' })
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: false,
      savePhase: 'idle',
      saveError: null,
      recoveryPhase: 'idle',
      recoveryError: null,
      lastSavedAt: 1_234,
    })
  })

  test('an invalid portable snapshot reports recovery failure and can retry', async () => {
    const deps = makeDeps(makeHandle())
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    for (let index = 0; index < 255; index++) {
      useDocumentStore.getState().addTrack('video')
    }

    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
    expect(deps.appendRecoverySnapshot).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      recoveryPhase: 'error',
    })
    expect(useProjectSessionStore.getState().recoveryError)
      .toMatch(/^Could not update the recovery copy:/)

    useDocumentStore.getState().setDoc(createTimelineDoc(
      'My edit',
      DEFAULT_PROJECT_SETTINGS,
      'doc-save-test',
    ))
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
    expect(deps.appendRecoverySnapshot).toHaveBeenCalledOnce()
    expect(useProjectSessionStore.getState()).toMatchObject({
      recoveryPhase: 'idle',
      recoveryError: null,
    })
  })

  test('a clean opened project waits for its first edit before recovery', async () => {
    const deps = makeDeps(makeHandle())
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: 'Opened.myrelith', persisted: true })

    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
    expect(deps.appendRecoverySnapshot).not.toHaveBeenCalled()

    useDocumentStore.getState().addTrack('video')
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
    expect(deps.appendRecoverySnapshot).toHaveBeenCalledOnce()
  })

  test('collection edits become dirty and persist in recovery and project saves', async () => {
    const handle = makeHandle()
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    const asset = makeAsset()
    useMediaStore.getState().addAsset(asset)
    controller.startSession({ fileName: 'Opened.myrelith', persisted: true })

    const collectionId = useMediaStore.getState().createCollection('Selects')!
    useMediaStore.getState().setCollectionMembership(
      collectionId,
      asset.id,
      true,
    )

    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(true)
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
    const recovered = parseProjectFile(
      vi.mocked(deps.appendRecoverySnapshot).mock.calls[0][0].serializedProject,
    )
    expect(recovered.collections).toEqual([{
      id: collectionId,
      name: 'Selects',
      assetIds: [asset.id],
    }])

    await expect(controller.saveAs()).resolves.toMatchObject({ status: 'saved' })
    expect(parseProjectFile(handle.writes[0]).collections)
      .toEqual(recovered.collections)
  })

  test('an edit during a recovery write schedules one newest follow-up', async () => {
    const firstWrite = deferred<void>()
    const appendRecoverySnapshot = vi.fn<ProjectPersistenceDeps['appendRecoverySnapshot']>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined)
    const deps = makeDeps(makeHandle(), { appendRecoverySnapshot })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })

    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
    expect(appendRecoverySnapshot).toHaveBeenCalledOnce()
    useDocumentStore.getState().addTrack('video')
    const expectedTracks = useDocumentStore.getState().doc.tracks
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)
    expect(appendRecoverySnapshot).toHaveBeenCalledOnce()

    firstWrite.resolve()
    await firstWrite.promise
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    expect(appendRecoverySnapshot).toHaveBeenCalledTimes(2)
    const newest = appendRecoverySnapshot.mock.calls[1][0]
    expect(parseProjectFile(newest.serializedProject).document.tracks)
      .toEqual(expectedTracks)
  })

  test('a late recovery completion cannot update a replacement session', async () => {
    const oldWrite = deferred<void>()
    const deps = makeDeps(makeHandle(), {
      appendRecoverySnapshot: vi.fn(() => oldWrite.promise),
    })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    controller.startSession({ fileName: 'Replacement.myrelith', persisted: true })
    oldWrite.resolve()
    await oldWrite.promise
    await Promise.resolve()

    expect(useProjectSessionStore.getState()).toMatchObject({
      activeProjectFileName: 'Replacement.myrelith',
      hasUnsavedChanges: false,
      recoveryPhase: 'idle',
      lastRecoveryAt: null,
      recoveryError: null,
    })
  })

  test('a successful Save clears recovery and remembers the writable project', async () => {
    const handle = makeHandle()
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    await expect(controller.saveAs()).resolves.toMatchObject({ status: 'saved' })

    expect(deps.deleteRecoveryJournal)
      .toHaveBeenCalledWith('recovery-journal-test')
    expect(deps.rememberRecentProject).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-save-test',
      projectName: 'My edit',
      fileName: 'Edit.myrelith',
      handle,
    }))
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: false,
      lastRecoveryAt: null,
      recoveryPhase: 'idle',
    })
  })

  test('Save before the recovery debounce cannot recreate a cleared journal', async () => {
    const deps = makeDeps(makeHandle())
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })

    await expect(controller.saveAs()).resolves.toMatchObject({ status: 'saved' })
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    expect(deps.deleteRecoveryJournal)
      .toHaveBeenCalledWith('recovery-journal-test')
    expect(deps.appendRecoverySnapshot).not.toHaveBeenCalled()
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: false,
      lastRecoveryAt: null,
      recoveryPhase: 'idle',
    })
  })

  test('a failed exit can rebuild the intentionally discarded recovery', async () => {
    const deps = makeDeps(makeHandle())
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    await controller.pauseSession()
    await controller.discardRecovery()
    controller.resumeSession()
    await vi.advanceTimersByTimeAsync(RECOVERY_SAVE_DELAY_MS)

    expect(deps.deleteRecoveryJournal)
      .toHaveBeenCalledWith('recovery-journal-test')
    expect(deps.appendRecoverySnapshot).toHaveBeenCalledTimes(2)
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      recoveryPhase: 'idle',
      lastRecoveryAt: 1_234,
    })
  })

  test('Save As writes one valid snapshot, adopts the handle, and enables live save', async () => {
    const handle = makeHandle()
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    useMediaStore.getState().addAsset(makeAsset())
    controller.startSession({ fileName: null, persisted: false })

    await expect(controller.saveAs()).resolves.toEqual({
      status: 'saved',
      fileName: 'Edit.myrelith',
      liveSaveEnabled: true,
    })

    expect(handle.createWritable).toHaveBeenCalledOnce()
    expect(handle.closes[0]).toHaveBeenCalledOnce()
    const saved = parseProjectFile(handle.writes[0])
    expect(saved.document.name).toBe('My edit')
    expect(saved.assets[0]).toMatchObject({
      id: 'asset-video',
      fileName: 'source.mp4',
    })
    expect(handle.writes[0]).not.toContain('blob:source')
    expect(useProjectSessionStore.getState()).toMatchObject({
      activeProjectFileName: 'Edit.myrelith',
      hasUnsavedChanges: false,
      liveSaveEnabled: true,
      lastSavedAt: 1_234,
      saveError: null,
    })
  })

  test('Save reuses an adopted handle and never reopens the picker', async () => {
    const handle = makeHandle()
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await controller.saveAs()
    useDocumentStore.getState().addTrack('video')
    const expectedTracks = useDocumentStore.getState().doc.tracks

    await expect(controller.save()).resolves.toMatchObject({ status: 'saved' })

    expect(deps.pickSaveFile).toHaveBeenCalledOnce()
    expect(handle.createWritable).toHaveBeenCalledTimes(2)
    expect(parseProjectFile(handle.writes[1]).document.tracks)
      .toEqual(expectedTracks)
  })

  test('picker cancellation preserves dirty state and resumes prior live save', async () => {
    const handle = makeHandle()
    const abort = new DOMException('cancelled', 'AbortError')
    const pickSaveFile = vi.fn<ProjectPersistenceDeps['pickSaveFile']>()
      .mockResolvedValueOnce(handle)
      .mockRejectedValueOnce(abort)
    const deps = makeDeps(handle, { pickSaveFile })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await controller.saveAs()
    useDocumentStore.getState().addTrack('video')

    await expect(controller.saveAs()).resolves.toEqual({ status: 'cancelled' })
    expect(useProjectSessionStore.getState()).toMatchObject({
      activeProjectFileName: 'Edit.myrelith',
      hasUnsavedChanges: true,
      liveSaveEnabled: true,
      savePhase: 'idle',
    })

    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS)
    expect(handle.createWritable).toHaveBeenCalledTimes(2)
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(false)
  })

  test('a failed Save As resumes the retained live-save queue', async () => {
    const handle = makeHandle()
    const pickSaveFile = vi.fn<ProjectPersistenceDeps['pickSaveFile']>()
      .mockResolvedValueOnce(handle)
      .mockRejectedValueOnce(new Error('replacement unavailable'))
    const deps = makeDeps(handle, { pickSaveFile })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await controller.saveAs()
    useDocumentStore.getState().addTrack('video')

    await expect(controller.saveAs()).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('replacement unavailable'),
    })
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      liveSaveEnabled: true,
      savePhase: 'error',
    })

    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS)
    expect(handle.createWritable).toHaveBeenCalledTimes(2)
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: false,
      savePhase: 'idle',
    })
  })

  test('a save failure preserves the true dirty state and aborts the write', async () => {
    const abort = vi.fn(async () => undefined)
    const failingHandle = makeHandle('Broken.myrelith', () => ({
      write: vi.fn(async () => {
        throw new Error('disk full')
      }),
      close: vi.fn(async () => undefined),
      abort,
    }))
    const deps = makeDeps(failingHandle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: 'Opened.myrelith', persisted: true })

    await expect(controller.saveAs()).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('disk full'),
    })

    expect(abort).toHaveBeenCalledOnce()
    expect(useProjectSessionStore.getState()).toMatchObject({
      activeProjectFileName: 'Opened.myrelith',
      hasUnsavedChanges: false,
      liveSaveEnabled: false,
      savePhase: 'error',
    })
    expect(deps.addBeforeUnload).not.toHaveBeenCalled()
  })

  test('edit bursts debounce into one live write', async () => {
    const handle = makeHandle()
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await controller.saveAs()

    useDocumentStore.getState().addTrack('video')
    await vi.advanceTimersByTimeAsync(500)
    useDocumentStore.getState().addTrack('audio')
    const expectedTracks = useDocumentStore.getState().doc.tracks
    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS - 1)
    expect(handle.createWritable).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)

    expect(handle.createWritable).toHaveBeenCalledTimes(2)
    expect(parseProjectFile(handle.writes[1]).document.tracks)
      .toEqual(expectedTracks)
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(false)
  })

  test('pausing cancels a queued live save and resume restores it', async () => {
    const handle = makeHandle()
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await controller.saveAs()
    useDocumentStore.getState().addTrack('video')

    await controller.pauseSession()
    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS)
    expect(handle.createWritable).toHaveBeenCalledOnce()
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(true)

    controller.resumeSession()
    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS)
    expect(handle.createWritable).toHaveBeenCalledTimes(2)
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(false)
  })

  test('pausing waits for an already-open writable stream', async () => {
    const liveClose = deferred<void>()
    let streamIndex = 0
    const handle = makeHandle('Wait.myrelith', () => {
      const index = streamIndex++
      return {
        write: vi.fn(async () => undefined),
        close: vi.fn(() => index === 0
          ? Promise.resolve()
          : liveClose.promise),
        abort: vi.fn(async () => undefined),
      }
    })
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await controller.saveAs()
    useDocumentStore.getState().addTrack('video')
    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS)
    await vi.waitFor(() => expect(handle.createWritable).toHaveBeenCalledTimes(2))

    let paused = false
    const pausing = controller.pauseSession().then(() => {
      paused = true
    })
    let secondPauseFinished = false
    const pausingAgain = controller.pauseSession().then(() => {
      secondPauseFinished = true
    })
    await Promise.resolve()
    expect(paused).toBe(false)
    expect(secondPauseFinished).toBe(false)

    liveClose.resolve()
    await Promise.all([pausing, pausingAgain])
    expect(paused).toBe(true)
    expect(secondPauseFinished).toBe(true)
  })

  test('an edit during a write stays dirty and gets one latest-state follow-up', async () => {
    const firstClose = deferred<void>()
    const writes: string[] = []
    let streamIndex = 0
    const handle = makeHandle('Latest.myrelith', () => {
      const index = streamIndex++
      return {
        write: vi.fn(async (data: string) => {
          writes.push(data)
        }),
        close: vi.fn(() => index === 0 ? firstClose.promise : Promise.resolve()),
        abort: vi.fn(async () => undefined),
      }
    })
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })

    const firstSave = controller.saveAs()
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    useDocumentStore.getState().addTrack('video')
    const expectedTracks = useDocumentStore.getState().doc.tracks
    firstClose.resolve()
    await expect(firstSave).resolves.toMatchObject({ status: 'saved' })
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(true)

    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS)
    expect(writes).toHaveLength(2)
    expect(parseProjectFile(writes[1]).document.tracks)
      .toEqual(expectedTracks)
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(false)
  })

  test('the first Save requests a writable file and enables live save', async () => {
    const handle = makeHandle()
    const download = vi.fn()
    const deps = makeDeps(handle, { download })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })

    await expect(controller.save()).resolves.toEqual({
      status: 'saved',
      fileName: 'Edit.myrelith',
      liveSaveEnabled: true,
    })

    expect(deps.pickSaveFile).toHaveBeenCalledWith('My edit.myrelith')
    expect(download).not.toHaveBeenCalled()
    expect(handle.createWritable).toHaveBeenCalledOnce()
    expect(parseProjectFile(handle.writes[0]).document.name).toBe('My edit')
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: false,
      liveSaveEnabled: true,
    })
  })

  test('a download fallback stays honestly dirty when durability is unobservable', async () => {
    const handle = makeHandle()
    const download = vi.fn()
    const deps = makeDeps(handle, {
      supportsSavePicker: vi.fn(() => false),
      download,
    })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })

    await expect(controller.saveAs()).resolves.toEqual({
      status: 'downloaded',
      fileName: 'My edit.myrelith',
      liveSaveEnabled: false,
    })

    expect(deps.pickSaveFile).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledOnce()
    expect(parseProjectFile(download.mock.calls[0][0]).document.name).toBe('My edit')
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      liveSaveEnabled: false,
      lastSavedAt: 1_234,
    })
    expect(deps.removeBeforeUnload).not.toHaveBeenCalled()
  })

  test('a fallback copy retains an existing live-save handle', async () => {
    let pickerAvailable = true
    const handle = makeHandle()
    const download = vi.fn()
    const deps = makeDeps(handle, {
      supportsSavePicker: vi.fn(() => pickerAvailable),
      download,
    })
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    await controller.saveAs()
    useDocumentStore.getState().addTrack('video')
    pickerAvailable = false

    await expect(controller.saveAs()).resolves.toEqual({
      status: 'downloaded',
      fileName: 'Edit.myrelith',
      liveSaveEnabled: true,
    })
    expect(useProjectSessionStore.getState()).toMatchObject({
      hasUnsavedChanges: true,
      liveSaveEnabled: true,
    })

    await vi.advanceTimersByTimeAsync(LIVE_SAVE_DELAY_MS)
    expect(handle.createWritable).toHaveBeenCalledTimes(2)
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(false)
  })

  test('tracks durable document/media changes but ignores visual-only updates', async () => {
    const handle = makeHandle()
    const deps = makeDeps(handle)
    const asset = makeAsset()
    useMediaStore.getState().addAsset(asset)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: 'Opened.myrelith', persisted: true })

    useMediaStore.getState().setAssetVisuals(asset.id, {
      filmstrip: null,
      waveform: { url: 'blob:waveform', width: 100, height: 40 },
    })
    useDocumentStore.getState().setTrackFlags('V1', { hidden: false })
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(false)

    useDocumentStore.getState().addTrack('video')
    expect(useProjectSessionStore.getState().hasUnsavedChanges).toBe(true)
  })

  test('only attaches beforeunload while dirty and a stale save cannot touch a replacement', async () => {
    const closeGate = deferred<void>()
    const handle = makeHandle('Old.myrelith', () => ({
      write: vi.fn(async () => undefined),
      close: vi.fn(() => closeGate.promise),
      abort: vi.fn(async () => undefined),
    }))
    const deps = makeDeps(handle)
    controller = new ProjectPersistenceController(deps)
    controller.startSession({ fileName: null, persisted: false })
    const beforeUnload = vi.mocked(deps.addBeforeUnload).mock.calls[0][0]
    const event = {
      preventDefault: vi.fn(),
      returnValue: false,
    }
    beforeUnload(event as unknown as BeforeUnloadEvent)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe(true)

    const oldSave = controller.saveAs()
    await vi.waitFor(() => expect(handle.createWritable).toHaveBeenCalledOnce())
    controller.startSession({ fileName: 'New.myrelith', persisted: true })
    closeGate.resolve()

    await expect(oldSave).resolves.toEqual({ status: 'cancelled' })
    expect(useProjectSessionStore.getState()).toMatchObject({
      activeProjectFileName: 'New.myrelith',
      hasUnsavedChanges: false,
      liveSaveEnabled: false,
      lastSavedAt: null,
    })
    expect(deps.removeBeforeUnload).toHaveBeenCalled()
  })
})
