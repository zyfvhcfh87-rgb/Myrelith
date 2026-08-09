import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CURRENT_PROJECT_FORMAT_VERSION,
  CURRENT_TIMELINE_SCHEMA_VERSION,
  parseProjectFile,
  PROJECT_FILE_FORMAT,
  serializeProjectFile,
  type ProjectFile,
} from '../domain/projectFile'
import {
  createLocalProjectStorage,
  createMapLocalProjectStorageBackend,
  isLocalProjectPickerCancellation,
  LOCAL_PROJECT_RECORD_VERSION,
  LOCAL_PROJECT_STORAGE_LIMITS,
  pickLocalProjectFile,
  queryLocalProjectPermission,
  requestLocalProjectPermission,
  supportsLocalProjectFiles,
  type LocalProjectFileHandle,
  type LocalProjectStorageBackend,
  type RecentProjectRecord,
  type RecoverySnapshotInput,
} from './localProjectStorage'

function makeHandle(name = 'project.myrelith'): LocalProjectFileHandle {
  return {
    kind: 'file',
    name,
    getFile: vi.fn(async () => new File(['project'], name, {
      type: 'application/json',
    })),
    isSameEntry: vi.fn(async () => false),
    createWritable: vi.fn(async () => ({
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    })),
  }
}

function recentProject(
  documentId: string,
  lastOpenedAt: number,
): RecentProjectRecord {
  return {
    version: LOCAL_PROJECT_RECORD_VERSION,
    documentId,
    projectName: `Project ${documentId}`,
    fileName: `${documentId}.myrelith`,
    lastOpenedAt,
    handle: makeHandle(`${documentId}.myrelith`),
  }
}

function serializedProject(
  documentId: string,
  projectName = `Project ${documentId}`,
): string {
  const project: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document: {
      schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
      id: documentId,
      name: projectName,
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      tracks: [],
      markers: [],
      captionTracks: [],
    },
    assets: [],
    collections: [],
  }
  return serializeProjectFile(project)
}

function recoverySnapshot(
  journalId: string,
  documentId: string,
  capturedAt: number,
  projectName = `Project ${documentId}`,
): RecoverySnapshotInput {
  return {
    journalId,
    snapshotId: `${journalId}-snapshot-${capturedAt}`,
    documentId,
    projectName,
    projectFileName: `${documentId}.myrelith`,
    capturedAt,
    serializedProject: serializedProject(documentId, projectName),
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'showOpenFilePicker')
})

describe('recent project storage', () => {
  test('sorts recent project handles and keeps only the newest twelve', async () => {
    const backend = createMapLocalProjectStorageBackend()
    const storage = createLocalProjectStorage(backend)

    for (let index = 0; index < 14; index++) {
      await storage.rememberRecentProject(recentProject(`doc-${index}`, index))
    }

    const records = await storage.listRecentProjects()
    expect(records).toHaveLength(LOCAL_PROJECT_STORAGE_LIMITS.maxRecentProjects)
    expect(records.map((record) => record.documentId)).toEqual([
      'doc-13',
      'doc-12',
      'doc-11',
      'doc-10',
      'doc-9',
      'doc-8',
      'doc-7',
      'doc-6',
      'doc-5',
      'doc-4',
      'doc-3',
      'doc-2',
    ])
    expect(backend.stores['recent-projects'].has('doc-0')).toBe(false)
    expect(backend.stores['recent-projects'].has('doc-1')).toBe(false)
  })

  test('ignores corrupt records without exposing their untrusted fields', async () => {
    const backend = createMapLocalProjectStorageBackend()
    backend.stores['recent-projects'].set('broken', {
      version: LOCAL_PROJECT_RECORD_VERSION,
      documentId: 'broken',
      projectName: 'Broken',
      fileName: 'broken.myrelith',
      lastOpenedAt: 10,
      handle: { kind: 'file', name: 'broken.myrelith', getFile: 'not callable' },
    })
    backend.stores['recent-projects'].set('future', {
      ...recentProject('future', 20),
      version: 2,
    })
    backend.stores['recent-projects'].set('invalid-date', {
      ...recentProject('invalid-date', 20),
      lastOpenedAt: Number.MAX_SAFE_INTEGER,
    })
    const storage = createLocalProjectStorage(backend)

    await expect(storage.listRecentProjects()).resolves.toEqual([])
    await expect(storage.forgetRecentProject('broken')).resolves.toBeUndefined()
  })

  test('serializes writes for one document so the latest call wins', async () => {
    const mapBackend = createMapLocalProjectStorageBackend()
    let setCount = 0
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const backend: LocalProjectStorageBackend = {
      ...mapBackend,
      async set(storeName, key, value) {
        setCount++
        if (setCount === 1) {
          firstStarted()
          await firstCanFinish
        }
        await mapBackend.set(storeName, key, value)
      },
    }
    const storage = createLocalProjectStorage(backend)
    const older = recentProject('same-doc', 1)
    const newer = recentProject('same-doc', 2)

    const first = storage.rememberRecentProject(older)
    await firstDidStart
    const second = storage.rememberRecentProject(newer)
    expect(setCount).toBe(1)

    releaseFirst()
    await Promise.all([first, second])

    const records = await storage.listRecentProjects()
    expect(setCount).toBe(2)
    expect(records).toHaveLength(1)
    expect(records[0].lastOpenedAt).toBe(2)
    expect(records[0].handle).toBe(newer.handle)
  })
})

describe('recovery journal storage', () => {
  test('round-trips timeline markers inside recovery snapshots', async () => {
    const backend = createMapLocalProjectStorageBackend()
    const storage = createLocalProjectStorage(backend)
    const project = parseProjectFile(serializedProject('doc-markers'))
    project.document.markers = [{
      id: 'marker-recovery',
      frame: 240,
      label: 'Recovery beat',
      color: 'purple',
      note: 'Still here',
    }]
    const snapshot = recoverySnapshot('journal-markers', 'doc-markers', 1)

    await storage.appendRecoverySnapshot({
      ...snapshot,
      serializedProject: serializeProjectFile(project),
    })

    const journal = await storage.getRecoveryJournal('journal-markers')
    const recovered = parseProjectFile(journal?.generations[0].serializedProject ?? '')
    expect(recovered.document.markers).toEqual(project.document.markers)
  })

  test('writes each full journal atomically and retains only three generations', async () => {
    const mapBackend = createMapLocalProjectStorageBackend()
    const writtenGenerationCounts: number[] = []
    const backend: LocalProjectStorageBackend = {
      ...mapBackend,
      async set(storeName, key, value) {
        if (storeName === 'recovery-journals') {
          const record = value as { generations: unknown[] }
          writtenGenerationCounts.push(record.generations.length)
        }
        await mapBackend.set(storeName, key, value)
      },
    }
    const storage = createLocalProjectStorage(backend)

    for (let capturedAt = 1; capturedAt <= 4; capturedAt++) {
      await storage.appendRecoverySnapshot(
        recoverySnapshot('journal-a', 'doc-a', capturedAt),
      )
    }

    const journal = await storage.getRecoveryJournal('journal-a')
    expect(writtenGenerationCounts).toEqual([1, 2, 3, 3])
    expect(journal?.generations.map((generation) => generation.capturedAt))
      .toEqual([2, 3, 4])
    expect(journal?.generations.map((generation) => generation.snapshotId))
      .toEqual([
        'journal-a-snapshot-2',
        'journal-a-snapshot-3',
        'journal-a-snapshot-4',
      ])
  })

  test('leaves the previously committed generation intact when append fails', async () => {
    const mapBackend = createMapLocalProjectStorageBackend()
    let rejectWrites = false
    const backend: LocalProjectStorageBackend = {
      ...mapBackend,
      async set(storeName, key, value) {
        if (rejectWrites && storeName === 'recovery-journals') {
          throw new Error('simulated interrupted transaction')
        }
        await mapBackend.set(storeName, key, value)
      },
    }
    const storage = createLocalProjectStorage(backend)
    await storage.appendRecoverySnapshot(recoverySnapshot('journal-a', 'doc-a', 1))
    const before = mapBackend.stores['recovery-journals'].get('journal-a')

    rejectWrites = true
    await expect(storage.appendRecoverySnapshot(
      recoverySnapshot('journal-a', 'doc-a', 2),
    )).rejects.toThrow('simulated interrupted transaction')

    expect(mapBackend.stores['recovery-journals'].get('journal-a')).toBe(before)
    const journal = await storage.getRecoveryJournal('journal-a')
    expect(journal?.generations.map((generation) => generation.capturedAt))
      .toEqual([1])
  })

  test('prunes old journals by count and total serialized characters', async () => {
    const byCountBackend = createMapLocalProjectStorageBackend()
    const byCount = createLocalProjectStorage(byCountBackend, {
      limits: { maxRecoveryJournals: 2 },
    })
    await byCount.appendRecoverySnapshot(recoverySnapshot('journal-a', 'doc-a', 1))
    await byCount.appendRecoverySnapshot(recoverySnapshot('journal-b', 'doc-b', 2))
    await byCount.appendRecoverySnapshot(recoverySnapshot('journal-c', 'doc-c', 3))
    await expect(byCount.listRecoveryJournals()).resolves.toMatchObject([
      { journalId: 'journal-c' },
      { journalId: 'journal-b' },
    ])

    const bySizeBackend = createMapLocalProjectStorageBackend()
    const oneSnapshotSize = serializedProject('doc-a').length
    const bySize = createLocalProjectStorage(bySizeBackend, {
      limits: {
        maxRecoverySerializedCharacters: oneSnapshotSize,
      },
    })
    await bySize.appendRecoverySnapshot(recoverySnapshot('journal-a', 'doc-a', 1))
    await bySize.appendRecoverySnapshot(recoverySnapshot('journal-b', 'doc-b', 2))
    await expect(bySize.listRecoveryJournals()).resolves.toMatchObject([
      { journalId: 'journal-b' },
    ])
  })

  test('ignores malformed journals and rejects non-portable snapshots', async () => {
    const backend = createMapLocalProjectStorageBackend()
    backend.stores['recovery-journals'].set('broken', {
      version: LOCAL_PROJECT_RECORD_VERSION,
      journalId: 'broken',
      documentId: 'doc-a',
      projectName: 'Project doc-a',
      projectFileName: null,
      updatedAt: 1,
      generations: [{
        snapshotId: 'broken-1',
        capturedAt: 1,
        serializedProject: '{ definitely not project JSON',
      }],
    })
    const storage = createLocalProjectStorage(backend)

    await expect(storage.listRecoveryJournals()).resolves.toEqual([])
    await expect(storage.getRecoveryJournal('broken')).resolves.toBeNull()
    await expect(storage.appendRecoverySnapshot({
      ...recoverySnapshot('new', 'doc-a', 2),
      serializedProject: '{}',
    })).rejects.toThrow('not a portable Myrelith project')
  })

  test('falls back to an older complete generation when the newest is corrupt', async () => {
    const backend = createMapLocalProjectStorageBackend()
    const storage = createLocalProjectStorage(backend)
    await storage.appendRecoverySnapshot(
      recoverySnapshot('journal-a', 'doc-a', 1),
    )
    await storage.appendRecoverySnapshot(
      recoverySnapshot('journal-a', 'doc-a', 2),
    )
    const stored = backend.stores['recovery-journals'].get('journal-a') as {
      generations: Array<{ serializedProject: string }>
    }
    stored.generations[1].serializedProject = '{broken newest snapshot'

    await expect(storage.getRecoveryJournal('journal-a')).resolves.toMatchObject({
      updatedAt: 1,
      generations: [{ capturedAt: 1 }],
    })
  })

  test('rejects reusing one journal id for a different document', async () => {
    const storage = createLocalProjectStorage(
      createMapLocalProjectStorageBackend(),
    )
    await storage.appendRecoverySnapshot(recoverySnapshot('journal', 'doc-a', 1))

    await expect(storage.appendRecoverySnapshot(
      recoverySnapshot('journal', 'doc-b', 2),
    )).rejects.toThrow('different document')
  })
})

describe('local project picker helpers', () => {
  test('opens one .myrelith file through a remembered handle', async () => {
    const handle = makeHandle('saved.myrelith')
    const picker = vi.fn(async () => [handle])
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: picker,
    })

    expect(supportsLocalProjectFiles()).toBe(true)
    const selection = await pickLocalProjectFile()

    expect(selection.handle).toBe(handle)
    expect(selection.file.name).toBe('saved.myrelith')
    expect(picker).toHaveBeenCalledWith({
      id: 'myrelith-project',
      multiple: false,
      excludeAcceptAllOption: true,
      types: [{
        description: 'Myrelith project',
        accept: { 'application/json': ['.myrelith', '.webcut'] },
      }],
    })
  })

  test('queries and requests least-privilege read access with a legacy fallback', async () => {
    const modern = makeHandle()
    modern.queryPermission = vi.fn(async () => 'prompt' as const)
    modern.requestPermission = vi.fn(async () => 'granted' as const)

    await expect(queryLocalProjectPermission(modern)).resolves.toBe('prompt')
    await expect(requestLocalProjectPermission(modern)).resolves.toBe('granted')
    expect(modern.queryPermission).toHaveBeenCalledWith({ mode: 'read' })
    expect(modern.requestPermission).toHaveBeenCalledWith({ mode: 'read' })

    const legacy = makeHandle()
    await expect(queryLocalProjectPermission(legacy)).resolves.toBe('granted')
    await expect(requestLocalProjectPermission(legacy)).resolves.toBe('granted')
  })

  test('recognizes picker cancellation without treating other failures as cancel', () => {
    expect(isLocalProjectPickerCancellation(new DOMException('', 'AbortError')))
      .toBe(true)
    expect(isLocalProjectPickerCancellation(new Error('disk failure'))).toBe(false)
  })
})
