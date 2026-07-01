/**
 * domain/time.test.ts — Phase 0 gate tests.
 * The plan's rule: do not proceed to Phase 1 with failing time math;
 * every later bug traces back here.
 */

import { describe, test, expect } from 'vitest'
import type { FrameRate, TimeRange } from './schema'
import {
  addFrames,
  framesToSeconds,
  growRange,
  rangeContains,
  rangeEnd,
  rangeOverlap,
  rateEquals,
  rescaleFrames,
  secondsToFrames,
} from './time'

/** NTSC rates — the drift-prone ones this module exists to tame. */
const NTSC_2997: FrameRate = { num: 30000, den: 1001 }
const NTSC_23976: FrameRate = { num: 24000, den: 1001 }
const NTSC_5994: FrameRate = { num: 60000, den: 1001 }
const F30: FrameRate = { num: 30, den: 1 }
const F60: FrameRate = { num: 60, den: 1 }

const r = (startFrame: number, durationFrames: number): TimeRange => ({
  startFrame,
  durationFrames,
})

/* ------------------------------------------------------------------ */
/* Plan test 1: round-trip drift                                        */
/* ------------------------------------------------------------------ */

describe('frames <-> seconds round-trips (no drift)', () => {
  test('29.97fps: 1000 frames does not drift after 10 round-trips', () => {
    let frames = 1000
    for (let i = 0; i < 10; i++) {
      frames = secondsToFrames(framesToSeconds(frames, NTSC_2997), NTSC_2997)
    }
    expect(frames).toBe(1000)
  })

  test('every frame 0..5000 survives 10 round-trips at all NTSC rates', () => {
    for (const rate of [NTSC_2997, NTSC_23976, NTSC_5994]) {
      for (let f = 0; f <= 5000; f++) {
        let frames = f
        for (let i = 0; i < 10; i++) {
          frames = secondsToFrames(framesToSeconds(frames, rate), rate)
        }
        expect(frames).toBe(f)
      }
    }
  })

  test('8-hour mark at 29.97fps survives round-trips (long-timeline case)', () => {
    // ~8h of NTSC video ≈ 863136 frames; way past where naive float
    // "frame * 0.03336..." accumulation goes wrong.
    const f = 863136
    const roundTripped = secondsToFrames(
      framesToSeconds(f, NTSC_2997),
      NTSC_2997,
    )
    expect(roundTripped).toBe(f)
  })

  test('exact rational results: 30000 NTSC frames is exactly 1001 seconds', () => {
    expect(framesToSeconds(30000, NTSC_2997)).toBe(1001)
    expect(framesToSeconds(90, F30)).toBe(3)
  })

  test('secondsToFrames rounds to the nearest frame', () => {
    // 1 second at 29.97fps is 29.97 frames -> nearest is 30
    expect(secondsToFrames(1, NTSC_2997)).toBe(30)
    expect(secondsToFrames(0.5, F30)).toBe(15)
  })

  test('invalid rates are rejected', () => {
    expect(() => framesToSeconds(1, { num: 29.97, den: 1 })).toThrow(TypeError)
    expect(() => secondsToFrames(1, { num: 0, den: 1 })).toThrow(TypeError)
    expect(() => framesToSeconds(1, { num: 30, den: -1 })).toThrow(TypeError)
    expect(() => framesToSeconds(Number.NaN, F30)).toThrow(TypeError)
  })
})

/* ------------------------------------------------------------------ */
/* Plan test 2: addFrames / durations never go negative                 */
/* ------------------------------------------------------------------ */

describe('addFrames and duration safety', () => {
  test('same-rate add sums integer frames', () => {
    const sum = addFrames(
      { frames: 100, rate: NTSC_2997 },
      { frames: 50, rate: NTSC_2997 },
    )
    expect(sum).toEqual({ frames: 150, rate: NTSC_2997 })
  })

  test('mixed-rate add rescales to the first operand rate', () => {
    // 1 second of 60fps (60 frames) added to 1 second of 30fps (30 frames)
    // = 2 seconds at 30fps = 60 frames.
    const sum = addFrames({ frames: 30, rate: F30 }, { frames: 60, rate: F60 })
    expect(sum).toEqual({ frames: 60, rate: F30 })
  })

  test('negative deltas are allowed on time points (moving a clip left)', () => {
    const sum = addFrames(
      { frames: 10, rate: F30 },
      { frames: -25, rate: F30 },
    )
    expect(sum.frames).toBe(-15) // pure point math; ranges clamp, points do not
  })

  test('growRange never produces negative duration', () => {
    // The plan's "addFrames never produces negative duration" guarantee lives
    // here: duration math goes through growRange, which clamps at 0.
    expect(growRange(r(10, 5), -3)).toEqual(r(10, 2))
    expect(growRange(r(10, 5), -5)).toEqual(r(10, 0))
    expect(growRange(r(10, 5), -9999)).toEqual(r(10, 0))
    for (let delta = -20; delta <= 20; delta++) {
      expect(growRange(r(0, 7), delta).durationFrames).toBeGreaterThanOrEqual(0)
    }
  })

  test('rateEquals compares reduced value, not representation', () => {
    expect(rateEquals(F30, { num: 60, den: 2 })).toBe(true)
    expect(rateEquals(F30, F60)).toBe(false)
  })

  test('rescaleFrames: exact conversions stay exact, others round nearest', () => {
    expect(rescaleFrames(30, F30, F60)).toBe(60) // exact
    expect(rescaleFrames(1, F60, F30)).toBe(1) // 0.5 rounds to 1 (Math.round)
    expect(rescaleFrames(1000, NTSC_2997, F30)).toBe(1001) // exact: 1000*1001*30/30000
    expect(rescaleFrames(1000, F30, NTSC_2997)).toBe(999) // 999.000999 -> 999
  })
})

/* ------------------------------------------------------------------ */
/* Plan test 3: range overlap / containment (half-open)                 */
/* ------------------------------------------------------------------ */

describe('rangeOverlap (half-open ranges)', () => {
  test('adjacent-but-not-overlapping ranges do NOT overlap', () => {
    // [0,10) and [10,15): frame 10 belongs only to the second range.
    expect(rangeOverlap(r(0, 10), r(10, 5))).toBe(false)
    expect(rangeOverlap(r(10, 5), r(0, 10))).toBe(false)
  })

  test('one shared frame is an overlap', () => {
    expect(rangeOverlap(r(0, 10), r(9, 5))).toBe(true)
    expect(rangeOverlap(r(9, 5), r(0, 10))).toBe(true)
  })

  test('containment and identity are overlaps', () => {
    expect(rangeOverlap(r(0, 100), r(20, 5))).toBe(true)
    expect(rangeOverlap(r(5, 5), r(5, 5))).toBe(true)
  })

  test('empty ranges never overlap anything', () => {
    expect(rangeOverlap(r(5, 0), r(0, 100))).toBe(false)
    expect(rangeOverlap(r(0, 100), r(5, 0))).toBe(false)
    expect(rangeOverlap(r(5, 0), r(5, 0))).toBe(false)
  })

  test('fully disjoint ranges do not overlap', () => {
    expect(rangeOverlap(r(0, 10), r(50, 10))).toBe(false)
  })
})

describe('rangeContains', () => {
  test('start is inclusive, end is exclusive', () => {
    const range = r(10, 5) // frames 10,11,12,13,14
    expect(rangeContains(range, 10)).toBe(true)
    expect(rangeContains(range, 14)).toBe(true)
    expect(rangeContains(range, 15)).toBe(false)
    expect(rangeContains(range, 9)).toBe(false)
  })

  test('empty range contains nothing, not even its own start', () => {
    expect(rangeContains(r(10, 0), 10)).toBe(false)
  })

  test('rangeEnd is one past the last frame', () => {
    expect(rangeEnd(r(10, 5))).toBe(15)
    expect(rangeEnd(r(0, 0))).toBe(0)
  })
})
