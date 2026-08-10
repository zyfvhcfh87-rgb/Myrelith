/** Pure, bounded scalar clip-keyframe model and evaluator. */

import {
  MAX_CLIP_SCALE,
  MIN_CLIP_SCALE,
} from './clipInspector'
import type {
  Clip,
  ClipAnimation,
  ClipAnimationEasing,
  ClipAnimationKeyframe,
  ClipAnimationProperty,
  ClipAnimationTrack,
  Transform,
} from './schema'

export const ANIMATABLE_CLIP_PROPERTIES = [
  'position-x',
  'position-y',
  'scale-x',
  'scale-y',
  'rotation',
  'opacity',
] as const satisfies readonly ClipAnimationProperty[]

export const MAX_KEYFRAMES_PER_TRACK = 1_024
export const MAX_KEYFRAME_FRAME = 1_000_000_000
export const MAX_ANIMATED_FINITE_MAGNITUDE = 1_000_000_000

export const LINEAR_ANIMATION_EASING: ClipAnimationEasing = {
  type: 'linear',
}

export const DEFAULT_CLIP_ANIMATION: ClipAnimation = { tracks: [] }

const PROPERTY_SET = new Set<ClipAnimationProperty>(ANIMATABLE_CLIP_PROPERTIES)

export function defaultClipAnimation(): ClipAnimation {
  return { tracks: [] }
}

export function clipAnimation(clip: Clip): ClipAnimation {
  return clip.animation ?? DEFAULT_CLIP_ANIMATION
}

export function cloneAnimationEasing(
  easing: ClipAnimationEasing,
): ClipAnimationEasing {
  return easing.type === 'cubic-bezier' ? { ...easing } : { type: easing.type }
}

export function cloneClipAnimation(animation: ClipAnimation): ClipAnimation {
  return {
    tracks: animation.tracks.map((track) => ({
      property: track.property,
      keyframes: track.keyframes.map((keyframe) => ({
        frame: keyframe.frame,
        ...(keyframe.sourceTimeTicks === undefined
          ? {}
          : { sourceTimeTicks: keyframe.sourceTimeTicks }),
        value: keyframe.value,
        easing: cloneAnimationEasing(keyframe.easing),
      })),
    })),
  }
}

export function clipAnimationTrack(
  clip: Clip,
  property: ClipAnimationProperty,
): ClipAnimationTrack | null {
  return clipAnimation(clip).tracks.find((track) => track.property === property) ?? null
}

export function isClipPropertyAnimated(
  clip: Clip,
  property: ClipAnimationProperty,
): boolean {
  return clipAnimationTrack(clip, property) !== null
}

export function clipAnimationPropertyLabel(property: ClipAnimationProperty): string {
  switch (property) {
    case 'position-x': return 'Position X'
    case 'position-y': return 'Position Y'
    case 'scale-x': return 'Scale X'
    case 'scale-y': return 'Scale Y'
    case 'rotation': return 'Rotation'
    case 'opacity': return 'Opacity'
  }
}

export function readClipAnimationProperty(
  clip: Clip,
  property: ClipAnimationProperty,
): number {
  switch (property) {
    case 'position-x': return clip.transform.x
    case 'position-y': return clip.transform.y
    case 'scale-x': return clip.transform.scaleX
    case 'scale-y': return clip.transform.scaleY
    case 'rotation': return clip.transform.rotation
    case 'opacity': return clip.opacity
  }
}

export function animationPropertyValueError(
  property: ClipAnimationProperty,
  value: number,
): string | null {
  if (!Number.isFinite(value)) return `${property} value must be finite`
  if (property === 'opacity' && (value < 0 || value > 1)) {
    return 'opacity keyframe value must be from 0 to 1'
  }
  if (
    (property === 'scale-x' || property === 'scale-y')
    && (value < MIN_CLIP_SCALE || value > MAX_CLIP_SCALE)
  ) {
    return `${property} keyframe value must be from ${MIN_CLIP_SCALE} to ${MAX_CLIP_SCALE}`
  }
  if (Math.abs(value) > MAX_ANIMATED_FINITE_MAGNITUDE) {
    return `${property} keyframe value exceeds the finite project bound`
  }
  return null
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

export function animationTrackValidationError(
  track: ClipAnimationTrack,
): string | null {
  if (!PROPERTY_SET.has(track.property)) return 'unsupported animated property'
  if (track.keyframes.length < 1) return 'animation tracks require at least one keyframe'
  if (track.keyframes.length > MAX_KEYFRAMES_PER_TRACK) {
    return `animation track exceeds ${MAX_KEYFRAMES_PER_TRACK} keyframes`
  }
  let previousFrame: number | null = null
  for (const keyframe of track.keyframes) {
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
    const valueError = animationPropertyValueError(track.property, keyframe.value)
    if (valueError) return valueError
    const easingError = animationEasingValidationError(keyframe.easing)
    if (easingError) return easingError
    previousFrame = keyframe.frame
  }
  return null
}

export function clipAnimationValidationError(animation: ClipAnimation): string | null {
  if (animation.tracks.length > ANIMATABLE_CLIP_PROPERTIES.length) {
    return `clip animation exceeds ${ANIMATABLE_CLIP_PROPERTIES.length} property tracks`
  }
  const properties = new Set<ClipAnimationProperty>()
  for (const track of animation.tracks) {
    if (properties.has(track.property)) return `duplicate ${track.property} animation track`
    properties.add(track.property)
    const error = animationTrackValidationError(track)
    if (error) return `${track.property}: ${error}`
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

/**
 * Evaluate one canonical track at an exact clip-local integer frame.
 * Boundaries hold the nearest value; an exact duplicate time is impossible in
 * persisted data and edit operations deterministically replace the target.
 * Invalid in-memory tracks return the supplied static fallback.
 */
export function evaluateAnimationTrack(
  track: ClipAnimationTrack,
  frame: number,
  fallback: number,
): number {
  if (!Number.isSafeInteger(frame) || animationTrackValidationError(track)) return fallback
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

function applyAnimatedValues(
  clip: Clip,
  values: ReadonlyMap<ClipAnimationProperty, number>,
): Clip {
  let transform: Transform | null = null
  let opacity = clip.opacity
  for (const [property, value] of values) {
    if (property === 'opacity') {
      opacity = value
      continue
    }
    transform ??= { ...clip.transform }
    if (property === 'position-x') transform.x = value
    else if (property === 'position-y') transform.y = value
    else if (property === 'scale-x') transform.scaleX = value
    else if (property === 'scale-y') transform.scaleY = value
    else transform.rotation = value
  }
  if (transform === null && opacity === clip.opacity) return clip
  return { ...clip, transform: transform ?? clip.transform, opacity }
}

/** Shared pure resolver used by Inspector, Program Monitor, preview, and export. */
export function resolveClipAnimationAtFrame(clip: Clip, timelineFrame: number): Clip {
  if (!Number.isSafeInteger(timelineFrame)) return clip
  const animation = clipAnimation(clip)
  if (animation.tracks.length === 0 || clipAnimationValidationError(animation)) return clip
  const localFrame = timelineFrame - clip.timelineRange.startFrame
  if (!Number.isSafeInteger(localFrame)) return clip
  const values = new Map<ClipAnimationProperty, number>()
  for (const track of animation.tracks) {
    const fallback = readClipAnimationProperty(clip, track.property)
    values.set(
      track.property,
      evaluateAnimationTrack(track, localFrame, fallback),
    )
  }
  return applyAnimatedValues(clip, values)
}

function replaceTrack(
  animation: ClipAnimation,
  property: ClipAnimationProperty,
  nextTrack: ClipAnimationTrack | null,
): ClipAnimation {
  const tracks = animation.tracks.filter((track) => track.property !== property)
  if (nextTrack) tracks.push(nextTrack)
  tracks.sort(
    (left, right) => ANIMATABLE_CLIP_PROPERTIES.indexOf(left.property)
      - ANIMATABLE_CLIP_PROPERTIES.indexOf(right.property),
  )
  return { tracks }
}

/** Upsert semantics: a keyframe at the same property/time is replaced. */
export function upsertAnimationKeyframe(
  animation: ClipAnimation,
  property: ClipAnimationProperty,
  keyframe: ClipAnimationKeyframe,
): ClipAnimation | null {
  if (animationPropertyValueError(property, keyframe.value)) return null
  if (animationEasingValidationError(keyframe.easing)) return null
  if (
    !Number.isSafeInteger(keyframe.frame)
    || keyframe.frame < -MAX_KEYFRAME_FRAME
    || keyframe.frame > MAX_KEYFRAME_FRAME
  ) return null
  if (clipAnimationValidationError(animation)) return null
  const existing = animation.tracks.find((track) => track.property === property)
  const keyframes = (existing?.keyframes ?? [])
    .filter((item) => item.frame !== keyframe.frame)
    .map((item) => ({ ...item, easing: cloneAnimationEasing(item.easing) }))
  keyframes.push({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) })
  keyframes.sort((left, right) => left.frame - right.frame)
  if (keyframes.length > MAX_KEYFRAMES_PER_TRACK) return null
  return replaceTrack(animation, property, { property, keyframes })
}

/** Move semantics: the moved source deterministically replaces a target-time key. */
export function moveAnimationKeyframe(
  animation: ClipAnimation,
  property: ClipAnimationProperty,
  fromFrame: number,
  toFrame: number,
): ClipAnimation | null {
  const track = animation.tracks.find((item) => item.property === property)
  const source = track?.keyframes.find((keyframe) => keyframe.frame === fromFrame)
  if (!track || !source) return null
  if (fromFrame === toFrame) return animation
  const remainingKeyframes = track.keyframes
    .filter((keyframe) => keyframe.frame !== fromFrame)
    .map((keyframe) => ({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) }))
  const withoutSource = replaceTrack(
    animation,
    property,
    remainingKeyframes.length === 0
      ? null
      : { property, keyframes: remainingKeyframes },
  )
  return upsertAnimationKeyframe(withoutSource, property, {
    ...source,
    frame: toFrame,
  })
}

export function removeAnimationKeyframe(
  animation: ClipAnimation,
  property: ClipAnimationProperty,
  frame: number,
): ClipAnimation | null {
  const track = animation.tracks.find((item) => item.property === property)
  if (!track || !track.keyframes.some((keyframe) => keyframe.frame === frame)) return null
  const keyframes = track.keyframes
    .filter((keyframe) => keyframe.frame !== frame)
    .map((keyframe) => ({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) }))
  return replaceTrack(
    animation,
    property,
    keyframes.length === 0 ? null : { property, keyframes },
  )
}

export function removeAnimationTrack(
  animation: ClipAnimation,
  property: ClipAnimationProperty,
): ClipAnimation | null {
  if (!animation.tracks.some((track) => track.property === property)) return null
  return replaceTrack(animation, property, null)
}

/** Shift a clip-local animation origin while retaining exact curve geometry. */
export function shiftClipAnimation(
  animation: ClipAnimation,
  deltaFrames: number,
): ClipAnimation | null {
  if (!Number.isSafeInteger(deltaFrames) || clipAnimationValidationError(animation)) return null
  const tracks: ClipAnimationTrack[] = []
  for (const track of animation.tracks) {
    const keyframes: ClipAnimationKeyframe[] = []
    for (const keyframe of track.keyframes) {
      const frame = keyframe.frame + deltaFrames
      if (
        !Number.isSafeInteger(frame)
        || frame < -MAX_KEYFRAME_FRAME
        || frame > MAX_KEYFRAME_FRAME
      ) return null
      keyframes.push({
        ...keyframe,
        frame,
        easing: cloneAnimationEasing(keyframe.easing),
      })
    }
    tracks.push({ property: track.property, keyframes })
  }
  return { tracks }
}
