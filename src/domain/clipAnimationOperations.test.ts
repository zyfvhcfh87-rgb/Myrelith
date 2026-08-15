import { describe, expect, test } from 'vitest'
import type { Clip, TimelineDoc, Track } from './schema'
import { defaultClipAnimation, resolveClipAnimationAtFrame } from './clipAnimation'
import {
  moveClipKeyframe,
  removeClipKeyframe,
  resetClipAnimationTrack,
  setClipKeyframe,
  splitClipAtFrame,
  trimClip,
  updateClipVisualAtFrame,
} from './operations'

const linear = { type: 'linear' } as const

function clip(id = 'clip-1'): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: 'Media clip',
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 40 },
    timelineRange: { startFrame: 10, durationFrames: 40 },
    transform: {
      x: 4,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    animation: defaultClipAnimation(),
    effects: [],
  }
}

function track(clips: Clip[], kind: Track['kind'] = 'video', locked = false): Track {
  return {
    id: 'track-1',
    kind,
    name: 'Track 1',
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked,
  }
}

function doc(clips = [clip()], kind: Track['kind'] = 'video', locked = false): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'doc-1',
    name: 'Animation operations',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    tracks: [track(clips, kind, locked)],
  }
}

function findClip(document: TimelineDoc, id = 'clip-1'): Clip {
  const found = document.tracks.flatMap((item) => item.clips)
    .find((item) => item.id === id)
  if (!found) throw new Error(`Missing clip ${id}`)
  return found
}

describe('clip animation document operations', () => {
  test('adds, replaces, moves, removes, and resets keyframes immutably', () => {
    const original = doc()
    const first = setClipKeyframe(original, 'clip-1', 'position-x', {
      frame: 0,
      value: 10,
      easing: linear,
    })
    const second = setClipKeyframe(first, 'clip-1', 'position-x', {
      frame: 10,
      value: 20,
      easing: linear,
    })
    const replaced = setClipKeyframe(second, 'clip-1', 'position-x', {
      frame: 10,
      value: 25,
      easing: { type: 'hold' },
    })
    const moved = moveClipKeyframe(replaced, 'clip-1', 'position-x', 0, 10)
    const removed = removeClipKeyframe(moved, 'clip-1', 'position-x', 10)

    expect(findClip(original).animation).toEqual({ tracks: [], effectTracks: [] })
    expect(findClip(replaced).animation?.tracks[0].keyframes).toEqual([
      { frame: 0, sourceTimeTicks: 0, value: 10, easing: linear },
      { frame: 10, sourceTimeTicks: 10_000_000, value: 25, easing: { type: 'hold' } },
    ])
    expect(findClip(moved).animation?.tracks[0].keyframes).toEqual([
      { frame: 10, sourceTimeTicks: 10_000_000, value: 10, easing: linear },
    ])
    expect(findClip(removed).animation).toEqual({ tracks: [], effectTracks: [] })
    expect(resetClipAnimationTrack(second, 'clip-1', 'position-x'))
      .not.toBe(second)
    expect(findClip(resetClipAnimationTrack(second, 'clip-1', 'position-x')).transform.x)
      .toBe(4)
  })

  test('keeps static edits static and routes animated edits to the playhead', () => {
    const original = doc()
    const staticEdit = updateClipVisualAtFrame(original, 'clip-1', 15, {
      transform: { x: 30 },
    })
    const animated = setClipKeyframe(staticEdit, 'clip-1', 'position-x', {
      frame: 0,
      value: 30,
      easing: linear,
    })
    const keyedEdit = updateClipVisualAtFrame(animated, 'clip-1', 15, {
      transform: { x: 80 },
      opacity: 0.5,
    })
    const result = findClip(keyedEdit)

    expect(findClip(staticEdit).transform.x).toBe(30)
    expect(findClip(staticEdit).animation).toEqual({ tracks: [], effectTracks: [] })
    expect(result.transform.x).toBe(30)
    expect(result.opacity).toBe(0.5)
    expect(result.animation?.tracks[0].keyframes).toEqual([
      { frame: 0, sourceTimeTicks: 0, value: 30, easing: linear },
      { frame: 5, sourceTimeTicks: 5_000_000, value: 80, easing: linear },
    ])
  })

  test('preserves global curve values through split and head trim', () => {
    const animated = clip()
    animated.animation = {
      tracks: [{
        property: 'position-x',
        keyframes: [
          { frame: 0, value: 0, easing: linear },
          { frame: 20, value: 100, easing: linear },
        ],
      }],
    }
    const original = doc([animated])
    const expectedAt15 = resolveClipAnimationAtFrame(animated, 15).transform.x
    const expectedAt25 = resolveClipAnimationAtFrame(animated, 25).transform.x
    const split = splitClipAtFrame(original, 'clip-1', 20)
    const [left, right] = split.tracks[0].clips
    const trimmed = trimClip(original, 'clip-1', 'start', 5)

    expect(resolveClipAnimationAtFrame(left, 15).transform.x).toBe(expectedAt15)
    expect(resolveClipAnimationAtFrame(right, 25).transform.x).toBe(expectedAt25)
    expect(resolveClipAnimationAtFrame(findClip(trimmed), 25).transform.x)
      .toBe(expectedAt25)
  })

  test('rejects incompatible, locked, and out-of-range animated edits', () => {
    const audioDocument = doc([clip()], 'audio')
    const lockedDocument = doc([clip()], 'video', true)
    const animated = setClipKeyframe(doc(), 'clip-1', 'opacity', {
      frame: 0,
      value: 1,
      easing: linear,
    })

    expect(setClipKeyframe(audioDocument, 'clip-1', 'opacity', {
      frame: 0,
      value: 1,
      easing: linear,
    })).toBe(audioDocument)
    expect(setClipKeyframe(lockedDocument, 'clip-1', 'opacity', {
      frame: 0,
      value: 1,
      easing: linear,
    })).toBe(lockedDocument)
    expect(updateClipVisualAtFrame(animated, 'clip-1', 100, { opacity: 0.5 }))
      .toBe(animated)
  })
})
