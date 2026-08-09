import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  INITIAL_PROJECT_LIBRARY_STATE,
  useProjectLibraryStore,
} from '../state/projectLibraryStore'
import {
  LOCAL_PROJECT_RECORD_VERSION,
  type LocalProjectFileHandle,
  type RecentProjectRecord,
  type RecoveryJournalRecord,
} from './localProjectStorage'
import {
  ProjectLibraryController,
  type ProjectLibraryControllerDeps,
} from './projectLibraryController'

function handle(): LocalProjectFileHandle {
  return {
    kind: 'file',
    name: 'Recent.webcut',
    getFile: vi.fn(async () => new File(['{}'], 'Recent.webcut')),
    queryPermission: vi.fn(async () => 'prompt' as const),
  }
}

function recent(): RecentProjectRecord {
  return {
    version: LOCAL_PROJECT_RECORD_VERSION,
    documentId: 'doc-recent',
    projectName: 'Recent edit',
    fileName: 'Recent.webcut',
    lastOpenedAt: 200,
    handle: handle(),
  }
}

function recovery(): RecoveryJournalRecord {
  return {
    version: LOCAL_PROJECT_RECORD_VERSION,
    journalId: 'journal-recovery',
    documentId: 'doc-recovery',
    projectName: 'Recovered edit',
    projectFileName: null,
    updatedAt: 100,
    generations: [{
      snapshotId: 'snapshot-1',
      capturedAt: 100,
      serializedProject: '{}',
    }],
  }
}

function deps(
  overrides: Partial<ProjectLibraryControllerDeps> = {},
): ProjectLibraryControllerDeps {
  return {
    supportsRecentProjects: vi.fn(() => true),
    listRecentProjects: vi.fn(async () => [recent()]),
    listRecoveryJournals: vi.fn(async () => [recovery()]),
    queryPermission: vi.fn(async () => 'prompt' as const),
    rememberRecentProject: vi.fn(async () => undefined),
    forgetRecentProject: vi.fn(async () => undefined),
    deleteRecoveryJournal: vi.fn(async () => undefined),
    ...overrides,
  }
}

beforeEach(() => {
  useProjectLibraryStore.setState({ ...INITIAL_PROJECT_LIBRARY_STATE })
})

describe('project library controller', () => {
  test('publishes summaries while keeping handles and payloads controller-local', async () => {
    const controller = new ProjectLibraryController(deps())

    await controller.refresh()

    expect(useProjectLibraryStore.getState()).toMatchObject({
      phase: 'ready',
      recentProjectsSupported: true,
      recentProjects: [{
        documentId: 'doc-recent',
        projectName: 'Recent edit',
        permission: 'prompt',
      }],
      recoveries: [{
        journalId: 'journal-recovery',
        projectName: 'Recovered edit',
        generationCount: 1,
      }],
    })
    expect(controller.getRecentProject('doc-recent')?.handle).toBeDefined()
    expect(controller.getRecoveryJournal('journal-recovery')?.generations[0])
      .toHaveProperty('serializedProject')
    expect(useProjectLibraryStore.getState().recentProjects[0])
      .not.toHaveProperty('handle')
    expect(useProjectLibraryStore.getState().recoveries[0])
      .not.toHaveProperty('generations')
  })

  test('reports protected recovery bytes separately from disposable data and quota', async () => {
    const controller = new ProjectLibraryController(deps({
      estimateBrowserStorage: vi.fn(async () => ({ usage: 4_096, quota: 8_192 })),
      estimateDisposableStorage: vi.fn(async () => ({ bytes: 512, itemCount: 3 })),
    }))

    await controller.refresh()

    expect(useProjectLibraryStore.getState().storage).toEqual({
      browserUsageBytes: 4_096,
      browserQuotaBytes: 8_192,
      recoveryBytes: 2,
      disposableBytes: 512,
      disposableItemCount: 3,
      error: null,
    })
  })

  test('keeps usable partial results when one local surface fails', async () => {
    const controller = new ProjectLibraryController(deps({
      listRecentProjects: vi.fn(async () => {
        throw new Error('handles unavailable')
      }),
    }))

    await controller.refresh()

    expect(useProjectLibraryStore.getState()).toMatchObject({
      phase: 'error',
      recentProjects: [],
      recoveries: [{ journalId: 'journal-recovery' }],
      error: expect.stringContaining('handles unavailable'),
    })
  })

  test('removes recent and recovery records then refreshes their summaries', async () => {
    const fixture = deps()
    const controller = new ProjectLibraryController(fixture)
    await controller.refresh()
    vi.mocked(fixture.listRecentProjects).mockResolvedValue([])
    vi.mocked(fixture.listRecoveryJournals).mockResolvedValue([])

    await expect(controller.forgetRecentProject('doc-recent')).resolves.toBe(true)
    await expect(controller.deleteRecoveryJournal('journal-recovery'))
      .resolves.toBe(true)

    expect(fixture.forgetRecentProject).toHaveBeenCalledWith('doc-recent')
    expect(fixture.deleteRecoveryJournal)
      .toHaveBeenCalledWith('journal-recovery')
    expect(useProjectLibraryStore.getState()).toMatchObject({
      recentProjects: [],
      recoveries: [],
    })
  })

  test('bulk cleanup deletes only exact loaded recovery ids once', async () => {
    const fixture = deps()
    const controller = new ProjectLibraryController(fixture)
    await controller.refresh()

    await expect(controller.deleteRecoveryJournals([
      'journal-recovery',
      'unknown-journal',
      'journal-recovery',
    ])).resolves.toBe(true)

    expect(fixture.deleteRecoveryJournal).toHaveBeenCalledTimes(1)
    expect(fixture.deleteRecoveryJournal).toHaveBeenCalledWith('journal-recovery')
  })

  test('clears only the registered disposable surface then refreshes usage', async () => {
    const clearDisposableStorage = vi.fn(async () => undefined)
    const estimateDisposableStorage = vi
      .fn<() => Promise<{ bytes: number; itemCount: number }>>()
      .mockResolvedValueOnce({ bytes: 100, itemCount: 1 })
      .mockResolvedValueOnce({ bytes: 0, itemCount: 0 })
    const controller = new ProjectLibraryController(deps({
      clearDisposableStorage,
      estimateDisposableStorage,
    }))
    await controller.refresh()

    await expect(controller.clearDisposableStorage()).resolves.toBe(true)
    expect(clearDisposableStorage).toHaveBeenCalledOnce()
    expect(useProjectLibraryStore.getState().storage.disposableBytes).toBe(0)
  })
})
