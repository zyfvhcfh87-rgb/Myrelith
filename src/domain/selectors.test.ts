/**
 * domain/selectors.test.ts — Phase 3.2.
 */

import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import {
  activeClipAt,
  audibleTracks,
  clipSourceFrame,
  docDurationFrames,
  findClip,
  trackOfClip,
  tracksInDisplayOrder,
} from './selectors'

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
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked: false }
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

describe('tracksInDisplayOrder', () => {
  test('videos reversed (top composite layer first), then audios in order', () => {
    const v1 = makeTrack('V1', 'video', [])
    const v2 = makeTrack('V2', 'video', [])
    const a1 = makeTrack('A1', 'audio', [])
    const a2 = makeTrack('A2', 'audio', [])
    const doc = makeDoc([v1, v2, a1, a2])
    // V2 composites ABOVE V1 (later in the array), so it displays on top.
    expect(tracksInDisplayOrder(doc)).toEqual([v2, v1, a1, a2])
    // Same references, pure reordering; the doc array is untouched.
    expect(tracksInDisplayOrder(doc)[0]).toBe(v2)
    expect(doc.tracks).toEqual([v1, v2, a1, a2])
  })

  test('interleaved kinds are grouped: all videos first, then all audios', () => {
    const v1 = makeTrack('V1', 'video', [])
    const a1 = makeTrack('A1', 'audio', [])
    const v2 = makeTrack('V2', 'video', [])
    expect(tracksInDisplayOrder(makeDoc([v1, a1, v2]))).toEqual([v2, v1, a1])
  })

  test('empty doc yields an empty array', () => {
    expect(tracksInDisplayOrder(makeDoc([]))).toEqual([])
  })
})

describe('trackOfClip', () => {
  test('finds the owning track on any lane; unknown clips yield null', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', [makeClip('a', 0, 10)]),
      makeTrack('A1', 'audio', [makeClip('b', 5, 10)]),
    ])
    expect(trackOfClip(doc, 'a')?.id).toBe('V1')
    expect(trackOfClip(doc, 'b')?.kind).toBe('audio')
    expect(trackOfClip(doc, 'nope')).toBeNull()
  })
})

describe('audibleTracks', () => {
  const flagged = (id: string, flags: Partial<Track> = {}): Track => ({
    ...makeTrack(id, 'audio', []),
    ...flags,
  })

  test('with no solo anywhere, every unmuted audio track is audible', () => {
    const doc = makeDoc([
      makeTrack('V1', 'video', []),
      flagged('A1'),
      flagged('A2', { muted: true }),
      flagged('A3'),
    ])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A1', 'A3'])
  })

  test('one solo track silences every non-solo audio track', () => {
    const doc = makeDoc([flagged('A1'), flagged('A2', { solo: true }), flagged('A3')])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A2'])
  })

  test('several solo tracks are audible together', () => {
    const doc = makeDoc([
      flagged('A1', { solo: true }),
      flagged('A2'),
      flagged('A3', { solo: true }),
    ])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A1', 'A3'])
  })

  test('mute wins over solo on the same track', () => {
    const doc = makeDoc([flagged('A1', { solo: true, muted: true }), flagged('A2')])
    // A1 is solo (so A2 is silenced) but also muted — nothing plays.
    expect(audibleTracks(doc)).toEqual([])
  })

  test('video tracks are never in the mix set, whatever their flags', () => {
    const doc = makeDoc([
      { ...makeTrack('V1', 'video', []), solo: true },
      flagged('A1'),
    ])
    expect(audibleTracks(doc).map((t) => t.id)).toEqual(['A1'])
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
