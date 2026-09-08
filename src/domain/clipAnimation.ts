/** Pure, bounded scalar clip-keyframe model and evaluator. */

import {
  clipAudioSettings,
  clipVisualSettings,
  cropInsetsValidationError,
} from './clipInspector'
import type {
  Clip,
  ClipAnimation,
  ClipAnimationEasing,
  ClipAnimationKeyframe,
  ClipAnimationProperty,
  ClipAnimationTrack,
  ClipAudioSettings,
  EffectAnimationTrack,
  EffectDescriptor,
  TimelineDoc,
  TrackKind,
  Transform,
} from './schema'
import {
  effectAnimationParameterSpec,
  effectParamsValidationError,
} from './effectStack'
import { EFFECT_STACK_LIMITS } from './effectBounds'
import { mapAnimationTrackKeyframes } from './animationTiming'
import { animationParameterIdentityError } from './animationParameterIdentity'
import {
  effectPathAnimationTracks, forEachAnimationTrack, mapAnimationCollections,
  MAX_ANIMATION_PROPERTY_CHARACTERS, MAX_CLIP_SCALAR_ANIMATION_TRACKS,
  MAX_TITLE_ANIMATION_TRACKS, titleAnimationTracks, type AnyAnimationTrack,
} from './animationCollections'
import { effectPathAnimationTracksBoundsError } from './maskPathAnimation'
import { CLIP_SCALAR_PROPERTY_SPECS, CROP_ANIMATION_PROPERTIES, readClipScalarProperty } from './clipAnimationProperties'
import { resolveEffectPathAnimation } from './effectPathAnimationResolution'
import {
  animationEasingValidationError,
  cloneAnimationEasing,
  evaluateAnimationTrack,
  keyframesValidationError,
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  MAX_KEYFRAMES_PER_TRACK,
} from './scalarAnimation'

// Preserve existing public imports while all consumers share the same leaf.
export {
  animationEasingProgress,
  animationEasingValidationError,
  cloneAnimationEasing,
  evaluateAnimationTrack,
  evaluateAnimationTrackAtBoundaryPosition,
  evaluateValidatedAnimationTrackAtBoundaryPosition,
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  MAX_KEYFRAMES_PER_TRACK,
} from './scalarAnimation'

export const ANIMATABLE_VISUAL_PROPERTIES = [
  'position-x',
  'position-y',
  'scale-x',
  'scale-y',
  'rotation',
  'opacity',
] as const satisfies readonly ClipAnimationProperty[]

export const ANIMATABLE_AUDIO_PROPERTIES = [
  'volume',
  'balance',
] as const satisfies readonly ClipAnimationProperty[]

export const ANIMATABLE_CLIP_PROPERTIES = [
  ...ANIMATABLE_VISUAL_PROPERTIES,
  ...ANIMATABLE_AUDIO_PROPERTIES,
  ...CROP_ANIMATION_PROPERTIES,
] as const satisfies readonly ClipAnimationProperty[]

export const MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP = 1_280
export const MAX_TOTAL_ANIMATION_KEYFRAMES = 100_000

export const LINEAR_ANIMATION_EASING: ClipAnimationEasing = {
  type: 'linear',
}

export const DEFAULT_CLIP_ANIMATION: ClipAnimation = { tracks: [], effectTracks: [] }

const PROPERTY_SET = new Set<ClipAnimationProperty>(ANIMATABLE_CLIP_PROPERTIES)

export function defaultClipAnimation(): ClipAnimation {
  return { tracks: [], effectTracks: [] }
}

export function effectAnimationTracks(
  animation: ClipAnimation,
): readonly EffectAnimationTrack[] {
  return animation.effectTracks ?? []
}

export function clipAnimation(clip: Clip): ClipAnimation {
  return clip.animation ?? DEFAULT_CLIP_ANIMATION
}

export function clipAnimationKeyframeCount(animation: ClipAnimation): number {
  let total = 0
  forEachAnimationTrack(animation, (track) => { total += track.keyframes.length })
  return total
}

export function documentAnimationKeyframeCount(doc: TimelineDoc): number {
  let total = 0
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      total += clipAnimationKeyframeCount(clipAnimation(clip))
    }
    for (const adjustment of track.adjustments ?? []) {
      total += clipAnimationKeyframeCount(adjustment.animation)
    }
  }
  return total
}

/** Zero-growth edits remain legal even for preserved over-budget authoring intent. */
export function documentAnimationKeyframeGrowthAllowed(
  doc: TimelineDoc,
  additionalKeyframes: number,
): boolean {
  if (!Number.isSafeInteger(additionalKeyframes) || additionalKeyframes < 0) return false
  if (additionalKeyframes === 0) return true
  return documentAnimationKeyframeCount(doc)
    <= MAX_TOTAL_ANIMATION_KEYFRAMES - additionalKeyframes
}

export function cloneClipAnimation(animation: ClipAnimation): ClipAnimation {
  return mapAnimationCollections(animation, <T extends AnyAnimationTrack>(tracks: readonly T[]): T[] =>
    tracks.map((track) => ({
      ...track,
      ...('parameterIdentity' in track && track.parameterIdentity !== undefined
        ? { parameterIdentity: { ...track.parameterIdentity } } : {}),
      keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, easing: { ...keyframe.easing } })),
    })))!
}

export function clipAnimationTrack(
  clip: Clip,
  property: ClipAnimationProperty,
): ClipAnimationTrack | null {
  return clipAnimation(clip).tracks.find((track) => track.property === property && (track.propertyVersion ?? 1) === 1) ?? null
}

export function isClipPropertyAnimated(
  clip: Clip,
  property: ClipAnimationProperty,
): boolean {
  return clipAnimationTrack(clip, property) !== null
}

export function isAudioAnimationProperty(
  property: string,
): property is (typeof ANIMATABLE_AUDIO_PROPERTIES)[number] {
  return property === 'volume' || property === 'balance'
}

export function isKnownClipAnimationProperty(property: string): property is ClipAnimationProperty {
  return PROPERTY_SET.has(property as ClipAnimationProperty)
}

function propertyIdentityError(property: string, version: number): string | null {
  if (typeof property !== 'string' || property.trim().length === 0 || property.length > MAX_ANIMATION_PROPERTY_CHARACTERS) return 'animation property name exceeds its bound'
  if (!Number.isSafeInteger(version) || version < 1) return 'animation property version must be a positive safe integer'
  return null
}

export function clipAnimationPropertyLabel(property: ClipAnimationProperty): string {
  return CLIP_SCALAR_PROPERTY_SPECS[property].label
}

export function readClipAnimationProperty(
  clip: Clip,
  property: ClipAnimationProperty,
): number {
  return readClipScalarProperty(clip, property)
}

export function animationPropertyValueError(
  property: ClipAnimationProperty,
  value: number,
): string | null {
  if (!Number.isFinite(value)) return `${property} value must be finite`
  const spec = CLIP_SCALAR_PROPERTY_SPECS[property]
  if (value < spec.min || value > spec.max) {
    if (spec.min === -MAX_ANIMATED_FINITE_MAGNITUDE) return `${property} keyframe value exceeds the finite project bound`
    return `${property} keyframe value must be from ${spec.min} to ${spec.max}`
  }
  return null
}

export function animationTrackValidationError(
  track: ClipAnimationTrack,
): string | null {
  const identityError = propertyIdentityError(track.property, track.propertyVersion ?? 1)
  if (identityError) return identityError
  return keyframesValidationError(
    track.keyframes,
    (value) => isKnownClipAnimationProperty(track.property) && (track.propertyVersion ?? 1) === 1
      ? animationPropertyValueError(track.property, value)
      : !Number.isFinite(value) || Math.abs(value) > MAX_ANIMATED_FINITE_MAGNITUDE
        ? 'unavailable scalar exceeds the finite project bound' : null,
  )
}

export function effectAnimationTrackValidationError(
  track: EffectAnimationTrack,
): string | null {
  if (
    typeof track.effectId !== 'string'
    || track.effectId.trim().length === 0
    || track.effectId.length > EFFECT_STACK_LIMITS.maxIdCharacters
  ) return 'effect id is missing or exceeds its bound'
  if (
    typeof track.parameter !== 'string'
    || track.parameter.trim().length === 0
    || track.parameter.length > EFFECT_STACK_LIMITS.maxTypeAndParamKeyCharacters
  ) return 'effect parameter is missing or exceeds its bound'
  if (track.parameterIdentity !== undefined) {
    const identityError = animationParameterIdentityError(track.parameterIdentity)
    if (identityError) return identityError
  }
  return keyframesValidationError(track.keyframes, (value) =>
    !Number.isFinite(value) || Math.abs(value) > MAX_ANIMATED_FINITE_MAGNITUDE
      ? 'effect keyframe value exceeds the finite project bound'
      : null,
  )
}

/** Placement rules for durable animation on video vs audio vs text clips. */
export function clipAnimationKindError(
  trackKind: TrackKind,
  isText: boolean,
  animation: ClipAnimation,
): string | null {
  const hasTracks = animation.tracks.length > 0
    || effectAnimationTracks(animation).length > 0
    || titleAnimationTracks(animation).length > 0
    || effectPathAnimationTracks(animation).length > 0
  if (!hasTracks) return null
  if (isText) {
    if (animation.tracks.some((track) => isKnownClipAnimationProperty(track.property)
      && track.property !== 'opacity')) return 'title clips support only outer opacity animation'
    return null
  }
  if (trackKind === 'video') return null
  if (trackKind !== 'audio') return 'keyframes are supported only on visual media clips'
  if (effectAnimationTracks(animation).length > 0 || effectPathAnimationTracks(animation).length > 0 || titleAnimationTracks(animation).length > 0) {
    return 'effect keyframes are supported only on visual media clips'
  }
  for (const track of animation.tracks) {
    if (isKnownClipAnimationProperty(track.property) && !isAudioAnimationProperty(track.property)) {
      return 'audio clips support only volume and balance keyframes'
    }
  }
  return null
}

export function clipAnimationValidationError(animation: ClipAnimation): string | null {
  if (animation.tracks.length > MAX_CLIP_SCALAR_ANIMATION_TRACKS) {
    return `clip animation exceeds ${MAX_CLIP_SCALAR_ANIMATION_TRACKS} property tracks`
  }
  const properties = new Set<string>()
  for (const track of animation.tracks) {
    if (properties.has(track.property)) return `duplicate ${track.property} animation track`
    properties.add(track.property)
    const error = animationTrackValidationError(track)
    if (error) return `${track.property}: ${error}`
  }
  const effectTracks = effectAnimationTracks(animation)
  if (effectTracks.length > MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP) {
    return `clip animation exceeds ${MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP} effect tracks`
  }
  const targets = new Map<string, Set<string>>()
  for (const track of effectTracks) {
    const parameters = targets.get(track.effectId) ?? new Set<string>()
    if (parameters.has(track.parameter)) {
      return `duplicate ${track.effectId}.${track.parameter} effect animation track`
    }
    parameters.add(track.parameter)
    targets.set(track.effectId, parameters)
    const error = effectAnimationTrackValidationError(track)
    if (error) return `${track.effectId}.${track.parameter}: ${error}`
  }
  const paths = effectPathAnimationTracks(animation)
  const pathError = effectPathAnimationTracksBoundsError(paths)
  if (pathError) return pathError
  for (const track of paths) {
    if (targets.get(track.effectId)?.has(track.parameter)) return 'scalar and path tracks cannot compete for one effect parameter'
  }
  const titleTracks = titleAnimationTracks(animation)
  if (titleTracks.length > MAX_TITLE_ANIMATION_TRACKS) return 'title animation exceeds 256 tracks'
  const titleTargets = new Map<string, Set<string>>()
  for (const track of titleTracks) {
    if (typeof track.elementId !== 'string' || !track.elementId.trim() || track.elementId.length > EFFECT_STACK_LIMITS.maxIdCharacters) return 'title element id exceeds its bound'
    const identityError = propertyIdentityError(track.property, track.propertyVersion)
    if (identityError) return identityError
    const properties = titleTargets.get(track.elementId) ?? new Set<string>()
    if (properties.has(track.property)) return 'duplicate title element property; versions cannot compete'
    properties.add(track.property)
    titleTargets.set(track.elementId, properties)
    const keyError = keyframesValidationError(track.keyframes, (value) =>
      !Number.isFinite(value) || Math.abs(value) > MAX_ANIMATED_FINITE_MAGNITUDE ? 'title scalar exceeds finite bound' : null)
    if (keyError) return keyError
  }
  return null
}

function applyAnimatedValues(
  clip: Clip,
  values: ReadonlyMap<ClipAnimationProperty, number>,
): Clip {
  let transform: Transform | null = null
  let opacity = clip.opacity
  let volume = clip.volume
  let audio: ClipAudioSettings | undefined
  let visual: Clip['visual'] | undefined
  for (const [property, value] of values) {
    switch (property) {
      case 'opacity':
        opacity = value
        break
      case 'volume':
        volume = value
        break
      case 'balance':
        audio ??= { ...clipAudioSettings(clip) }
        audio.balance = value
        break
      case 'crop-left':
      case 'crop-right':
      case 'crop-top':
      case 'crop-bottom': {
        visual ??= { ...clipVisualSettings(clip), crop: { ...clipVisualSettings(clip).crop } }
        visual.crop[property.slice(5) as 'left' | 'right' | 'top' | 'bottom'] = value
        break
      }
      case 'position-x':
        transform ??= { ...clip.transform }
        transform.x = value
        break
      case 'position-y':
        transform ??= { ...clip.transform }
        transform.y = value
        break
      case 'scale-x':
        transform ??= { ...clip.transform }
        transform.scaleX = value
        break
      case 'scale-y':
        transform ??= { ...clip.transform }
        transform.scaleY = value
        break
      case 'rotation':
        transform ??= { ...clip.transform }
        transform.rotation = value
        break
    }
  }
  if (
    transform === null
    && opacity === clip.opacity
    && volume === clip.volume
    && audio === undefined
    && visual === undefined
  ) return clip
  return {
    ...clip,
    transform: transform ?? clip.transform,
    opacity,
    volume,
    ...(audio === undefined ? {} : { audio }),
    // In-memory callers that bypass admission cannot emit an invalid rectangle.
    ...(visual === undefined || cropInsetsValidationError(visual.crop) ? {} : { visual }),
  }
}

function applyAnimatedEffectValues(
  clip: Clip,
  tracks: readonly EffectAnimationTrack[],
  localFrame: number,
): Clip {
  if (tracks.length === 0) return clip
  let effects: EffectDescriptor[] | null = null
  for (let effectIndex = 0; effectIndex < clip.effects.length; effectIndex++) {
    const effect = clip.effects[effectIndex]
    const targeted = tracks.filter((track) => track.effectId === effect.id)
    if (targeted.length === 0) continue
    const params = { ...effect.params }
    let changed = false
    for (const track of targeted) {
      // Bound identities belong to plugin declarations, never to this built-in resolver.
      if (track.parameterIdentity !== undefined) continue
      const spec = effectAnimationParameterSpec(effect, track.parameter)
      const fallback = params[track.parameter]
      if (!spec || typeof fallback !== 'number') continue
      if (track.keyframes.some((keyframe) => (
        keyframe.value < spec.min || keyframe.value > spec.max
      ))) continue
      const value = evaluateAnimationTrack(track, localFrame, fallback)
      if (value < spec.min || value > spec.max || value === fallback) continue
      params[track.parameter] = value
      changed = true
    }
    if (!changed) continue
    const resolved = { ...effect, params }
    if (effectParamsValidationError(resolved)) continue
    effects ??= clip.effects.slice()
    effects[effectIndex] = resolved
  }
  return effects === null ? clip : { ...clip, effects }
}

/** Shared pure resolver used by Inspector, Program Monitor, preview, and export. */
export function resolveClipAnimationAtFrame(clip: Clip, timelineFrame: number): Clip {
  if (!Number.isSafeInteger(timelineFrame)) return clip
  const animation = clipAnimation(clip)
  if (
    (animation.tracks.length === 0 && effectAnimationTracks(animation).length === 0 && effectPathAnimationTracks(animation).length === 0)
    || clipAnimationValidationError(animation)
  ) return clip
  const localFrame = timelineFrame - clip.timelineRange.startFrame
  if (!Number.isSafeInteger(localFrame)) return clip
  const values = new Map<ClipAnimationProperty, number>()
  for (const track of animation.tracks) {
    if (!isKnownClipAnimationProperty(track.property) || (track.propertyVersion ?? 1) !== 1) continue
    const fallback = readClipAnimationProperty(clip, track.property)
    values.set(
      track.property,
      evaluateAnimationTrack(track, localFrame, fallback),
    )
  }
  const resolved = applyAnimatedEffectValues(
    applyAnimatedValues(clip, values),
    effectAnimationTracks(animation),
    localFrame,
  )
  return resolveEffectPathAnimation(resolved, effectPathAnimationTracks(animation), localFrame)
}

function replaceTrack(
  animation: ClipAnimation,
  property: ClipAnimationProperty,
  nextTrack: ClipAnimationTrack | null,
): ClipAnimation {
  const tracks = animation.tracks.filter((track) => track.property !== property)
  if (nextTrack) tracks.push(nextTrack)
  tracks.sort(
    (left, right) => ANIMATABLE_CLIP_PROPERTIES.indexOf(left.property as ClipAnimationProperty)
      - ANIMATABLE_CLIP_PROPERTIES.indexOf(right.property as ClipAnimationProperty),
  )
  return { ...animation, tracks, effectTracks: [...effectAnimationTracks(animation)] }
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
  if (existing && (existing.propertyVersion ?? 1) !== 1) return null
  const keyframes = (existing?.keyframes ?? [])
    .filter((item) => item.frame !== keyframe.frame)
    .map((item) => ({ ...item, easing: cloneAnimationEasing(item.easing) }))
  keyframes.push({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) })
  keyframes.sort((left, right) => left.frame - right.frame)
  if (keyframes.length > MAX_KEYFRAMES_PER_TRACK) return null
  return replaceTrack(animation, property, { ...existing, property, keyframes })
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
  if (!track || !source || (track.propertyVersion ?? 1) !== 1) return null
  if (fromFrame === toFrame) return animation
  const remainingKeyframes = track.keyframes
    .filter((keyframe) => keyframe.frame !== fromFrame)
    .map((keyframe) => ({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) }))
  const withoutSource = replaceTrack(
    animation,
    property,
    remainingKeyframes.length === 0
      ? null
      : { ...track, property, keyframes: remainingKeyframes },
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
    keyframes.length === 0 ? null : { ...track, property, keyframes },
  )
}

export function removeAnimationTrack(
  animation: ClipAnimation,
  property: ClipAnimationProperty,
): ClipAnimation | null {
  if (!animation.tracks.some((track) => track.property === property)) return null
  return replaceTrack(animation, property, null)
}

export function effectAnimationTrack(
  animation: ClipAnimation,
  effectId: string,
  parameter: string,
): EffectAnimationTrack | null {
  return effectAnimationTracks(animation).find((track) =>
    track.effectId === effectId && track.parameter === parameter,
  ) ?? null
}

function replaceEffectTrack(
  animation: ClipAnimation,
  effectId: string,
  parameter: string,
  nextTrack: EffectAnimationTrack | null,
): ClipAnimation {
  const effectTracks = effectAnimationTracks(animation).filter((track) =>
    track.effectId !== effectId || track.parameter !== parameter,
  )
  if (nextTrack) effectTracks.push(nextTrack)
  effectTracks.sort((left, right) => {
    const idOrder = left.effectId.localeCompare(right.effectId)
    return idOrder !== 0 ? idOrder : left.parameter.localeCompare(right.parameter)
  })
  return {
    ...animation,
    tracks: animation.tracks.map((track) => ({
      ...track,
      keyframes: track.keyframes.map((keyframe) => ({
        ...keyframe,
        easing: cloneAnimationEasing(keyframe.easing),
      })),
    })),
    effectTracks,
  }
}

export function upsertEffectAnimationKeyframe(
  animation: ClipAnimation,
  effect: EffectDescriptor,
  parameter: string,
  keyframe: ClipAnimationKeyframe,
): ClipAnimation | null {
  const spec = effectAnimationParameterSpec(effect, parameter)
  if (!spec || keyframe.value < spec.min || keyframe.value > spec.max) return null
  if (animationEasingValidationError(keyframe.easing)) return null
  if (
    !Number.isSafeInteger(keyframe.frame)
    || keyframe.frame < -MAX_KEYFRAME_FRAME
    || keyframe.frame > MAX_KEYFRAME_FRAME
    || clipAnimationValidationError(animation)
  ) return null
  const existing = effectAnimationTrack(animation, effect.id, parameter)
  if (existing?.parameterIdentity !== undefined
    || effectPathAnimationTracks(animation).some((track) => track.effectId === effect.id && track.parameter === parameter)) return null
  const keyframes = (existing?.keyframes ?? [])
    .filter((item) => item.frame !== keyframe.frame)
    .map((item) => ({ ...item, easing: cloneAnimationEasing(item.easing) }))
  keyframes.push({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) })
  keyframes.sort((left, right) => left.frame - right.frame)
  if (keyframes.length > MAX_KEYFRAMES_PER_TRACK) return null
  if (!existing && effectAnimationTracks(animation).length >= MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP) {
    return null
  }
  return replaceEffectTrack(animation, effect.id, parameter, {
    ...existing,
    effectId: effect.id,
    parameter,
    keyframes,
  })
}

export function moveEffectAnimationKeyframe(
  animation: ClipAnimation,
  effect: EffectDescriptor,
  parameter: string,
  fromFrame: number,
  toFrame: number,
): ClipAnimation | null {
  const track = effectAnimationTrack(animation, effect.id, parameter)
  const source = track?.keyframes.find((keyframe) => keyframe.frame === fromFrame)
  if (!track || !source || track.parameterIdentity !== undefined) return null
  if (fromFrame === toFrame) return animation
  const remaining = track.keyframes
    .filter((keyframe) => keyframe.frame !== fromFrame)
    .map((keyframe) => ({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) }))
  const withoutSource = replaceEffectTrack(
    animation,
    effect.id,
    parameter,
    remaining.length === 0 ? null : { ...track, keyframes: remaining },
  )
  return upsertEffectAnimationKeyframe(withoutSource, effect, parameter, {
    ...source,
    frame: toFrame,
  })
}

export function removeEffectAnimationKeyframe(
  animation: ClipAnimation,
  effectId: string,
  parameter: string,
  frame: number,
): ClipAnimation | null {
  const track = effectAnimationTrack(animation, effectId, parameter)
  if (!track || !track.keyframes.some((keyframe) => keyframe.frame === frame)) return null
  const keyframes = track.keyframes
    .filter((keyframe) => keyframe.frame !== frame)
    .map((keyframe) => ({ ...keyframe, easing: cloneAnimationEasing(keyframe.easing) }))
  return replaceEffectTrack(
    animation,
    effectId,
    parameter,
    keyframes.length === 0 ? null : { ...track, keyframes },
  )
}

export function removeEffectAnimationTracks(
  animation: ClipAnimation,
  effectId: string,
  parameters?: ReadonlySet<string>,
): ClipAnimation {
  return {
    ...animation,
    tracks: animation.tracks.map((track) => ({
      ...track,
      keyframes: track.keyframes.map((keyframe) => ({
        ...keyframe,
        easing: cloneAnimationEasing(keyframe.easing),
      })),
    })),
    effectTracks: effectAnimationTracks(animation)
      .filter((track) => track.effectId !== effectId || (
        parameters !== undefined && !parameters.has(track.parameter)
      ))
      .map((track) => ({
        ...track,
        keyframes: track.keyframes.map((keyframe) => ({
          ...keyframe,
          easing: cloneAnimationEasing(keyframe.easing),
        })),
      })),
    ...(animation.effectPathTracks === undefined ? {} : {
      effectPathTracks: animation.effectPathTracks.filter((track) => track.effectId !== effectId
        || (parameters !== undefined && !parameters.has(track.parameter))),
    }),
  }
}

export function remapEffectAnimationIds(
  animation: ClipAnimation,
  replacements: ReadonlyMap<string, string>,
): ClipAnimation {
  const cloned = cloneClipAnimation(animation)
  cloned.effectTracks = effectAnimationTracks(cloned).map((track) => ({
    ...track,
    effectId: replacements.get(track.effectId) ?? track.effectId,
  }))
  if (cloned.effectPathTracks) cloned.effectPathTracks = cloned.effectPathTracks.map((track) => ({
    ...track, effectId: replacements.get(track.effectId) ?? track.effectId,
  }))
  return cloned
}

/** Shift a clip-local animation origin while retaining exact curve geometry. */
export function shiftClipAnimation(
  animation: ClipAnimation,
  deltaFrames: number,
): ClipAnimation | null {
  if (!Number.isSafeInteger(deltaFrames) || clipAnimationValidationError(animation)) return null
  const shiftTracks = <T extends AnyAnimationTrack>(
    sourceTracks: readonly T[],
  ): T[] | null => mapAnimationTrackKeyframes(sourceTracks, (keyframe) => {
    const frame = keyframe.frame + deltaFrames
    if (
      !Number.isSafeInteger(frame)
      || frame < -MAX_KEYFRAME_FRAME
      || frame > MAX_KEYFRAME_FRAME
    ) return null
    return { ...keyframe, frame, easing: { ...keyframe.easing } }
  })
  return mapAnimationCollections(animation, shiftTracks)
}
