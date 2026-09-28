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
  voiceoverSessionOwnsDraft,
  type VoiceoverDraftClassification,
  type VoiceoverDraftReference,
} from '../domain/voiceoverDrafts'
import type { VoiceoverSession } from '../domain/voiceoverSession'
import { projectMediaAssetIds } from '../domain/projectSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useVoiceoverCaptureStore } from '../state/voiceoverCaptureStore'
import { VoiceoverWavBridge } from './voiceoverWavBridge'
import type {
  LocalMediaFileHandle,
  LocalMediaHandleReference,
} from './localMediaHandles'
import { localMediaHandleRegistry } from './localMediaHandles'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { importMediaFromHandle, type MediaImportResult } from './mediaImportController'
import { VOICEOVER_RECORDINGS_DIRECTORY } from '../pipeline/voiceoverWavDraft'

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
  isRecordingOriginal(draftId: string, handle: LocalMediaFileHandle): Promise<boolean>
  importMedia(file: File, handle: LocalMediaFileHandle): Promise<MediaImportResult>
  /** The capture session's state; its id is the draft id while it owns one. */
  liveSession(): VoiceoverSession | null
  /** Mark a source offline in this session after its original file is gone. */
  disconnectAsset(assetId: string): void
}

export interface VoiceoverDraftSurvey {
  /** Every `.wav` entry in the recordings directory, classified. */
  readonly drafts: readonly VoiceoverDraftClassification[]
}

export type VoiceoverDraftAction =
  | { status: 'recovered'; assetId: string; sizeBytes: number | null }
  | { status: 'discarded'; sizeBytes: number | null }
  | { status: 'removed'; sizeBytes: number | null; note?: string }
  | { status: 'cancelled' }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; message: string }

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export class VoiceoverDraftRecovery {
  private readonly deps: VoiceoverDraftRecoveryDeps
  private bridge: RecoveryWriter | null = null
  private lifecycle = 0

  constructor(deps: VoiceoverDraftRecoveryDeps) {
    this.deps = deps
  }

  /** Terminate the dedicated worker; drafts on disk are never touched. */
  dispose(): void {
    this.lifecycle++
    if (this.bridge) {
      this.bridge.close()
      this.bridge = null
    }
  }

  /**
   * Enumerate the recordings directory and classify every entry. Reading and
   * classifying only: nothing is imported or deleted, ever, from this path.
   */
  async survey(): Promise<VoiceoverDraftSurvey> {
    const [drafts, references] = await Promise.all([
      this.writer().list(),
      this.references(),
    ])
    return {
      drafts: classifyVoiceoverDrafts(
        drafts,
        this.liveSessionIds(),
        references,
      ),
    }
  }

  private writer(): RecoveryWriter {
    if (!this.bridge || this.bridge.isClosed) this.bridge = this.deps.createWriter()
    return this.bridge
  }

  private liveSessionIds(): string[] {
    const session = this.deps.liveSession()
    if (session && voiceoverSessionOwnsDraft(session)) return [session.sessionId]
    return []
  }

  private async references(): Promise<VoiceoverDraftReference[]> {
    let references: readonly LocalMediaHandleReference[]
    try {
      references = await this.deps.allRememberedHandles()
    } catch (cause) {
      throw new Error(`Could not read remembered media handles: ${failureMessage(cause)}`)
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
  async recoverDraft(draftId: string): Promise<VoiceoverDraftAction> {
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
      const bridge = this.writer()
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
        return { status: 'recovered', assetId: imported.assetId, sizeBytes: classification.sizeBytes }
      } finally {
        bridge.close()
        this.bridge = null
      }
    } catch (cause) {
      return { status: 'failed', message: failureMessage(cause) }
    }
  }

  /**
   * Explicit discard. Legal only for orphaned drafts; a kept or live draft is
   * rejected so referenced media is never deleted.
   */
  async discardDraft(draftId: string): Promise<VoiceoverDraftAction> {
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
    try {
      await this.writer().discardId(draftId)
      return { status: 'discarded', sizeBytes: classification.sizeBytes }
    } catch (cause) {
      return { status: 'failed', message: failureMessage(cause) }
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
  async removeKeptOriginal(assetId: string): Promise<VoiceoverDraftAction> {
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
      return { status: 'failed', message: `Could not read the remembered original: ${failureMessage(cause)}` }
    }
    if (!handle) {
      return { status: 'rejected', reason: 'No remembered original for this asset' }
    }
    let survey: VoiceoverDraftSurvey
    try {
      survey = await this.survey()
    } catch (cause) {
      return { status: 'failed', message: failureMessage(cause) }
    }
    if (
      lifecycle !== this.lifecycle
      || !this.projectIsCurrent(binding, projectGeneration, documentSnapshot)
    ) return { status: 'cancelled' }
    const classification = survey.drafts.find((draft) => `${draft.id}.wav` === handle.name)
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
      isOriginal = await this.deps.isRecordingOriginal(classification.id, handle)
    } catch (cause) {
      return { status: 'failed', message: `Could not verify the recording original: ${failureMessage(cause)}` }
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
      await this.writer().discardId(classification.id)
    } catch (cause) {
      return { status: 'failed', message: `The original file could not be deleted: ${failureMessage(cause)}` }
    }
    let note: string | undefined
    try {
      for (const referencedAssetId of classification.assetIds) {
        await this.deps.forgetHandle(binding, referencedAssetId)
      }
    } catch (cause) {
      // The file is already deleted; the stale grant self-heals on the next
      // resume, so report the removal with the cleanup caveat.
      note = `The original was deleted, but its browser grant could not be forgotten: ${failureMessage(cause)}`
    }
    if (this.projectIsCurrent(binding, projectGeneration, documentSnapshot)) {
      for (const referencedAssetId of classification.assetIds) {
        this.deps.disconnectAsset(referencedAssetId)
      }
    }
    return { status: 'removed', sizeBytes: classification.sizeBytes, ...(note ? { note } : {}) }
  }

  private async classify(draftId: string): Promise<VoiceoverDraftClassification | null> {
    const survey = await this.survey()
    return survey.drafts.find((draft) => draft.id === draftId) ?? null
  }
}

let recovery: VoiceoverDraftRecovery | null = null

export function getVoiceoverDraftRecovery(): VoiceoverDraftRecovery {
  if (recovery) return recovery
  recovery = new VoiceoverDraftRecovery({
    createWriter: () => new VoiceoverWavBridge(),
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
    isRecordingOriginal: async (draftId, handle) => {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false
      const root = await navigator.storage.getDirectory()
      const recordings = await root.getDirectoryHandle(VOICEOVER_RECORDINGS_DIRECTORY)
      const original = await recordings.getFileHandle(`${draftId}.wav`)
      return handle.isSameEntry(original)
    },
    importMedia: (file, handle) => importMediaFromHandle(file, handle),
    liveSession: () => useVoiceoverCaptureStore.getState().session,
    disconnectAsset: (assetId) => useMediaStore.getState().disconnectAsset(assetId),
  })
  return recovery
}
