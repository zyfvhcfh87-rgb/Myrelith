/**
 * Portable project persistence composition root.
 *
 * The writable file handle is deliberately controller-local: it is a
 * session capability, not serializable editor state. The first Save and every
 * Save As use the picker path. Once that explicit grant succeeds, later
 * document/media changes are written back after a short debounce.
 */

import {
  createProjectFileSnapshot,
  serializeProjectFile,
} from '../domain/projectFile'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useProjectSessionStore } from '../state/projectSessionStore'
import {
  LOCAL_PROJECT_RECORD_VERSION,
  localProjectStorage,
  type LocalProjectFileHandle,
} from './localProjectStorage'

export const LIVE_SAVE_DELAY_MS = 800
export const RECOVERY_SAVE_DELAY_MS = 500

export interface ProjectWritableFileStream {
  write(data: string): Promise<void>
  close(): Promise<void>
  abort?(reason?: unknown): Promise<void>
}

export interface ProjectWritableFileHandle {
  readonly name: string
  readonly kind?: 'file'
  getFile?(): Promise<File>
  createWritable(): Promise<ProjectWritableFileStream>
}

export interface ProjectRecoverySnapshot {
  journalId: string
  snapshotId: string
  documentId: string
  projectName: string
  projectFileName: string | null
  capturedAt: number
  serializedProject: string
}

export interface RecentProjectBookmark {
  documentId: string
  projectName: string
  fileName: string
  lastOpenedAt: number
  handle: ProjectWritableFileHandle
}

export interface ProjectPersistenceDeps {
  supportsSavePicker(): boolean
  pickSaveFile(suggestedName: string): Promise<ProjectWritableFileHandle>
  download(serialized: string, fileName: string): void
  now(): number
  setTimer(callback: () => void, delayMilliseconds: number): number
  clearTimer(timer: number): void
  addBeforeUnload(handler: (event: BeforeUnloadEvent) => void): void
  removeBeforeUnload(handler: (event: BeforeUnloadEvent) => void): void
  createRecoveryJournalId(): string
  createRecoverySnapshotId(): string
  appendRecoverySnapshot(snapshot: ProjectRecoverySnapshot): Promise<void>
  deleteRecoveryJournal(journalId: string): Promise<void>
  rememberRecentProject(bookmark: RecentProjectBookmark): Promise<void>
}

export interface ProjectPersistenceSession {
  fileName: string | null
  persisted: boolean
  recoveryJournalId?: string
  recoveryCapturedAt?: number | null
}

export type ProjectSaveResult =
  | { status: 'saved'; fileName: string; liveSaveEnabled: boolean }
  | { status: 'downloaded'; fileName: string; liveSaveEnabled: boolean }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

interface SavePickerOptions {
  suggestedName: string
  excludeAcceptAllOption: boolean
  types: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (
    options: SavePickerOptions,
  ) => Promise<ProjectWritableFileHandle>
}

function browserWindow(): SavePickerWindow {
  return window as SavePickerWindow
}

function downloadProject(serialized: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([serialized], {
    type: 'application/json',
  }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const realDeps: ProjectPersistenceDeps = {
  supportsSavePicker: () => (
    typeof browserWindow().showSaveFilePicker === 'function'
  ),
  pickSaveFile: async (suggestedName) => {
    const picker = browserWindow().showSaveFilePicker
    if (!picker) throw new Error('This browser cannot choose a writable file')
    return picker.call(window, {
      suggestedName,
      excludeAcceptAllOption: true,
      types: [{
        description: 'WebCut project',
        accept: { 'application/json': ['.webcut'] },
      }],
    })
  },
  download: downloadProject,
  now: () => Date.now(),
  setTimer: (callback, delayMilliseconds) => (
    window.setTimeout(callback, delayMilliseconds)
  ),
  clearTimer: (timer) => window.clearTimeout(timer),
  addBeforeUnload: (handler) => window.addEventListener('beforeunload', handler),
  removeBeforeUnload: (handler) => window.removeEventListener('beforeunload', handler),
  createRecoveryJournalId: () => `recovery_${crypto.randomUUID()}`,
  createRecoverySnapshotId: () => `snapshot_${crypto.randomUUID()}`,
  appendRecoverySnapshot: async (snapshot) => {
    await localProjectStorage.appendRecoverySnapshot(snapshot)
  },
  deleteRecoveryJournal: (journalId) => (
    localProjectStorage.deleteRecoveryJournal(journalId)
  ),
  rememberRecentProject: async (bookmark) => {
    const { handle } = bookmark
    if (
      handle.kind !== 'file'
      || typeof handle.getFile !== 'function'
    ) {
      return
    }
    await localProjectStorage.rememberRecentProject({
      version: LOCAL_PROJECT_RECORD_VERSION,
      documentId: bookmark.documentId,
      projectName: bookmark.projectName,
      fileName: bookmark.fileName,
      lastOpenedAt: bookmark.lastOpenedAt,
      handle: handle as LocalProjectFileHandle,
    })
  },
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isPickerCancellation(cause: unknown): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && cause.name === 'AbortError'
}

/** Windows-safe, extension-stable default for both picker and fallback. */
export function projectFileName(projectName: string): string {
  let base = projectName.trim().replace(/[. ]+$/g, '').replace(/\.webcut$/i, '')
  base = base.replace(/[<>:"/\\|?*]/g, '-')
  base = Array.from(base, (character) => (
    character.charCodeAt(0) < 32 ? '-' : character
  )).join('')
  base = Array.from(base).slice(0, 80).join('').replace(/[. ]+$/g, '')
  if (
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i
      .test(base)
  ) {
    base = `webcut-${base}`
  }
  return `${base || 'untitled-project'}.webcut`
}

interface SaveOperation {
  generation: number
  kind: 'current' | 'save-as' | 'live'
}

interface CapturedProjectSnapshot {
  serialized: string
  revision: number
  documentId: string
  projectName: string
}

export class ProjectPersistenceController {
  private readonly deps: ProjectPersistenceDeps
  private active = false
  private generation = 0
  private revision = 0
  private persistedRevision = 0
  private handle: ProjectWritableFileHandle | null = null
  private timer: number | null = null
  private recoveryTimer: number | null = null
  private operation: SaveOperation | null = null
  private activeWrite: Promise<ProjectSaveResult> | null = null
  private activeRecoveryWrite: Promise<void> | null = null
  private recoveryFollowUp = false
  private recoveryRevision = 0
  private recoveryJournalId: string | null = null
  private paused = false
  private unsubscribeDocument: (() => void) | null = null
  private unsubscribeMedia: (() => void) | null = null
  private beforeUnloadAttached = false

  private readonly beforeUnloadHandler = (event: BeforeUnloadEvent): void => {
    event.preventDefault()
    event.returnValue = true
  }

  constructor(deps: ProjectPersistenceDeps) {
    this.deps = deps
  }

  startSession(session: ProjectPersistenceSession): void {
    this.suspendSession()
    this.active = true
    this.revision = 0
    this.persistedRevision = session.persisted ? 0 : -1
    this.recoveryRevision = session.persisted || session.recoveryCapturedAt
      ? 0
      : -1
    this.recoveryJournalId = session.recoveryJournalId
      ?? this.deps.createRecoveryJournalId()
    this.recoveryFollowUp = false
    this.unsubscribeDocument = useDocumentStore.subscribe((state, previous) => {
      if (state.doc !== previous.doc) this.markDirty()
    })
    this.unsubscribeMedia = useMediaStore.subscribe((state, previous) => {
      if (state.assets !== previous.assets) this.markDirty()
    })
    const hasUnsavedChanges = !session.persisted
    useProjectSessionStore.setState({
      activeProjectFileName: session.fileName,
      hasUnsavedChanges,
      savePhase: 'idle',
      liveSaveEnabled: false,
      lastSavedAt: null,
      saveError: null,
      recoveryPhase: 'idle',
      lastRecoveryAt: session.recoveryCapturedAt ?? null,
      recoveryError: null,
    })
    this.syncBeforeUnload(hasUnsavedChanges)
    if (this.recoveryRevision < this.revision) this.scheduleRecovery()
  }

  suspendSession(): void {
    this.generation++
    this.active = false
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    if (this.recoveryTimer !== null) this.deps.clearTimer(this.recoveryTimer)
    this.recoveryTimer = null
    this.unsubscribeDocument?.()
    this.unsubscribeDocument = null
    this.unsubscribeMedia?.()
    this.unsubscribeMedia = null
    this.handle = null
    this.operation = null
    this.recoveryJournalId = null
    this.recoveryFollowUp = false
    this.paused = false
    this.syncBeforeUnload(false)
  }

  /** Stop new writes immediately and wait for an already-open stream. */
  async pauseSession(): Promise<void> {
    if (!this.active) return
    if (this.paused) {
      await Promise.all([
        this.activeWrite ?? Promise.resolve(),
        this.activeRecoveryWrite?.catch(() => undefined) ?? Promise.resolve(),
      ])
      return
    }
    this.paused = true
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    if (this.recoveryTimer !== null) this.deps.clearTimer(this.recoveryTimer)
    this.recoveryTimer = null
    const activeWrite = this.activeWrite
    const activeRecoveryWrite = this.activeRecoveryWrite
    if (this.operation && !activeWrite) {
      // A picker may still be open, but it no longer owns this session.
      this.operation = null
      useProjectSessionStore.setState({ savePhase: 'idle', saveError: null })
    }
    await Promise.all([
      activeWrite ?? Promise.resolve(),
      activeRecoveryWrite?.catch(() => undefined) ?? Promise.resolve(),
    ])
  }

  /** Restore the retained handle after an editor-exit attempt fails. */
  resumeSession(): void {
    if (!this.active || !this.paused) return
    this.paused = false
    if (
      useProjectSessionStore.getState().hasUnsavedChanges
      && this.handle
      && !this.operation
      && !this.activeWrite
    ) {
      this.scheduleLiveSave()
    }
    if (this.revision !== this.recoveryRevision) this.scheduleRecovery()
  }

  /** Remove this editing lineage only after any in-flight recovery write ends. */
  async discardRecovery(): Promise<void> {
    const journalId = this.recoveryJournalId
    if (!journalId) return
    const pending = this.activeRecoveryWrite
    if (pending) {
      try {
        await pending
      } catch {
        // Deleting the journal is still the useful intentional-discard action.
      }
    }
    if (journalId !== this.recoveryJournalId) return
    await this.deps.deleteRecoveryJournal(journalId)
    if (journalId !== this.recoveryJournalId) return
    // A later teardown step can still fail after this intentional delete. Keep
    // dirty work eligible for a fresh recovery write if the editor is resumed.
    this.recoveryRevision = useProjectSessionStore.getState().hasUnsavedChanges
      ? this.revision - 1
      : this.revision
    useProjectSessionStore.setState({
      recoveryPhase: 'idle',
      lastRecoveryAt: null,
      recoveryError: null,
    })
  }

  async save(): Promise<ProjectSaveResult> {
    if (!this.active) return this.inactiveResult()
    if (!this.handle) return this.saveAs()
    const operation = this.beginOperation('current')
    if (!operation) return this.busyResult()
    return this.trackWrite(this.writeToHandle(operation, this.handle, false))
  }

  async saveAs(): Promise<ProjectSaveResult> {
    if (!this.active) return this.inactiveResult()
    const operation = this.beginOperation('save-as')
    if (!operation) return this.busyResult()

    if (!this.deps.supportsSavePicker()) {
      return this.downloadFallback(operation)
    }

    let target: ProjectWritableFileHandle
    try {
      // Keep the picker first in this async path: transient user activation
      // must still be present when the browser checks this call.
      target = await this.deps.pickSaveFile(this.suggestedFileName())
    } catch (cause) {
      if (isPickerCancellation(cause)) {
        this.finishCancelledOperation(operation)
        return { status: 'cancelled' }
      }
      return this.failOperation(operation, cause)
    }
    if (!this.operationIsCurrent(operation)) return { status: 'cancelled' }
    return this.trackWrite(this.writeToHandle(operation, target, true))
  }

  private suggestedFileName(): string {
    const session = useProjectSessionStore.getState()
    return session.activeProjectFileName
      ?? projectFileName(session.activeProjectName ?? 'Untitled project')
  }

  private capture(): CapturedProjectSnapshot {
    const revision = this.revision
    const project = createProjectFileSnapshot(
      useDocumentStore.getState().doc,
      useMediaStore.getState().assets.values(),
    )
    return {
      serialized: serializeProjectFile(project),
      revision,
      documentId: project.document.id,
      projectName: project.document.name,
    }
  }

  private beginOperation(kind: SaveOperation['kind']): SaveOperation | null {
    if (this.operation || this.paused) return null
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    const operation = { generation: this.generation, kind }
    this.operation = operation
    useProjectSessionStore.setState({ savePhase: 'saving', saveError: null })
    return operation
  }

  private trackWrite(
    write: Promise<ProjectSaveResult>,
  ): Promise<ProjectSaveResult> {
    this.activeWrite = write
    void write.then(() => {
      if (this.activeWrite === write) this.activeWrite = null
    })
    return write
  }

  private operationIsCurrent(operation: SaveOperation): boolean {
    return this.active
      && this.operation === operation
      && operation.generation === this.generation
  }

  private async writeToHandle(
    operation: SaveOperation,
    target: ProjectWritableFileHandle,
    adoptTarget: boolean,
  ): Promise<ProjectSaveResult> {
    if (!this.operationIsCurrent(operation)) return { status: 'cancelled' }
    let writable: ProjectWritableFileStream | null = null
    try {
      const snapshot = this.capture()
      writable = await target.createWritable()
      await writable.write(snapshot.serialized)
      await writable.close()
      writable = null
      if (!this.operationIsCurrent(operation)) return { status: 'cancelled' }
      if (adoptTarget) this.handle = target
      await Promise.all([
        this.rememberRecentBestEffort(snapshot, target),
        this.clearRecoveryAfterSuccessfulSave(snapshot, operation),
      ])
      if (!this.operationIsCurrent(operation)) return { status: 'cancelled' }
      this.completeSave(operation, snapshot.revision, target.name)
      return {
        status: 'saved',
        fileName: target.name,
        liveSaveEnabled: true,
      }
    } catch (cause) {
      if (writable?.abort) {
        try {
          await writable.abort(cause)
        } catch {
          // Preserve the write failure as the useful error.
        }
      }
      return this.failOperation(operation, cause)
    }
  }

  private downloadFallback(operation: SaveOperation): ProjectSaveResult {
    try {
      const snapshot = this.capture()
      const fileName = this.suggestedFileName()
      this.deps.download(snapshot.serialized, fileName)
      this.completeDownloadCopy(operation, fileName)
      return {
        status: 'downloaded',
        fileName,
        liveSaveEnabled: this.handle !== null,
      }
    } catch (cause) {
      return this.failOperation(operation, cause)
    }
  }

  private completeDownloadCopy(
    operation: SaveOperation,
    fileName: string,
  ): void {
    if (!this.operationIsCurrent(operation)) return
    const hasUnsavedChanges = this.revision !== this.persistedRevision
    this.operation = null
    useProjectSessionStore.setState({
      activeProjectFileName: fileName,
      hasUnsavedChanges,
      savePhase: 'idle',
      liveSaveEnabled: this.handle !== null,
      lastSavedAt: this.deps.now(),
      saveError: null,
    })
    this.syncBeforeUnload(hasUnsavedChanges)
    if (hasUnsavedChanges && this.handle) this.scheduleLiveSave()
  }

  private completeSave(
    operation: SaveOperation,
    savedRevision: number,
    fileName: string,
  ): void {
    if (!this.operationIsCurrent(operation)) return
    this.persistedRevision = savedRevision
    const hasUnsavedChanges = this.revision !== this.persistedRevision
    this.operation = null
    useProjectSessionStore.setState({
      activeProjectFileName: fileName,
      hasUnsavedChanges,
      savePhase: 'idle',
      liveSaveEnabled: this.handle !== null,
      lastSavedAt: this.deps.now(),
      saveError: null,
    })
    this.syncBeforeUnload(hasUnsavedChanges)
    if (hasUnsavedChanges && this.handle) this.scheduleLiveSave()
  }

  private async rememberRecentBestEffort(
    snapshot: CapturedProjectSnapshot,
    handle: ProjectWritableFileHandle,
  ): Promise<void> {
    try {
      await this.deps.rememberRecentProject({
        documentId: snapshot.documentId,
        projectName: snapshot.projectName,
        fileName: handle.name,
        lastOpenedAt: this.deps.now(),
        handle,
      })
    } catch (cause) {
      console.warn('Could not add the saved project to Recent projects', cause)
    }
  }

  private async clearRecoveryAfterSuccessfulSave(
    snapshot: CapturedProjectSnapshot,
    operation: SaveOperation,
  ): Promise<void> {
    const journalId = this.recoveryJournalId
    if (!journalId) return
    const pendingRecovery = this.activeRecoveryWrite
    if (pendingRecovery) {
      try {
        await pendingRecovery
      } catch {
        // The user-file write already succeeded. Recovery errors remain a
        // separate status and must never turn that durable save into failure.
      }
    }
    if (
      !this.operationIsCurrent(operation)
      || this.recoveryJournalId !== journalId
      || this.revision !== snapshot.revision
    ) {
      return
    }
    // A manual Save can finish before the pending recovery debounce. Cancel
    // that older timer before deleting the now-redundant journal so it cannot
    // recreate a recovery copy for already-saved work.
    if (this.recoveryTimer !== null) {
      this.deps.clearTimer(this.recoveryTimer)
      this.recoveryTimer = null
    }
    try {
      await this.deps.deleteRecoveryJournal(journalId)
      if (!this.operationIsCurrent(operation)) return
      this.recoveryRevision = snapshot.revision
      useProjectSessionStore.setState({
        recoveryPhase: 'idle',
        lastRecoveryAt: null,
        recoveryError: null,
      })
    } catch (cause) {
      const message = `Could not clear the recovery copy: ${messageFrom(cause)}`
      if (this.operationIsCurrent(operation)) {
        useProjectSessionStore.setState({
          recoveryPhase: 'error',
          recoveryError: message,
        })
      }
      console.warn(message, cause)
    } finally {
      if (
        this.operationIsCurrent(operation)
        && this.revision !== snapshot.revision
      ) {
        this.scheduleRecovery()
      }
    }
  }

  private finishCancelledOperation(operation: SaveOperation): void {
    if (!this.operationIsCurrent(operation)) return
    this.operation = null
    useProjectSessionStore.setState({ savePhase: 'idle', saveError: null })
    if (
      useProjectSessionStore.getState().hasUnsavedChanges
      && this.handle
    ) {
      this.scheduleLiveSave()
    }
  }

  private failOperation(
    operation: SaveOperation,
    cause: unknown,
  ): { status: 'failed'; message: string } {
    const message = `Could not save the project: ${messageFrom(cause)}`
    if (this.operationIsCurrent(operation)) {
      const hasUnsavedChanges = this.revision !== this.persistedRevision
      this.operation = null
      useProjectSessionStore.setState({
        hasUnsavedChanges,
        savePhase: 'error',
        saveError: message,
      })
      this.syncBeforeUnload(hasUnsavedChanges)
      if (
        hasUnsavedChanges
        && this.handle
        && !this.paused
        && operation.kind === 'save-as'
      ) {
        this.scheduleLiveSave()
      }
    }
    return { status: 'failed', message }
  }

  private markDirty(): void {
    if (!this.active) return
    this.revision++
    useProjectSessionStore.setState({ hasUnsavedChanges: true })
    this.syncBeforeUnload(true)
    this.scheduleRecovery()
    if (!this.handle) return
    if (this.operation) return
    this.scheduleLiveSave()
  }

  private scheduleLiveSave(): void {
    if (!this.active || !this.handle || this.paused) return
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      void this.runLiveSave()
    }, LIVE_SAVE_DELAY_MS)
  }

  private scheduleRecovery(): void {
    if (!this.active || !this.recoveryJournalId || this.paused) return
    if (this.recoveryTimer !== null) {
      this.deps.clearTimer(this.recoveryTimer)
    }
    this.recoveryTimer = this.deps.setTimer(() => {
      this.recoveryTimer = null
      void this.runRecoverySave()
    }, RECOVERY_SAVE_DELAY_MS)
  }

  private async runRecoverySave(): Promise<void> {
    const journalId = this.recoveryJournalId
    if (!this.active || !journalId || this.paused) return
    if (this.activeRecoveryWrite) {
      this.recoveryFollowUp = true
      return
    }

    const generation = this.generation
    this.recoveryFollowUp = false
    let snapshot: CapturedProjectSnapshot
    try {
      snapshot = this.capture()
    } catch (cause) {
      if (
        this.active
        && generation === this.generation
        && journalId === this.recoveryJournalId
      ) {
        useProjectSessionStore.setState({
          recoveryPhase: 'error',
          recoveryError: `Could not update the recovery copy: ${messageFrom(cause)}`,
        })
      }
      return
    }
    useProjectSessionStore.setState({
      recoveryPhase: 'saving',
      recoveryError: null,
    })
    const write = Promise.resolve().then(() => (
      this.deps.appendRecoverySnapshot({
        journalId,
        snapshotId: this.deps.createRecoverySnapshotId(),
        documentId: snapshot.documentId,
        projectName: snapshot.projectName,
        projectFileName: useProjectSessionStore.getState().activeProjectFileName,
        capturedAt: this.deps.now(),
        serializedProject: snapshot.serialized,
      })
    ))
    this.activeRecoveryWrite = write
    let succeeded = false

    try {
      await write
      succeeded = true
      if (
        this.active
        && generation === this.generation
        && journalId === this.recoveryJournalId
      ) {
        this.recoveryRevision = snapshot.revision
        useProjectSessionStore.setState({
          recoveryPhase: 'idle',
          lastRecoveryAt: this.deps.now(),
          recoveryError: null,
        })
      }
    } catch (cause) {
      if (
        this.active
        && generation === this.generation
        && journalId === this.recoveryJournalId
      ) {
        useProjectSessionStore.setState({
          recoveryPhase: 'error',
          recoveryError: `Could not update the recovery copy: ${messageFrom(cause)}`,
        })
      }
    } finally {
      if (this.activeRecoveryWrite === write) this.activeRecoveryWrite = null
      if (
        this.active
        && generation === this.generation
        && journalId === this.recoveryJournalId
        && !this.paused
        && (
          this.recoveryFollowUp
          || (succeeded && this.revision !== this.recoveryRevision)
        )
      ) {
        this.scheduleRecovery()
      }
    }
  }

  private async runLiveSave(): Promise<void> {
    const target = this.handle
    if (!this.active || !target || this.paused) return
    const operation = this.beginOperation('live')
    if (!operation) return
    await this.trackWrite(this.writeToHandle(operation, target, false))
  }

  private syncBeforeUnload(shouldAttach: boolean): void {
    if (shouldAttach === this.beforeUnloadAttached) return
    if (shouldAttach) {
      this.deps.addBeforeUnload(this.beforeUnloadHandler)
    } else {
      this.deps.removeBeforeUnload(this.beforeUnloadHandler)
    }
    this.beforeUnloadAttached = shouldAttach
  }

  private inactiveResult(): { status: 'failed'; message: string } {
    return {
      status: 'failed',
      message: 'Could not save the project: no editor project is active',
    }
  }

  private busyResult(): { status: 'failed'; message: string } {
    return {
      status: 'failed',
      message: 'Could not save the project: another save is already running',
    }
  }
}

const controller = new ProjectPersistenceController(realDeps)

export function startProjectPersistenceSession(
  session: ProjectPersistenceSession,
): void {
  controller.startSession(session)
}

export function suspendProjectPersistenceSession(): void {
  controller.suspendSession()
}

export function pauseProjectPersistenceSession(): Promise<void> {
  return controller.pauseSession()
}

export function resumeProjectPersistenceSession(): void {
  controller.resumeSession()
}

export function discardProjectRecoverySession(): Promise<void> {
  return controller.discardRecovery()
}

export function saveActiveProject(): Promise<ProjectSaveResult> {
  return controller.save()
}

export function saveActiveProjectAs(): Promise<ProjectSaveResult> {
  return controller.saveAs()
}
