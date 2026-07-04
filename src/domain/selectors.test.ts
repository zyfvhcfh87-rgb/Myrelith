/**
 * domain/selectors.test.ts — Phase 3.2.
 */

import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import { docDurationFrames } from './selectors'

function makeClip(id: string, tlStart: number, duration: number): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceRange: { startFrame: 0, durationFrames: duration },
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
