import { CURRENT_TIMELINE_SCHEMA_VERSION } from './projectFile'
import { describe, expect, test } from 'vitest'
import {
  buildChapterSidecar,
  chapterCuesInRange,
  chapterSidecarFileName,
  serializeChapterSidecar,
} from './deliveryChapters'
import type { TimelineDoc, TimelineMarker } from './schema'

function marker(id: string, frame: number, note?: string): TimelineMarker {
  const value: TimelineMarker = { id, frame, label: id, color: 'blue' }
  if (note !== undefined) value.note = note
  return value
}

function doc(markers: TimelineMarker[]): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: 'chapters',
    name: 'Chapters',
    frameRate: { num: 30_000, den: 1_001 },
    width: 1280,
    height: 720,
    audioSampleRate: 48_000,
    tracks: [],
    markers,
  }
}

describe('chapter sidecar', () => {
  test('keeps exclusive-end range coverage and integer microsecond timestamps', () => {
    const sequence = doc([
      marker('before', 2),
      marker('in', 3, 'scene'),
      marker('end', 9),
      marker('after', 9),
    ])
    const cues = chapterCuesInRange(sequence, { startFrame: 3, endFrame: 9 })
    expect(cues.map((cue) => cue.id)).toEqual(['in'])
    expect(cues[0]).toMatchObject({
      frame: 3,
      outputFrame: 0,
      note: 'scene',
    })
    expect(cues[0]?.timestampMicroseconds).toBe(0)
    const sidecar = buildChapterSidecar(sequence, { startFrame: 3, endFrame: 9 })
    expect(sidecar.containerChapterSupport).toBe('unsupported')
    expect(sidecar.chapters).toHaveLength(1)
    const raw = serializeChapterSidecar(sequence, { startFrame: 3, endFrame: 10 })
    const parsed = JSON.parse(raw) as { chapters: Array<{ frame: number; outputFrame: number; timestampMicroseconds: number }> }
    expect(parsed.chapters.map((cue) => cue.frame)).toEqual([3, 9, 9])
    expect(parsed.chapters[0]?.outputFrame).toBe(0)
    expect(parsed.chapters.every((cue) => Number.isSafeInteger(cue.timestampMicroseconds))).toBe(true)
  })

  test('names the sidecar beside the selected media file', () => {
    expect(chapterSidecarFileName('show.mp4')).toBe('show.chapters.json')
    expect(chapterSidecarFileName('mix.wav')).toBe('mix.chapters.json')
  })
})
