/** Canonical scalar interpolation leaf; no property registry or browser dependencies. */

import type { ClipAnimationEasing, ClipAnimationKeyframe, ClipAnimationTrack } from './schema'

export const MAX_KEYFRAMES_PER_TRACK = 1_024
export const MAX_KEYFRAME_FRAME = 1_000_000_000
export const MAX_ANIMATED_FINITE_MAGNITUDE = 1_000_000_000

export function cloneAnimationEasing(
  easing: ClipAnimationEasing,
): ClipAnimationEasing {
  return easing.type === 'cubic-bezier' ? { ...easing } : { type: easing.type }
}

export function animationEasingValidationError(
  easing: ClipAnimationEasing,
): string | null {
  if (easing.type === 'linear' || easing.type === 'hold') return null
  if (easing.type !== 'cubic-bezier') return 'unsupported keyframe easing'
  for (const key of ['x1', 'y1', 'x2', 'y2'] as const) {
    const value = easing[key]
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return `cubic-bezier ${key} must be from 0 to 1`
    }
  }
  return null
}

export function keyframesValidationError(
  keyframes: readonly ClipAnimationKeyframe[],
  valueError: (value: number) => string | null,
): string | null {
  if (keyframes.length < 1) return 'animation tracks require at least one keyframe'
  if (keyframes.length > MAX_KEYFRAMES_PER_TRACK) {
    return `animation track exceeds ${MAX_KEYFRAMES_PER_TRACK} keyframes`
  }
  let previousFrame: number | null = null
  for (const keyframe of keyframes) {
    if (
      !Number.isSafeInteger(keyframe.frame)
      || keyframe.frame < -MAX_KEYFRAME_FRAME
      || keyframe.frame > MAX_KEYFRAME_FRAME
    ) {
      return `keyframe frame must be a safe integer from ${-MAX_KEYFRAME_FRAME} to ${MAX_KEYFRAME_FRAME}`
    }
    if (
      keyframe.sourceTimeTicks !== undefined
      && !Number.isSafeInteger(keyframe.sourceTimeTicks)
    ) return 'keyframe sourceTimeTicks must be a safe integer'
    if (previousFrame !== null && keyframe.frame <= previousFrame) {
      return 'keyframe frames must be strictly increasing and unique'
    }
    const invalidValue = valueError(keyframe.value)
    if (invalidValue) return invalidValue
    const easingError = animationEasingValidationError(keyframe.easing)
    if (easingError) return easingError
    previousFrame = keyframe.frame
  }
  return null
}

function cubicCoordinate(
  amount: number,
  firstControl: number,
  secondControl: number,
): number {
  const inverse = 1 - amount
  return 3 * inverse * inverse * amount * firstControl
    + 3 * inverse * amount * amount * secondControl
    + amount * amount * amount
}

/** Deterministic CSS-style cubic-bezier progress using a fixed bisection budget. */
export function animationEasingProgress(
  easing: ClipAnimationEasing,
  progress: number,
): number {
  const bounded = Math.min(1, Math.max(0, progress))
  if (easing.type === 'hold') return 0
  if (easing.type === 'linear') return bounded
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 24; iteration++) {
    const middle = (low + high) / 2
    if (cubicCoordinate(middle, easing.x1, easing.x2) < bounded) low = middle
    else high = middle
  }
  return cubicCoordinate((low + high) / 2, easing.y1, easing.y2)
}

function evaluateValidatedAnimationTrackPosition(
  track: Pick<ClipAnimationTrack, 'keyframes'>,
  frame: number,
): number {
  const keyframes = track.keyframes
  if (frame <= keyframes[0].frame) return keyframes[0].value
  const last = keyframes[keyframes.length - 1]
  if (frame >= last.frame) return last.value

  let low = 0
  let high = keyframes.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (keyframes[middle].frame <= frame) low = middle
    else high = middle
  }
  const left = keyframes[low]
  const right = keyframes[high]
  if (frame === left.frame) return left.value
  const linearProgress = (frame - left.frame) / (right.frame - left.frame)
  const eased = animationEasingProgress(left.easing, linearProgress)
  return left.value + (right.value - left.value) * eased
}

function evaluateAnimationTrackPosition(
  track: Pick<ClipAnimationTrack, 'keyframes'>,
  frame: number,
  fallback: number,
): number {
  if (
    keyframesValidationError(track.keyframes, (value) =>
      !Number.isFinite(value) || Math.abs(value) > MAX_ANIMATED_FINITE_MAGNITUDE
        ? 'animated value exceeds the finite project bound'
        : null,
    )
  ) return fallback
  return evaluateValidatedAnimationTrackPosition(track, frame)
}

/** Evaluate authored timeline geometry only at an exact integer frame. */
export function evaluateAnimationTrack(
  track: Pick<ClipAnimationTrack, 'keyframes'>,
  frame: number,
  fallback: number,
): number {
  if (!Number.isSafeInteger(frame)) return fallback
  return evaluateAnimationTrackPosition(track, frame, fallback)
}

/**
 * Evaluate an ephemeral decoder/audio-clock boundary position. The caller
 * owns conversion from an exact integer timeline or sample boundary; this
 * value must never become authored or persisted geometry.
 */
export function evaluateAnimationTrackAtBoundaryPosition(
  track: Pick<ClipAnimationTrack, 'keyframes'>,
  frame: number,
  fallback: number,
): number {
  if (!Number.isFinite(frame)) return fallback
  return evaluateAnimationTrackPosition(track, frame, fallback)
}

/**
 * Allocation-free boundary evaluation for audio-rate callers whose planning
 * boundary already accepted the complete animation track.
 */
export function evaluateValidatedAnimationTrackAtBoundaryPosition(
  track: Pick<ClipAnimationTrack, 'keyframes'>,
  frame: number,
  fallback: number,
): number {
  if (!Number.isFinite(frame)) return fallback
  return evaluateValidatedAnimationTrackPosition(track, frame)
}
