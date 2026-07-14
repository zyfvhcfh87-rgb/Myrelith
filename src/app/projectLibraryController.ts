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

export interface ProjectLibraryControllerDeps {
  supportsRecentProjects(): boolean
  listRecentProjects(): Promise<RecentProjectRecord[]>
  listRecoveryJournals(): Promise<RecoveryJournalRecord[]>
  queryPermission(handle: LocalProjectFileHandle): Promise<LocalProjectPermission>
  rememberRecentProject(record: RecentProjectRecord): Promise<void>
  forgetRecentProject(documentId: string): Promise<void>
  deleteRecoveryJournal(journalId: string): Promise<void>
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

    const [recentResult, recoveryResult] = await Promise.allSettled([
      recentSupported
        ? this.deps.listRecentProjects()
        : Promise.resolve([] as RecentProjectRecord[]),
      this.deps.listRecoveryJournals(),
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

export function resetProjectLibraryController(): void {
  controller.reset()
}
