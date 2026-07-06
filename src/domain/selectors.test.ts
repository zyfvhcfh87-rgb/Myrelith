/**
 * domain/selectors.test.ts — Phase 3.2.
 */

import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import { activeClipAt, clipSourceFrame, docDurationFrames, findClip } from './selectors'

function makeClip(id: string, tlStart: number, duration: number, sourceStart = 0): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: sourceStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, kind: Track['kind'], clips: Clip[]): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, locked: false }
}

function makeDoc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 1,
    id: 'doc',
    name: 'doc',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks,
  }
}

describe('docDurationFrames', () => {
  test('empty project has zero duration', () => {
    expect(docDurationFrames(makeDoc([makeTrack('V1', 'video', [])]))).toBe(0)
  })

  test('duration is the furthest clip end across ALL tracks', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 0, 100), makeClip('b', 150, 60)]), // ends 210
      makeTrack('A1', 'audio', [makeClip('c', 200, 100)]), // ends 300 ← winner
      makeTrack('V2', 'video', []),
    ])
    expect(docDurationFrames(doc)).toBe(300)
  })

  test('a lone clip starting late still defines the duration', () => {
    const doc = makeDoc([makeTrack('V1', 'video', [makeClip('a', 500, 10)])])
    expect(docDurationFrames(doc)).toBe(510)
  })
})

describe('activeClipAt', () => {
  const track = makeTrack('V1', 'video', [
    makeClip('a', 10, 20), // [10, 30)
    makeClip('b', 30, 15), // [30, 45) — touches a
    makeClip('c', 60, 10), // [60, 70) — gap [45, 60)
  ])

  test('start frame is inclusive, end frame is exclusive', () => {
    expect(activeClipAt(track, 10)?.id).toBe('a')
    expect(activeClipAt(track, 29)?.id).toBe('a')
    // 30 is a's exclusive end AND b's inclusive start: b owns it.
    expect(activeClipAt(track, 30)?.id).toBe('b')
    expect(activeClipAt(track, 44)?.id).toBe('b')
  })

  test('gaps, before-first and after-last are null', () => {
    expect(activeClipAt(track, 0)).toBeNull() // before first clip
    expect(activeClipAt(track, 45)).toBeNull() // gap start (b's exclusive end)
    expect(activeClipAt(track, 59)).toBeNull() // gap end
    expect(activeClipAt(track, 70)).toBeNull() // c's exclusive end = past the track
  })

  test('empty track yields null', () => {
    expect(activeClipAt(makeTrack('V2', 'video', []), 5)).toBeNull()
  })
})

describe('findClip', () => {
  test('finds clips on any track; unknown ids yield null', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 0, 10)]),
      makeTrack('A1', 'audio', [makeClip('b', 5, 10)]),
    ])
    expect(findClip(doc, 'b')?.id).toBe('b')
    expect(findClip(doc, 'a')?.id).toBe('a')
    expect(findClip(doc, 'nope')).toBeNull()
  })
})

describe('clipSourceFrame', () => {
  test('untrimmed clip maps its start to source frame 0', () => {
    const clip = makeClip('a', 100, 50)
    expect(clipSourceFrame(clip, 100)).toBe(0)
    expect(clipSourceFrame(clip, 149)).toBe(49)
  })

  test('trimmed clip offsets into the source', () => {
    // Clip shows source frames [30, 80) at timeline [100, 150).
    const clip = makeClip('a', 100, 50, 30)
    expect(clipSourceFrame(clip, 100)).toBe(30)
    expect(clipSourceFrame(clip, 110)).toBe(40)
    expect(clipSourceFrame(clip, 149)).toBe(79)
  })
})
