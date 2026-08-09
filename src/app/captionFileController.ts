/** Browser composition root for atomic caption-file import and download. */

import {
  CaptionFileError,
  MAX_CAPTION_FILE_CHARACTERS,
  parseCaptionFile,
  serializeCaptionTrack,
  type CaptionFileFormat,
} from '../domain/captionFiles'
import {
  createCaptionTrack,
  findCaptionTrack,
  replaceCaptionItems,
} from '../domain/captions'
import type { CaptionTrack, CaptionTrackId, TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'

export const MAX_CAPTION_FILE_BYTES = 4_000_000

export interface CaptionFileStorePort {
  getDoc(): TimelineDoc
  commitDoc(expected: TimelineDoc, next: TimelineDoc): boolean
}

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

function defaultStorePort(): CaptionFileStorePort {
  return {
    getDoc: () => useDocumentStore.getState().doc,
    commitDoc: (expected, next) => {
      if (useDocumentStore.getState().doc !== expected) return false
      useDocumentStore.getState().setDocWithHistory(next)
      return true
    },
  }
}

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
  private readonly store: CaptionFileStorePort
  private readonly browser: CaptionFileBrowserPort

  constructor(store: CaptionFileStorePort, browser: CaptionFileBrowserPort) {
    this.store = store
    this.browser = browser
  }

  private async readAndParse(
    file: File,
    format: CaptionFileFormat,
    doc: TimelineDoc,
    replaceTrackId: CaptionTrackId | null,
  ) {
    if (file.size > MAX_CAPTION_FILE_BYTES) {
      throw new CaptionFileError(
        'file-too-large',
        `Caption file exceeds ${MAX_CAPTION_FILE_BYTES} bytes`,
      )
    }
    const source = await file.text()
    if (source.length > MAX_CAPTION_FILE_CHARACTERS) {
      throw new CaptionFileError(
        'file-too-large',
        `Caption file exceeds ${MAX_CAPTION_FILE_CHARACTERS} characters`,
      )
    }
    const reserved = new Set((doc.captionTracks ?? []).flatMap((track) => (
      track.id === replaceTrackId ? [] : track.items.map((item) => item.id)
    )))
    const generated = new Set<string>()
    return parseCaptionFile(
      source,
      format,
      doc.frameRate,
      (_index, sourceId) => {
        if (
          format === 'vtt'
          && sourceId !== null
          && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(sourceId)
          && sourceId.length <= 256
          && !reserved.has(sourceId)
          && !generated.has(sourceId)
        ) {
          generated.add(sourceId)
          return sourceId
        }
        let candidate = this.browser.createId('caption_item')
        while (reserved.has(candidate) || generated.has(candidate)) {
          candidate = this.browser.createId('caption_item')
        }
        generated.add(candidate)
        return candidate
      },
    )
  }

  /** Import into an existing lane as one mutation, after the whole file validates. */
  async importIntoTrack(
    file: File,
    format: CaptionFileFormat,
    trackId: CaptionTrackId,
  ): Promise<number> {
    const expected = this.store.getDoc()
    if (!findCaptionTrack(expected, trackId)) {
      throw new RangeError(`Caption track not found: ${trackId}`)
    }
    const items = await this.readAndParse(file, format, expected, trackId)
    const next = replaceCaptionItems(expected, trackId, items)
    if (!this.store.commitDoc(expected, next)) {
      throw new Error('The project changed during import. No captions were changed; try again.')
    }
    return items.length
  }

  /** Import as a complete new lane; malformed input leaves no empty lane behind. */
  async importAsTrack(
    file: File,
    format: CaptionFileFormat,
    metadata: CaptionTrackMetadata,
  ): Promise<CaptionTrackId> {
    const expected = this.store.getDoc()
    const items = await this.readAndParse(file, format, expected, null)
    const id = this.browser.createId('caption_track')
    const base = createCaptionTrack(id, metadata.name, metadata.language)
    const track: CaptionTrack = {
      ...base,
      role: metadata.role,
      stylePreset: metadata.stylePreset,
      items,
    }
    const next = { ...expected, captionTracks: [...(expected.captionTracks ?? []), track] }
    const validated = replaceCaptionItems(next, id, items)
    if (!this.store.commitDoc(expected, validated)) {
      throw new Error('The project changed during import. No captions were changed; try again.')
    }
    return id
  }

  /** Serialize from the same frame ranges used by preview/export, then download. */
  exportTrack(trackId: CaptionTrackId, format: CaptionFileFormat): string {
    const doc = this.store.getDoc()
    const track = findCaptionTrack(doc, trackId)
    if (!track) throw new RangeError(`Caption track not found: ${trackId}`)
    if (track.items.length === 0) throw new RangeError('Caption track has no items to export')
    const content = serializeCaptionTrack(track, format, doc.frameRate)
    const extension = format
    const mimeType = format === 'srt' ? 'application/x-subrip' : 'text/vtt'
    this.browser.download(`${safeFileStem(track.name)}.${extension}`, mimeType, content)
    return content
  }
}

export const captionFileController = new CaptionFileController(
  defaultStorePort(),
  defaultBrowserPort(),
)
