/**
 * domain/operations.test.ts — Phase 1.1 acceptance tests.
 *
 * Every test deep-freezes the input doc: if an operation mutates its input
 * instead of returning a new doc, the mutation throws immediately.
 * Rejected operations must return the SAME reference (toBe(doc)).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Clip, Effect, MediaAsset, TimelineDoc, Track } from './schema'
import {
  addEffect,
  clipFromAsset,
  insertClip,
  moveClip,
  rippleDelete,
  rippleTrim,
  slideClip,
  slipClip,
  splitClipAtFrame,
  trimClip,
} from './operations'
import { rangeEnd } from './time'

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
    sourceRange: { startFrame: srcStart, durationFrames: duration },
    timelineRange: { startFrame: tlStart, durationFrames: duration },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function makeTrack(id: string, kind: Track['kind'], clips: Clip[], locked = false): Track {
  return { id, kind, name: id, clips, transitions: [], hidden: false, muted: false, locked }
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
    schemaVersion: 1,
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
  enabled: true,
  params: { amount: 0.5 },
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
  objectUrl: 'blob:fake',
  kind: 'video',
  durationFrames: 120,
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
