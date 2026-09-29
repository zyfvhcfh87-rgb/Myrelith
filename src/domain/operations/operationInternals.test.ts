import { describe, expect, test } from 'vitest'
import type { Clip, Track, Transition } from '../schema'
import { resolveCrossfadeGeometry } from '../crossfadePlan'
import { crossfadeWindowsOverlap } from '../selectors'
import { defaultTextProps } from '../textOverlay'
import { validTransitionIndexes } from './operationInternals'

/** The original full-scan, all-pairs definition the indexed version replaced. */
function referenceValidTransitionIndexes(track: Track): number[] {
  const resolved = track.transitions.map((transition) =>
    resolveCrossfadeGeometry(track, transition),
  )
  const invalid = new Set<number>()
  const counts = new Map<string, number>()
  for (const transition of track.transitions) {
    counts.set(transition.id, (counts.get(transition.id) ?? 0) + 1)
  }
  track.transitions.forEach((transition, index) => {
    if (!resolved[index] || (counts.get(transition.id) ?? 0) > 1) invalid.add(index)
  })
  for (let left = 0; left < resolved.length; left++) {
    const leftWindow = resolved[left]
    if (!leftWindow) continue
    for (let right = left + 1; right < resolved.length; right++) {
      const rightWindow = resolved[right]
      if (rightWindow && crossfadeWindowsOverlap(leftWindow, rightWindow)) {
        invalid.add(left)
        invalid.add(right)
      }
    }
  }
  return track.transitions.map((_transition, index) => index)
    .filter((index) => !invalid.has(index))
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function clip(id: string, startFrame: number, durationFrames: number, over: Partial<Clip> = {}): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 10, durationFrames },
    timelineRange: { startFrame, durationFrames },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
    ...over,
  }
}

function transition(id: string, fromClipId: string, toClipId: string, durationFrames: number): Transition {
  return {
    id,
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { enabled: true, curve: 'equal-power' },
  }
}

function track(clips: Clip[], transitions: Transition[], kind: Track['kind'] = 'video'): Track {
  return { id: 'V1', kind, name: 'V1', clips, transitions, hidden: false, muted: false, solo: false, locked: false }
}

function randomTrack(random: () => number): Track {
  const integer = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
  const clips: Clip[] = []
  let cursor = 0
  const clipCount = integer(0, 12)
  for (let index = 0; index < clipCount; index++) {
    const durationFrames = integer(1, 16)
    cursor += random() < 0.7 ? 0 : integer(1, 4)
    const id = index > 0 && random() < 0.08 ? clips[integer(0, index - 1)].id : `c${index}`
    const roll = random()
    const over: Partial<Clip> = roll < 0.08
      ? { sourceMode: 'still', sourceRange: { startFrame: 0, durationFrames: 1 } }
      : roll < 0.14
        ? { text: defaultTextProps(1920, 1080), assetId: `text:${id}` }
        : roll < 0.18
          ? { sourceRange: { startFrame: -1, durationFrames } }
          : {}
    clips.push(clip(id, cursor, durationFrames, over))
    cursor += durationFrames
  }
  const transitions: Transition[] = []
  const transitionCount = clips.length < 2 ? integer(0, 2) : integer(0, clips.length + 2)
  for (let index = 0; index < transitionCount; index++) {
    const from = clips.length === 0 ? 0 : integer(0, clips.length - 1)
    const to = random() < 0.8 ? from + 1 : integer(0, clips.length)
    const id = index > 0 && random() < 0.08 ? transitions[integer(0, index - 1)].id : `t${index}`
    transitions.push(transition(
      id,
      clips[from]?.id ?? 'missing',
      clips[to]?.id ?? 'missing',
      integer(0, 24),
    ))
  }
  return track(clips, transitions, random() < 0.9 ? 'video' : 'audio')
}

describe('validTransitionIndexes', () => {
  test('matches the full-scan all-pairs definition on randomized tracks', () => {
    const random = mulberry32(0x5eed)
    let validSeen = 0
    let invalidSeen = 0
    let overlapInvalidSeen = 0
    for (let round = 0; round < 5_000; round++) {
      const candidate = randomTrack(random)
      const expected = referenceValidTransitionIndexes(candidate)
      expect([...validTransitionIndexes(candidate)].sort((a, b) => a - b)).toEqual(expected)
      validSeen += expected.length
      invalidSeen += candidate.transitions.length - expected.length
      overlapInvalidSeen += candidate.transitions.filter((item, index) => (
        !expected.includes(index)
        && resolveCrossfadeGeometry(candidate, item) !== null
        && candidate.transitions.filter((other) => other.id === item.id).length === 1
      )).length
    }
    // The generator must exercise every outcome heavily to mean anything.
    expect(validSeen).toBeGreaterThan(1_000)
    expect(invalidSeen).toBeGreaterThan(1_000)
    expect(overlapInvalidSeen).toBeGreaterThan(300)
  })

  test('two overlapping windows invalidate each other, including start ties', () => {
    // Three 6-frame clips; 6-frame fades on both seams cover [3,9) and [9,15).
    const clips = [clip('a', 0, 6), clip('b', 6, 6), clip('c', 12, 6)]
    const touching = track(clips, [transition('x', 'a', 'b', 6), transition('y', 'b', 'c', 6)])
    expect([...validTransitionIndexes(touching)]).toEqual([0, 1])

    // 8-frame fades on the same seams cover [2,10) and [8,16).
    const overlapping = track(clips, [transition('x', 'a', 'b', 8), transition('y', 'b', 'c', 8)])
    expect([...validTransitionIndexes(overlapping)]).toEqual([])

    // Two definitions of one seam tie on start ([4,8) and [4,9)): both drop,
    // while the untouched seam [11,13) survives.
    const duplicated = track(clips, [
      transition('x', 'a', 'b', 4),
      transition('z', 'a', 'b', 5),
      transition('y', 'b', 'c', 2),
    ])
    expect(referenceValidTransitionIndexes(duplicated)).toEqual([2])
    expect([...validTransitionIndexes(duplicated)]).toEqual([2])
  })
})
