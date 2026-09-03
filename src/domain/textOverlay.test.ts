import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createTextClip,
  insertClip,
  moveClip,
  slipClip,
  splitClipAtFrame,
  trimClip,
  updateTextClip,
} from './operations'
import {
  createProjectFileSnapshot,
  parseProjectFile,
  serializeProjectFile,
} from './projectFile'
import {
  createTimelineDoc,
  DEFAULT_PROJECT_SETTINGS,
} from './projectSettings'
import { findClip } from './selectors'
import {
  isProceduralTextAssetId,
  TEXT_OVERLAY_LIMITS,
} from './textOverlay'

afterEach(() => vi.restoreAllMocks())

function emptyDoc() {
  return createTimelineDoc('Text test', DEFAULT_PROJECT_SETTINGS, 'doc-text')
}

describe('text overlay document contract', () => {
  test('creates and inserts a media-free timed overlay with bounded defaults', () => {
    const doc = emptyDoc()
    const clip = createTextClip(doc, 12, 150, 'Hello creator')
    const inserted = insertClip(doc, 'V1', clip)

    expect(isProceduralTextAssetId(clip.assetId)).toBe(true)
    expect(clip).toMatchObject({
      name: 'Hello creator',
      sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 150 },
      timelineRange: { startFrame: 12, durationFrames: 150 },
      text: {
        content: 'Hello creator',
        fontFamily: 'sans-serif',
        color: '#ffffff',
      },
    })
    expect(findClip(inserted, clip.id)?.text).not.toBe(clip.text)
    expect(doc.tracks[0].clips).toEqual([])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mediaBacked = { ...clip, assetId: 'media-asset' }
    expect(insertClip(doc, 'V1', mediaBacked)).toBe(doc)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserved procedural asset id'))
  })

  test('edits styling without substitution and keeps split/trim semantics procedural', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clip = createTextClip(emptyDoc(), 20, 100, 'Old title')
    const inserted = insertClip(emptyDoc(), 'V1', clip)
    const styled = updateTextClip(inserted, clip.id, {
      content: 'New title',
      fontFamily: 'monospace',
      fontSizePx: 96,
      backgroundEnabled: true,
      backgroundColor: '#112233',
    })
    expect(findClip(styled, clip.id)).toMatchObject({
      name: 'New title',
      text: {
        content: 'New title',
        fontFamily: 'monospace',
        fontSizePx: 96,
        backgroundEnabled: true,
        backgroundColor: '#112233',
      },
    })

    const rejected = updateTextClip(styled, clip.id, {
      fontFamily: 'Papyrus' as 'sans-serif',
    })
    expect(rejected).toBe(styled)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unsupported font family'))

    const split = splitClipAtFrame(styled, clip.id, 70)
    expect(split.tracks[0].clips.map((part) => part.sourceRange)).toEqual([
      { startFrame: 0, durationFrames: 50 },
      { startFrame: 0, durationFrames: 50 },
    ])
    const right = split.tracks[0].clips[1]
    const trimmed = trimClip(split, right.id, 'end', 10)
    expect(findClip(trimmed, right.id)).toMatchObject({
      timelineRange: { startFrame: 70, durationFrames: 60 },
      sourceRange: { startFrame: 0, durationFrames: 60 },
    })
    expect(slipClip(trimmed, right.id, 40)).toBe(trimmed)
    expect(moveClip(trimmed, right.id, 'V2', 180)).not.toBe(trimmed)
  })

  test('rejects invalid box geometry instead of silently clamping it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clip = createTextClip(emptyDoc(), 0, 30)
    const doc = insertClip(emptyDoc(), 'V1', clip)
    const rejected = updateTextClip(doc, clip.id, {
      boxWidthPx: TEXT_OVERLAY_LIMITS.minBoxSizePx - 1,
    })
    expect(rejected).toBe(doc)
  })

  test('round-trips a text-only project without inventing a media descriptor', () => {
    const clip = createTextClip(emptyDoc(), 0, 90, 'No uploads needed')
    const doc = insertClip(emptyDoc(), 'V1', clip)
    const serialized = serializeProjectFile(createProjectFileSnapshot(doc, []))
    const parsed = parseProjectFile(serialized)

    expect(parsed.assets).toEqual([])
    expect(parsed.sequences[0]).toEqual(doc)
    expect(findClip(parsed.sequences[0], clip.id)?.text?.content).toBe('No uploads needed')
  })
})
