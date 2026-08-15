import { describe, expect, test } from 'vitest'
import { defaultClipAnimation } from './clipAnimation'
import { defaultClipVisualSettings } from './clipInspector'
import type { MotionTrackingPlan } from './motionTracking'
import { applyMotionTrackingWithResult } from './operations'
import type { Clip, TimelineDoc, Track } from './schema'

function clip(id: string, animation = defaultClipAnimation()): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames: 20 },
    timelineRange: { startFrame: 0, durationFrames: 20 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    visual: defaultClipVisualSettings(),
    animation,
    effects: [],
  }
}

function track(id: string, item: Clip, locked = false): Track {
  return { id, kind: 'video', name: id, clips: [item], transitions: [], hidden: false, muted: false, solo: false, locked }
}

function doc(target = clip('target'), locked = false): TimelineDoc {
  return {
    schemaVersion: 14,
    id: 'tracking-operation',
    name: 'Tracking operation',
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [track('source-track', clip('source')), track('target-track', target, locked)],
  }
}

function keyframe(frame: number, value: number) {
  return { frame, sourceTimeTicks: frame * 1_000_000, value, easing: { type: 'linear' as const } }
}

function plan(includeScale = true): MotionTrackingPlan {
  return {
    sourceClipId: 'source',
    targetClipId: 'target',
    kind: 'box',
    includeScale,
    direction: 'forward',
    sampleCount: 2,
    confidenceMinimum: 0.8,
    confidenceMean: 0.9,
    stopped: null,
    replacementRequired: false,
    tracks: [
      { property: 'position-x', keyframes: [keyframe(0, 0), keyframe(1, 2)] },
      { property: 'position-y', keyframes: [keyframe(0, 0), keyframe(1, 3)] },
      ...(includeScale ? [
        { property: 'scale-x' as const, keyframes: [keyframe(0, 1), keyframe(1, 1.1)] },
        { property: 'scale-y' as const, keyframes: [keyframe(0, 1), keyframe(1, 1.1)] },
      ] : []),
    ],
  }
}

describe('motion tracking document operation', () => {
  test('authors the reviewed exact track set in one immutable document replacement', () => {
    const initial = doc()
    const result = applyMotionTrackingWithResult(initial, plan(), false)
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.doc).not.toBe(initial)
    expect(result.doc.tracks[1]?.clips[0]?.animation?.tracks.map((item) => item.property)).toEqual([
      'position-x', 'position-y', 'scale-x', 'scale-y',
    ])
    expect(initial.tracks[1]?.clips[0]?.animation?.tracks).toEqual([])
  })

  test('requires explicit replacement and preserves unrelated rotation/opacity tracks', () => {
    const existing = clip('target', {
      tracks: [
        { property: 'position-x', keyframes: [keyframe(0, 7)] },
        { property: 'rotation', keyframes: [keyframe(0, 15)] },
        { property: 'opacity', keyframes: [keyframe(0, 0.8)] },
      ],
      effectTracks: [],
    })
    const initial = doc(existing)
    const rejected = applyMotionTrackingWithResult(initial, plan(), false)
    expect(rejected.ok).toBe(false)
    expect(rejected.doc).toBe(initial)

    const replaced = applyMotionTrackingWithResult(initial, plan(), true)
    expect(replaced.ok).toBe(true)
    expect(replaced.doc.tracks[1]?.clips[0]?.animation?.tracks.map((item) => item.property)).toEqual([
      'position-x', 'position-y', 'scale-x', 'scale-y', 'rotation', 'opacity',
    ])
  })

  test('rejects locked targets and mismatched point-only track sets', () => {
    const locked = doc(clip('target'), true)
    expect(applyMotionTrackingWithResult(locked, plan(), true).doc).toBe(locked)
    const initial = doc()
    expect(applyMotionTrackingWithResult(initial, { ...plan(false), includeScale: true }, true).doc)
      .toBe(initial)
  })

  test('rejects duplicate generated frames and document-budget growth without history-worthy changes', () => {
    const initial = doc()
    const duplicate = plan(false)
    const duplicateTracks = duplicate.tracks.map((trackItem) => ({
      ...trackItem,
      keyframes: [
        keyframe(0, trackItem.keyframes[0]!.value),
        keyframe(0, trackItem.keyframes[1]!.value),
      ],
    }))
    expect(applyMotionTrackingWithResult(
      initial,
      { ...duplicate, tracks: duplicateTracks },
      true,
    ).doc).toBe(initial)

    const filler = {
      ...clip('filler'),
      timelineRange: { startFrame: 40, durationFrames: 20 },
      animation: {
        tracks: [{
          property: 'opacity' as const,
          keyframes: Array.from({ length: 99_999 }, (_, frame) => ({
            frame: frame % 20,
            sourceTimeTicks: frame % 20 * 1_000_000,
            value: 1,
            easing: { type: 'linear' as const },
          })),
        }],
        effectTracks: [],
      },
    }
    const crowded = doc()
    crowded.tracks[0]!.clips.push(filler)
    expect(applyMotionTrackingWithResult(crowded, plan(false), true).doc).toBe(crowded)
  })
})
