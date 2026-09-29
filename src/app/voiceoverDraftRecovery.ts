/**
 * Explicit recovery, discard, and safe removal of local voiceover recording
 * drafts.
 *
 * The recordings directory is shared truth: a capture session writes drafts
 * there, a Keep leaves its original there (remembered in the browser-local
 * handle registry as the asset's source), and crashes leave unreferenced
 * remnants there. This feature owns a DEDICATED worker bridge — never the
 * capture session's writer — and only ever deletes files it has just
 * classified as `orphaned` (discard) or a kept original whose referencing
 * assets no longer appear in any clip (safe removal). Referenced media is
 * never deleted by any path here; `forget`ing the registry touches
 * IndexedDB only.
 */

import {
  classifyVoiceoverDrafts,
  keptOriginalRemovalEligible,
  voiceoverDraftIdsFromLockNames,
  voiceoverSessionOwnsDraft,
  type VoiceoverDraftAction,
  type VoiceoverDraftClassification,
  type VoiceoverDraftReference,
} from '../domain/voiceoverDrafts'
import type { VoiceoverSession } from '../domain/voiceoverSession'
import { projectMediaAssetIds } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useVoiceoverCaptureStore } from '../state/voiceoverCaptureStore'
import { useAvCaptureStore } from '../state/avCaptureStore'
import { avCaptureSessionIsTerminal } from '../domain/avCaptureSession'
import { errorMessage } from '../domain/errors'
import { VoiceoverWavBridge } from './voiceoverWavBridge'
import type {
  LocalMediaFileHandle,
  LocalMediaHandleReference,
} from './localMediaHandles'
import { localMediaHandleRegistry } from './localMediaHandles'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { importMediaFromHandle, type MediaImportResult } from './mediaImportController'
import { VOICEOVER_RECORDINGS_DIRECTORY } from '../pipeline/voiceoverWavDraft'
import { AV_CAPTURE_DIRECTORY } from '../pipeline/avCaptureProtocol'
import { AvCaptureBridge } from './avCaptureBridge'

/**
 * The directory/draft operations the recovery feature needs from one worker
 * owner. Structurally the capture `VoiceoverWavBridge` satisfies this, but the
 * recovery feature always creates its own instance and never the capture
 * session's writer.
 */
export type RecoveryWriter = Pick<
  VoiceoverWavBridge,
  'list' | 'recover' | 'finalize' | 'discardId' | 'close' | 'isClosed'
>

export interface VoiceoverDraftRecoveryDeps {
  /** One dedicated worker per recovery instance; never the capture bridge. */
  createWriter(): RecoveryWriter
  /** Camera/screen captures (`.mp4`), a separate worker and directory. */
  createCaptureStore?(): RecoveryWriter
  projectBindingId(): string | null
  projectGeneration(): number
  /** Immutable Zustand snapshot identity; changes on edits and history moves. */
  documentSnapshot(): object
  /** Every asset id in the active project, connected or offline. */
  projectAssetIds(): readonly string[]
  loadHandle(projectBindingId: string, assetId: string): Promise<LocalMediaFileHandle | null>
  forgetHandle(projectBindingId: string, assetId: string): Promise<void>
  /** All remembered handles, including assets from projects not currently open. */
  allRememberedHandles(): Promise<readonly LocalMediaHandleReference[]>
  /** Asset ids retained by the current project, its undo stack, or redo stack. */
  retainedAssetIds(): readonly string[]
  /** Prove the registry handle names the OPFS entry, not a same-named local file. */
  /** `fileName` is the stored draft's own name (`.wav` or `.mp4`). */
  isRecordingOriginal(fileName: string, handle: LocalMediaFileHandle): Promise<boolean>
  importMedia(file: File, handle: LocalMediaFileHandle): Promise<MediaImportResult>
  /** The capture session's state; its id is the draft id while it owns one. */
  liveSession(): VoiceoverSession | null
  /** Mark a source offline in this session after its original file is gone. */
  disconnectAsset(assetId: string): void
  /**
   * Persist the recovered original's grant before reporting success, so no
   * later survey can see the imported file as an orphan.
   */
  rememberHandle?(projectBindingId: string, assetId: string, handle: LocalMediaFileHandle): Promise<void>
  /** File names of every current-project media descriptor (online or offline). */
  projectAssetFileNames?(): readonly string[]
  /** The camera/screen session id while it still owns its draft (not kept/cancelled/failed). */
  liveCaptureId?(): string | null
  /** Draft ids whose capture-session Web Lock is held in any tab of this origin. */
  heldDraftLockIds?(): Promise<readonly string[]>
}

export interface VoiceoverDraftSurvey {
  /** Every stored voiceover (`.wav`) and camera/screen (`.mp4`) draft, classified. */
  readonly drafts: readonly VoiceoverDraftClassification[]
}

export type { VoiceoverDraftAction }

export class VoiceoverDraftRecovery {
  private readonly deps: VoiceoverDraftRecoveryDeps
  private bridge: RecoveryWriter | null = null
  private captureBridge: RecoveryWriter | null = null
  private lifecycle = 0
  /** Every public operation runs alone: one shared worker, no interleaved classify/delete. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(deps: VoiceoverDraftRecoveryDeps) {
    this.deps = deps
  }

  /** Terminate the dedicated worker; drafts on disk are never touched. */
  dispose(): void {
    this.lifecycle++
    this.captureBridge?.close()
    this.captureBridge = null
    if (this.bridge) {
      this.bridge.close()
      this.bridge = null
    }
  }

  /**
   * Enumerate the recordings directory and classify every entry. Reading and
   * classifying only: nothing is imported or deleted, ever, from this path.
   */
  survey(): Promise<VoiceoverDraftSurvey> {
    return this.serialized(() => this.surveyNow())
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(run, run)
    this.queue = task.catch(() => {})
    return task
  }

  private async surveyNow(): Promise<VoiceoverDraftSurvey> {
    const [drafts, references, locked] = await Promise.all([
      this.listAll(),
      this.references(),
      this.deps.heldDraftLockIds?.() ?? Promise.resolve([]),
    ])
    return {
      drafts: classifyVoiceoverDrafts(
        drafts,
        [...this.liveSessionIds(), ...locked],
        references,
      ),
    }
  }

  private writer(): RecoveryWriter {
    if (!this.bridge || this.bridge.isClosed) this.bridge = this.deps.createWriter()
    return this.bridge
  }

  private captures(): RecoveryWriter | null {
    if (!this.deps.createCaptureStore) return null
    if (!this.captureBridge || this.captureBridge.isClosed) this.captureBridge = this.deps.createCaptureStore()
    return this.captureBridge
  }

  /** The worker that owns a stored draft, by its file name. */
  private storeFor(fileName: string): RecoveryWriter {
    if (fileName.endsWith('.mp4')) {
      const store = this.captures()
      if (!store) throw new Error('Camera and screen captures are unavailable in this browser')
      return store
    }
    return this.writer()
  }

  private forget(store: RecoveryWriter): void {
    store.close()
    if (store === this.bridge) this.bridge = null
    if (store === this.captureBridge) this.captureBridge = null
  }

  private async listAll() {
    const store = this.captures()
    const [voiceover, captures] = await Promise.all([this.writer().list(), store ? store.list() : Promise.resolve([])])
    return [...voiceover, ...captures]
  }

  private liveSessionIds(): string[] {
    const ids: string[] = []
    const session = this.deps.liveSession()
    if (session && voiceoverSessionOwnsDraft(session)) ids.push(session.sessionId)
    // A camera/screen take in review has closed its file; protect it here
    // too, not only through the cross-tab lock.
    const capture = this.deps.liveCaptureId?.()
    if (capture) ids.push(capture)
    return ids
  }

  private async references(): Promise<VoiceoverDraftReference[]> {
    let references: readonly LocalMediaHandleReference[]
    try {
      references = await this.deps.allRememberedHandles()
    } catch (cause) {
      throw new Error(`Could not read remembered media handles: ${errorMessage(cause)}`)
    }
    return references.map(({ projectBindingId, assetId, handle }) => ({
      fileName: handle.name,
      projectBindingId,
      assetId,
    }))
  }

  private projectIsCurrent(
    bindingId: string,
    projectGeneration: number,
    documentSnapshot: object,
  ): boolean {
    return this.deps.projectBindingId() === bindingId
      && this.deps.projectGeneration() === projectGeneration
      && this.deps.documentSnapshot() === documentSnapshot
  }

  /**
   * Explicit recovery of a crash remnant: reopen the last durable checkpoint,
   * validate the header, and import through the ordinary media import path.
   * The file STAYS in the recordings directory and becomes the kept original
   * of the imported asset; only an explicit discard removes it later.
   */
  recoverDraft(draftId: string): Promise<VoiceoverDraftAction> {
    return this.serialized(() => this.recoverNow(draftId))
  }

  private async recoverNow(draftId: string): Promise<VoiceoverDraftAction> {
    const binding = this.deps.projectBindingId()
    if (!binding) {
      return { status: 'failed', message: 'Open a local project before recovering a draft' }
    }
    const projectGeneration = this.deps.projectGeneration()
    const documentSnapshot = this.deps.documentSnapshot()
    const lifecycle = this.lifecycle
    const classification = await this.classify(draftId)
    if (
      lifecycle !== this.lifecycle
      || !this.projectIsCurrent(binding, projectGeneration, documentSnapshot)
    ) return { status: 'cancelled' }
    if (!classification) {
      return { status: 'failed', message: 'The draft no longer exists in the recordings directory' }
    }
    if (classification.state === 'kept') {
      return { status: 'rejected', reason: 'The draft is already the original of a project asset' }
    }
    if (classification.state === 'live') {
      return { status: 'rejected', reason: 'The draft belongs to the active recording session' }
    }
    if (!classification.hasJournal) {
      return { status: 'rejected', reason: 'The draft has no recoverable checkpoint' }
    }
    try {
      const bridge = this.storeFor(classification.fileName)
      try {
        await bridge.recover(draftId)
        if (
          lifecycle !== this.lifecycle
          || !this.projectIsCurrent(binding, projectGeneration, documentSnapshot)
        ) return { status: 'cancelled' }
        const finalized = await bridge.finalize()
        if (
          lifecycle !== this.lifecycle
          || !this.projectIsCurrent(binding, projectGeneration, documentSnapshot)
        ) return { status: 'cancelled' }
        const imported = await this.deps.importMedia(finalized.file, finalized.handle)
        if (imported.status !== 'imported') {
          return {
            status: 'failed',
            message: imported.status === 'failed'
              ? imported.message
              : `The recovered draft was not imported (${imported.status})`,
          }
        }
        let note: string | undefined
        try { await this.deps.rememberHandle?.(binding, imported.assetId, finalized.handle) }
        catch (cause) {
          note = `The recording is in the Media Pool, but its browser grant could not be saved: ${errorMessage(cause)}`
        }
        return { status: 'recovered', assetId: imported.assetId, sizeBytes: classification.sizeBytes,
          ...(note ? { note } : {}) }
      } finally {
        this.forget(bridge)
      }
    } catch (cause) {
      return { status: 'failed', message: errorMessage(cause) }
    }
  }

  /**
   * Explicit discard. Legal only for orphaned drafts; a kept or live draft is
   * rejected so referenced media is never deleted.
   */
  discardDraft(draftId: string): Promise<VoiceoverDraftAction> {
    return this.serialized(() => this.discardNow(draftId))
  }

  private async discardNow(draftId: string): Promise<VoiceoverDraftAction> {
    const classification = await this.classify(draftId)
    if (!classification) {
      return { status: 'failed', message: 'The draft no longer exists in the recordings directory' }
    }
    if (classification.state === 'kept') {
      return { status: 'rejected', reason: 'The draft is the original of a kept recording; use Remove kept original' }
    }
    if (classification.state === 'live') {
      return { status: 'rejected', reason: 'The draft belongs to the active recording session' }
    }
    // A grant that failed to persist must not expose an imported file to deletion.
    if (this.deps.projectAssetFileNames?.().includes(classification.fileName)) {
      return { status: 'rejected', reason: 'A media item in this project uses this recording' }
    }
    try {
      await this.storeFor(classification.fileName).discardId(draftId)
      return { status: 'discarded', sizeBytes: classification.sizeBytes }
    } catch (cause) {
      return { status: 'failed', message: errorMessage(cause) }
    }
  }

  /**
   * Safe removal of a kept original: delete the OPFS file, forget the
   * registry grant (IndexedDB only), and mark the source offline in the
   * current session. The project descriptor remains, so a later reload
   * reports the source missing and the existing manual relink can reconnect
   * it. Rejected while any clip still references the asset, and rejected
   * whenever the remembered file is not visibly present in the recordings
   * directory — a moved or externally deleted source is reconnected, never
   * silently disconnected.
  */
  removeKeptOriginal(assetId: string): Promise<VoiceoverDraftAction> {
    return this.serialized(() => this.removeNow(assetId))
  }

  private async removeNow(assetId: string): Promise<VoiceoverDraftAction> {
    const binding = this.deps.projectBindingId()
    if (!binding) {
      return { status: 'failed', message: 'Open a local project before removing a kept original' }
    }
    const projectGeneration = this.deps.projectGeneration()
    const documentSnapshot = this.deps.documentSnapshot()
    const lifecycle = this.lifecycle
    if (!this.deps.projectAssetIds().includes(assetId)) {
      return { status: 'rejected', reason: 'The asset is not part of this project' }
    }
    let handle: LocalMediaFileHandle | null
    try {
      handle = await this.deps.loadHandle(binding, assetId)
    } catch (cause) {
      return { status: 'failed', message: `Could not read the remembered original: ${errorMessage(cause)}` }
    }
    if (!handle) {
      return { status: 'rejected', reason: 'No remembered original for this asset' }
    }
    let survey: VoiceoverDraftSurvey
    try {
      survey = await this.surveyNow()
    } catch (cause) {
      return { status: 'failed', message: errorMessage(cause) }
    }
    if (
      lifecycle !== this.lifecycle
      || !this.projectIsCurrent(binding, projectGeneration, documentSnapshot)
    ) return { status: 'cancelled' }
    const classification = survey.drafts.find((draft) => draft.fileName === handle.name)
    if (!classification) {
      // The remembered file is not visibly in the recordings directory. It may
      // have been moved, deleted, or never a recording original at all; the
      // existing missing-file relink is the recovery path, so change nothing.
      return {
        status: 'rejected',
        reason: 'The source file is not in the recordings directory; reconnect the asset to restore it',
      }
    }
    if (classification.state === 'live') {
      return { status: 'rejected', reason: 'The draft belongs to the active recording session' }
    }
    if (classification.references.some((reference) => (
      reference.projectBindingId === null
      || reference.projectBindingId !== binding
      || reference.assetId === null
    ))) {
      return { status: 'rejected', reason: 'Another project also remembers this original; remove it there first' }
    }
    let isOriginal: boolean
    try {
      isOriginal = await this.deps.isRecordingOriginal(classification.fileName, handle)
    } catch (cause) {
      return { status: 'failed', message: `Could not verify the recording original: ${errorMessage(cause)}` }
    }
    if (!isOriginal) {
      return { status: 'rejected', reason: 'The remembered file is not this recording original' }
    }
    const retainedAssetIds = this.deps.retainedAssetIds()
    if (!keptOriginalRemovalEligible(classification.assetIds, retainedAssetIds)) {
      return { status: 'rejected', reason: 'The original is still referenced by clips; remove them first' }
    }
    if (
      lifecycle !== this.lifecycle
      || !this.projectIsCurrent(binding, projectGeneration, documentSnapshot)
      || !this.deps.projectAssetIds().includes(assetId)
      || !keptOriginalRemovalEligible(classification.assetIds, this.deps.retainedAssetIds())
    ) return { status: 'cancelled' }
    try {
      await this.storeFor(classification.fileName).discardId(classification.id)
    } catch (cause) {
      return { status: 'failed', message: `The original file could not be deleted: ${errorMessage(cause)}` }
    }
    let note: string | undefined
    try {
      for (const referencedAssetId of classification.assetIds) {
        await this.deps.forgetHandle(binding, referencedAssetId)
      }
    } catch (cause) {
      // The file is already deleted; the stale grant self-heals on the next
      // resume, so report the removal with the cleanup caveat.
      note = `The original was deleted, but its browser grant could not be forgotten: ${errorMessage(cause)}`
    }
    if (this.projectIsCurrent(binding, projectGeneration, documentSnapshot)) {
      for (const referencedAssetId of classification.assetIds) {
        this.deps.disconnectAsset(referencedAssetId)
      }
    }
    return { status: 'removed', sizeBytes: classification.sizeBytes, ...(note ? { note } : {}) }
  }

  private async classify(draftId: string): Promise<VoiceoverDraftClassification | null> {
    const survey = await this.surveyNow()
    return survey.drafts.find((draft) => draft.id === draftId) ?? null
  }
}

let recovery: VoiceoverDraftRecovery | null = null

export function getVoiceoverDraftRecovery(): VoiceoverDraftRecovery {
  if (recovery) return recovery
  recovery = new VoiceoverDraftRecovery({
    createWriter: () => new VoiceoverWavBridge(),
    createCaptureStore: () => new AvCaptureBridge(),
    projectBindingId: getActiveLocalProjectBindingId,
    projectGeneration: () => useDocumentStore.getState().projectGeneration,
    documentSnapshot: () => useDocumentStore.getState(),
    projectAssetIds: () => [...useMediaStore.getState().descriptors.keys()],
    loadHandle: (binding, assetId) => localMediaHandleRegistry.load(binding, assetId),
    forgetHandle: (binding, assetId) => localMediaHandleRegistry.forget(binding, assetId),
    allRememberedHandles: () => localMediaHandleRegistry.list(),
    retainedAssetIds: () => {
      const documentState = useDocumentStore.getState()
      const ids = new Set<string>()
      for (const project of [documentState.project, ...documentState.past, ...documentState.future]) {
        for (const assetId of projectMediaAssetIds(project)) ids.add(assetId)
      }
      return [...ids]
    },
    isRecordingOriginal: async (fileName, handle) => {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle(fileName.endsWith('.mp4')
        ? AV_CAPTURE_DIRECTORY : VOICEOVER_RECORDINGS_DIRECTORY)
      const original = await directory.getFileHandle(fileName)
      return handle.isSameEntry(original)
    },
    importMedia: (file, handle) => importMediaFromHandle(file, handle),
    liveSession: () => useVoiceoverCaptureStore.getState().session,
    liveCaptureId: () => {
      const capture = useAvCaptureStore.getState().session
      return capture && !avCaptureSessionIsTerminal(capture) ? capture.sessionId : null
    },
    disconnectAsset: (assetId) => useMediaStore.getState().disconnectAsset(assetId),
    rememberHandle: (binding, assetId, handle) => localMediaHandleRegistry.remember(binding, assetId, handle),
    projectAssetFileNames: () => [...useMediaStore.getState().descriptors.values()]
      .map((descriptor) => descriptor.fileName),
    heldDraftLockIds: async () => {
      if (typeof navigator === 'undefined' || !navigator.locks?.query) return []
      const snapshot = await navigator.locks.query()
      return voiceoverDraftIdsFromLockNames([...(snapshot.held ?? []), ...(snapshot.pending ?? [])]
        .map((lock) => lock.name))
    },
  })
  return recovery
}
