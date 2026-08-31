import { describe, expect, test, vi } from 'vitest'
import { createAdjustmentItem } from './adjustmentItems'
import type { Clip, TimelineDoc, Track } from './schema'
import { moveClipsByDelta } from './operations'
import { linkedMoveClips } from './linking'

function clip(
  id: string,
  startFrame: number,
  durationFrames = 10,
  linkGroupId?: string,
): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame, durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
    ...(linkGroupId ? { linkGroupId } : {}),
  }
}

function track(
  id: string,
  kind: 'video' | 'audio',
  clips: Clip[],
  locked = false,
): Track {
  return {
    id,
    kind,
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function documentWith(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 18,
    id: 'multi-move-doc',
    name: 'multi move fixture',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks,
  }
}

function starts(doc: TimelineDoc, trackId: string): number[] {
  return doc.tracks
    .find((candidate) => candidate.id === trackId)!
    .clips.map((candidate) => candidate.timelineRange.startFrame)
}

describe('moveClipsByDelta', () => {
  test('moves touching selected clips through their old positions as one immutable edit', () => {
    const doc = documentWith([
      track('V1', 'video', [clip('A', 0), clip('B', 10), clip('still', 50)]),
    ])

    const moved = moveClipsByDelta(doc, ['A', 'B'], 10)

    expect(moved).not.toBe(doc)
    expect(starts(moved, 'V1')).toEqual([10, 20, 50])
    expect(starts(doc, 'V1')).toEqual([0, 10, 50])
  })

  test('preserves a transition when both adjacent clips move together', () => {
    const baseTrack = track('V1', 'video', [clip('A', 0), clip('B', 10)])
    const doc = documentWith([{
      ...baseTrack,
      transitions: [{
        id: 'crossfade-A-B',
        type: 'crossfade',
        fromClipId: 'A',
        toClipId: 'B',
        durationFrames: 3,
        audio: { enabled: true, curve: 'equal-power' },
      }],
    }])

    const moved = moveClipsByDelta(doc, ['A', 'B'], 8)

    expect(starts(moved, 'V1')).toEqual([8, 18])
    expect(moved.tracks[0].transitions).toEqual(doc.tracks[0].transitions)
  })

  test('rejects the complete group when any member collides or belongs to a locked track', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const collision = documentWith([
      track('V1', 'video', [clip('A', 0), clip('B', 20), clip('blocker', 35)]),
    ])
    const locked = documentWith([
      track('V1', 'video', [clip('A', 0)]),
      track('V2', 'video', [clip('B', 20)], true),
    ])

    expect(moveClipsByDelta(collision, ['A', 'B'], 10)).toBe(collision)
    expect(moveClipsByDelta(locked, ['A', 'B'], 10)).toBe(locked)
    expect(starts(collision, 'V1')).toEqual([0, 20, 35])

    const adjustmentBlock = documentWith([{
      ...track('V1', 'video', [clip('A', 0), clip('B', 20)]),
      adjustments: [createAdjustmentItem(35, 10)],
    }])
    expect(moveClipsByDelta(adjustmentBlock, ['A', 'B'], 10)).toBe(adjustmentBlock)
    warn.mockRestore()
  })

  test('treats zero delta as an exact no-op and rejects stale ids atomically', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = documentWith([track('V1', 'video', [clip('A', 5)])])

    expect(moveClipsByDelta(doc, ['A'], 0)).toBe(doc)
    expect(moveClipsByDelta(doc, ['A', 'missing'], 4)).toBe(doc)
    warn.mockRestore()
  })
})

describe('linkedMoveClips', () => {
  test('expands every selected root to its linked partners and moves the closure once', () => {
    const doc = documentWith([
      track('V1', 'video', [clip('video', 10, 10, 'pair'), clip('extra', 40)]),
      track('A1', 'audio', [clip('audio', 15, 10, 'pair')]),
    ])

    const moved = linkedMoveClips(doc, ['video', 'extra'], 5)

    expect(starts(moved, 'V1')).toEqual([15, 45])
    expect(starts(moved, 'A1')).toEqual([20])
  })
})
