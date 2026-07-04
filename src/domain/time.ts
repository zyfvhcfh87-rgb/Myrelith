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
 * Standard broadcast/web frame rates, used to turn a measured float fps
 * (e.g. Mediabunny's averagePacketRate of 29.97002997) back into the exact
 * rational it almost certainly is. Ordered list, nearest wins.
 */
const STANDARD_RATES: readonly FrameRate[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
  { num: 90, den: 1 },
  { num: 100, den: 1 },
  { num: 120000, den: 1001 },
  { num: 120, den: 1 },
]

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = b
    b = a % b
    a = t
  }
  return a
}

/**
 * Snap a measured float fps to the nearest standard rational rate when it is
 * within `toleranceFps`; otherwise build an exact rational from the float at
 * millifps precision (17.3 → 173/10). This is how float fps readings from
 * demuxed files re-enter the integer-frame world without smuggling drift in.
 */
export function snapToStandardRate(fps: number, toleranceFps = 0.05): FrameRate {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TypeError(`snapToStandardRate: fps must be finite and > 0, got ${fps}`)
  }
  let best = STANDARD_RATES[0]
  let bestDiff = Number.POSITIVE_INFINITY
  for (const rate of STANDARD_RATES) {
    const diff = Math.abs(fps - rate.num / rate.den)
    if (diff < bestDiff) {
      best = rate
      bestDiff = diff
    }
  }
  if (bestDiff <= toleranceFps) return best

  // Unusual rate: preserve it exactly at millifps precision, reduced.
  const num = Math.round(fps * 1000)
  const g = gcd(num, 1000)
  return { num: num / g, den: 1000 / g }
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

/**
 * Frame count → non-drop-frame timecode "HH:MM:SS:FF" for ruler/readout
 * display. NDF counts a nominal integer fps (29.97 counts 30 frames per
 * "second"), so it stays frame-accurate but drifts ~0.1% from wall-clock on
 * NTSC rates — the standard tradeoff; drop-frame display is a post-MVP
 * concern. Negative inputs clamp to 0.
 */
export function formatTimecode(frame: number, rate: FrameRate): string {
  assertValidRate(rate)
  const f = Math.max(0, Math.round(frame))
  const fps = Math.max(1, Math.round(rate.num / rate.den))
  const ff = f % fps
  const totalSeconds = Math.floor(f / fps)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`
}
