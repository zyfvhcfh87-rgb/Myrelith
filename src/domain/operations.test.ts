/**
 * domain/operations.test.ts — Phase 1.1 acceptance tests.
 *
 * Every test deep-freezes the input doc: if an operation mutates its input
 * instead of returning a new doc, the mutation throws immediately.
 * Rejected operations must return the SAME reference (toBe(doc)).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, Effect, MediaAsset, TimelineDoc, Track, Transition } from './schema'
import { defaultTextProps } from './textOverlay'
import { createColorAdjustEffect } from './effectStack'
import { EFFECT_STACK_LIMITS } from './effectBounds'
import {
  addCrossfade,
  addCrossfadeWithSourceBounds,
  addEffect,
  addTrack,
  clipFromAsset,
  clipFromAssetRange,
  deleteClip,
  insertClip,
  MAX_CLIP_VOLUME,
  moveClip,
  removeEffect,
  removeClipSpeedPoint,
  removeTrack,
  removeTransition,
  renameTrack,
  reorderEffect,
  resetEffect,
  rippleDelete,
  rippleTrim,
  retimeClip,
  clearClipSpeedRamp,
  setClipSpeedPoint,
  setClipVolume,
  setEffectEnabled,
  setCrossfadeDuration,
  setCrossfadeDurationWithSourceBounds,
  setCrossfadeSettings,
  setCrossfadeSettingsWithSourceBounds,
  setMasterAudio,
  setTrackFlags,
  setTrackMixer,
  slideClip,
  slipClip,
  splitClipAtFrame,
  trimClip,
  updateClipAudio,
  updateClipAudioAtFrame,
  setClipKeyframe,
  updateClipTransform,
  updateClipVisual,
  updateEffectParams,
} from './operations'
import { createAdjustmentItem } from './adjustmentItems'
import { rangeEnd } from './time'
import {
  defaultSourceTimeMap,
  sourceFrameAtTimelineFrame,
  sourceTimeRateFromPercent,
  sourceTimeSpeedRateFromPercent,
} from './sourceTimeMap'

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function makeClip(
  id: string,
  tlStart: number,
  duration: number,
  srcStart = 0,
): Clip {
  return {
    id,
    assetId: 'asset-1',
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: srcStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, kind: Track['kind'], clips: Clip[], locked = false): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, solo: false, locked }
}

/**
 * Layout used by most tests (frames, half-open):
 *   V1: clipA [0,100)  clipB [100,150)  clipC [200,260)
 *   V2: (empty)
 *   A1: clipD [0,80)          (audio)
 *   VL: clipE [0,50)          (locked)
 */
function makeDoc(): TimelineDoc {
  return deepFreeze({
    schemaVersion: 19,
    id: 'doc-1',
    name: 'Test doc',
    frameRate: { num: 30000, den: 1001 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      makeTrack('V1', 'video', [
        makeClip('clipA', 0, 100, 10),
        makeClip('clipB', 100, 50, 0),
        makeClip('clipC', 200, 60, 5),
      ]),
      makeTrack('V2', 'video', []),
      makeTrack('A1', 'audio', [makeClip('clipD', 0, 80)]),
      makeTrack('VL', 'video', [makeClip('clipE', 0, 50)], true),
    ],
  })
}

function makeStillClip(
  id: string,
  tlStart: number,
  duration: number,
): Clip {
  return {
    ...makeClip(id, tlStart, duration),
    assetId: 'image-1',
    sourceMode: 'still',
    sourceRange: { startFrame: 0, durationFrames: 1 },
  }
}

function makeVideoDoc(clips: Clip[]): TimelineDoc {
  return deepFreeze({
    schemaVersion: 19,
    id: 'doc-stills',
    name: 'Still source tests',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [makeTrack('V1', 'video', clips)],
  })
}

function clipsOf(doc: TimelineDoc, trackId: string): Clip[] {
  const track = doc.tracks.find((t) => t.id === trackId)
  if (!track) throw new Error(`no track ${trackId}`)
  return track.clips
}

function clipIn(doc: TimelineDoc, trackId: string, clipId: string): Clip {
  const clip = clipsOf(doc, trackId).find((c) => c.id === clipId)
  if (!clip) throw new Error(`no clip ${clipId} on ${trackId}`)
  return clip
}

const fx = (id: string): Effect => ({
  id,
  type: 'brightness',
  version: 1,
  enabled: true,
  params: { amount: 0.5 },
})

describe('constant-speed retiming', () => {
  test('changes duration, source mapping, trim, split, and keyframe time deterministically', () => {
    const base = makeDoc()
    const doc = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => track.id === 'V1'
        ? {
            ...track,
            clips: track.clips.map((clip) => clip.id === 'clipA'
              ? {
                  ...clip,
                  sourceRange: { startFrame: 0, durationFrames: 100 },
                  animation: {
                    tracks: [{
                      property: 'opacity' as const,
                      keyframes: [{ frame: 20, value: 0.5, easing: { type: 'linear' as const } }],
                    }],
                  },
                }
              : clip),
          }
        : track),
    })

    const doubled = retimeClip(doc, 'clipA', sourceTimeRateFromPercent(200))
    const doubledClip = clipIn(doubled, 'V1', 'clipA')
    expect(doubledClip.timelineRange.durationFrames).toBe(50)
    expect(doubledClip.sourceRange).toEqual({ startFrame: 0, durationFrames: 100 })
    expect(doubledClip.animation?.tracks[0].keyframes[0].frame).toBe(10)
    expect(sourceFrameAtTimelineFrame(doubledClip, 12)).toBe(24)

    const moved = moveClip(doubled, 'clipA', 'V2', 30)
    const movedClip = clipIn(moved, 'V2', 'clipA')
    expect(movedClip.sourceTimeMap).toEqual(doubledClip.sourceTimeMap)
    expect(sourceFrameAtTimelineFrame(movedClip, 42)).toBe(24)

    const trimmed = trimClip(doubled, 'clipA', 'start', 1)
    const trimmedClip = clipIn(trimmed, 'V1', 'clipA')
    expect(trimmedClip.timelineRange).toEqual({ startFrame: 1, durationFrames: 49 })
    expect(trimmedClip.sourceRange).toEqual({ startFrame: 2, durationFrames: 98 })
    expect(sourceFrameAtTimelineFrame(trimmedClip, 1)).toBe(2)

    const split = splitClipAtFrame(doubled, 'clipA', 25)
    const halves = clipsOf(split, 'V1').slice(0, 2)
    expect(halves.map((clip) => clip.sourceRange)).toEqual([
      { startFrame: 0, durationFrames: 50 },
      { startFrame: 50, durationFrames: 50 },
    ])
    expect(sourceFrameAtTimelineFrame(halves[1], 25)).toBe(50)
  })

  test('rejects overlap and non-media retiming without changing the document', () => {
    const doc = makeDoc()
    expect(retimeClip(doc, 'clipA', sourceTimeRateFromPercent(50))).toBe(doc)
    const stillDoc = {
      ...doc,
      tracks: doc.tracks.map((track) => track.id === 'V2'
        ? { ...track, clips: [makeStillClip('still', 0, 100)] }
        : track),
    }
    expect(retimeClip(stillDoc, 'still', sourceTimeRateFromPercent(200))).toBe(stillDoc)
  })

  test('does not lose a fractional source tail across repeated rate changes', () => {
    const base = makeDoc()
    const isolated = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => track.id === 'V1'
        ? {
            ...track,
            clips: track.clips.filter((clip) => clip.id === 'clipA').map((clip) => ({
              ...clip,
              sourceRange: { startFrame: 0, durationFrames: 100 },
            })),
          }
        : track),
    })

    const slowed = retimeClip(isolated, 'clipA', sourceTimeRateFromPercent(75))
    expect(clipIn(slowed, 'V1', 'clipA')).toMatchObject({
      timelineRange: { startFrame: 0, durationFrames: 133 },
      sourceRange: { startFrame: 0, durationFrames: 100 },
      sourceTimeMap: { sourceDurationTicks: 100_000_000 },
    })
    const restored = retimeClip(slowed, 'clipA', sourceTimeRateFromPercent(100))
    expect(clipIn(restored, 'V1', 'clipA')).toMatchObject({
      timelineRange: { startFrame: 0, durationFrames: 100 },
      sourceRange: { startFrame: 0, durationFrames: 100 },
    })
  })

  test('rejects a retime whose timeline end is not a safe integer', () => {
    const base = makeDoc()
    const unsafe = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => track.id === 'V1'
        ? {
            ...track,
            clips: track.clips.filter((clip) => clip.id === 'clipA').map((clip) => ({
              ...clip,
              timelineRange: {
                startFrame: Number.MAX_SAFE_INTEGER - 1,
                durationFrames: 1,
              },
              sourceRange: { startFrame: 0, durationFrames: 2 },
              sourceTimeMap: {
                sourceStartTicks: 0,
                sourceDurationTicks: 2_000_000,
                rate: sourceTimeRateFromPercent(200),
              },
            })),
          }
        : track),
    })

    expect(retimeClip(unsafe, 'clipA', sourceTimeRateFromPercent(100))).toBe(unsafe)
  })

  test('restores keyframe frames exactly after 100% to 150% to 100%', () => {
    const base = makeDoc()
    const isolated = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => track.id === 'V1'
        ? {
            ...track,
            clips: track.clips.filter((clip) => clip.id === 'clipA').map((clip) => ({
              ...clip,
              sourceRange: { startFrame: 0, durationFrames: 3 },
              timelineRange: { startFrame: 0, durationFrames: 3 },
              sourceTimeMap: undefined,
              animation: {
                tracks: [{
                  property: 'opacity' as const,
                  keyframes: [{ frame: 1, value: 0.5, easing: { type: 'linear' as const } }],
                }],
              },
            })),
          }
        : track),
    })

    const accelerated = retimeClip(
      isolated,
      'clipA',
      sourceTimeRateFromPercent(150),
    )
    expect(clipIn(accelerated, 'V1', 'clipA').animation?.tracks[0].keyframes[0])
      .toMatchObject({ frame: 0, sourceTimeTicks: 1_000_000 })

    const restored = retimeClip(
      accelerated,
      'clipA',
      sourceTimeRateFromPercent(100),
    )
    expect(clipIn(restored, 'V1', 'clipA').animation?.tracks[0].keyframes[0])
      .toMatchObject({ frame: 1, sourceTimeTicks: 1_000_000 })
  })

  test('rejects a retime that would collapse distinct keyframes', () => {
    const base = makeDoc()
    const isolated = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => track.id === 'V1'
        ? {
            ...track,
            clips: track.clips.filter((clip) => clip.id === 'clipA').map((clip) => ({
              ...clip,
              sourceRange: { startFrame: 0, durationFrames: 3 },
              timelineRange: { startFrame: 0, durationFrames: 3 },
              animation: {
                tracks: [{
                  property: 'opacity' as const,
                  keyframes: [
                    { frame: 0, value: 0, easing: { type: 'linear' as const } },
                    { frame: 1, value: 1, easing: { type: 'linear' as const } },
                  ],
                }],
              },
            })),
          }
        : track),
    })

    expect(retimeClip(isolated, 'clipA', sourceTimeRateFromPercent(200)))
      .toBe(isolated)
  })
})

describe('piecewise speed ramps', () => {
  test('adds, replaces, freezes, splits, removes, and clears points deterministically', () => {
    const base = makeDoc()
    const isolated = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => track.id === 'V1'
        ? {
            ...track,
            clips: track.clips.filter((clip) => clip.id === 'clipA').map((clip) => ({
              ...clip,
              sourceRange: { startFrame: 0, durationFrames: 100 },
              sourceTimeMap: defaultSourceTimeMap(0, 100),
            })),
          }
        : track),
    })

    const withTail = setClipSpeedPoint(
      isolated,
      'clipA',
      20,
      sourceTimeSpeedRateFromPercent(200),
      'linear',
    )
    const frozen = setClipSpeedPoint(
      withTail,
      'clipA',
      0,
      sourceTimeSpeedRateFromPercent(0),
      'hold',
    )
    const ramped = clipIn(frozen, 'V1', 'clipA')
    expect(ramped.timelineRange.durationFrames).toBe(70)
    expect(ramped.sourceTimeMap?.speedCurve?.points).toEqual([
      { frame: 0, rate: { numerator: 0, denominator: 1 }, easing: 'hold' },
      { frame: 20, rate: { numerator: 2, denominator: 1 }, easing: 'linear' },
    ])
    expect(sourceFrameAtTimelineFrame(ramped, 19)).toBe(0)
    expect(sourceFrameAtTimelineFrame(ramped, 21)).toBe(2)

    const split = splitClipAtFrame(frozen, 'clipA', 10)
    const [left, right] = clipsOf(split, 'V1')
    expect(left.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(right.sourceTimeMap?.speedCurve?.originFrame).toBe(10)
    expect(sourceFrameAtTimelineFrame(right, 20)).toBe(0)
    expect(sourceFrameAtTimelineFrame(right, 21)).toBe(2)

    const replaced = setClipSpeedPoint(
      frozen,
      'clipA',
      20,
      sourceTimeSpeedRateFromPercent(100),
      'smooth',
    )
    expect(clipIn(replaced, 'V1', 'clipA').sourceTimeMap?.speedCurve?.points)
      .toHaveLength(2)
    expect(clipIn(replaced, 'V1', 'clipA').sourceTimeMap?.speedCurve?.points[1])
      .toMatchObject({ frame: 20, easing: 'smooth', rate: { numerator: 1, denominator: 1 } })

    const removed = removeClipSpeedPoint(frozen, 'clipA', 0)
    expect(clipIn(removed, 'V1', 'clipA').timelineRange.durationFrames).toBe(50)
    const cleared = clearClipSpeedRamp(frozen, 'clipA')
    expect(clipIn(cleared, 'V1', 'clipA').timelineRange.durationFrames).toBe(100)
    expect(clipIn(cleared, 'V1', 'clipA').sourceTimeMap?.speedCurve)
      .toEqual({ originFrame: 0, points: [] })
  })

  test('rejects an unbounded terminal freeze and preserves the input by reference', () => {
    const doc = makeDoc()
    expect(setClipSpeedPoint(
      doc,
      'clipA',
      0,
      sourceTimeSpeedRateFromPercent(0),
      'hold',
    )).toBe(doc)
  })
})

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

/* ------------------------------------------------------------------ */
/* splitClipAtFrame                                                     */
/* ------------------------------------------------------------------ */

describe('splitClipAtFrame', () => {
  test('produces two clips sharing the same assetId', () => {
    const doc = makeDoc()
    const out = splitClipAtFrame(doc, 'clipA', 40)
    const clips = clipsOf(out, 'V1')
    expect(clips).toHaveLength(4)
    expect(clips[0].assetId).toBe('asset-1')
    expect(clips[1].assetId).toBe('asset-1')
    expect(clips[0].id).toBe('clipA') // left keeps identity
    expect(clips[1].id).not.toBe('clipA') // right is a new clip
  })

  test('halves partition the original source range exactly (merge-equivalent)', () => {
    const doc = makeDoc()
    const orig = clipIn(doc, 'V1', 'clipA') // src [10,110), tl [0,100)
    const out = splitClipAtFrame(doc, 'clipA', 40)
    const [left, right] = clipsOf(out, 'V1')

    // Timeline: left [0,40), right [40,100) — contiguous, no gap.
    expect(left.timelineRange).toEqual({ startFrame: 0, durationFrames: 40 })
    expect(right.timelineRange).toEqual({ startFrame: 40, durationFrames: 60 })
    expect(rangeEnd(left.timelineRange)).toBe(right.timelineRange.startFrame)

    // Source: right continues exactly where left stops; the union
    // reconstructs the original source range.
    expect(left.sourceRange.startFrame).toBe(orig.sourceRange.startFrame)
    expect(rangeEnd(left.sourceRange)).toBe(right.sourceRange.startFrame)
    expect(rangeEnd(right.sourceRange)).toBe(rangeEnd(orig.sourceRange))
    expect(
      left.sourceRange.durationFrames + right.sourceRange.durationFrames,
    ).toBe(orig.sourceRange.durationFrames)
  })

  test('split at clip boundaries is rejected (would create an empty clip)', () => {
    const doc = makeDoc()
    expect(splitClipAtFrame(doc, 'clipA', 0)).toBe(doc)
    expect(splitClipAtFrame(doc, 'clipA', 100)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('unknown clip, locked track, non-integer frame are rejected', () => {
    const doc = makeDoc()
    expect(splitClipAtFrame(doc, 'nope', 10)).toBe(doc)
    expect(splitClipAtFrame(doc, 'clipE', 10)).toBe(doc) // locked track
    expect(splitClipAtFrame(doc, 'clipA', 40.5)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })

  test('effects are deep-copied onto the right half with fresh ids', () => {
    const doc = makeDoc()
    const withFx = addEffect(doc, 'clipA', fx('fx1'))
    const out = splitClipAtFrame(deepFreeze(withFx), 'clipA', 40)
    const [left, right] = clipsOf(out, 'V1')
    expect(left.effects[0].id).toBe('fx1')
    expect(right.effects).toHaveLength(1)
    expect(right.effects[0].id).not.toBe('fx1')
    expect(right.effects[0].params).toEqual(left.effects[0].params)
    expect(right.effects[0].params).not.toBe(left.effects[0].params)
  })
})

/* ------------------------------------------------------------------ */
/* trimClip                                                             */
/* ------------------------------------------------------------------ */

describe('trimClip', () => {
  test('trimming the end shortens both ranges together', () => {
    const doc = makeDoc()
    const out = trimClip(doc, 'clipC', 'end', -20) // [200,260) -> [200,240)
    const c = clipIn(out, 'V1', 'clipC')
    expect(c.timelineRange).toEqual({ startFrame: 200, durationFrames: 40 })
    expect(c.sourceRange).toEqual({ startFrame: 5, durationFrames: 40 })
  })

  test('trimming the start advances the source in-point', () => {
    const doc = makeDoc()
    const out = trimClip(doc, 'clipC', 'start', 10) // tl [210,260), src in-point 15
    const c = clipIn(out, 'V1', 'clipC')
    expect(c.timelineRange).toEqual({ startFrame: 210, durationFrames: 50 })
    expect(c.sourceRange).toEqual({ startFrame: 15, durationFrames: 50 })
  })

  test('cannot shrink a clip below 1 frame', () => {
    const doc = makeDoc()
    expect(trimClip(doc, 'clipB', 'end', -50)).toBe(doc) // would be 0
    expect(trimClip(doc, 'clipB', 'start', 50)).toBe(doc) // would be 0
    const ok = trimClip(doc, 'clipB', 'end', -49) // exactly 1 frame survives
    expect(clipIn(ok, 'V1', 'clipB').timelineRange.durationFrames).toBe(1)
  })

  test('cannot extend before source start or timeline zero', () => {
    const doc = makeDoc()
    // clipB has srcStart 0: extending its start needs material before frame 0.
    expect(trimClip(doc, 'clipB', 'start', -5)).toBe(doc)
    // clipA starts at timeline 0 AND srcStart 10: -5 passes the source check
    // but would start at timeline -5.
    expect(trimClip(doc, 'clipA', 'start', -5)).toBe(doc)
  })

  test('cannot trim into a neighboring clip', () => {
    const doc = makeDoc()
    // clipA [0,100) extending its end collides with clipB at [100,150).
    expect(trimClip(doc, 'clipA', 'end', 1)).toBe(doc)
    // clipC extending 45 frames left: the gap is free, but its source
    // in-point is 5, so there aren't 45 frames of material — rejected.
    expect(trimClip(doc, 'clipC', 'start', -45)).toBe(doc)
  })

  test('extending into a free gap succeeds when source material exists', () => {
    const doc = makeDoc()
    const out = trimClip(doc, 'clipC', 'start', -5) // src 5 -> 0, tl 200 -> 195
    const c = clipIn(out, 'V1', 'clipC')
    expect(c.timelineRange).toEqual({ startFrame: 195, durationFrames: 65 })
    expect(c.sourceRange).toEqual({ startFrame: 0, durationFrames: 65 })
  })
})

/* ------------------------------------------------------------------ */
/* moveClip                                                             */
/* ------------------------------------------------------------------ */

describe('moveClip', () => {
  test('rejects overlap and returns doc unchanged', () => {
    const doc = makeDoc()
    // Move clipC onto clipB's territory.
    expect(moveClip(doc, 'clipC', 'V1', 60)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('repositions within the same track and keeps clips sorted', () => {
    const doc = makeDoc()
    // clipB ends at 150 (half-open), so clipC can land exactly there:
    // [150,210) touches clipB but does not overlap it.
    const out = moveClip(doc, 'clipC', 'V1', 150)
    const ids = clipsOf(out, 'V1').map((c) => c.id)
    expect(ids).toEqual(['clipA', 'clipB', 'clipC'])
    expect(clipIn(out, 'V1', 'clipC').timelineRange.startFrame).toBe(150)
  })

  test('moves across tracks of the same kind', () => {
    const doc = makeDoc()
    const out = moveClip(doc, 'clipB', 'V2', 0)
    expect(clipsOf(out, 'V1').map((c) => c.id)).toEqual(['clipA', 'clipC'])
    const moved = clipIn(out, 'V2', 'clipB')
    expect(moved.timelineRange).toEqual({ startFrame: 0, durationFrames: 50 })
    expect(moved.sourceRange).toEqual(clipIn(doc, 'V1', 'clipB').sourceRange)
  })

  test('rejects kind mismatch, unknown track, locked tracks, bad frame', () => {
    const doc = makeDoc()
    expect(moveClip(doc, 'clipB', 'A1', 300)).toBe(doc) // video -> audio
    expect(moveClip(doc, 'clipB', 'V9', 0)).toBe(doc) // no such track
    expect(moveClip(doc, 'clipB', 'VL', 300)).toBe(doc) // locked target
    expect(moveClip(doc, 'clipE', 'V2', 0)).toBe(doc) // locked source
    expect(moveClip(doc, 'clipB', 'V2', -1)).toBe(doc)
    expect(moveClip(doc, 'clipB', 'V2', 1.5)).toBe(doc)
  })
})

/* ------------------------------------------------------------------ */
/* rippleDelete                                                         */
/* ------------------------------------------------------------------ */

describe('deleteClip', () => {
  test('removes one clip and leaves the gap', () => {
    const doc = makeDoc()
    const out = deleteClip(doc, 'clipA')
    expect(out).not.toBe(doc)
    expect(clipsOf(out, 'V1').map((clip) => clip.id)).toEqual(['clipB', 'clipC'])
    expect(clipIn(out, 'V1', 'clipB').timelineRange.startFrame).toBe(100)
  })

  test('rejects a locked track with the original document', () => {
    const doc = makeDoc()
    expect(deleteClip(doc, 'clipE')).toBe(doc)
  })
})

describe('rippleDelete', () => {
  test('removes the clip and shifts later clips left by its duration', () => {
    const doc = makeDoc()
    const out = rippleDelete(doc, 'clipB') // 50 frames vanish
    const ids = clipsOf(out, 'V1').map((c) => c.id)
    expect(ids).toEqual(['clipA', 'clipC'])
    expect(clipIn(out, 'V1', 'clipA').timelineRange.startFrame).toBe(0) // before: untouched
    expect(clipIn(out, 'V1', 'clipC').timelineRange.startFrame).toBe(150) // 200 - 50
  })

  test('other tracks are untouched (single-track ripple)', () => {
    const doc = makeDoc()
    const out = rippleDelete(doc, 'clipB')
    expect(clipsOf(out, 'A1')).toEqual(clipsOf(doc, 'A1'))
    expect(out.tracks.find((t) => t.id === 'A1')).toBe(
      doc.tracks.find((t) => t.id === 'A1'),
    ) // structural sharing: same reference
  })

  test('rejects unknown clip and locked track', () => {
    const doc = makeDoc()
    expect(rippleDelete(doc, 'nope')).toBe(doc)
    expect(rippleDelete(doc, 'clipE')).toBe(doc)
  })
})

describe('clip edits respect adjustment occupancy', () => {
  function withGapAdjustment(): TimelineDoc {
    // V1: clipA [0,100) clipB [100,150) gap [150,200) clipC [200,260)
    const start = makeDoc()
    return deepFreeze({
      ...start,
      tracks: start.tracks.map((track) => (
        track.id === 'V1'
          ? { ...track, adjustments: [createAdjustmentItem(150, 50)] }
          : track
      )),
    })
  }

  test('insert, move, and trim reject a range already held by an adjustment', () => {
    const doc = withGapAdjustment()
    expect(insertClip(doc, 'V1', makeClip('into-adj', 150, 50))).toBe(doc)
    expect(moveClip(doc, 'clipC', 'V1', 150)).toBe(doc)
    expect(trimClip(doc, 'clipC', 'start', -5)).toBe(doc)
  })

  test('ripple-delete and ripple-trim shift later adjustments with later clips', () => {
    const doc = withGapAdjustment()
    const deleted = rippleDelete(doc, 'clipB')
    expect(deleted).not.toBe(doc)
    expect(clipIn(deleted, 'V1', 'clipC').timelineRange.startFrame).toBe(150)
    expect(deleted.tracks.find((track) => track.id === 'V1')!.adjustments![0]!
      .timelineRange).toEqual({ startFrame: 100, durationFrames: 50 })

    const trimmed = rippleTrim(doc, 'clipB', 'end', 20)
    expect(trimmed).not.toBe(doc)
    expect(clipIn(trimmed, 'V1', 'clipC').timelineRange.startFrame).toBe(220)
    expect(trimmed.tracks.find((track) => track.id === 'V1')!.adjustments![0]!
      .timelineRange).toEqual({ startFrame: 170, durationFrames: 50 })
  })

  test('slide and retime reject growing or sliding into an adjustment', () => {
    const doc = withGapAdjustment()
    expect(slideClip(doc, 'clipB', 10)).toBe(doc)

    const isolated = deepFreeze({
      schemaVersion: 19,
      id: 'doc-retime-adj',
      name: 'retime vs adjustment',
      frameRate: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48000,
      tracks: [makeTrack('V1', 'video', [makeClip('solo', 0, 20)])],
    })
    const withAdj = deepFreeze({
      ...isolated,
      tracks: isolated.tracks.map((track) => ({
        ...track,
        adjustments: [createAdjustmentItem(20, 10)],
      })),
    })
    expect(retimeClip(withAdj, 'solo', sourceTimeRateFromPercent(50))).toBe(withAdj)
  })
})

/* ------------------------------------------------------------------ */
/* addEffect                                                            */
/* ------------------------------------------------------------------ */

describe('addEffect', () => {
  test('appends a defensive copy of the effect', () => {
    const doc = makeDoc()
    const effect = fx('fx1')
    const out = addEffect(doc, 'clipA', effect)
    const stored = clipIn(out, 'V1', 'clipA').effects[0]
    expect(stored).toEqual(effect)
    expect(stored).not.toBe(effect)
    expect(stored.params).not.toBe(effect.params)
  })

  test('rejects duplicate effect id on the same clip', () => {
    const doc = makeDoc()
    const withFx = deepFreeze(addEffect(doc, 'clipA', fx('fx1')))
    expect(addEffect(withFx, 'clipA', fx('fx1'))).toBe(withFx)
  })

  test('rejects unknown clip and locked track', () => {
    const doc = makeDoc()
    expect(addEffect(doc, 'nope', fx('fx1'))).toBe(doc)
    expect(addEffect(doc, 'clipE', fx('fx1'))).toBe(doc)
  })

  test('requires globally unique effect ids', () => {
    const doc = addEffect(makeDoc(), 'clipA', fx('shared-id'))
    expect(addEffect(doc, 'clipB', fx('shared-id'))).toBe(doc)
  })

  test('accepts the exact descriptor limits and rejects every over-limit edit', () => {
    const params: Effect['params'] = Object.fromEntries(Array.from(
      { length: EFFECT_STACK_LIMITS.maxEffectParams },
      (_value, index) => [`parameter-${index}`, index],
    ))
    params['parameter-0'] = 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters)
    const exact: Effect = {
      id: 'i'.repeat(EFFECT_STACK_LIMITS.maxIdCharacters),
      type: 't'.repeat(EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters),
      version: Number.MAX_SAFE_INTEGER,
      enabled: true,
      params,
    }
    const base = makeDoc()
    const accepted = addEffect(base, 'clipA', exact)
    expect(accepted).not.toBe(base)

    const overCases: Effect[] = [
      { ...exact, id: `${exact.id}x` },
      { ...exact, type: `${exact.type}x` },
      { ...exact, id: 'too-many-params', params: { ...params, overflow: true } },
      {
        ...exact,
        id: 'too-long-string',
        params: { label: 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters + 1) },
      },
      {
        ...exact,
        id: 'too-large-number',
        params: { amount: EFFECT_STACK_LIMITS.maxFiniteMagnitude + 1 },
      },
    ]
    for (const candidate of overCases) {
      const doc = deepFreeze(makeDoc())
      expect(addEffect(doc, 'clipA', candidate)).toBe(doc)
    }
  })

  test('rejects an add after the exact per-clip limit without changing the document', () => {
    let doc = makeDoc()
    for (let index = 0; index < EFFECT_STACK_LIMITS.maxEffectsPerClip; index++) {
      doc = addEffect(doc, 'clipA', fx(`limit-${index}`))
    }
    const full = deepFreeze(doc)
    expect(clipIn(full, 'V1', 'clipA').effects).toHaveLength(
      EFFECT_STACK_LIMITS.maxEffectsPerClip,
    )
    expect(addEffect(full, 'clipA', fx('over-limit'))).toBe(full)
  })
})

describe('ordered effect-stack operations', () => {
  test('enable, parameter, reorder, reset, and remove are immutable atomic edits', () => {
    const first = createColorAdjustEffect('fx-color-a')
    const second = createColorAdjustEffect('fx-color-b')
    let doc = addEffect(addEffect(makeDoc(), 'clipA', first), 'clipA', second)
    const original = doc

    doc = setEffectEnabled(doc, 'clipA', first.id, false)
    expect(clipIn(doc, 'V1', 'clipA').effects[0].enabled).toBe(false)
    doc = updateEffectParams(doc, 'clipA', first.id, { exposure: 1.5, contrast: 0.25 })
    expect(clipIn(doc, 'V1', 'clipA').effects[0].params).toMatchObject({
      exposure: 1.5,
      contrast: 0.25,
    })
    doc = reorderEffect(doc, 'clipA', second.id, 0)
    expect(clipIn(doc, 'V1', 'clipA').effects.map((effect) => effect.id))
      .toEqual([second.id, first.id])
    doc = resetEffect(doc, 'clipA', first.id)
    expect(clipIn(doc, 'V1', 'clipA').effects[1].params).toEqual({
      exposure: 0,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
    })
    doc = removeEffect(doc, 'clipA', second.id)
    expect(clipIn(doc, 'V1', 'clipA').effects.map((effect) => effect.id)).toEqual([first.id])
    expect(original).not.toBe(doc)
    expect(clipIn(original, 'V1', 'clipA').effects.map((effect) => effect.id))
      .toEqual([first.id, second.id])
  })

  test('rejects invalid params, indices, missing effects, and locked clips', () => {
    const doc = deepFreeze(addEffect(makeDoc(), 'clipA', createColorAdjustEffect('fx-color')))
    expect(updateEffectParams(doc, 'clipA', 'fx-color', { exposure: 99 })).toBe(doc)
    expect(reorderEffect(doc, 'clipA', 'fx-color', 9)).toBe(doc)
    expect(removeEffect(doc, 'clipA', 'missing')).toBe(doc)
    expect(setEffectEnabled(doc, 'clipE', 'fx-color', false)).toBe(doc)
  })

  test('rejects parameter patches that cross portable descriptor bounds', () => {
    const opaque: Effect = {
      id: 'fx-opaque',
      type: 'future.opaque',
      version: 1,
      enabled: true,
      params: Object.fromEntries(Array.from(
        { length: EFFECT_STACK_LIMITS.maxEffectParams },
        (_value, index) => [`parameter-${index}`, index],
      )),
    }
    const doc = deepFreeze(addEffect(makeDoc(), 'clipA', opaque))
    expect(updateEffectParams(doc, 'clipA', opaque.id, { overflow: true })).toBe(doc)
    expect(updateEffectParams(doc, 'clipA', opaque.id, {
      'parameter-0': EFFECT_STACK_LIMITS.maxFiniteMagnitude + 1,
    })).toBe(doc)
    expect(updateEffectParams(doc, 'clipA', opaque.id, {
      'parameter-0': 'x'.repeat(EFFECT_STACK_LIMITS.maxEffectStringCharacters + 1),
    })).toBe(doc)
  })
})

/* ------------------------------------------------------------------ */
/* Cross-cutting guarantees                                             */
/* ------------------------------------------------------------------ */

describe('cross-cutting guarantees', () => {
  test('successful ops never mutate the input (deep-frozen fixtures)', () => {
    // Every op above already runs against frozen docs; this is the explicit
    // end-to-end version: chain several ops and re-verify the original.
    const doc = makeDoc()
    const snapshot = JSON.parse(JSON.stringify(doc))
    let d = splitClipAtFrame(doc, 'clipA', 40)
    d = trimClip(d, 'clipB', 'end', -10)
    d = moveClip(d, 'clipC', 'V2', 0)
    d = rippleDelete(d, 'clipB')
    d = addEffect(d, 'clipC', fx('fx9'))
    expect(JSON.parse(JSON.stringify(doc))).toEqual(snapshot)
    expect(d).not.toBe(doc)
  })

  test('docs survive JSON round-trips after every operation', () => {
    const doc = makeDoc()
    const out = addEffect(
      rippleDelete(splitClipAtFrame(doc, 'clipA', 40), 'clipB'),
      'clipC',
      fx('fx1'),
    )
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  test('clips stay sorted by start frame after any successful op', () => {
    const doc = makeDoc()
    const ops: TimelineDoc[] = [
      splitClipAtFrame(doc, 'clipB', 120),
      trimClip(doc, 'clipC', 'start', -5),
      moveClip(doc, 'clipA', 'V1', 300),
      rippleDelete(doc, 'clipA'),
    ]
    for (const out of ops) {
      for (const track of out.tracks) {
        const starts = track.clips.map((c) => c.timelineRange.startFrame)
        expect(starts).toEqual([...starts].sort((a, b) => a - b))
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/* insertClip + clipFromAsset (Phase 4.0)                               */
/* ------------------------------------------------------------------ */

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'asset-9',
  fileName: 'beach.mp4',
  mimeType: 'video/mp4',
  size: 1_024,
  lastModified: 1_725_000_000_000,
  objectUrl: 'blob:fake',
  kind: 'video',
  durationFrames: 120,
  durationMicroseconds: 4_000_000,
  sourceBounds: {
    video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
    audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 4_000_000 },
  },
  frameRate: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  hasAudio: true,
  audioSampleRate: 48000,
  audioChannels: 2,
  decoderConfigB64: null,
  ...over,
})

describe('clipFromAsset', () => {
  test('plays the whole asset from its first frame with schema defaults', () => {
    const c = clipFromAsset(asset(), 30)
    expect(c.assetId).toBe('asset-9')
    expect(c.name).toBe('beach.mp4')
    expect(c.sourceMode).toBe('timed')
    expect(c.sourceRange).toEqual({ startFrame: 0, durationFrames: 120 })
    expect(c.timelineRange).toEqual({ startFrame: 30, durationFrames: 120 })
    expect(c.opacity).toBe(1)
    expect(c.volume).toBe(1)
    expect(c.effects).toEqual([])
    expect(c.transform).toEqual({
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
    })
  })

  test('every call mints a fresh clip id', () => {
    expect(clipFromAsset(asset(), 0).id).not.toBe(clipFromAsset(asset(), 0).id)
  })

  test('clipFromAssetRange plays a timed subrange at 1x', () => {
    const c = clipFromAssetRange(asset(), 40, 10, 30)
    expect(c.timelineRange).toEqual({ startFrame: 40, durationFrames: 30 })
    expect(c.sourceRange).toEqual({ startFrame: 10, durationFrames: 30 })
    expect(c.sourceMode).toBe('timed')
  })

  test('an image gets one still source frame and a nominal editable timeline duration', () => {
    const c = clipFromAsset(asset({
      kind: 'image',
      fileName: 'poster.png',
      mimeType: 'image/png',
      durationFrames: 150,
      durationMicroseconds: 5_000_000,
      sourceBounds: { video: null, audio: null },
      frameRate: null,
      hasAudio: false,
      audioSampleRate: null,
      audioChannels: null,
    }), 45)

    expect(c.sourceMode).toBe('still')
    expect(c.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(c.timelineRange).toEqual({ startFrame: 45, durationFrames: 150 })
  })
})

describe('insertClip', () => {
  test('inserts onto an empty track (factory output passes validation)', () => {
    const doc = makeDoc()
    const clip = clipFromAsset(asset(), 40)
    const out = insertClip(doc, 'V2', clip)
    expect(out).not.toBe(doc)
    expect(clipsOf(out, 'V2')).toHaveLength(1)
    expect(clipsOf(out, 'V2')[0].timelineRange).toEqual({ startFrame: 40, durationFrames: 120 })
    expect(clipsOf(doc, 'V2')).toHaveLength(0) // input untouched
  })

  test('lands sorted between neighbors; touching ranges do not overlap (half-open)', () => {
    // V1 has clipB [100,150) and clipC [200,260); [150,200) touches both.
    const doc = makeDoc()
    const out = insertClip(doc, 'V1', makeClip('clipNew', 150, 50))
    const ids = clipsOf(out, 'V1').map((c) => c.id)
    expect(ids).toEqual(['clipA', 'clipB', 'clipNew', 'clipC'])
  })

  test('overlap, locked track, unknown track are rejected (same reference)', () => {
    const doc = makeDoc()
    expect(insertClip(doc, 'V1', makeClip('n1', 90, 20))).toBe(doc) // overlaps clipA
    expect(insertClip(doc, 'VL', makeClip('n2', 0, 10))).toBe(doc) // locked
    expect(insertClip(doc, 'V9', makeClip('n3', 0, 10))).toBe(doc) // no such track
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })

  test('duplicate clip id anywhere in the doc is rejected', () => {
    const doc = makeDoc()
    expect(insertClip(doc, 'V2', makeClip('clipA', 500, 10))).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('bad geometry is rejected: dur < 1, floats, negatives, speed != 1.0', () => {
    const doc = makeDoc()
    expect(insertClip(doc, 'V2', makeClip('z1', 0, 0))).toBe(doc) // empty clip
    expect(insertClip(doc, 'V2', makeClip('z2', 0.5, 10))).toBe(doc) // float start
    expect(insertClip(doc, 'V2', makeClip('z3', -5, 10))).toBe(doc) // negative start
    expect(insertClip(doc, 'V2', makeClip('z4', 0, 10, -1))).toBe(doc) // negative src start
    const mismatched = {
      ...makeClip('z5', 0, 10),
      sourceRange: { startFrame: 0, durationFrames: 9 },
    }
    expect(insertClip(doc, 'V2', mismatched)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(5)
  })

  test('the stored clip is a deep copy — mutating the argument later is harmless', () => {
    const doc = makeDoc()
    const clip = makeClip('clipNew', 300, 40)
    clip.effects.push(fx('fx1'))
    const out = insertClip(doc, 'V2', clip)

    clip.timelineRange.startFrame = 999
    clip.transform.x = 999
    clip.effects[0].params.amount = 999

    const stored = clipIn(out, 'V2', 'clipNew')
    expect(stored.timelineRange.startFrame).toBe(300)
    expect(stored.transform.x).toBe(0)
    expect(stored.effects[0].params.amount).toBe(0.5)
  })

  test('result survives a JSON round-trip', () => {
    const out = insertClip(makeDoc(), 'V2', clipFromAsset(asset(), 0))
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  test('accepts canonical still geometry and rejects invented still source frames', () => {
    const doc = makeVideoDoc([])
    const still = makeStillClip('still', 10, 150)
    const inserted = insertClip(doc, 'V1', still)
    expect(clipIn(inserted, 'V1', 'still')).toMatchObject({
      sourceMode: 'still',
      sourceRange: { startFrame: 0, durationFrames: 1 },
      timelineRange: { startFrame: 10, durationFrames: 150 },
    })

    const malformed = {
      ...makeStillClip('bad-still', 200, 30),
      sourceRange: { startFrame: 1, durationFrames: 1 },
    }
    expect(insertClip(doc, 'V1', malformed)).toBe(doc)

    const unknownMode = {
      ...makeClip('bad-mode', 200, 30),
      sourceMode: 'animated',
    } as unknown as Clip
    expect(insertClip(doc, 'V1', unknownMode)).toBe(doc)

    const implicitMode = { ...makeClip('implicit-mode', 200, 30) }
    Reflect.deleteProperty(implicitMode, 'sourceMode')
    expect(insertClip(doc, 'V1', implicitMode as unknown as Clip)).toBe(doc)
  })
})

/* ------------------------------------------------------------------ */
/* slipClip                                                             */
/* ------------------------------------------------------------------ */

describe('slipClip', () => {
  test('shifts source material only; timeline placement is untouched', () => {
    const doc = makeDoc()
    const out = slipClip(doc, 'clipA', 25) // src [10,110) -> [35,135)
    const slipped = clipIn(out, 'V1', 'clipA')
    expect(slipped.sourceRange).toEqual({ startFrame: 35, durationFrames: 100 })
    expect(slipped.timelineRange).toEqual({ startFrame: 0, durationFrames: 100 })
    // Neighbors completely unaffected (same references — structural sharing).
    expect(clipIn(out, 'V1', 'clipB')).toBe(clipIn(doc, 'V1', 'clipB'))
    expect(out.tracks[2]).toBe(doc.tracks[2])
  })

  test('negative slip down to source frame 0 works; past it is rejected', () => {
    const doc = makeDoc()
    const out = slipClip(doc, 'clipA', -10) // src start 10 -> 0
    expect(clipIn(out, 'V1', 'clipA').sourceRange.startFrame).toBe(0)

    expect(slipClip(doc, 'clipA', -11)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('slip re-anchors durable keyframe source intent while keeping its timeline frame', () => {
    const base = makeDoc()
    const modern = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => track.id === 'V1'
        ? {
            ...track,
            clips: track.clips.map((clip) => clip.id === 'clipA'
              ? {
                  ...clip,
                  sourceTimeMap: defaultSourceTimeMap(10, 100),
                  animation: {
                    tracks: [{
                      property: 'opacity' as const,
                      keyframes: [{ frame: 5, value: 0.5, easing: { type: 'linear' as const } }],
                    }],
                  },
                }
              : clip),
          }
        : track),
    })

    const slipped = clipIn(slipClip(modern, 'clipA', 3), 'V1', 'clipA')
    expect(slipped.animation?.tracks[0].keyframes[0]).toMatchObject({
      frame: 5,
      sourceTimeTicks: 18_000_000,
    })
  })

  test('rejects non-integer deltas, unknown clips, and locked tracks', () => {
    const doc = makeDoc()
    expect(slipClip(doc, 'clipA', 1.5)).toBe(doc)
    expect(slipClip(doc, 'nope', 5)).toBe(doc)
    expect(slipClip(doc, 'clipE', 5)).toBe(doc) // VL is locked
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })
})

/* ------------------------------------------------------------------ */
/* slideClip                                                            */
/* ------------------------------------------------------------------ */

describe('slideClip', () => {
  // Fixture reminder: V1 = clipA [0,100) + clipB [100,150) touching,
  // then a gap, then clipC [200,260).

  test('sliding right extends the touching left neighbor; gap side just moves', () => {
    const doc = makeDoc()
    const out = slideClip(doc, 'clipB', 10)
    const a = clipIn(out, 'V1', 'clipA')
    const b = clipIn(out, 'V1', 'clipB')

    expect(b.timelineRange).toEqual({ startFrame: 110, durationFrames: 50 })
    expect(b.sourceRange).toBe(clipIn(doc, 'V1', 'clipB').sourceRange) // content untouched
    // A's tail grew to stay glued (timeline AND source duration).
    expect(a.timelineRange).toEqual({ startFrame: 0, durationFrames: 110 })
    expect(a.sourceRange.durationFrames).toBe(110)
    // C sits across the gap: same reference.
    expect(clipIn(out, 'V1', 'clipC')).toBe(clipIn(doc, 'V1', 'clipC'))
  })

  test('sliding left shrinks the touching left neighbor', () => {
    const doc = makeDoc()
    const out = slideClip(doc, 'clipB', -20)
    expect(clipIn(out, 'V1', 'clipA').timelineRange.durationFrames).toBe(80)
    expect(clipIn(out, 'V1', 'clipB').timelineRange.startFrame).toBe(80)
  })

  test('a touching RIGHT neighbor is head-trimmed in both directions', () => {
    const doc = makeDoc()
    const out = slideClip(doc, 'clipA', 10) // B touches A's tail
    const b = clipIn(out, 'V1', 'clipB')
    expect(clipIn(out, 'V1', 'clipA').timelineRange).toEqual({
      startFrame: 10,
      durationFrames: 100,
    })
    expect(b.timelineRange).toEqual({ startFrame: 110, durationFrames: 40 })
    expect(b.sourceRange).toEqual({ startFrame: 10, durationFrames: 40 })
  })

  test('rejects when a touching neighbor would vanish or lose source', () => {
    const doc = makeDoc()
    expect(slideClip(doc, 'clipB', -100)).toBe(doc) // A would hit 0 frames
    expect(slideClip(doc, 'clipA', 50)).toBe(doc) // B would hit 0 frames
    expect(slideClip(doc, 'clipA', -5)).toBe(doc) // B src would go below 0
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })

  test('rejects sliding across a gap INTO another clip, and before frame 0', () => {
    const doc = makeDoc()
    expect(slideClip(doc, 'clipB', 60)).toBe(doc) // B [160,210) vs C [200,260)
    expect(slideClip(doc, 'clipA', -1)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('rejects non-integer deltas, unknown clips, and locked tracks', () => {
    const doc = makeDoc()
    expect(slideClip(doc, 'clipB', 0.5)).toBe(doc)
    expect(slideClip(doc, 'nope', 5)).toBe(doc)
    expect(slideClip(doc, 'clipE', 5)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })
})

/* ------------------------------------------------------------------ */
/* rippleTrim                                                           */
/* ------------------------------------------------------------------ */

describe('rippleTrim', () => {
  test("'end' shortening pulls every downstream clip left; gaps are preserved", () => {
    const doc = makeDoc()
    const out = rippleTrim(doc, 'clipA', 'end', -20)
    expect(clipIn(out, 'V1', 'clipA').timelineRange).toEqual({
      startFrame: 0,
      durationFrames: 80,
    })
    expect(clipIn(out, 'V1', 'clipA').sourceRange.durationFrames).toBe(80)
    expect(clipIn(out, 'V1', 'clipB').timelineRange.startFrame).toBe(80)
    // B->C gap was 50 frames (150..200) and still is (130..180).
    expect(clipIn(out, 'V1', 'clipC').timelineRange.startFrame).toBe(180)
  })

  test("'end' lengthening pushes downstream right; earlier clips untouched", () => {
    const doc = makeDoc()
    const out = rippleTrim(doc, 'clipB', 'end', 30)
    expect(clipIn(out, 'V1', 'clipA')).toBe(clipIn(doc, 'V1', 'clipA'))
    expect(clipIn(out, 'V1', 'clipB').timelineRange.durationFrames).toBe(80)
    expect(clipIn(out, 'V1', 'clipB').sourceRange.durationFrames).toBe(80)
    expect(clipIn(out, 'V1', 'clipC').timelineRange.startFrame).toBe(230)
  })

  test("'start' trim keeps the clip head in place and closes downstream", () => {
    const doc = makeDoc()
    const out = rippleTrim(doc, 'clipB', 'start', 30) // cut 30 frames of material
    const b = clipIn(out, 'V1', 'clipB')
    expect(b.timelineRange).toEqual({ startFrame: 100, durationFrames: 20 })
    expect(b.sourceRange).toEqual({ startFrame: 30, durationFrames: 20 })
    expect(clipIn(out, 'V1', 'clipC').timelineRange.startFrame).toBe(170)
    expect(clipIn(out, 'V1', 'clipA')).toBe(clipIn(doc, 'V1', 'clipA'))
  })

  test("'start' extension restores head material when the source allows it", () => {
    const doc = makeDoc()
    const out = rippleTrim(doc, 'clipA', 'start', -10) // src starts at 10
    const a = clipIn(out, 'V1', 'clipA')
    expect(a.timelineRange).toEqual({ startFrame: 0, durationFrames: 110 })
    expect(a.sourceRange).toEqual({ startFrame: 0, durationFrames: 110 })
    expect(clipIn(out, 'V1', 'clipB').timelineRange.startFrame).toBe(110)
    expect(clipIn(out, 'V1', 'clipC').timelineRange.startFrame).toBe(210)

    expect(rippleTrim(doc, 'clipB', 'start', -1)).toBe(doc) // B's src starts at 0
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('rejects shrinking to zero frames from either edge', () => {
    const doc = makeDoc()
    expect(rippleTrim(doc, 'clipA', 'end', -100)).toBe(doc)
    expect(rippleTrim(doc, 'clipA', 'start', 100)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('rejects non-integer deltas, unknown clips, and locked tracks', () => {
    const doc = makeDoc()
    expect(rippleTrim(doc, 'clipA', 'end', 0.5)).toBe(doc)
    expect(rippleTrim(doc, 'nope', 'end', 5)).toBe(doc)
    expect(rippleTrim(doc, 'clipE', 'end', 5)).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })

  test('other tracks keep their references (structural sharing)', () => {
    const doc = makeDoc()
    const out = rippleTrim(doc, 'clipA', 'end', -20)
    expect(out.tracks[1]).toBe(doc.tracks[1])
    expect(out.tracks[2]).toBe(doc.tracks[2])
  })
})

describe('still-source editing semantics', () => {
  test('razor halves both retain source frame 0 while partitioning timeline duration', () => {
    const doc = makeVideoDoc([makeStillClip('still', 10, 100)])
    const out = splitClipAtFrame(doc, 'still', 45)
    const [left, right] = clipsOf(out, 'V1')

    expect(left.timelineRange).toEqual({ startFrame: 10, durationFrames: 35 })
    expect(right.timelineRange).toEqual({ startFrame: 45, durationFrames: 65 })
    expect(left.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(right.sourceRange).toEqual({ startFrame: 0, durationFrames: 1 })
    expect(left.sourceMode).toBe('still')
    expect(right.sourceMode).toBe('still')
  })

  test('plain trims freely extend either edge without changing the still source', () => {
    const doc = makeVideoDoc([makeStillClip('still', 100, 50)])
    const extendedStart = trimClip(doc, 'still', 'start', -25)
    expect(clipIn(extendedStart, 'V1', 'still')).toMatchObject({
      timelineRange: { startFrame: 75, durationFrames: 75 },
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })

    const extendedEnd = trimClip(extendedStart, 'still', 'end', 500)
    expect(clipIn(extendedEnd, 'V1', 'still')).toMatchObject({
      timelineRange: { startFrame: 75, durationFrames: 575 },
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })
  })

  test('ripple trims change timeline geometry and downstream positions only', () => {
    const downstream = makeClip('downstream', 100, 20)
    const doc = makeVideoDoc([makeStillClip('still', 0, 50), downstream])

    const endExtended = rippleTrim(doc, 'still', 'end', 30)
    expect(clipIn(endExtended, 'V1', 'still')).toMatchObject({
      timelineRange: { startFrame: 0, durationFrames: 80 },
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })
    expect(clipIn(endExtended, 'V1', 'downstream').timelineRange.startFrame).toBe(130)

    const startExtended = rippleTrim(doc, 'still', 'start', -25)
    expect(clipIn(startExtended, 'V1', 'still')).toMatchObject({
      timelineRange: { startFrame: 0, durationFrames: 75 },
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })
    expect(clipIn(startExtended, 'V1', 'downstream').timelineRange.startFrame).toBe(125)
  })

  test('slip is a silent same-reference no-op, including on a locked still track', () => {
    const doc = makeVideoDoc([makeStillClip('still', 0, 50)])
    expect(slipClip(doc, 'still', 20)).toBe(doc)
    expect(warnSpy).not.toHaveBeenCalled()

    const locked = deepFreeze({
      ...doc,
      tracks: [{ ...doc.tracks[0], locked: true }],
    })
    expect(slipClip(locked, 'still', 20)).toBe(locked)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('slide preserves canonical source geometry for touching still neighbors', () => {
    const target = makeClip('target', 50, 20)
    const doc = makeVideoDoc([
      makeStillClip('left-still', 0, 50),
      target,
      makeStillClip('right-still', 70, 30),
    ])
    const out = slideClip(doc, 'target', 5)

    expect(clipIn(out, 'V1', 'left-still')).toMatchObject({
      timelineRange: { startFrame: 0, durationFrames: 55 },
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })
    expect(clipIn(out, 'V1', 'target')).toMatchObject({
      timelineRange: { startFrame: 55, durationFrames: 20 },
      sourceRange: target.sourceRange,
    })
    expect(clipIn(out, 'V1', 'right-still')).toMatchObject({
      timelineRange: { startFrame: 75, durationFrames: 25 },
      sourceRange: { startFrame: 0, durationFrames: 1 },
    })
  })
})

/* ------------------------------------------------------------------ */
/* Crossfade authoring + lifecycle (Phase 5.1e-1)                      */
/* ------------------------------------------------------------------ */

function crossfade(
  id: string,
  fromClipId: string,
  toClipId: string,
  durationFrames: number,
): Transition {
  return {
    id,
    type: 'crossfade',
    fromClipId,
    toClipId,
    durationFrames,
    audio: { enabled: true, curve: 'equal-power' },
  }
}

function makeCrossfadeDoc(
  clips: Clip[],
  transitions: Transition[] = [],
  extraTracks: Track[] = [makeTrack('V2', 'video', [])],
  locked = false,
): TimelineDoc {
  return deepFreeze({
    schemaVersion: 19,
    id: 'crossfade-doc',
    name: 'Crossfade lifecycle',
    frameRate: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    tracks: [
      {
        ...makeTrack('V1', 'video', clips, locked),
        transitions,
      },
      ...extraTracks,
    ],
  })
}

function transitionsOf(doc: TimelineDoc, trackId = 'V1'): Transition[] {
  const track = doc.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`no track ${trackId}`)
  return track.transitions
}

function authoredPair(durationFrames = 5): TimelineDoc {
  const doc = makeCrossfadeDoc([
    makeClip('A', 0, 10),
    makeClip('B', 10, 10),
  ])
  return deepFreeze(addCrossfade(doc, 'A', 'B', durationFrames))
}

function authoredTriple(durationFrames = 5): TimelineDoc {
  const doc = makeCrossfadeDoc([
    makeClip('A', 0, 10),
    makeClip('B', 10, 10),
    makeClip('C', 20, 10),
  ])
  const withLeft = addCrossfade(doc, 'A', 'B', durationFrames)
  return deepFreeze(addCrossfade(withLeft, 'B', 'C', durationFrames))
}

describe('crossfade authoring', () => {
  test('handle-aware add and duration changes reject with the same reference', () => {
    const doc = makeCrossfadeDoc([
      makeClip('A', 0, 10, 0),
      makeClip('B', 10, 10, 10),
    ])
    const bounds = new Map([[
      'asset-1',
      {
        video: {
          status: 'exact' as const,
          firstTimestampUs: 233_333,
          endTimestampUs: 466_666,
        },
        audio: null,
      },
    ]])

    expect(addCrossfadeWithSourceBounds(doc, 'A', 'B', 8, bounds)).toBe(doc)
    const added = addCrossfadeWithSourceBounds(doc, 'A', 'B', 7, bounds)
    expect(added).not.toBe(doc)
    const authored = transitionsOf(added)[0]
    expect(authored.durationFrames).toBe(7)
    expect(setCrossfadeDurationWithSourceBounds(
      added,
      'V1',
      authored.id,
      8,
      bounds,
    )).toBe(added)

    const settings = {
      durationFrames: 5,
      audio: { enabled: false, curve: 'linear' as const },
    }
    const updated = setCrossfadeSettingsWithSourceBounds(
      added,
      'V1',
      authored.id,
      settings,
      bounds,
    )
    expect(updated).not.toBe(added)
    expect(transitionsOf(updated)[0]).toEqual({
      ...authored,
      ...settings,
    })
    expect(transitionsOf(added)[0].audio).toEqual({
      enabled: true,
      curve: 'equal-power',
    })
    expect(setCrossfadeSettings(
      updated,
      'V1',
      authored.id,
      settings,
    )).toBe(updated)
  })

  test('adds ordered seam metadata with a fresh id and preserves structural sharing', () => {
    const doc = makeCrossfadeDoc([
      makeClip('A', 0, 10),
      makeClip('B', 10, 10),
      makeClip('C', 20, 10),
    ])

    const withLeft = deepFreeze(addCrossfade(doc, 'A', 'B', 5))
    const left = transitionsOf(withLeft)[0]
    expect(left).toEqual({
      id: expect.stringMatching(/^transition_/),
      type: 'crossfade',
      fromClipId: 'A',
      toClipId: 'B',
      durationFrames: 5,
      audio: { enabled: true, curve: 'equal-power' },
    })

    const withBoth = addCrossfade(withLeft, 'B', 'C', 5)
    expect(transitionsOf(withBoth)).toHaveLength(2)
    expect(transitionsOf(withBoth)[1].id).not.toBe(left.id)
    expect(transitionsOf(doc)).toEqual([])
    expect(withBoth.tracks[1]).toBe(doc.tracks[1])
  })

  test('requires an ordered touching video seam with editable media endpoints', () => {
    const textClip: Clip = {
      ...makeClip('text', 40, 10),
      text: {
        ...defaultTextProps(1920, 1080),
        content: 'Title',
        fontFamily: 'sans-serif',
        fontSizePx: 48,
        color: '#ffffff',
        align: 'center',
        bold: false,
        italic: false,
      },
    }
    const doc = makeCrossfadeDoc(
      [
        makeClip('A', 0, 10),
        makeClip('B', 10, 10),
        makeClip('gap', 30, 10),
        textClip,
      ],
      [],
      [
        makeTrack('V2', 'video', [makeClip('other', 0, 10)]),
        makeTrack('A1', 'audio', [
          makeClip('audioA', 0, 10),
          makeClip('audioB', 10, 10),
        ]),
        makeTrack('VL', 'video', [
          makeClip('lockedA', 0, 10),
          makeClip('lockedB', 10, 10),
        ], true),
      ],
    )

    const rejected = [
      addCrossfade(doc, 'A', 'missing', 5),
      addCrossfade(doc, 'A', 'A', 5),
      addCrossfade(doc, 'B', 'A', 5),
      addCrossfade(doc, 'A', 'other', 5),
      addCrossfade(doc, 'audioA', 'audioB', 5),
      addCrossfade(doc, 'B', 'gap', 5),
      addCrossfade(doc, 'gap', 'text', 5),
      addCrossfade(doc, 'lockedA', 'lockedB', 5),
    ]

    for (const result of rejected) expect(result).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(rejected.length)
  })

  test('uses the centered odd/even fit rule and rejects unsafe durations', () => {
    // D=5 needs floor(5/2)=2 outgoing frames and ceil(5/2)=3 incoming.
    const exact = makeCrossfadeDoc([
      makeClip('A', 0, 2),
      makeClip('B', 2, 3),
    ])
    expect(transitionsOf(addCrossfade(exact, 'A', 'B', 5))).toHaveLength(1)
    expect(addCrossfade(exact, 'A', 'B', 6)).toBe(exact)

    const minimal = makeCrossfadeDoc([
      makeClip('oneA', 0, 1),
      makeClip('oneB', 1, 1),
    ])
    expect(transitionsOf(addCrossfade(minimal, 'oneA', 'oneB', 1))).toHaveLength(1)

    for (const duration of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(addCrossfade(exact, 'A', 'B', duration)).toBe(exact)
    }
  })

  test('allows half-open transition windows to touch but rejects duplicates and overlap', () => {
    // A->B is [8,13); B->C is [13,18): exact half-open contact is valid.
    const touching = makeCrossfadeDoc([
      makeClip('A', 0, 10),
      makeClip('B', 10, 5),
      makeClip('C', 15, 10),
    ])
    const touchingLeft = deepFreeze(addCrossfade(touching, 'A', 'B', 5))
    const touchingBoth = addCrossfade(touchingLeft, 'B', 'C', 5)
    expect(transitionsOf(touchingBoth)).toHaveLength(2)
    expect(addCrossfade(touchingLeft, 'A', 'B', 5)).toBe(touchingLeft)

    // With a 4-frame B, the individually fitting windows overlap at frame 12.
    const overlapping = makeCrossfadeDoc([
      makeClip('A', 0, 10),
      makeClip('B', 10, 4),
      makeClip('C', 14, 10),
    ])
    const overlappingLeft = deepFreeze(addCrossfade(overlapping, 'A', 'B', 5))
    expect(addCrossfade(overlappingLeft, 'B', 'C', 5)).toBe(overlappingLeft)
  })

  test('updates duration in place, preserves identity, and is idempotent', () => {
    const added = authoredPair(3)
    const original = transitionsOf(added)[0]
    const updated = deepFreeze(setCrossfadeDuration(added, 'V1', original.id, 5))

    expect(transitionsOf(updated)).toEqual([
      { ...original, durationFrames: 5 },
    ])
    expect(transitionsOf(updated)[0].id).toBe(original.id)
    expect(setCrossfadeDuration(updated, 'V1', original.id, 5)).toBe(updated)
    expect(setCrossfadeDuration(updated, 'V1', 'missing', 5)).toBe(updated)
    expect(setCrossfadeDuration(updated, 'V1', original.id, 21)).toBe(updated)
    expect(setCrossfadeDuration(updated, 'V1', original.id, 2.5)).toBe(updated)

    // An explicit transition edit may repair a stale duration; geometry edits may not.
    const stale = makeCrossfadeDoc(
      [makeClip('staleA', 0, 10), makeClip('staleB', 10, 10)],
      [crossfade('stale', 'staleA', 'staleB', 21)],
    )
    expect(transitionsOf(setCrossfadeDuration(stale, 'V1', 'stale', 5))).toEqual([
      crossfade('stale', 'staleA', 'staleB', 5),
    ])
  })

  test('duration updates reject overlap but accept exact half-open contact', () => {
    const doc = makeCrossfadeDoc([
      makeClip('A', 0, 10),
      makeClip('B', 10, 5),
      makeClip('C', 15, 10),
    ])
    const left = addCrossfade(doc, 'A', 'B', 3)
    const both = deepFreeze(addCrossfade(left, 'B', 'C', 3))
    const leftId = transitionsOf(both)[0].id

    // D=8 ends at 14, before B->C's [14,17); D=9 overlaps frame 14.
    const touching = deepFreeze(setCrossfadeDuration(both, 'V1', leftId, 8))
    expect(transitionsOf(touching)[0].durationFrames).toBe(8)
    expect(setCrossfadeDuration(both, 'V1', leftId, 9)).toBe(both)
  })

  test('removes exactly one transition and honors track locking', () => {
    const doc = authoredTriple()
    const [left, right] = transitionsOf(doc)
    const removed = removeTransition(doc, 'V1', left.id)

    expect(transitionsOf(removed)).toHaveLength(1)
    expect(transitionsOf(removed)[0]).toBe(right)
    expect(removed.tracks[1]).toBe(doc.tracks[1])
    expect(removeTransition(doc, 'V1', 'missing')).toBe(doc)

    const locked = deepFreeze(setTrackFlags(doc, 'V1', { locked: true }))
    expect(removeTransition(locked, 'V1', left.id)).toBe(locked)
    expect(setCrossfadeDuration(locked, 'V1', left.id, 3)).toBe(locked)

    const stale = makeCrossfadeDoc(
      [makeClip('staleA', 0, 10), makeClip('staleB', 20, 10)],
      [crossfade('stale', 'staleA', 'staleB', 5)],
    )
    expect(transitionsOf(removeTransition(stale, 'V1', 'stale'))).toEqual([])
  })

  test('scopes transition ids to their owning track', () => {
    const sharedId = 'shared-transition-id'
    const secondTrack: Track = {
      ...makeTrack('V2', 'video', [
        makeClip('X', 0, 10),
        makeClip('Y', 10, 10),
      ]),
      transitions: [crossfade(sharedId, 'X', 'Y', 3)],
    }
    const doc = makeCrossfadeDoc(
      [makeClip('A', 0, 10), makeClip('B', 10, 10)],
      [crossfade(sharedId, 'A', 'B', 3)],
      [secondTrack],
    )

    const updated = setCrossfadeDuration(doc, 'V2', sharedId, 5)
    expect(transitionsOf(updated, 'V1')[0].durationFrames).toBe(3)
    expect(transitionsOf(updated, 'V2')[0].durationFrames).toBe(5)

    const removed = removeTransition(updated, 'V1', sharedId)
    expect(transitionsOf(removed, 'V1')).toEqual([])
    expect(transitionsOf(removed, 'V2')).toEqual([
      crossfade(sharedId, 'X', 'Y', 5),
    ])
  })

  test('drops corrupt same-track duplicate ids and rejects ambiguous id edits', () => {
    const duplicateId = 'duplicate-on-v1'
    const doc = makeCrossfadeDoc(
      [
        makeClip('A', 0, 10),
        makeClip('B', 10, 10),
        makeClip('C', 20, 10),
        makeClip('D', 30, 10),
      ],
      [
        crossfade(duplicateId, 'A', 'B', 3),
        crossfade(duplicateId, 'C', 'D', 3),
      ],
    )

    expect(removeTransition(doc, 'V1', duplicateId)).toBe(doc)
    expect(setCrossfadeDuration(doc, 'V1', duplicateId, 5)).toBe(doc)
    expect(transitionsOf(trimClip(doc, 'B', 'end', -1))).toEqual([])
  })
})

describe('crossfade geometry lifecycle', () => {
  test('trim keeps exact-fit outer edges and drops too-short or disconnected seams', () => {
    const doc = authoredPair()
    const transition = transitionsOf(doc)[0]

    expect(transitionsOf(trimClip(doc, 'A', 'start', 8))[0]).toBe(transition)
    expect(transitionsOf(trimClip(doc, 'A', 'start', 9))).toEqual([])
    expect(transitionsOf(trimClip(doc, 'B', 'end', -7))[0]).toBe(transition)
    expect(transitionsOf(trimClip(doc, 'B', 'end', -8))).toEqual([])
    expect(transitionsOf(trimClip(doc, 'A', 'end', -1))).toEqual([])
    expect(transitionsOf(trimClip(doc, 'B', 'start', 1))).toEqual([])

    // Geometry rejection is still atomic, including transition metadata.
    expect(trimClip(doc, 'A', 'end', 1)).toBe(doc)
  })

  test('move drops transitions on moved endpoints and retains unrelated valid seams', () => {
    const base = makeCrossfadeDoc([
      makeClip('A', 0, 10),
      makeClip('B', 10, 10),
      makeClip('unrelated', 40, 5),
    ])
    const doc = deepFreeze(addCrossfade(base, 'A', 'B', 5))
    const transition = transitionsOf(doc)[0]

    expect(transitionsOf(moveClip(doc, 'A', 'V1', 30))).toEqual([])
    expect(transitionsOf(moveClip(doc, 'B', 'V1', 20))).toEqual([])
    expect(transitionsOf(moveClip(doc, 'A', 'V2', 0))).toEqual([])
    expect(transitionsOf(moveClip(doc, 'unrelated', 'V1', 50))[0]).toBe(transition)
    expect(transitionsOf(moveClip(doc, 'A', 'V1', 0))[0]).toBe(transition)
  })

  test('split rebinds an outgoing seam to its new right half at the exact fit boundary', () => {
    const doc = authoredPair()
    const transition = transitionsOf(doc)[0]
    const retained = splitClipAtFrame(doc, 'A', 8)
    const right = clipsOf(retained, 'V1').find(
      (clip) => clip.id !== 'A' && clip.timelineRange.startFrame === 8,
    )
    expect(right).toBeDefined()
    expect(transitionsOf(retained)).toEqual([
      { ...transition, fromClipId: right?.id },
    ])
    expect(transitionsOf(retained)[0].id).toBe(transition.id)
    expect(transitionsOf(splitClipAtFrame(doc, 'A', 9))).toEqual([])
  })

  test('split keeps an incoming left half only while its transition window fits', () => {
    const doc = authoredPair()
    const transition = transitionsOf(doc)[0]
    const retained = splitClipAtFrame(doc, 'B', 13)
    expect(transitionsOf(retained)[0]).toBe(transition)
    expect(transitionsOf(retained)[0].toClipId).toBe('B')
    expect(transitionsOf(splitClipAtFrame(doc, 'B', 12))).toEqual([])
  })

  test('splitting a middle clip preserves both outer seams with asymmetric id inheritance', () => {
    const doc = authoredTriple()
    const [leftTransition, rightTransition] = transitionsOf(doc)
    const out = splitClipAtFrame(doc, 'B', 15)
    const newRight = clipsOf(out, 'V1').find(
      (clip) => clip.id !== 'B' && clip.timelineRange.startFrame === 15,
    )

    expect(newRight).toBeDefined()
    expect(transitionsOf(out)).toEqual([
      leftTransition,
      { ...rightTransition, fromClipId: newRight?.id },
    ])
    expect(transitionsOf(out)).toHaveLength(2) // no invented transition at the split
  })

  test('ripple delete drops only removed-endpoint transitions and never invents a new seam', () => {
    const doc = authoredTriple()
    const [, right] = transitionsOf(doc)

    const middleDeleted = rippleDelete(doc, 'B')
    expect(clipsOf(middleDeleted, 'V1').map((clip) => clip.id)).toEqual(['A', 'C'])
    expect(rangeEnd(clipsOf(middleDeleted, 'V1')[0].timelineRange)).toBe(
      clipsOf(middleDeleted, 'V1')[1].timelineRange.startFrame,
    )
    expect(transitionsOf(middleDeleted)).toEqual([])

    const firstDeleted = rippleDelete(doc, 'A')
    expect(transitionsOf(firstDeleted)).toEqual([right])
  })

  test('ripple trim retains exact-fit seams and drops a transition one frame past fit', () => {
    const doc = authoredPair()
    const transition = transitionsOf(doc)[0]

    expect(transitionsOf(rippleTrim(doc, 'A', 'end', -8))[0]).toBe(transition)
    expect(transitionsOf(rippleTrim(doc, 'A', 'end', -9))).toEqual([])
    expect(transitionsOf(rippleTrim(doc, 'B', 'start', 7))[0]).toBe(transition)
    expect(transitionsOf(rippleTrim(doc, 'B', 'start', 8))).toEqual([])
  })

  test('ripple trim keeps touching windows and drops every member of an overlap', () => {
    const doc = authoredTriple()

    // B becomes 5 frames: [8,13) and [13,18) merely touch.
    expect(transitionsOf(rippleTrim(doc, 'B', 'start', 5))).toHaveLength(2)
    // B becomes 4 frames: [8,13) and [12,17) overlap, so both fail closed.
    expect(transitionsOf(rippleTrim(doc, 'B', 'start', 6))).toEqual([])
  })

  test('slide follows the same exact-contact versus overlap rule', () => {
    const base = makeCrossfadeDoc([
      makeClip('P', 0, 10),
      makeClip('A', 10, 10),
      makeClip('B', 20, 10),
    ])
    const withLeft = addCrossfade(base, 'P', 'A', 5)
    const doc = deepFreeze(addCrossfade(withLeft, 'A', 'B', 5))

    // Sliding B left by 5 leaves A 5 frames long: windows touch at 13.
    expect(transitionsOf(slideClip(doc, 'B', -5))).toHaveLength(2)
    // One frame further leaves two individually fitting, overlapping windows.
    expect(transitionsOf(slideClip(doc, 'B', -6))).toEqual([])
  })

  test('slip preserves transitions, while track removal owns their lifetime', () => {
    const doc = authoredTriple()
    const slipped = slipClip(doc, 'B', 3)
    expect(transitionsOf(slipped)).toBe(transitionsOf(doc))
    expect(slipClip(doc, 'B', Number.MAX_SAFE_INTEGER)).toBe(doc)

    const unrelatedRemoved = removeTrack(doc, 'V2')
    expect(unrelatedRemoved.tracks[0]).toBe(doc.tracks[0])
    expect(transitionsOf(unrelatedRemoved)).toBe(transitionsOf(doc))

    expect(removeTrack(doc, 'V1').tracks.some((track) => track.id === 'V1')).toBe(false)
    const locked = deepFreeze(setTrackFlags(doc, 'V1', { locked: true }))
    expect(removeTrack(locked, 'V1')).toBe(locked)
  })

  test('never resurrects a stale transition when geometry happens to repair it', () => {
    const gap = makeCrossfadeDoc(
      [makeClip('A', 0, 10), makeClip('B', 20, 10)],
      [crossfade('stale-gap', 'A', 'B', 5)],
    )
    expect(transitionsOf(moveClip(gap, 'B', 'V1', 10))).toEqual([])

    const tooLong = makeCrossfadeDoc(
      [makeClip('A', 0, 2), makeClip('B', 2, 1)],
      [crossfade('stale-duration', 'A', 'B', 5)],
    )
    expect(transitionsOf(rippleTrim(tooLong, 'B', 'end', 2))).toEqual([])

    const ambiguous = makeCrossfadeDoc(
      [makeClip('P', 0, 10), makeClip('A', 10, 4), makeClip('B', 14, 10)],
      [
        crossfade('stale-left', 'P', 'A', 5),
        crossfade('stale-right', 'A', 'B', 5),
      ],
    )
    // Sliding B right separates the windows, but explicit authoring is still required.
    expect(transitionsOf(slideClip(ambiguous, 'B', 1))).toEqual([])

    const unsafeSource = {
      ...makeClip('unsafeA', 0, 10),
      sourceRange: {
        startFrame: Number.MAX_SAFE_INTEGER,
        durationFrames: 10,
      },
    }
    const staleSource = makeCrossfadeDoc(
      [unsafeSource, makeClip('unsafeB', 10, 10)],
      [crossfade('stale-source', 'unsafeA', 'unsafeB', 5)],
    )
    const repairedSource = slipClip(
      staleSource,
      'unsafeA',
      -Number.MAX_SAFE_INTEGER,
    )
    expect(clipIn(repairedSource, 'V1', 'unsafeA').sourceRange.startFrame).toBe(0)
    expect(transitionsOf(repairedSource)).toEqual([])
  })

  test('authored and edited transitions remain serializable without mutating frozen inputs', () => {
    const doc = makeCrossfadeDoc([makeClip('A', 0, 10), makeClip('B', 10, 10)])
    const added = deepFreeze(addCrossfade(doc, 'A', 'B', 3))
    const id = transitionsOf(added)[0].id
    const updated = deepFreeze(setCrossfadeDuration(added, 'V1', id, 5))
    const removed = removeTransition(updated, 'V1', id)

    expect(JSON.parse(JSON.stringify(updated))).toEqual(updated)
    expect(JSON.parse(JSON.stringify(removed))).toEqual(removed)
    expect(transitionsOf(doc)).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* updateClipTransform                                                  */
/* ------------------------------------------------------------------ */

describe('updateClipTransform', () => {
  test('merges a partial transform; untouched fields and ranges survive', () => {
    const doc = makeDoc()
    const out = updateClipTransform(doc, 'clipA', {
      transform: { x: 40, rotation: 15 },
    })
    const clip = clipIn(out, 'V1', 'clipA')
    expect(clip.transform).toEqual({
      x: 40,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 15,
      anchorX: 0.5,
      anchorY: 0.5,
    })
    expect(clip.opacity).toBe(1) // untouched
    expect(clip.timelineRange).toBe(clipIn(doc, 'V1', 'clipA').timelineRange)
    expect(out.tracks[2]).toBe(doc.tracks[2]) // structural sharing
  })

  test('opacity is clamped into [0,1], alone or alongside a transform', () => {
    const doc = makeDoc()
    expect(clipIn(updateClipTransform(doc, 'clipA', { opacity: 1.7 }), 'V1', 'clipA').opacity).toBe(1)
    expect(clipIn(updateClipTransform(doc, 'clipA', { opacity: -0.3 }), 'V1', 'clipA').opacity).toBe(0)
    const both = updateClipTransform(doc, 'clipA', { transform: { scaleX: 2 }, opacity: 0.5 })
    expect(clipIn(both, 'V1', 'clipA').opacity).toBe(0.5)
    expect(clipIn(both, 'V1', 'clipA').transform.scaleX).toBe(2)
  })

  test('rejects non-finite numbers — NaN/Infinity never enter the doc', () => {
    const doc = makeDoc()
    expect(updateClipTransform(doc, 'clipA', { transform: { x: Number.NaN } })).toBe(doc)
    expect(updateClipTransform(doc, 'clipA', { transform: { scaleY: 1 / 0 } })).toBe(doc)
    expect(updateClipTransform(doc, 'clipA', { opacity: Number.NaN })).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })

  test('rejects empty patches, unknown clips, and locked tracks', () => {
    const doc = makeDoc()
    expect(updateClipTransform(doc, 'clipA', {})).toBe(doc)
    expect(updateClipTransform(doc, 'nope', { opacity: 1 })).toBe(doc)
    expect(updateClipTransform(doc, 'clipE', { opacity: 1 })).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })
})

/* ------------------------------------------------------------------ */
/* Issue #34 clip Inspector mutations                                  */
/* ------------------------------------------------------------------ */

describe('updateClipVisual', () => {
  test('commits transform, opacity, crop, flips, and scale lock atomically', () => {
    const doc = makeDoc()
    const out = updateClipVisual(doc, 'clipA', {
      transform: { x: 32, scaleX: 1.5 },
      opacity: 0.65,
      visual: {
        crop: { left: 0.1, top: 0.2 },
        flipHorizontal: true,
      },
    })
    const clip = clipIn(out, 'V1', 'clipA')

    expect(clip.transform).toMatchObject({ x: 32, scaleX: 1.5, scaleY: 1.5 })
    expect(clip.opacity).toBe(0.65)
    expect(clip.visual).toEqual({
      crop: { left: 0.1, right: 0, top: 0.2, bottom: 0 },
      flipHorizontal: true,
      flipVertical: false,
      scaleLocked: true,
    })
    expect(out.tracks[1]).toBe(doc.tracks[1])
  })

  test('locking unequal scales makes X authoritative, then either scale edits both', () => {
    const doc = updateClipVisual(makeDoc(), 'clipA', {
      transform: { scaleX: 2, scaleY: 3 },
      visual: { scaleLocked: false },
    })
    const locked = updateClipVisual(doc, 'clipA', { visual: { scaleLocked: true } })
    expect(clipIn(locked, 'V1', 'clipA').transform).toMatchObject({ scaleX: 2, scaleY: 2 })

    const resized = updateClipVisual(locked, 'clipA', { transform: { scaleY: 4 } })
    expect(clipIn(resized, 'V1', 'clipA').transform).toMatchObject({ scaleX: 4, scaleY: 4 })
  })

  test('rejects invalid crop, scale, anchors, unknown nested fields, and locked tracks', () => {
    const doc = makeDoc()
    expect(updateClipVisual(doc, 'clipA', { visual: { crop: { left: 0.6, right: 0.5 } } })).toBe(doc)
    expect(updateClipVisual(doc, 'clipA', { transform: { scaleX: -1 } })).toBe(doc)
    expect(updateClipVisual(doc, 'clipA', { transform: { anchorY: 1.1 } })).toBe(doc)
    expect(updateClipVisual(doc, 'clipA', {
      visual: { crop: { diagonal: 0.2 } as never },
    })).toBe(doc)
    expect(updateClipVisual(doc, 'clipE', { opacity: 0.5 })).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(5)
  })

  test('an idempotent patch is a same-reference no-op', () => {
    const doc = makeDoc()
    expect(updateClipVisual(doc, 'clipA', {
      transform: { x: 0 },
      opacity: 1,
      visual: { flipHorizontal: false },
    })).toBe(doc)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('updateClipAudio', () => {
  test('commits gain, enabled state, balance, and frame fades atomically', () => {
    const doc = makeDoc()
    const out = updateClipAudio(doc, 'clipD', {
      volume: 0.75,
      audio: { enabled: false, balance: 0.4, fadeInFrames: 12, fadeOutFrames: 18 },
    })
    const clip = clipIn(out, 'A1', 'clipD')

    expect(clip.volume).toBe(0.75)
    expect(clip.audio).toEqual({
      enabled: false,
      balance: 0.4,
      fadeInFrames: 12,
      fadeOutFrames: 18,
    })
    expect(out.tracks[0]).toBe(doc.tracks[0])
  })

  test('rejects invalid balance or fades and preserves idempotent history inputs', () => {
    const doc = makeDoc()
    expect(updateClipAudio(doc, 'clipD', { audio: { balance: 1.1 } })).toBe(doc)
    expect(updateClipAudio(doc, 'clipD', { audio: { fadeInFrames: 81 } })).toBe(doc)
    expect(updateClipAudio(doc, 'clipD', { audio: { fadeOutFrames: 0.5 } })).toBe(doc)
    expect(updateClipAudio(doc, 'clipE', { audio: { enabled: false } })).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(4)

    const unchanged = updateClipAudio(doc, 'clipD', {
      volume: 1,
      audio: { enabled: true, balance: 0, fadeInFrames: 0, fadeOutFrames: 0 },
    })
    expect(unchanged).toBe(doc)
  })

  test('duration edits clamp authored fades on both sides of a split', () => {
    const authored = updateClipAudio(makeDoc(), 'clipA', {
      audio: { fadeInFrames: 90, fadeOutFrames: 80 },
    })
    const out = splitClipAtFrame(authored, 'clipA', 40)
    const [left, right] = out.tracks[0].clips

    expect(left.timelineRange.durationFrames).toBe(40)
    expect(left.audio).toMatchObject({ fadeInFrames: 40, fadeOutFrames: 40 })
    expect(right.timelineRange.durationFrames).toBe(60)
    expect(right.audio).toMatchObject({ fadeInFrames: 60, fadeOutFrames: 60 })
  })

  test('keys volume at the playhead once that track is animated', () => {
    const doc = makeDoc()
    const animated = setClipKeyframe(doc, 'clipD', 'volume', {
      frame: 0,
      value: 1,
      easing: { type: 'linear' },
    })
    const keyed = updateClipAudioAtFrame(animated, 'clipD', 10, { volume: 0.25 })
    const clip = clipIn(keyed, 'A1', 'clipD')

    expect(clip.volume).toBe(1)
    expect(clip.animation?.tracks).toEqual([
      expect.objectContaining({
        property: 'volume',
        keyframes: expect.arrayContaining([
          expect.objectContaining({ frame: 0, value: 1 }),
          expect.objectContaining({ frame: 10, value: 0.25 }),
        ]),
      }),
    ])
    expect(updateClipAudioAtFrame(animated, 'clipD', 10_000, { volume: 0.5 }))
      .toBe(animated)
  })
})

/* ------------------------------------------------------------------ */
/* addTrack (timeline header upgrade)                                   */
/* ------------------------------------------------------------------ */

describe('addTrack', () => {
  // Fixture reminder: tracks = [V1, V2, A1, VL] — VL is a video track, so
  // videos are NOT contiguous; "after the LAST video" means after VL.

  test('adds an empty video track with the next free V number, after the last video', () => {
    const doc = makeDoc()
    const out = addTrack(doc, 'video')
    expect(out.tracks.map((t) => t.id)).toEqual(['V1', 'V2', 'A1', 'VL', 'V3'])
    const added = out.tracks[4]
    expect(added).toEqual({
      id: 'V3',
      kind: 'video',
      name: 'V3',
      clips: [],
      sequenceInstances: [],
      adjustments: [],
      transitions: [],
      hidden: false,
      muted: false,
      solo: false,
      locked: false,
      volume: 1,
      balance: 0,
      audioEffects: [],
    })
    // Compositing convention: last video in the array = topmost layer.
  })

  test('adds an audio track directly after the last audio track', () => {
    const doc = makeDoc()
    const out = addTrack(doc, 'audio')
    expect(out.tracks.map((t) => t.id)).toEqual(['V1', 'V2', 'A1', 'A2', 'VL'])
    expect(out.tracks[3].kind).toBe('audio')
  })

  test('numbering counts names as well as ids, so renames cannot collide', () => {
    const doc = deepFreeze({
      ...makeDoc(),
      tracks: [{ ...makeTrack('track-7', 'video', []), name: 'V7' }],
    })
    expect(addTrack(doc, 'video').tracks.map((t) => t.id)).toEqual(['track-7', 'V8'])
  })

  test('first track of a kind: video lands at index 0, audio at the end', () => {
    const audioOnly = deepFreeze({ ...makeDoc(), tracks: [makeTrack('A1', 'audio', [])] })
    expect(addTrack(audioOnly, 'video').tracks.map((t) => t.id)).toEqual(['V1', 'A1'])

    const videoOnly = deepFreeze({ ...makeDoc(), tracks: [makeTrack('V1', 'video', [])] })
    expect(addTrack(videoOnly, 'audio').tracks.map((t) => t.id)).toEqual(['V1', 'A1'])
  })

  test('existing tracks keep their references; result survives JSON round-trip', () => {
    const doc = makeDoc()
    const out = addTrack(doc, 'video')
    expect(out).not.toBe(doc)
    for (let t = 0; t < doc.tracks.length; t++) {
      expect(out.tracks[t]).toBe(doc.tracks[t])
    }
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })
})

/* ------------------------------------------------------------------ */
/* setTrackFlags                                                        */
/* ------------------------------------------------------------------ */

describe('setTrackFlags', () => {
  test('sets one flag; everything else on the track is untouched', () => {
    const doc = makeDoc()
    const out = setTrackFlags(doc, 'V1', { hidden: true })
    const track = out.tracks[0]
    expect(track.hidden).toBe(true)
    expect(track.muted).toBe(false)
    expect(track.locked).toBe(false)
    expect(track.clips).toBe(doc.tracks[0].clips) // same reference
    expect(out.tracks[1]).toBe(doc.tracks[1]) // structural sharing
    expect(out.tracks[2]).toBe(doc.tracks[2])
  })

  test('sets several flags in one call', () => {
    const doc = makeDoc()
    const out = setTrackFlags(doc, 'A1', { muted: true, locked: true })
    expect(out.tracks[2].muted).toBe(true)
    expect(out.tracks[2].locked).toBe(true)
  })

  test('a locked track CAN be unlocked (the deliberate locked-rule exception)', () => {
    const doc = makeDoc()
    const out = setTrackFlags(doc, 'VL', { locked: false })
    expect(out).not.toBe(doc)
    expect(out.tracks[3].locked).toBe(false)
  })

  test('no-change patch returns the same reference WITHOUT warning', () => {
    const doc = makeDoc()
    expect(setTrackFlags(doc, 'V1', { hidden: false })).toBe(doc)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('unknown track and empty patch are rejected with a warning', () => {
    const doc = makeDoc()
    expect(setTrackFlags(doc, 'V9', { hidden: true })).toBe(doc)
    expect(setTrackFlags(doc, 'V1', {})).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('solo is a flag like the others: set, idempotent no-op, combined', () => {
    const doc = makeDoc()
    const out = setTrackFlags(doc, 'A1', { solo: true })
    expect(out.tracks[2].solo).toBe(true)
    expect(setTrackFlags(out, 'A1', { solo: true })).toBe(out) // idempotent
    const both = setTrackFlags(doc, 'A1', { solo: true, muted: true })
    expect(both.tracks[2].solo).toBe(true)
    expect(both.tracks[2].muted).toBe(true)
  })
})

describe('setTrackMixer', () => {
  test('sets audio-track volume and balance as one patch', () => {
    const doc = makeDoc()
    const out = setTrackMixer(doc, 'A1', { volume: 0.5, balance: -0.25 })
    expect(out.tracks[2].volume).toBe(0.5)
    expect(out.tracks[2].balance).toBe(-0.25)
    expect(out.tracks[0]).toBe(doc.tracks[0])
  })

  test('clamps volume and balance and no-ops an identical write', () => {
    const doc = makeDoc()
    const out = setTrackMixer(doc, 'A1', { volume: 9, balance: -4 })
    expect(out.tracks[2].volume).toBe(2)
    expect(out.tracks[2].balance).toBe(-1)
    expect(setTrackMixer(out, 'A1', { volume: 2, balance: -1 })).toBe(out)
  })

  test('rejects video tracks, locked tracks, and empty patches', () => {
    const doc = makeDoc()
    expect(setTrackMixer(doc, 'V1', { volume: 0.5 })).toBe(doc)
    const locked = setTrackFlags(doc, 'A1', { locked: true })
    expect(setTrackMixer(locked, 'A1', { volume: 0.5 })).toBe(locked)
    expect(setTrackMixer(doc, 'A1', {})).toBe(doc)
    expect(setTrackMixer(doc, 'missing', { volume: 0.5 })).toBe(doc)
  })
})

describe('setMasterAudio', () => {
  test('writes master volume, balance, and mute', () => {
    const doc = makeDoc()
    const out = setMasterAudio(doc, { volume: 0.8, balance: 0.5, muted: true })
    expect(out.masterAudio).toEqual({
      volume: 0.8,
      balance: 0.5,
      muted: true,
      audioEffects: [],
    })
    expect(setMasterAudio(out, { muted: true })).toBe(out)
  })

  test('rejects an empty patch and clamps out-of-range gain', () => {
    const doc = makeDoc()
    expect(setMasterAudio(doc, {})).toBe(doc)
    expect(setMasterAudio(doc, { volume: 4 }).masterAudio?.volume).toBe(2)
  })
})

/* ------------------------------------------------------------------ */
/* setClipVolume                                                        */
/* ------------------------------------------------------------------ */

describe('setClipVolume', () => {
  test('sets the volume; ranges, transform and neighbors are untouched', () => {
    const doc = makeDoc()
    const out = setClipVolume(doc, 'clipD', 0.5) // clipD lives on A1
    const clip = clipIn(out, 'A1', 'clipD')
    expect(clip.volume).toBe(0.5)
    expect(clip.timelineRange).toBe(clipIn(doc, 'A1', 'clipD').timelineRange)
    expect(out.tracks[0]).toBe(doc.tracks[0]) // structural sharing
  })

  test('clamps into [0, MAX_CLIP_VOLUME] instead of rejecting', () => {
    const doc = makeDoc()
    expect(clipIn(setClipVolume(doc, 'clipD', 9), 'A1', 'clipD').volume).toBe(
      MAX_CLIP_VOLUME,
    )
    expect(clipIn(setClipVolume(doc, 'clipD', -1), 'A1', 'clipD').volume).toBe(0)
  })

  test('setting the current volume returns the same reference, no warning', () => {
    const doc = makeDoc()
    expect(setClipVolume(doc, 'clipD', 1)).toBe(doc) // default volume is 1
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('rejects non-finite values, unknown clips and locked tracks', () => {
    const doc = makeDoc()
    expect(setClipVolume(doc, 'clipD', Number.NaN)).toBe(doc)
    expect(setClipVolume(doc, 'nope', 0.5)).toBe(doc)
    expect(setClipVolume(doc, 'clipE', 0.5)).toBe(doc) // VL is locked
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })
})

/* ------------------------------------------------------------------ */
/* renameTrack                                                          */
/* ------------------------------------------------------------------ */

describe('renameTrack', () => {
  test('renames the display name only; the id and content are untouched', () => {
    const doc = makeDoc()
    const out = renameTrack(doc, 'V1', '  Main cam  ') // trimmed
    const track = out.tracks[0]
    expect(track.name).toBe('Main cam')
    expect(track.id).toBe('V1')
    expect(track.clips).toBe(doc.tracks[0].clips) // same reference
    expect(out.tracks[1]).toBe(doc.tracks[1]) // structural sharing
  })

  test('renaming to the current name returns the same reference, no warning', () => {
    const doc = makeDoc()
    expect(renameTrack(doc, 'V1', 'V1')).toBe(doc)
    expect(renameTrack(doc, 'V1', '  V1  ')).toBe(doc) // trims first
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('empty/whitespace names and unknown tracks are rejected', () => {
    const doc = makeDoc()
    expect(renameTrack(doc, 'V1', '')).toBe(doc)
    expect(renameTrack(doc, 'V1', '   ')).toBe(doc)
    expect(renameTrack(doc, 'V9', 'ghost')).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(3)
  })

  test('a locked track CAN be renamed (metadata, not content — like flags)', () => {
    const doc = makeDoc()
    const out = renameTrack(doc, 'VL', 'Locked lane')
    expect(out).not.toBe(doc)
    expect(out.tracks[3].name).toBe('Locked lane')
  })
})

/* ------------------------------------------------------------------ */
/* removeTrack                                                          */
/* ------------------------------------------------------------------ */

describe('removeTrack', () => {
  test('removes the track; the others keep their references', () => {
    const doc = makeDoc()
    const out = removeTrack(doc, 'V2')
    expect(out.tracks.map((t) => t.id)).toEqual(['V1', 'A1', 'VL'])
    expect(out.tracks[0]).toBe(doc.tracks[0])
    expect(out.tracks[1]).toBe(doc.tracks[2])
  })

  test('a track with clips goes down WITH its clips in one op', () => {
    const doc = makeDoc()
    const out = removeTrack(doc, 'V1') // 3 clips on it
    expect(out.tracks.map((t) => t.id)).toEqual(['V2', 'A1', 'VL'])
    expect(JSON.parse(JSON.stringify(out))).toEqual(out) // round-trips
  })

  test('the LAST track of a kind may be removed', () => {
    const doc = makeDoc()
    const out = removeTrack(doc, 'A1') // the only audio track
    expect(out.tracks.some((t) => t.kind === 'audio')).toBe(false)
  })

  test('dissolves every link group that would leave one surviving partner', () => {
    const base = makeDoc()
    const firstGroup = 'link_removed_track_first'
    const secondGroup = 'link_removed_track_second'
    const doc = deepFreeze({
      ...base,
      tracks: [
        {
          ...base.tracks[0],
          clips: [
            { ...base.tracks[0].clips[0], linkGroupId: firstGroup },
            { ...base.tracks[0].clips[1], linkGroupId: secondGroup },
            base.tracks[0].clips[2],
          ],
        },
        base.tracks[1],
        {
          ...base.tracks[2],
          hidden: true,
          muted: true,
          clips: [
            { ...base.tracks[2].clips[0], linkGroupId: firstGroup },
            {
              ...makeClip('clipF', 100, 40),
              linkGroupId: secondGroup,
            },
          ],
        },
        base.tracks[3],
      ],
    })

    const out = removeTrack(doc, 'V1')
    const firstSurvivor = clipIn(out, 'A1', 'clipD')
    const secondSurvivor = clipIn(out, 'A1', 'clipF')

    expect(out.tracks.map((track) => track.id)).toEqual(['V2', 'A1', 'VL'])
    expect('linkGroupId' in firstSurvivor).toBe(false)
    expect('linkGroupId' in secondSurvivor).toBe(false)
    expect(out.tracks[0]).toBe(doc.tracks[1])
    expect(out.tracks[1]).not.toBe(doc.tracks[2])
    expect(out.tracks[2]).toBe(doc.tracks[3])
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('rejects atomically when dissolving an orphan would edit a locked partner', () => {
    const base = makeDoc()
    const groupId = 'link_locked_track_survivor'
    const doc = deepFreeze({
      ...base,
      tracks: base.tracks.map((track) => {
        if (track.id === 'A1') {
          return {
            ...track,
            clips: [{ ...track.clips[0], linkGroupId: groupId }],
          }
        }
        if (track.id === 'VL') {
          return {
            ...track,
            clips: [{ ...track.clips[0], linkGroupId: groupId }],
          }
        }
        return track
      }),
    })

    expect(removeTrack(doc, 'A1')).toBe(doc)
    expect(clipIn(doc, 'A1', 'clipD').linkGroupId).toBe(groupId)
    expect(clipIn(doc, 'VL', 'clipE').linkGroupId).toBe(groupId)
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  test('locked and unknown tracks are rejected', () => {
    const doc = makeDoc()
    expect(removeTrack(doc, 'VL')).toBe(doc)
    expect(removeTrack(doc, 'V9')).toBe(doc)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
