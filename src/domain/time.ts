/**
 * domain/time.ts — Pure frame/time math. Phase 0.
 *
 * The one rule that keeps the whole editor frame-accurate: timeline math
 * happens in INTEGER frame counts, and floating-point seconds appear only at
 * the boundary (encoders, decoders, the audio clock). Non-integer rates like
 * NTSC 29.97 (30000/1001) stay exact because we keep numerator/denominator
 * as integers and multiply BEFORE dividing.
 *
 * No browser APIs, no imports outside domain/ (ARCHITECTURE.md).
 */

import type { FrameRate, RationalTime, TimeRange } from './schema'

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

/** Throws unless the rate is made of positive integers (e.g. 30000/1001). */
function assertValidRate(rate: FrameRate): void {
  if (
    !Number.isInteger(rate.num) ||
    !Number.isInteger(rate.den) ||
    rate.num <= 0 ||
    rate.den <= 0
  ) {
    throw new TypeError(
      `Invalid FrameRate ${rate.num}/${rate.den}: num and den must be positive integers`,
    )
  }
}

/* ------------------------------------------------------------------ */
/* Rate helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * True when two rates describe the same fps, even with different terms
 * (30/1 equals 60/2). Compared by cross-multiplication — no division, so no
 * float error.
 */
export function rateEquals(a: FrameRate, b: FrameRate): boolean {
  assertValidRate(a)
  assertValidRate(b)
  return a.num * b.den === b.num * a.den
}

/**
 * Convert an integer frame count from one rate to another, rounding to the
 * nearest destination frame. All multiplication happens on integers first,
 * so results are exact whenever the conversion is exact (e.g. 30fps → 60fps).
 */
export function rescaleFrames(
  frames: number,
  from: FrameRate,
  to: FrameRate,
): number {
  assertValidRate(from)
  assertValidRate(to)
  if (!Number.isFinite(frames)) {
    throw new TypeError(`rescaleFrames: frames must be finite, got ${frames}`)
  }
  return Math.round((frames * from.den * to.num) / (from.num * to.den))
}

/* ------------------------------------------------------------------ */
/* Seconds boundary (float allowed here, and ONLY here)                 */
/* ------------------------------------------------------------------ */

/**
 * Integer frames → seconds, for the encoder/decoder/audio-clock boundary.
 * seconds = frames * den / num. The numerator is computed in integer space
 * first, so e.g. 30000 NTSC frames is exactly 1001 seconds.
 */
export function framesToSeconds(frames: number, rate: FrameRate): number {
  assertValidRate(rate)
  if (!Number.isFinite(frames)) {
    throw new TypeError(`framesToSeconds: frames must be finite, got ${frames}`)
  }
  return (frames * rate.den) / rate.num
}

/**
 * Seconds → nearest integer frame. The inverse of framesToSeconds: any value
 * produced by framesToSeconds converts back to the exact same frame, no
 * matter how many round-trips (drift-free — see time.test.ts).
 */
export function secondsToFrames(seconds: number, rate: FrameRate): number {
  assertValidRate(rate)
  if (!Number.isFinite(seconds)) {
    throw new TypeError(`secondsToFrames: seconds must be finite, got ${seconds}`)
  }
  return Math.round((seconds * rate.num) / rate.den)
}

/* ------------------------------------------------------------------ */
/* RationalTime arithmetic                                              */
/* ------------------------------------------------------------------ */

/**
 * Add two RationalTimes; the result is expressed at `a`'s rate. When rates
 * differ, `b` is rescaled to `a`'s rate first (nearest frame). Deltas may be
 * negative — this is a pure point/delta add and never clamps; use growRange
 * for duration math that must not go negative.
 */
export function addFrames(a: RationalTime, b: RationalTime): RationalTime {
  const bFrames = rateEquals(a.rate, b.rate)
    ? b.frames
    : rescaleFrames(b.frames, b.rate, a.rate)
  return { frames: a.frames + bFrames, rate: a.rate }
}

/* ------------------------------------------------------------------ */
/* TimeRange helpers (half-open: [start, start + duration))             */
/* ------------------------------------------------------------------ */

/** One-past-the-last frame of a range (exclusive end). */
export function rangeEnd(range: TimeRange): number {
  return range.startFrame + range.durationFrames
}

/**
 * True when the ranges share at least one frame. Half-open semantics:
 * ranges that merely touch ([0,10) and [10,15)) do NOT overlap, and an
 * empty range (duration 0) never overlaps anything.
 */
export function rangeOverlap(a: TimeRange, b: TimeRange): boolean {
  return (
    Math.max(a.startFrame, b.startFrame) < Math.min(rangeEnd(a), rangeEnd(b))
  )
}

/** True when `frame` lies inside the range: start inclusive, end exclusive. */
export function rangeContains(range: TimeRange, frame: number): boolean {
  return frame >= range.startFrame && frame < rangeEnd(range)
}

/**
 * Lengthen (positive delta) or shorten (negative delta) a range, keeping the
 * start fixed. Duration is clamped at 0 — a range can never have negative
 * duration. (Clip operations additionally enforce a 1-frame minimum; that
 * rule lives in domain/operations.ts, not here.)
 */
export function growRange(range: TimeRange, deltaFrames: number): TimeRange {
  return {
    startFrame: range.startFrame,
    durationFrames: Math.max(0, range.durationFrames + deltaFrames),
  }
}
