/** One resource-free caption review owner; Apply validates the complete live file. */
import { planCaptionBatch, type CaptionBatchOperation, type CaptionBatchScope, type CaptionBatchPreviewRow } from '../domain/captionBatch'
import { CAPTION_LIMITS, captionDocumentValidationError, findCaptionTrack } from '../domain/captions'
import { captionIntentOwners, captionRetentionError, type CaptionIntentOwner } from '../domain/captionIntentBudget'
import { captionIntentEqual, copyCaptionIntent } from '../domain/captionIntent'
import { inspectCaptionStyle, type CaptionStyleDescriptor } from '../domain/captionStyle'
import { replaceProjectSequence, sequenceProjectReservedIds, type SequenceProject } from '../domain/projectSequences'
import type { CaptionItem, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { commitPortableProjectEdit, portableProjectEditError } from './portableProjectEdit'

export interface CaptionEditReview {
  readonly token: number
  readonly changedCueCount: number
  readonly replacementCount: number
  readonly preview: readonly CaptionBatchPreviewRow[]
  readonly omittedPreviewRows: number
  readonly requiresLossAcceptance: boolean
}
let ownerSerial = 0
const stale = 'The project changed or another sequence is active. Reopen the caption review.'
function copyCue(item: CaptionItem): CaptionItem {
  return Object.freeze({ ...item, range: Object.freeze({ ...item.range }),
    ...(item.style === undefined ? {} : { style: copyCaptionIntent(item.style) }),
    ...(item.origin === undefined ? {} : { origin: copyCaptionIntent(item.origin) }),
  })
}

export class CaptionEditSession {
  private expected: { project: SequenceProject; generation: number; sequenceId: string } | null
  private candidate: SequenceProject | null = null
  private review: CaptionEditReview | null = null
  private readonly ownerId = `caption-review-${++ownerSerial}`
  private revision = 0
  private admittingOwners = false
  private readonly reserved: Set<string>

  constructor() {
    const state = useDocumentStore.getState()
    this.expected = { project: state.project, generation: state.projectGeneration, sequenceId: state.activeSequenceId }
    this.reserved = new Set(sequenceProjectReservedIds(state.project))
    const error = this.installOwners(captionIntentOwners(state.project))
    if (error) { this.dispose(); throw new RangeError(error) }
  }
  private pin() {
    const expected = this.expected, state = useDocumentStore.getState()
    if (!expected || state.project !== expected.project || state.projectGeneration !== expected.generation || state.activeSequenceId !== expected.sequenceId) throw new Error(stale)
    return expected
  }
  private assertNotAdmitting(): void {
    if (this.admittingOwners) throw new Error('A caption owner admission is already in progress')
  }
  private installOwners(owners: readonly CaptionIntentOwner[], releasePrior = false): string | null {
    this.assertNotAdmitting()
    this.admittingOwners = true
    try {
      if (releasePrior) {
        useDocumentStore.getState().releaseCaptionOwners(this.ownerId)
        this.pin()
      }
      const error = useDocumentStore.getState().retainCaptionOwners(this.ownerId, owners)
      // A returned budget rejection publishes nothing, so keep the old review.
      if (error) return error
      // Store notification is synchronous: replacement, navigation or disposal
      // may have happened after the new ledger was installed. Never retain the
      // old candidate under that new ledger, or publish a disposed session.
      this.pin()
      return null
    } catch (cause) {
      this.dispose()
      throw cause
    } finally { this.admittingOwners = false }
  }
  document(): TimelineDoc {
    const expected = this.pin()
    return expected.project.sequences.find((doc) => doc.id === expected.sequenceId)!
  }
  /** Caller factories are bounded and cannot reuse dormant or cross-category IDs. */
  createId(factory: () => string, preferred?: string | null): string {
    this.pin()
    const valid = (id: string) => id.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) && !this.reserved.has(id)
    if (preferred && valid(preferred)) { this.reserved.add(preferred); return preferred }
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = factory()
      if (valid(id)) { this.reserved.add(id); return id }
    }
    throw new RangeError('Could not allocate a fresh caption identity within 100 attempts')
  }
  prepareDocument(next: TimelineDoc, detail: {
    changedCueCount?: number; replacementCount?: number; preview?: readonly CaptionBatchPreviewRow[];
    omittedPreviewRows?: number; requiresLossAcceptance?: boolean;
  } = {}): CaptionEditReview {
    this.assertNotAdmitting()
    const expected = this.pin()
    const current = this.document()
    if (Object.keys(next).some((key) => key !== 'captionTracks' && Reflect.get(next, key) !== Reflect.get(current, key))
      || Object.keys(current).some((key) => key !== 'captionTracks' && !Object.hasOwn(next, key))) throw new RangeError('A caption review may only replace caption tracks')
    const documentError = captionDocumentValidationError(next)
    if (documentError) throw new RangeError(documentError)
    if (next.id !== expected.sequenceId) throw new RangeError('Caption edits must target the captured sequence')
    const candidate = replaceProjectSequence(expected.project, expected.sequenceId, next)
    if (candidate === expected.project && next !== this.document()) throw new RangeError('Caption edit exceeds project limits')
    const error = portableProjectEditError(expected.project, expected.generation, candidate)
      ?? captionRetentionError(useDocumentStore.getState(), candidate)
    if (error) throw new RangeError(error)
    if ((detail.preview?.length ?? 0) > 100 || detail.preview?.some((row) => row.before.length > 10 || row.after.length > 10)) throw new RangeError('Caption review exceeds its bounded preview limit')
    const preview = Object.freeze((detail.preview ?? []).map((row) => Object.freeze({ ...row,
      before: Object.freeze(row.before.map(copyCue)), after: Object.freeze(row.after.map(copyCue)),
    })))
    const owners: readonly CaptionIntentOwner[] = [...captionIntentOwners(expected.project), ...captionIntentOwners(candidate),
      ...preview.flatMap((row) => [...row.before, ...row.after])]
    const retentionError = this.installOwners(owners)
    if (retentionError) throw new RangeError(retentionError)
    this.candidate = candidate
    this.review = Object.freeze({ token: ++this.revision, changedCueCount: detail.changedCueCount ?? 0,
      replacementCount: detail.replacementCount ?? 0, preview, omittedPreviewRows: detail.omittedPreviewRows ?? 0,
      requiresLossAcceptance: detail.requiresLossAcceptance ?? false })
    return this.review
  }
  prepareBatch(trackId: string, scope: CaptionBatchScope, operation: CaptionBatchOperation): CaptionEditReview | null {
    this.assertNotAdmitting()
    const expected = this.pin()
    const result = planCaptionBatch(this.document(), trackId, scope, operation, sequenceProjectReservedIds(expected.project))
    if (result.kind === 'rejected') throw new RangeError(result.reason)
    if (result.kind === 'unchanged') { this.clearReview(); return null }
    return this.prepareDocument(result.document, result)
  }
  prepareStyle(trackId: string, cueIds: readonly string[] | null, style: CaptionStyleDescriptor | null): CaptionEditReview | null {
    this.assertNotAdmitting()
    const doc = this.document(), track = findCaptionTrack(doc, trackId)
    if (!track) throw new RangeError('The caption track no longer exists')
    if (cueIds !== null && cueIds.length > CAPTION_LIMITS.maxItemsPerTrack) throw new RangeError('Caption style selection exceeds the track budget')
    const ids = cueIds === null ? null : new Set(cueIds)
    if (ids) {
      const existing = new Set(track.items.map((item) => item.id))
      if (ids.size !== cueIds!.length || [...ids].some((id) => !existing.has(id))) throw new RangeError('Caption style selection has missing or duplicate IDs')
    }
    // Validate once even for an empty selection. Opaque bounded intent remains
    // opaque; equality compares stored intent rather than current render output.
    const inspected = style === null ? null : inspectCaptionStyle(style)
    if (inspected?.kind === 'invalid') throw new RangeError(inspected.reason)
    const replacement = inspected?.descriptor
    let changedCueCount = 0
    const change = <T extends { style?: CaptionStyleDescriptor }>(owner: T): T => {
      if (captionIntentEqual(owner.style, replacement)) return owner
      const { style: _old, ...rest } = owner
      return { ...rest, ...(replacement === undefined ? {} : { style: replacement }) } as T
    }
    const items = ids ? track.items.map((item) => {
      const next = ids.has(item.id) ? change(item) : item
      if (next !== item) changedCueCount++
      return next
    }) : track.items
    const nextTrack = ids ? (changedCueCount ? { ...track, items } : track) : change(track)
    if (nextTrack === track) { this.clearReview(); return null }
    return this.prepareDocument({ ...doc, captionTracks: doc.captionTracks!.map((item) => item.id === trackId ? nextTrack : item) },
      { changedCueCount: ids ? changedCueCount : track.items.length })
  }
  apply(review: CaptionEditReview, acceptLoss = false): string | null {
    try {
      this.assertNotAdmitting()
      const expected = this.pin()
      if (!this.candidate || review !== this.review) return 'The caption review was replaced. Review the current proposal.'
      if (review.requiresLossAcceptance && !acceptLoss) return 'Accept the disclosed caption losses before applying this review.'
      const error = commitPortableProjectEdit(expected.project, expected.generation, this.candidate)
      if (error) return error
      this.dispose()
      return null
    } catch (cause) { return cause instanceof Error ? cause.message : stale }
  }
  private clearReview() {
    const expected = this.pin()
    this.candidate = null; this.review = null
    // This strictly reduces owned payload; no new copy is admitted here.
    const error = this.installOwners(captionIntentOwners(expected.project), true)
    if (error) { this.dispose(); throw new RangeError(error) }
  }
  dispose(): void {
    this.expected = null; this.candidate = null; this.review = null; this.reserved.clear()
    useDocumentStore.getState().releaseCaptionOwners(this.ownerId)
  }
}
