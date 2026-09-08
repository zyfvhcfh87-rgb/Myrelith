/** Browser composition root for whole-project caption import and reviewed loss. */
import { CaptionFileError, MAX_CAPTION_FILE_CHARACTERS, parseCaptionFile, serializeCaptionTrack, type CaptionFileFormat } from '../domain/captionFiles'
import { parseCaptionAss, type CaptionAssImport, type CaptionAssReport } from '../domain/captionAss'
import { createCaptionTrack, findCaptionTrack, replaceCaptionItems } from '../domain/captions'
import type { CaptionTrack, CaptionTrackId, TextFontFamily } from '../domain/schema'
import { utf8ByteLength } from '../domain/documentMemory'
import { useDocumentStore } from '../state/documentStore'
import { CaptionEditSession, type CaptionEditReview } from './captionEditingController'

export const MAX_CAPTION_FILE_BYTES = 4_000_000
export interface CaptionFileBrowserPort {
  createId(prefix: 'caption_track' | 'caption_item'): string
  download(fileName: string, mimeType: string, content: string): void
}
export interface CaptionTrackMetadata {
  name: string
  language: string
  role: CaptionTrack['role']
  stylePreset: CaptionTrack['stylePreset']
}
export type CaptionAssFileReview =
  | Extract<CaptionAssImport, { kind: 'needs-fonts' | 'rejected' }>
  | { readonly kind: 'ready' | 'review'; readonly session: CaptionEditSession; readonly review: CaptionEditReview;
      readonly report: CaptionAssReport; readonly trackId: string }

function defaultBrowserPort(): CaptionFileBrowserPort {
  return {
    createId: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    download: (fileName, mimeType, content) => {
      const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.click()
      queueMicrotask(() => URL.revokeObjectURL(url))
    },
  }
}

function safeFileStem(value: string): string {
  const stem = value.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return stem.length > 0 ? stem.slice(0, 120) : 'captions'
}

export class CaptionFileController {
  private readonly browser: CaptionFileBrowserPort
  constructor(browser: CaptionFileBrowserPort = defaultBrowserPort()) { this.browser = browser }

  private async read(file: File): Promise<string> {
    if (file.size > MAX_CAPTION_FILE_BYTES) throw new CaptionFileError('file-too-large', `Caption file exceeds ${MAX_CAPTION_FILE_BYTES} bytes`)
    const source = await file.text()
    if (source.length > MAX_CAPTION_FILE_CHARACTERS || utf8ByteLength(source) > MAX_CAPTION_FILE_BYTES) throw new CaptionFileError('file-too-large', 'Caption file exceeds its character or UTF-8 byte limit')
    return source
  }
  private async readAndParse(file: File, format: CaptionFileFormat, session: CaptionEditSession) {
    const source = await this.read(file)
    return parseCaptionFile(source, format, session.document().frameRate, (_index, sourceId) =>
      session.createId(() => this.browser.createId('caption_item'), format === 'vtt' ? sourceId : null))
  }
  async importIntoTrack(file: File, format: CaptionFileFormat, trackId: CaptionTrackId): Promise<number> {
    const session = new CaptionEditSession()
    try {
      if (!findCaptionTrack(session.document(), trackId)) throw new RangeError(`Caption track not found: ${trackId}`)
      const items = await this.readAndParse(file, format, session)
      const next = replaceCaptionItems(session.document(), trackId, items)
      const review = session.prepareDocument(next, { changedCueCount: items.length })
      const error = session.apply(review)
      if (error) throw new Error(error)
      return items.length
    } finally { session.dispose() }
  }
  async importAsTrack(file: File, format: CaptionFileFormat, metadata: CaptionTrackMetadata): Promise<CaptionTrackId> {
    const session = new CaptionEditSession()
    try {
      const items = await this.readAndParse(file, format, session)
      const id = session.createId(() => this.browser.createId('caption_track'))
      const track: CaptionTrack = { ...createCaptionTrack(id, metadata.name, metadata.language), role: metadata.role, stylePreset: metadata.stylePreset, items }
      const doc = session.document()
      const review = session.prepareDocument({ ...doc, captionTracks: [...(doc.captionTracks ?? []), track] }, { changedCueCount: items.length })
      const error = session.apply(review)
      if (error) throw new Error(error)
      return id
    } finally { session.dispose() }
  }
  /** The caller owns the returned session until Apply or cancel/dispose. No download or edit occurs here. */
  async prepareAssImport(file: File, metadata: CaptionTrackMetadata, substitutions: Readonly<Record<string, TextFontFamily>> = {}): Promise<CaptionAssFileReview> {
    const session = new CaptionEditSession()
    try {
      const source = await this.read(file)
      const parsed = parseCaptionAss(source, session.document().frameRate, () => session.createId(() => this.browser.createId('caption_item')), substitutions)
      if (parsed.kind === 'needs-fonts' || parsed.kind === 'rejected') { session.dispose(); return parsed }
      const id = session.createId(() => this.browser.createId('caption_track'))
      const track: CaptionTrack = { ...createCaptionTrack(id, metadata.name, metadata.language), role: metadata.role,
        stylePreset: parsed.proposal.stylePreset, style: parsed.proposal.style, items: parsed.proposal.items }
      const doc = session.document()
      const review = session.prepareDocument({ ...doc, captionTracks: [...(doc.captionTracks ?? []), track] },
        { changedCueCount: track.items.length, requiresLossAcceptance: parsed.kind === 'review' })
      return { kind: parsed.kind, session, review, report: parsed.report, trackId: id }
    } catch (cause) { session.dispose(); throw cause }
  }
  /** New descriptors require a disclosed loss decision; their stored project data is untouched. */
  exportTrack(trackId: CaptionTrackId, format: CaptionFileFormat, acceptStyleAndOriginLoss = false): string {
    const doc = useDocumentStore.getState().doc, track = findCaptionTrack(doc, trackId)
    if (!track) throw new RangeError(`Caption track not found: ${trackId}`)
    if (!track.items.length) throw new RangeError('Caption track has no items to export')
    if (!acceptStyleAndOriginLoss && (track.style !== undefined || track.origin !== undefined || track.items.some((item) => item.style !== undefined || item.origin !== undefined))) {
      throw new RangeError('SRT/VTT omit caption style overrides and generated origin. Review and accept this loss before downloading.')
    }
    const content = serializeCaptionTrack(track, format, doc.frameRate)
    this.browser.download(`${safeFileStem(track.name)}.${format}`, format === 'srt' ? 'application/x-subrip' : 'text/vtt', content)
    return content
  }
}
export const captionFileController = new CaptionFileController()
