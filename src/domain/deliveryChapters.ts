/**
 * Marker-to-chapter cues with integer-frame timing. Seconds never appear;
 * microseconds are the encoder-boundary integer used in the sidecar.
 */

import type { ExportRange } from './exportRange'
import type { TimelineDoc, TimelineMarker } from './schema'
import { timelineMarkers, compareTimelineMarkers } from './timelineMarkers'
import { framesToMicroseconds } from './time'
import { containerChapterSupport } from './deliveryProduct'

export interface ChapterCue {
  readonly id: string
  readonly frame: number
  readonly outputFrame: number
  readonly label: string
  readonly color: TimelineMarker['color']
  readonly note?: string
  readonly timestampMicroseconds: number
}

export interface ChapterSidecar {
  readonly format: 'myrelith-chapters'
  readonly version: 1
  readonly containerChapterSupport: 'unsupported'
  readonly reason: string
  readonly frameRate: TimelineDoc['frameRate']
  readonly range: ExportRange
  readonly chapters: readonly ChapterCue[]
}

const SIDECAR_REASON =
  'This browser encoder does not write MP4 or WebM chapter metadata. Timing is delivered as a JSON sidecar with integer frames and microseconds.'

export function chapterCuesInRange(
  doc: Pick<TimelineDoc, 'markers' | 'frameRate'>,
  range: ExportRange,
): readonly ChapterCue[] {
  framesToMicroseconds(0, doc.frameRate)
  const cues: ChapterCue[] = []
  const markers = [...timelineMarkers(doc as TimelineDoc)].sort(compareTimelineMarkers)
  for (const marker of markers) {
    if (marker.frame < range.startFrame || marker.frame >= range.endFrame) continue
    const cue = Object.freeze({
      id: marker.id,
      frame: marker.frame,
      outputFrame: marker.frame - range.startFrame,
      label: marker.label,
      color: marker.color,
      timestampMicroseconds: framesToMicroseconds(marker.frame - range.startFrame, doc.frameRate),
      ...(marker.note !== undefined ? { note: marker.note } : {}),
    })
    cues.push(Object.freeze(cue))
  }
  return Object.freeze(cues)
}

export function buildChapterSidecar(
  doc: Pick<TimelineDoc, 'markers' | 'frameRate'>,
  range: ExportRange,
): Readonly<ChapterSidecar> {
  return Object.freeze({
    format: 'myrelith-chapters',
    version: 1,
    containerChapterSupport: containerChapterSupport('webm'),
    reason: SIDECAR_REASON,
    frameRate: Object.freeze({ ...doc.frameRate }),
    range: Object.freeze({ startFrame: range.startFrame, endFrame: range.endFrame }),
    chapters: chapterCuesInRange(doc, range),
  })
}

export function serializeChapterSidecar(
  doc: Pick<TimelineDoc, 'markers' | 'frameRate'>,
  range: ExportRange,
): string {
  return `${JSON.stringify(buildChapterSidecar(doc, range), null, 2)}\n`
}

export function chapterSidecarFileName(baseName: string): string {
  const trimmed = baseName.replace(/\.(?:mp4|webm|wav|m4a|zip)$/i, '')
  return `${trimmed || 'myrelith-export'}.chapters.json`
}
