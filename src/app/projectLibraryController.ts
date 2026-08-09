/**
 * Home-screen facade over origin-local recent handles and recovery journals.
 * Only compact summaries enter Zustand; capabilities and serialized snapshots
 * remain controller-local.
 */

import {
  INITIAL_PROJECT_LIBRARY_STATE,
  useProjectLibraryStore,
  type LocalProjectPermission as LibraryPermission,
} from '../state/projectLibraryStore'
import {
  LOCAL_PROJECT_RECORD_VERSION,
  localProjectStorage,
  queryLocalProjectPermission,
  supportsLocalProjectFiles,
  type LocalProjectFileHandle,
  type LocalProjectPermission,
  type RecentProjectRecord,
  type RecoveryJournalRecord,
} from './localProjectStorage'
import {
  localDerivedStorage,
  type DisposableStorageEstimate,
} from './localDerivedStorage'

interface BrowserStorageEstimate {
  usage: number | null
  quota: number | null
}

export interface ProjectLibraryControllerDeps {
  supportsRecentProjects(): boolean
  listRecentProjects(): Promise<RecentProjectRecord[]>
  listRecoveryJournals(): Promise<RecoveryJournalRecord[]>
  queryPermission(handle: LocalProjectFileHandle): Promise<LocalProjectPermission>
  rememberRecentProject(record: RecentProjectRecord): Promise<void>
  forgetRecentProject(documentId: string): Promise<void>
  deleteRecoveryJournal(journalId: string): Promise<void>
  estimateBrowserStorage?(): Promise<BrowserStorageEstimate | null>
  estimateDisposableStorage?(): Promise<DisposableStorageEstimate>
  clearDisposableStorage?(): Promise<void>
}

async function estimateBrowserStorage(): Promise<BrowserStorageEstimate | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  const normalize = (value: number | undefined): number | null => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : null
  )
  return { usage: normalize(estimate.usage), quota: normalize(estimate.quota) }
}

const realDeps: ProjectLibraryControllerDeps = {
  supportsRecentProjects: supportsLocalProjectFiles,
  listRecentProjects: () => localProjectStorage.listRecentProjects(),
  listRecoveryJournals: () => localProjectStorage.listRecoveryJournals(),
  queryPermission: queryLocalProjectPermission,
  rememberRecentProject: (record) => (
    localProjectStorage.rememberRecentProject(record)
  ),
  forgetRecentProject: (documentId) => (
    localProjectStorage.forgetRecentProject(documentId)
  ),
  deleteRecoveryJournal: (journalId) => (
    localProjectStorage.deleteRecoveryJournal(journalId)
  ),
  estimateBrowserStorage,
  estimateDisposableStorage: () => localDerivedStorage.estimate(),
  clearDisposableStorage: () => localDerivedStorage.clear(),
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export class ProjectLibraryController {
  private readonly deps: ProjectLibraryControllerDeps
  private generation = 0
  private recentRecords = new Map<string, RecentProjectRecord>()
  private recoveryRecords = new Map<string, RecoveryJournalRecord>()
  private activeRefresh: Promise<void> | null = null

  constructor(deps: ProjectLibraryControllerDeps) {
    this.deps = deps
  }

  refresh(force = false): Promise<void> {
    if (this.activeRefresh && !force) return this.activeRefresh
    const generation = ++this.generation
    const refresh = this.runRefresh(generation)
    this.activeRefresh = refresh
    const finish = (): void => {
      if (this.activeRefresh === refresh) this.activeRefresh = null
    }
    void refresh.then(finish, finish)
    return refresh
  }

  getRecentProject(documentId: string): RecentProjectRecord | null {
    return this.recentRecords.get(documentId) ?? null
  }

  getRecoveryJournal(journalId: string): RecoveryJournalRecord | null {
    return this.recoveryRecords.get(journalId) ?? null
  }

  async rememberRecentProject(
    project: Omit<RecentProjectRecord, 'version'>,
  ): Promise<void> {
    await this.deps.rememberRecentProject({
      ...project,
      version: LOCAL_PROJECT_RECORD_VERSION,
    })
    await this.refresh(true)
  }

  async forgetRecentProject(documentId: string): Promise<boolean> {
    try {
      await this.deps.forgetRecentProject(documentId)
      this.recentRecords.delete(documentId)
      await this.refresh(true)
      return true
    } catch (cause) {
      this.publishError(`Could not remove the recent project: ${messageFrom(cause)}`)
      return false
    }
  }

  async deleteRecoveryJournal(journalId: string): Promise<boolean> {
    try {
      await this.deps.deleteRecoveryJournal(journalId)
      this.recoveryRecords.delete(journalId)
      await this.refresh(true)
      return true
    } catch (cause) {
      this.publishError(`Could not discard the recovery copy: ${messageFrom(cause)}`)
      return false
    }
  }

  async deleteRecoveryJournals(journalIds: readonly string[]): Promise<boolean> {
    const exactIds = [...new Set(journalIds)].filter(
      (journalId) => this.recoveryRecords.has(journalId),
    )
    if (exactIds.length === 0) return true
    const results = await Promise.allSettled(
      exactIds.map((journalId) => this.deps.deleteRecoveryJournal(journalId)),
    )
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.recoveryRecords.delete(exactIds[index] as string)
      }
    })
    await this.refresh(true)
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length === 0) return true
    this.publishError(
      `Could not discard ${failed.length} of ${exactIds.length} selected recovery copies. No other local data was changed.`,
    )
    return false
  }

  async clearDisposableStorage(): Promise<boolean> {
    if (!this.deps.clearDisposableStorage) return true
    try {
      await this.deps.clearDisposableStorage()
      await this.refresh(true)
      return true
    } catch (cause) {
      this.publishError(`Could not clear disposable local data: ${messageFrom(cause)}`)
      return false
    }
  }

  reset(): void {
    this.generation++
    this.activeRefresh = null
    this.recentRecords.clear()
    this.recoveryRecords.clear()
    useProjectLibraryStore.setState({ ...INITIAL_PROJECT_LIBRARY_STATE })
  }

  private async runRefresh(generation: number): Promise<void> {
    const recentSupported = this.deps.supportsRecentProjects()
    useProjectLibraryStore.setState({
      phase: 'loading',
      recentProjectsSupported: recentSupported,
      error: null,
    })

    const [
      recentResult,
      recoveryResult,
      browserStorageResult,
      disposableStorageResult,
    ] = await Promise.allSettled([
      recentSupported
        ? this.deps.listRecentProjects()
        : Promise.resolve([] as RecentProjectRecord[]),
      this.deps.listRecoveryJournals(),
      this.deps.estimateBrowserStorage?.() ?? Promise.resolve(null),
      this.deps.estimateDisposableStorage?.()
        ?? Promise.resolve({ bytes: 0, itemCount: 0 }),
    ])
    if (generation !== this.generation) return

    const recent = recentResult.status === 'fulfilled' ? recentResult.value : []
    const recoveries = recoveryResult.status === 'fulfilled'
      ? recoveryResult.value
      : []
    const permissions = await Promise.all(recent.map(async (record) => {
      try {
        return await this.deps.queryPermission(record.handle)
      } catch {
        return 'unknown' as const
      }
    }))
    if (generation !== this.generation) return

    this.recentRecords = new Map(recent.map((record) => [
      record.documentId,
      record,
    ]))
    this.recoveryRecords = new Map(recoveries.map((record) => [
      record.journalId,
      record,
    ]))
    const errors: string[] = []
    if (recentResult.status === 'rejected') {
      errors.push(`Recent projects: ${messageFrom(recentResult.reason)}`)
    }
    if (recoveryResult.status === 'rejected') {
      errors.push(`Recovery copies: ${messageFrom(recoveryResult.reason)}`)
    }
    const storageErrors: string[] = []
    if (browserStorageResult.status === 'rejected') {
      storageErrors.push('Browser quota is unavailable.')
    }
    if (disposableStorageResult.status === 'rejected') {
      storageErrors.push('Disposable storage usage is unavailable.')
    }
    const browserStorage = browserStorageResult.status === 'fulfilled'
      ? browserStorageResult.value
      : null
    const disposableStorage = disposableStorageResult.status === 'fulfilled'
      ? disposableStorageResult.value
      : { bytes: 0, itemCount: 0 }
    const recoveryBytes = recoveries.reduce((total, record) => (
      total + record.generations.reduce((generationTotal, generation) => (
        generationTotal + new TextEncoder().encode(
          generation.serializedProject,
        ).byteLength
      ), 0)
    ), 0)
    const error = errors.length > 0 ? errors.join(' ') : null
    useProjectLibraryStore.setState({
      phase: error ? 'error' : 'ready',
      recentProjectsSupported: recentSupported,
      recentProjects: recent.map((record, index) => ({
        documentId: record.documentId,
        projectName: record.projectName,
        fileName: record.fileName,
        lastOpenedAt: record.lastOpenedAt,
        permission: permissions[index] as LibraryPermission,
      })),
      recoveries: recoveries.map((record) => ({
        journalId: record.journalId,
        documentId: record.documentId,
        projectName: record.projectName,
        projectFileName: record.projectFileName,
        updatedAt: record.updatedAt,
        generationCount: record.generations.length,
      })),
      storage: {
        browserUsageBytes: browserStorage?.usage ?? null,
        browserQuotaBytes: browserStorage?.quota ?? null,
        recoveryBytes,
        disposableBytes: disposableStorage.bytes,
        disposableItemCount: disposableStorage.itemCount,
        error: storageErrors.length > 0 ? storageErrors.join(' ') : null,
      },
      error,
    })
  }

  private publishError(message: string): void {
    useProjectLibraryStore.setState({ phase: 'error', error: message })
  }
}

const controller = new ProjectLibraryController(realDeps)

export function refreshProjectLibrary(): Promise<void> {
  return controller.refresh()
}

export function getRecentProjectRecord(
  documentId: string,
): RecentProjectRecord | null {
  return controller.getRecentProject(documentId)
}

export function getRecoveryJournalRecord(
  journalId: string,
): RecoveryJournalRecord | null {
  return controller.getRecoveryJournal(journalId)
}

export function rememberRecentProjectRecord(
  project: Omit<RecentProjectRecord, 'version'>,
): Promise<void> {
  return controller.rememberRecentProject(project)
}

export function forgetRecentProject(documentId: string): Promise<boolean> {
  return controller.forgetRecentProject(documentId)
}

export function discardRecoveryJournal(journalId: string): Promise<boolean> {
  return controller.deleteRecoveryJournal(journalId)
}

export function discardRecoveryJournals(
  journalIds: readonly string[],
): Promise<boolean> {
  return controller.deleteRecoveryJournals(journalIds)
}

export function clearDisposableLocalData(): Promise<boolean> {
  return controller.clearDisposableStorage()
}

export function resetProjectLibraryController(): void {
  controller.reset()
}
