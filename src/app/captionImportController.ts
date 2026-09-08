/** Editor-owned, abortable file reads and reviewed caption imports. */
import { parseCaptionAss, type CaptionAssReport } from '../domain/captionAss'
import { MAX_CAPTION_FILE_CHARACTERS, parseCaptionFile, type CaptionFileFormat } from '../domain/captionFiles'
import { createCaptionTrack, findCaptionTrack, replaceCaptionItems } from '../domain/captions'
import { utf8ByteLength } from '../domain/documentMemory'
import type { CaptionItem, CaptionTrack, TextFontFamily } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { CaptionEditSession, type CaptionEditReview } from './captionEditingController'
import { MAX_CAPTION_FILE_BYTES, type CaptionTrackMetadata } from './captionFileController'
import type { CaptionReviewSnapshot } from './captionReviewController'
import { captionStyleSummary } from './captionStylePresentation'

export type CaptionImportFormat = CaptionFileFormat | 'ass'
export interface CaptionImportPort {
  read(file: File, signal: AbortSignal): Promise<string>
  createId(prefix: 'caption_item' | 'caption_track'): string
}
export interface CaptionImportSnapshot {
  readonly revision: number
  readonly phase: 'idle' | 'reading' | 'fonts' | 'review' | 'error'
  readonly message: string
  readonly fonts: readonly string[]
  readonly diagnostics: readonly string[]
  readonly omittedDiagnostics: number
  readonly review: CaptionReviewSnapshot | null
}

/** FileReader owns the native read so cancellation actually aborts it. */
export function readCaptionFile(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Caption import cancelled.')); return }
    const reader = new FileReader()
    const finish = (error: Error | null, text = ''): void => {
      signal.removeEventListener('abort', abort)
      reader.onload = null; reader.onerror = null; reader.onabort = null
      if (error) reject(error); else resolve(text)
    }
    const abort = (): void => { reader.abort(); finish(new Error('Caption import cancelled.')) }
    reader.onload = () => typeof reader.result === 'string'
      ? finish(null, reader.result) : finish(new Error('The caption file did not contain text.'))
    reader.onerror = () => finish(new Error('The caption file could not be read.'))
    reader.onabort = () => finish(new Error('Caption import cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    try { reader.readAsText(file) } catch (error) { finish(error instanceof Error ? error : new Error('The caption file could not be read.')) }
  })
}

const idle = (revision: number): CaptionImportSnapshot => Object.freeze({ revision, phase: 'idle', message: '',
  fonts: Object.freeze([]), diagnostics: Object.freeze([]), omittedDiagnostics: 0, review: null })
const summary = (cue: CaptionItem): string => `${cue.range.startFrame}–${cue.range.startFrame + cue.range.durationFrames}: ${cue.text.length > 240 ? cue.text.slice(0, 240) + '… (text shortened in review)' : cue.text}`
interface ImportOwner {
  session: CaptionEditSession
  abort: AbortController
  format: CaptionImportFormat
  targetId: string | null
  metadata: CaptionTrackMetadata
  source: string | null
  review: CaptionEditReview | null
  importedTrackId: string | null
}

export class CaptionImportController {
  private readonly port: CaptionImportPort
  private snapshot: CaptionImportSnapshot = idle(0)
  private owner: ImportOwner | null = null
  private readonly listeners = new Set<() => void>()
  private unsubscribeStore: (() => void) | null = null
  private epoch = 0
  constructor(port: CaptionImportPort = { read: readCaptionFile, createId: prefix => `${prefix}_${crypto.randomUUID()}` }) { this.port = port }
  getSnapshot = (): CaptionImportSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.unsubscribeStore) {
      let current = useDocumentStore.getState()
      this.unsubscribeStore = useDocumentStore.subscribe(next => {
        const changed = next.project !== current.project || next.projectGeneration !== current.projectGeneration || next.activeSequenceId !== current.activeSequenceId
        current = next
        if (changed) this.cancel()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) { this.unsubscribeStore?.(); this.unsubscribeStore = null; this.cancel() }
    }
  }
  private publish(snapshot: CaptionImportSnapshot): void {
    this.snapshot = Object.freeze(snapshot)
    for (const listener of this.listeners) listener()
  }
  cancel = (): void => {
    this.epoch++
    const owner = this.owner; this.owner = null
    try { if (this.snapshot.phase !== 'idle') this.publish(idle(this.snapshot.revision + 1)) }
    finally {
      if (owner) { owner.source = null; owner.review = null; owner.abort.abort(); owner.session.dispose() }
    }
  }
  private fail(owner: ImportOwner | null, error: unknown): void {
    if (owner && this.owner !== owner) return
    const epoch = this.epoch + 1
    this.cancel()
    if (this.epoch === epoch && this.unsubscribeStore) this.publish({ ...idle(this.snapshot.revision + 1), phase: 'error',
      message: (error instanceof Error ? error.message : 'Caption import failed.').slice(0, 2000) })
  }
  async begin(file: File, format: CaptionImportFormat, targetId: string | null, metadata: CaptionTrackMetadata): Promise<void> {
    if (!this.unsubscribeStore) throw new Error('The caption editor is closed.')
    const epoch = this.epoch + 1
    this.cancel()
    if (epoch !== this.epoch || !this.unsubscribeStore) return
    let owner: ImportOwner | null = null, session: CaptionEditSession | null = null
    try {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CAPTION_FILE_BYTES) throw new RangeError(`Caption file exceeds ${MAX_CAPTION_FILE_BYTES} bytes.`)
      session = new CaptionEditSession()
      if (epoch !== this.epoch || !this.unsubscribeStore) { session.dispose(); return }
      owner = { session, abort: new AbortController(), format, targetId: format === 'ass' ? null : targetId,
        metadata: { ...metadata }, source: null, review: null, importedTrackId: null }
      this.owner = owner
      if (owner.targetId && !findCaptionTrack(session.document(), owner.targetId)) throw new RangeError('The caption track no longer exists.')
      this.publish({ ...idle(this.snapshot.revision + 1), phase: 'reading', message: 'Reading captions locally…' })
      if (this.owner !== owner) return
      const source = await this.port.read(file, owner.abort.signal)
      if (this.owner !== owner || owner.abort.signal.aborted) return
      if (source.length > MAX_CAPTION_FILE_CHARACTERS || utf8ByteLength(source) > MAX_CAPTION_FILE_BYTES) throw new RangeError('Caption file exceeds its character or UTF-8 byte limit.')
      owner.source = source
      this.prepare(owner, {})
    } catch (error) {
      if (!owner) session?.dispose()
      if (epoch === this.epoch) this.fail(owner, error)
    }
  }
  chooseFonts(revision: number, substitutions: Readonly<Record<string, TextFontFamily>>): void {
    const owner = this.owner
    if (!owner || revision !== this.snapshot.revision || this.snapshot.phase !== 'fonts') return
    try { this.prepare(owner, substitutions) } catch (error) { this.fail(owner, error) }
  }
  private prepare(owner: ImportOwner, substitutions: Readonly<Record<string, TextFontFamily>>): void {
    if (owner !== this.owner || owner.source === null) throw new Error('The caption import was cancelled.')
    const session = owner.session, doc = session.document()
    let items: CaptionItem[], importedStyle: CaptionTrack['style'], preset = owner.metadata.stylePreset
    let report: CaptionAssReport | null = null, parsedLoss = false
    if (owner.format === 'ass') {
      const parsed = parseCaptionAss(owner.source, doc.frameRate, () => session.createId(() => this.port.createId('caption_item')), substitutions)
      report = parsed.report
      if (parsed.kind === 'needs-fonts' || parsed.kind === 'rejected') {
        const state: CaptionImportSnapshot = { ...idle(this.snapshot.revision + 1), phase: parsed.kind === 'needs-fonts' ? 'fonts' : 'error',
          message: parsed.kind === 'needs-fonts' ? 'Choose a local replacement for each unavailable ASS font.' : 'This ASS file cannot be imported.',
          fonts: Object.freeze(parsed.kind === 'needs-fonts' ? [...parsed.fonts] : []), diagnostics: this.diagnostics(report), omittedDiagnostics: report.omittedDetails }
        if (parsed.kind === 'rejected') {
          const epoch = this.epoch + 1
          this.cancel()
          if (this.epoch === epoch && this.unsubscribeStore) this.publish({ ...state, revision: this.snapshot.revision + 1 })
        }
        else this.publish(state)
        return
      }
      items = parsed.proposal.items; importedStyle = parsed.proposal.style; preset = parsed.proposal.stylePreset
      parsedLoss = parsed.kind === 'review'
    } else items = parseCaptionFile(owner.source, owner.format, doc.frameRate, (_index, sourceId) =>
      session.createId(() => this.port.createId('caption_item'), owner.format === 'vtt' ? sourceId : null))
    const before = owner.targetId ? findCaptionTrack(doc, owner.targetId)!.items : []
    const importedTrackId = owner.targetId ?? session.createId(() => this.port.createId('caption_track'))
    const next = owner.targetId ? replaceCaptionItems(doc, owner.targetId, items) : { ...doc, captionTracks: [...(doc.captionTracks ?? []), {
      ...createCaptionTrack(importedTrackId, owner.metadata.name, owner.metadata.language), role: owner.metadata.role,
      stylePreset: preset, ...(importedStyle === undefined ? {} : { style: importedStyle }), items,
    }] }
    const rowCount = Math.max(before.length, items.length)
    const preview = Array.from({ length: Math.min(100, rowCount) }, (_, i) => ({
      before: before[i] ? [before[i]!] : [], after: items[i] ? [items[i]!] : [], omittedBeforeItems: 0, omittedAfterItems: 0,
    }))
    const review = session.prepareDocument(next, { changedCueCount: items.length, preview,
      omittedPreviewRows: Math.max(0, rowCount - preview.length), requiresLossAcceptance: parsedLoss || before.length > 0 })
    if (this.owner !== owner) throw new Error('The caption import was cancelled.')
    owner.review = review; owner.importedTrackId = importedTrackId; owner.source = null
    const revision = this.snapshot.revision + 1
    const lossDisclosure = [before.length ? `This replaces ${before.length} existing cues, including their cue overrides and origin. Undo restores them.` : '',
      parsedLoss ? 'The ASS conversion has the losses listed above. Review them before applying.' : ''].filter(Boolean).join(' ') || null
    this.publish({ ...idle(revision), phase: 'review', message: owner.targetId ? 'Review replacement of this track’s cues.' : 'Review a new caption track.',
      diagnostics: Object.freeze([...(report ? this.diagnostics(report) : []), ...(importedStyle ? [`Imported track defaults: ${captionStyleSummary(importedStyle, 'the track preset')}`] : [])]),
      omittedDiagnostics: report?.omittedDetails ?? 0,
      review: Object.freeze({ revision, label: `Review ${owner.format.toUpperCase()} import`, changedCueCount: items.length, replacementCount: 0,
        requiresLossAcceptance: review.requiresLossAcceptance, lossDisclosure,
        preview: Object.freeze(preview.map(row => Object.freeze({ before: Object.freeze(row.before.map(summary)), after: Object.freeze(row.after.map(summary)), omittedBeforeItems: 0, omittedAfterItems: 0 }))),
        omittedPreviewRows: review.omittedPreviewRows }) })
  }
  private diagnostics(report: CaptionAssReport): readonly string[] {
    return Object.freeze(report.details.map(detail => `${detail.severity}${detail.line === null ? '' : ` · line ${detail.line}`}: ${detail.detail}`))
  }
  apply(revision: number, acceptLoss: boolean): { error: string | null; trackId: string | null } {
    const owner = this.owner
    if (!owner?.review || revision !== this.snapshot.revision) return { error: 'The caption import was cancelled or replaced.', trackId: null }
    const trackId = owner.importedTrackId
    const error = owner.session.apply(owner.review, acceptLoss)
    if (!error && this.owner === owner) this.cancel()
    return { error, trackId: error ? null : trackId }
  }
}
