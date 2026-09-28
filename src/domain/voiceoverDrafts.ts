/**
 * Pure classification of local voiceover recording drafts.
 *
 * The recordings directory (`myrelith-recordings-v1`) is where drafts live
 * while a capture session owns them, and where KEPT originals stay after an
 * import: the original `.wav` remains the asset's source and is remembered in
 * the browser-local handle registry. After a crash, a reload, a kept clip
 * deletion, or an explicit Keep, the directory can hold three kinds of
 * entries:
 *
 * - `live`: owned by the capture session, or still locked by another writer;
 * - `kept`: referenced by at least one project asset through a remembered
 *   file handle;
 * - `orphaned`: neither — unreferenced leftovers (crash remnants, drafts of
 *   failed sessions, originals of assets the project no longer remembers).
 *
 * Discard is only ever legal for `orphaned` drafts. Deleting referenced media
 * is not. Browser facts (directory listing, registry handles) are passed in by
 * the app layer; this module decides only.
 */

import type { VoiceoverSession } from './voiceoverSession'

/** One `.wav` entry observed in the recordings directory. */
export interface VoiceoverDraftInfo {
  /** Draft id; the recording is `${id}.wav`, its journal `${id}.checkpoint`. */
  readonly id: string
  /**
   * On-disk size of the `.wav` file, or `null` while another open access
   * handle (a recording in progress) makes the size unobservable.
   */
  readonly sizeBytes: number | null
  /** A `.checkpoint` journal exists; it may hold recoverable audio. */
  readonly hasJournal: boolean
}

export type VoiceoverDraftState = 'live' | 'kept' | 'orphaned'

/** A project asset whose remembered file handle points into the directory. */
export interface VoiceoverDraftReference {
  /** The remembered handle's file name, e.g. `voiceover_<uuid>.wav`. */
  readonly fileName: string
  /** Null only when an older or damaged registry key has no known owner. */
  readonly projectBindingId: string | null
  readonly assetId: string | null
}

export interface VoiceoverDraftClassification {
  readonly id: string
  readonly sizeBytes: number | null
  readonly hasJournal: boolean
  readonly state: VoiceoverDraftState
  /** Asset ids whose remembered handles point at this draft (`kept` only). */
  readonly assetIds: readonly string[]
  /** All remembered owners, including projects that are not currently open. */
  readonly references: readonly VoiceoverDraftReference[]
}

/**
 * Classify every observed draft. A draft referenced by a remembered handle is
 * `kept` even when its capture session object is still alive (a finished Keep
 * lingers in the session state). An unreferenced draft of a session that still
 * owns it is `live`. Everything else is `orphaned`.
 */
export function classifyVoiceoverDrafts(
  drafts: readonly VoiceoverDraftInfo[],
  liveSessionIds: readonly string[],
  references: readonly VoiceoverDraftReference[],
): readonly VoiceoverDraftClassification[] {
  const live = new Set(liveSessionIds)
  const referencesByName = new Map<string, VoiceoverDraftReference[]>()
  for (const reference of references) {
    const matches = referencesByName.get(reference.fileName)
    if (matches) matches.push(reference)
    else referencesByName.set(reference.fileName, [reference])
  }
  return drafts.map((draft) => {
    const draftReferences = referencesByName.get(`${draft.id}.wav`) ?? []
    const state: VoiceoverDraftState = draftReferences.length > 0
      ? 'kept'
      : live.has(draft.id) || draft.sizeBytes === null
        ? 'live'
        : 'orphaned'
    return {
      id: draft.id,
      sizeBytes: draft.sizeBytes,
      hasJournal: draft.hasJournal,
      state,
      assetIds: [...new Set(draftReferences.flatMap((reference) => (
        reference.assetId ? [reference.assetId] : []
      )))],
      references: draftReferences,
    }
  })
}

/** Only orphaned drafts may be deleted; kept and live drafts are protected. */
export function isVoiceoverDraftDiscardable(
  classification: VoiceoverDraftClassification,
): boolean {
  return classification.state === 'orphaned'
}

/**
 * A kept original may be removed from disk only when none of the assets that
 * reference it is used by any clip of the project.
 */
export function keptOriginalRemovalEligible(
  referencingAssetIds: readonly string[],
  clipReferencedAssetIds: readonly string[],
): boolean {
  if (referencingAssetIds.length === 0) return false
  const inUse = new Set(clipReferencedAssetIds)
  return referencingAssetIds.every((id) => !inUse.has(id))
}

/**
 * A session whose capture writer still owns a draft file, or which finished a
 * Keep whose original must not be discarded out from under it. Terminal
 * sessions (`requesting` has created no draft yet; `failed` released its
 * checkpoint; `cancelled` discarded it) no longer own one.
 */
export function voiceoverSessionOwnsDraft(
  session: VoiceoverSession | null,
): boolean {
  if (!session) return false
  return session.phase !== 'requesting'
    && session.phase !== 'failed'
    && session.phase !== 'cancelled'
}
