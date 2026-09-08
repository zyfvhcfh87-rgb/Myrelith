/** App-owned pending caption edits. UI snapshots contain bounded text summaries. */
import { captionBatchSelectedIds, type CaptionBatchOperation, type CaptionBatchScope } from '../domain/captionBatch'
import { findCaptionTrack } from '../domain/captions'
import { isCaptionStyleField, type CaptionStyleDescriptor, type CaptionStyleValue } from '../domain/captionStyle'
import type { CaptionItem } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { CaptionEditSession, type CaptionEditReview } from './captionEditingController'
import { CAPTION_STYLE_LABELS, captionStyleValueLabel } from './captionStylePresentation'

export interface CaptionReviewSnapshot {
  readonly revision: number
  readonly label: string | null
  readonly changedCueCount: number
  readonly replacementCount: number
  readonly requiresLossAcceptance: boolean
  readonly lossDisclosure: string | null
  readonly preview: readonly { readonly before: readonly string[]; readonly after: readonly string[];
    readonly omittedBeforeItems: number; readonly omittedAfterItems: number }[]
  readonly omittedPreviewRows: number
}

function idle(revision: number): CaptionReviewSnapshot {
  return Object.freeze({ revision, label: null, changedCueCount: 0, replacementCount: 0,
    requiresLossAcceptance: false, lossDisclosure: null, preview: Object.freeze([]), omittedPreviewRows: 0 })
}
function cueSummary(cue: CaptionItem): string {
  const text = cue.text.length <= 240 ? cue.text : `${cue.text.slice(0, 240)}… (text shortened in review)`
  return `${cue.range.startFrame}–${cue.range.startFrame + cue.range.durationFrames}: ${text}`
}

/** Subscribe while the editor is mounted. The last unsubscribe cancels the
 * pending edit and releases its ledger owners, including during StrictMode's
 * setup/cleanup cycle. No document copies or descriptor payloads escape into
 * the UI snapshot. All edits still use the existing fresh Apply authority.
 */
export class CaptionReviewController {
  private snapshot: CaptionReviewSnapshot = idle(0)
  private pending: { session: CaptionEditSession; review: CaptionEditReview } | null = null
  private readonly listeners = new Set<() => void>()
  private unsubscribeStore: (() => void) | null = null
  private preparing = false
  private epoch = 0

  getSnapshot = (): CaptionReviewSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.unsubscribeStore) {
      let current = useDocumentStore.getState()
      this.unsubscribeStore = useDocumentStore.subscribe((next) => {
        const changed = next.project !== current.project || next.projectGeneration !== current.projectGeneration
          || next.activeSequenceId !== current.activeSequenceId
        current = next
        if (changed) this.cancel()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unsubscribeStore?.(); this.unsubscribeStore = null
        this.cancel()
      }
    }
  }
  private publish(snapshot: CaptionReviewSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  cancel = (): void => {
    this.epoch++
    if (this.pending === null && this.snapshot.label === null) return
    const previous = this.pending
    this.pending = null
    // Clear the externally readable snapshot before owner release can notify
    // the document store and re-enter application code.
    try { this.publish(idle(this.snapshot.revision + 1)) }
    finally { previous?.session.dispose() }
  }
  private prepare(label: string, propose: (session: CaptionEditSession) => CaptionEditReview | null): boolean {
    if (!this.unsubscribeStore) throw new Error('The caption editor is closed.')
    if (this.preparing) throw new Error('A caption review is already being prepared.')
    this.preparing = true
    const epoch = this.epoch
    let session: CaptionEditSession | null = null
    try {
      session = new CaptionEditSession()
      const review = propose(session)
      if (epoch !== this.epoch || !this.unsubscribeStore) throw new Error('The caption review was cancelled or the project changed.')
      if (!review) { session.dispose(); this.cancel(); return false }
      const previous = this.pending, pending = { session, review }
      this.pending = pending
      try { this.publish(Object.freeze({ revision: this.snapshot.revision + 1, label, changedCueCount: review.changedCueCount,
        replacementCount: review.replacementCount, requiresLossAcceptance: review.requiresLossAcceptance,
        lossDisclosure: review.unavailableStylesRemoved ? `This edit replaces or removes ${review.unavailableStylesRemoved} unavailable style override${review.unavailableStylesRemoved === 1 ? '' : 's'} and loses their stored settings. Undo restores them.` : null,
        preview: Object.freeze([...review.preview.map((row) => Object.freeze({
          before: Object.freeze(row.before.map(cueSummary)), after: Object.freeze(row.after.map(cueSummary)),
          omittedBeforeItems: row.omittedBeforeItems, omittedAfterItems: row.omittedAfterItems,
        })), ...review.stylePreview.map(row => Object.freeze({
          before: Object.freeze([row.target, row.before, row.inheritance]),
          after: Object.freeze([row.target, row.after, row.inheritance]), omittedBeforeItems: 0, omittedAfterItems: 0,
        }))]), omittedPreviewRows: review.omittedPreviewRows })) }
      finally { previous?.session.dispose() }
      if (this.pending !== pending) throw new Error('The caption review was cancelled or replaced.')
      return true
    } catch (cause) {
      try { if (this.pending?.session === session) this.cancel() }
      finally { session?.dispose() }
      throw cause
    } finally { this.preparing = false }
  }
  prepareBatch(trackId: string, scope: CaptionBatchScope, operation: CaptionBatchOperation): boolean {
    return this.prepare(`Review caption ${operation.kind}`, (session) => session.prepareBatch(trackId, scope, operation))
  }
  /** Explicit midpoint/word-boundary generator; the resulting text and times
   * still require review and one normal batch Apply. Never guess a missing cut.
   */
  prepareMidpointSplits(trackId: string, scope: CaptionBatchScope): boolean {
    return this.prepare('Review midpoint splits at word boundaries', session => {
      const track = findCaptionTrack(session.document(), trackId)
      if (!track) throw new RangeError('The caption track no longer exists')
      const ids = captionBatchSelectedIds(track, scope)
      const plans = track.items.filter(cue => ids.has(cue.id)).map(cue => {
        const boundaries = [...cue.text.matchAll(/\s+/gu)].map(match => match.index)
          .filter(offset => cue.text.slice(0, offset).trim() && cue.text.slice(offset).trim())
        if (cue.range.durationFrames < 2 || !boundaries.length) throw new RangeError('Each split cue needs at least two frames and two words. Adjust the scope or split it manually.')
        const middle = cue.text.length / 2
        const textOffset = boundaries.reduce((best, next) => Math.abs(next - middle) < Math.abs(best - middle) ? next : best)
        return { itemId: cue.id, textOffset, frame: cue.range.startFrame + Math.floor(cue.range.durationFrames / 2),
          rightId: session.createId(() => `caption_item_${crypto.randomUUID()}`) }
      })
      return session.prepareBatch(trackId, scope, { kind: 'split', plans })
    })
  }
  prepareStyleField(trackId: string, cueIds: readonly string[] | null, key: string, value: CaptionStyleValue | null): boolean {
    if (!isCaptionStyleField(key)) throw new RangeError('This caption style field is unavailable')
    return this.prepare(`Review ${CAPTION_STYLE_LABELS[key]}: ${value === null ? 'Inherit' : captionStyleValueLabel(key, value)}`,
      (session) => session.prepareStyleField(trackId, cueIds, key, value))
  }
  prepareStyle(trackId: string, cueIds: readonly string[] | null, style: CaptionStyleDescriptor | null): boolean {
    return this.prepare(style === null ? 'Review removal of style overrides' : 'Review replacement of style overrides',
      (session) => session.prepareStyle(trackId, cueIds, style))
  }
  apply(revision: number, acceptLoss = false): string | null {
    if (this.preparing) return 'A caption review is already being prepared.'
    const pending = this.pending
    if (!pending || revision !== this.snapshot.revision) return 'The caption review was cancelled or replaced.'
    const error = pending.session.apply(pending.review, acceptLoss)
    if (!error) this.cancel()
    return error
  }
}
