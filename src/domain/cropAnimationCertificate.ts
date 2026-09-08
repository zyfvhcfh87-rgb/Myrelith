/** Standalone admission proof for integer-frame crops; no schema or runtime enablement. */
import { cropInsetsValidationError, MAX_CROP_SUM } from './clipInspector'
import {
  evaluateValidatedAnimationTrackAtBoundaryPosition,
  keyframesValidationError,
  MAX_KEYFRAME_FRAME,
  MAX_KEYFRAMES_PER_TRACK,
  solveAnimationBezierParameter,
} from './scalarAnimation'
import type { ClipAnimationTrack, CropInsets } from './schema'

export const CROP_CERTIFICATE_LIMITS = Object.freeze({
  intervalsPerClip: 16_384,
  intervalsPerProject: 1_048_576,
  // A proof-work bound, including retained keys outside the requested frame range.
  keyVisitsPerProject: 100_000,
})

const EDGES = ['left', 'right', 'top', 'bottom'] as const
type Edge = typeof EDGES[number]
type ScalarTrack = Pick<ClipAnimationTrack, 'keyframes'>
type Interval = readonly [low: number, high: number]

export interface CropAnimationCertificateRequest {
  readonly crop: Readonly<CropInsets>
  readonly tracks: Readonly<Partial<Record<Edge, ScalarTrack>>>
  /** Inclusive authored integer-frame range, including any retained range to be admitted. */
  readonly startFrame: number
  readonly endFrame: number
}

export type CropAnimationCertificateResult = {
  readonly ok: true
  readonly intervals: number
  readonly evaluatedFrames: number
} | {
  readonly ok: false
  readonly reason: 'invalid-input' | 'unsafe-crop' | 'proof-budget'
  readonly detail: string
  readonly intervals: number
  readonly evaluatedFrames: number
  readonly frame?: number
}

/** Local scratch only. Every primitive encloses the actual rounded Number operation. */
function intervalArithmetic() {
  const bits = new DataView(new ArrayBuffer(8))
  function adjacent(value: number, up: boolean): number {
    if (Number.isNaN(value)) return value
    if (value === (up ? Infinity : -Infinity)) return value
    if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE
    bits.setFloat64(0, value)
    const encoded = bits.getBigUint64(0)
    bits.setBigUint64(0, encoded + ((value > 0) === up ? 1n : -1n))
    return bits.getFloat64(0)
  }
  function add(a: Interval, b: Interval): Interval {
    return [adjacent(a[0] + b[0], false), adjacent(a[1] + b[1], true)]
  }
  function subtract(a: Interval, b: Interval): Interval {
    return [adjacent(a[0] - b[1], false), adjacent(a[1] - b[0], true)]
  }
  function multiply(a: Interval, b: Interval): Interval {
    const aa = a[0] * b[0], ab = a[0] * b[1], ba = a[1] * b[0], bb = a[1] * b[1]
    return [adjacent(Math.min(aa, ab, ba, bb), false), adjacent(Math.max(aa, ab, ba, bb), true)]
  }
  return { add, subtract, multiply }
}

function point(value: number): Interval { return [value, value] }

function frameValid(frame: number): boolean {
  return Number.isSafeInteger(frame) && Math.abs(frame) <= MAX_KEYFRAME_FRAME
}

function validBudget(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum
}

/**
 * Certifies every integer frame or rejects without changing the request. A budget
 * rejection means unproven, not unsafe. The caller may lower, never raise, the cap.
 * This accepts typed immutable candidate data, not an untrusted JSON boundary.
 */
export function certifyCropAnimation(
  request: CropAnimationCertificateRequest,
  intervalBudget: number = CROP_CERTIFICATE_LIMITS.intervalsPerClip,
): CropAnimationCertificateResult {
  let intervals = 0
  let evaluatedFrames = 0
  function failure(reason: 'invalid-input' | 'unsafe-crop' | 'proof-budget', detail: string, frame?: number): CropAnimationCertificateResult {
    return { ok: false, reason, detail, intervals, evaluatedFrames, ...(frame === undefined ? {} : { frame }) }
  }
  if (!validBudget(intervalBudget, CROP_CERTIFICATE_LIMITS.intervalsPerClip)) {
    return failure('invalid-input', 'Crop proof interval budget is outside its bound.')
  }
  if (!frameValid(request.startFrame) || !frameValid(request.endFrame) || request.startFrame > request.endFrame) {
    return failure('invalid-input', 'Crop proof requires an ordered, bounded integer-frame range.')
  }
  const staticError = cropInsetsValidationError(request.crop)
  if (staticError) return failure('invalid-input', staticError)
  // Count every lane before walking any payload or allocating the cut list.
  for (const edge of EDGES) {
    const track = request.tracks[edge]
    if (track && (track.keyframes.length < 1 || track.keyframes.length > MAX_KEYFRAMES_PER_TRACK)) {
      return failure('invalid-input', `Crop ${edge} track exceeds its key count bound.`)
    }
  }
  for (const edge of EDGES) {
    const track = request.tracks[edge]
    if (!track) continue
    const error = keyframesValidationError(track.keyframes, (value) =>
      !Number.isFinite(value) || value < 0 || value > MAX_CROP_SUM ? 'Crop key value is outside [0, 0.99].' : null)
    if (error) return failure('invalid-input', error)
  }

  const arithmetic = intervalArithmetic()
  const { add, subtract, multiply } = arithmetic
  function trackInterval(edge: Edge, start: number, end: number): Interval {
    const track = request.tracks[edge]
    if (!track) return point(request.crop[edge])
    const keys = track.keyframes
    if (end <= keys[0].frame) return point(keys[0].value)
    const last = keys[keys.length - 1]
    if (start >= last.frame) return point(last.value)
    let low = 0, high = keys.length - 1
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2)
      if (keys[middle].frame <= start) low = middle
      else high = middle
    }
    const left = keys[low], right = keys[high]
    if (left.easing.type === 'hold' || left.value === right.value) return point(left.value)
    // The union-of-keys cuts exclude right.frame; exact left keys bypass easing.
    const includesLeftKey = start === left.frame
    const interiorStart = includesLeftKey ? start + 1 : start
    if (interiorStart > end) return point(left.value)
    const progress: Interval = [
      (interiorStart - left.frame) / (right.frame - left.frame),
      (end - left.frame) / (right.frame - left.frame),
    ]
    let eased = progress
    if (left.easing.type === 'cubic-bezier') {
      const easing = left.easing
      // Bisection's decision tree orders its final dyadic parameter by progress;
      // this does not assume the rounded cubic coordinate itself is monotone.
      const t: Interval = [solveAnimationBezierParameter(easing, progress[0]), solveAnimationBezierParameter(easing, progress[1])]
      const u = subtract(point(1), t)
      // Preserve the canonical polynomial's exact left-associated operation tree.
      const first = multiply(multiply(multiply(multiply(point(3), u), u), t), point(easing.y1))
      const second = multiply(multiply(multiply(multiply(point(3), u), t), t), point(easing.y2))
      const third = multiply(multiply(t, t), t)
      eased = add(add(first, second), third)
    }
    const values = add(point(left.value), multiply(point(right.value - left.value), eased))
    return includesLeftKey ? [Math.min(left.value, values[0]), Math.max(left.value, values[1])] : values
  }

  const cuts = new Set<number>([request.startFrame])
  for (const edge of EDGES) {
    for (const key of request.tracks[edge]?.keyframes ?? []) {
      if (key.frame > request.startFrame && key.frame <= request.endFrame) cuts.add(key.frame)
    }
  }
  const starts = [...cuts].sort((a, b) => a - b)
  // Reverse push makes both the partition walk and subdivision deterministic.
  const pending: [number, number][] = []
  for (let i = starts.length - 1; i >= 0; i--) {
    pending.push([starts[i], i + 1 < starts.length ? starts[i + 1] - 1 : request.endFrame])
  }
  while (pending.length > 0) {
    if (intervals >= intervalBudget) return failure('proof-budget', 'Crop safety could not be proved within the interval budget.')
    const [start, end] = pending.pop()!
    intervals++
    if (start === end) {
      evaluatedFrames++
      const crop = { ...request.crop }
      for (const edge of EDGES) {
        const track = request.tracks[edge]
        if (track) crop[edge] = evaluateValidatedAnimationTrackAtBoundaryPosition(track, start, crop[edge])
      }
      const error = cropInsetsValidationError(crop)
      if (error) return failure('unsafe-crop', error, start)
      continue
    }
    const bounds = EDGES.map((edge) => trackInterval(edge, start, end))
    // Rounded addition is monotone: summing the upper endpoints encloses the
    // actual validator's rounded sum. No permissive tolerance is introduced.
    if (bounds.every(([low, high]) => Number.isFinite(low) && Number.isFinite(high) && low >= 0 && high <= MAX_CROP_SUM)
      && bounds[0][1] + bounds[1][1] <= MAX_CROP_SUM
      && bounds[2][1] + bounds[3][1] <= MAX_CROP_SUM) continue
    const middle = Math.floor((start + end) / 2)
    pending.push([middle + 1, end], [start, middle])
  }
  return { ok: true, intervals, evaluatedFrames }
}

export type CropAnimationProjectCertificateResult = CropAnimationCertificateResult & {
  readonly requests: number
  readonly keyVisits: number
  readonly requestIndex?: number
}

/** Bounded whole-project proof traversal, independent of the project wire schema. */
export function certifyCropAnimations(
  requests: readonly CropAnimationCertificateRequest[],
  intervalBudget: number = CROP_CERTIFICATE_LIMITS.intervalsPerProject,
): CropAnimationProjectCertificateResult {
  let intervals = 0, evaluatedFrames = 0, keyVisits = 0
  function failure(reason: 'invalid-input' | 'proof-budget', detail: string, index = 0): CropAnimationProjectCertificateResult {
    return { ok: false, reason, detail, intervals, evaluatedFrames, requests: index, keyVisits, requestIndex: index }
  }
  if (!validBudget(intervalBudget, CROP_CERTIFICATE_LIMITS.intervalsPerProject)) {
    return failure('invalid-input', 'Project crop proof interval budget is outside its bound.')
  }
  // Every request needs at least one visit. Avoid touching an oversized payload.
  if (requests.length > intervalBudget) return failure('proof-budget', 'Too many crop requests for the project proof budget.')
  for (let index = 0; index < requests.length; index++) {
    if (intervals >= intervalBudget) return failure('proof-budget', 'Project crop proof interval budget exhausted.', index)
    const request = requests[index]
    for (const edge of EDGES) {
      const count = request.tracks[edge]?.keyframes.length ?? 0
      if (count > MAX_KEYFRAMES_PER_TRACK) return failure('invalid-input', 'Crop track exceeds its key count bound.', index)
      if (count > CROP_CERTIFICATE_LIMITS.keyVisitsPerProject - keyVisits) {
        return failure('proof-budget', 'Project crop proof key-visit budget exhausted.', index)
      }
      keyVisits += count
    }
    const result = certifyCropAnimation(request, Math.min(CROP_CERTIFICATE_LIMITS.intervalsPerClip, intervalBudget - intervals))
    intervals += result.intervals
    evaluatedFrames += result.evaluatedFrames
    if (!result.ok) return { ...result, intervals, evaluatedFrames, requests: index, keyVisits, requestIndex: index }
  }
  return { ok: true, intervals, evaluatedFrames, requests: requests.length, keyVisits }
}
