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
import { sequenceById } from '../domain/projectSequences'
import { sequenceInstances } from '../domain/nestedSequences'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useVoiceoverCaptureStore } from '../state/voiceoverCaptureStore'
import { VoiceoverWavBridge } from './voiceoverWavBridge'
import type { LocalMediaFileHandle } from './localMediaHandles'
import { localMediaHandleRegistry } from './localMediaHandles'
import { getActiveLocalProjectBindingId } from './localProjectProvenance'
import { importMediaFromHandle, type MediaImportResult } from './mediaImportController'

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
  /** Every asset id in the active project, connected or offline. */
  projectAssetIds(): readonly string[]
  loadHandle(projectBindingId: string, assetId: string): Promise<LocalMediaFileHandle | null>
  forgetHandle(projectBindingId: string, assetId: string): Promise<void>
  /** Asset ids used by a clip of any project sequence (dormant and nested included). */
  clipReferencedAssetIds(): readonly string[]
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
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; message: string }

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export class VoiceoverDraftRecovery {
  private readonly deps: VoiceoverDraftRecoveryDeps
  private bridge: RecoveryWriter | null = null

  constructor(deps: VoiceoverDraftRecoveryDeps) {
    this.deps = deps
  }

  /** Terminate the dedicated worker; drafts on disk are never touched. */
  dispose(): void {
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
    const binding = this.deps.projectBindingId()
    if (!binding) return []
    const settled = await Promise.allSettled(
      this.deps.projectAssetIds().map(async (assetId) => {
        const handle = await this.deps.loadHandle(binding, assetId)
        return handle ? { fileName: handle.name, assetId } : null
      }),
    )
    // An unreadable registry entry must not silently reclassify a kept draft
    // as orphaned; fail the survey so nothing is offered for deletion.
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        throw new Error(`Could not read remembered media handles: ${failureMessage(outcome.reason)}`)
      }
    }
    return settled.flatMap((outcome) => outcome.status === 'fulfilled' && outcome.value ? [outcome.value] : [])
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
    const classification = await this.classify(draftId)
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
        const finalized = await bridge.finalize()
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
    if (!this.deps.projectAssetIds().includes(assetId)) {
      return { status: 'rejected', reason: 'The asset is not part of this project' }
    }
    const clipReferenced = this.deps.clipReferencedAssetIds()
    if (clipReferenced.includes(assetId)) {
      return { status: 'rejected', reason: 'The recording is still used by clips; remove them first' }
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
    if (!keptOriginalRemovalEligible(classification.assetIds, clipReferenced)) {
      return { status: 'rejected', reason: 'The original is still referenced by clips; remove them first' }
    }
    try {
      await this.writer().discardId(classification.id)
    } catch (cause) {
      return { status: 'failed', message: `The original file could not be deleted: ${failureMessage(cause)}` }
    }
    let note: string | undefined
    try {
      await this.deps.forgetHandle(binding, assetId)
    } catch (cause) {
      // The file is already deleted; the stale grant self-heals on the next
      // resume, so report the removal with the cleanup caveat.
      note = `The original was deleted, but its browser grant could not be forgotten: ${failureMessage(cause)}`
    }
    this.deps.disconnectAsset(assetId)
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
    projectAssetIds: () => [...useMediaStore.getState().descriptors.keys()],
    loadHandle: (binding, assetId) => localMediaHandleRegistry.load(binding, assetId),
    forgetHandle: (binding, assetId) => localMediaHandleRegistry.forget(binding, assetId),
    clipReferencedAssetIds: () => {
      const documentState = useDocumentStore.getState()
      const ids = new Set<string>()
      const visited = new Set<string>()
      const queue = documentState.project.sequences.map((sequence) => sequence.id)
      while (queue.length > 0) {
        const sequenceId = queue.shift()!
        if (visited.has(sequenceId)) continue
        visited.add(sequenceId)
        const sequence = sequenceById(documentState.project, sequenceId)
        if (!sequence) continue
        for (const track of sequence.tracks) {
          for (const clip of track.clips) {
            if (clip.text === undefined && clip.title === undefined) ids.add(clip.assetId)
          }
          for (const instance of sequenceInstances(track)) queue.push(instance.sequenceId)
        }
      }
      return [...ids]
    },
    importMedia: (file, handle) => importMediaFromHandle(file, handle),
    liveSession: () => useVoiceoverCaptureStore.getState().session,
    disconnectAsset: (assetId) => useMediaStore.getState().disconnectAsset(assetId),
  })
  return recovery
}
