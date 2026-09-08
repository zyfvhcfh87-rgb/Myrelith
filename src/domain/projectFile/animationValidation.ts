/** One portable animation boundary for clips and item-local adjustments. */
import { titlePayloadBudget } from '../titleBudgets'
import type { ClipAnimation, ClipAnimationEasing } from '../schema'
import { clipAnimationValidationError, MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP } from '../clipAnimation'
import { MAX_ANIMATION_PROPERTY_CHARACTERS, MAX_CLIP_SCALAR_ANIMATION_TRACKS, MAX_TITLE_ANIMATION_TRACKS } from '../animationCollections'
import { animationParameterIdentityError } from '../animationParameterIdentity'
import { effectPathAnimationTrackBoundsError, MASK_PATH_ANIMATION_LIMITS } from '../maskPathAnimation'
import { MAX_KEYFRAME_FRAME, MAX_KEYFRAMES_PER_TRACK, MAX_ANIMATED_FINITE_MAGNITUDE } from '../scalarAnimation'
import { PROJECT_FILE_LIMITS } from './projectTypes'
import { boundedArray, exactKeys, fail, finiteNumber, record, safeInteger, stringValue } from './validationPrimitives'

export interface AnimationValidationCounts {
  keyframeCount: number
  pathKeyframeCount: number
  pathValueCharacters: number
}

export function validateAnimationEasing(value: unknown, path: string): asserts value is ClipAnimationEasing {
  const easing = record(value, path)
  if (easing.type === 'linear' || easing.type === 'hold') {
    exactKeys(easing, ['type'], [], path)
    return
  }
  if (easing.type !== 'cubic-bezier') fail(`${path}.type`, 'expected hold, linear, or cubic-bezier')
  exactKeys(easing, ['type', 'x1', 'y1', 'x2', 'y2'], [], path)
  for (const key of ['x1', 'y1', 'x2', 'y2'] as const) finiteNumber(easing[key], `${path}.${key}`, 0, 1)
}

export function validatePortableAnimation(
  value: unknown,
  path: string,
  context: AnimationValidationCounts,
  sourceTicks: 'required' | 'forbidden',
): asserts value is ClipAnimation {
  const animation = record(value, path)
  exactKeys(animation, ['tracks', 'effectTracks'], ['titleTracks', 'effectPathTracks'], path)
  const collections = [
    ['tracks', MAX_CLIP_SCALAR_ANIMATION_TRACKS],
    ['effectTracks', MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP],
    ['titleTracks', MAX_TITLE_ANIMATION_TRACKS],
    ['effectPathTracks', MASK_PATH_ANIMATION_LIMITS.tracksPerClip],
  ] as const
  // All collection/key counts are admitted before any key payload traversal.
  for (const [name, limit] of collections) {
    if (animation[name] === undefined && (name === 'titleTracks' || name === 'effectPathTracks')) continue
    const tracks = animation[name]
    boundedArray(tracks, `${path}.${name}`, limit)
    for (let index = 0; index < tracks.length; index++) {
      const trackPath = `${path}.${name}[${index}]`
      const track = record(tracks[index], trackPath)
      boundedArray(track.keyframes, `${trackPath}.keyframes`, name === 'effectPathTracks' ? MASK_PATH_ANIMATION_LIMITS.keysPerTrack : MAX_KEYFRAMES_PER_TRACK)
      if (track.keyframes.length === 0) fail(trackPath, 'animation tracks require at least one keyframe')
      context.keyframeCount += track.keyframes.length
      if (context.keyframeCount > PROJECT_FILE_LIMITS.maxTotalKeyframes) fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxTotalKeyframes} keyframes in total`)
      if (name === 'effectPathTracks') {
        context.pathKeyframeCount += track.keyframes.length
        if (context.pathKeyframeCount > MASK_PATH_ANIMATION_LIMITS.projectKeys) fail('$.sequences', 'exceeds 4,096 path keys')
      }
    }
  }
  for (const [name] of collections) {
    const tracks = animation[name] as unknown[] | undefined
    if (!tracks) continue
    for (let index = 0; index < tracks.length; index++) {
      const trackPath = `${path}.${name}[${index}]`
      const track = record(tracks[index], trackPath)
      const pathTrack = name === 'effectPathTracks'
      if (pathTrack) {
        const error = effectPathAnimationTrackBoundsError(track, sourceTicks === 'required')
        if (error) fail(trackPath, error)
      } else if (name === 'effectTracks') {
        exactKeys(track, ['effectId', 'parameter', 'keyframes'], ['parameterIdentity'], trackPath)
        stringValue(track.effectId, `${trackPath}.effectId`, PROJECT_FILE_LIMITS.maxIdCharacters)
        stringValue(track.parameter, `${trackPath}.parameter`, MAX_ANIMATION_PROPERTY_CHARACTERS)
        if (track.parameterIdentity !== undefined) {
          const error = animationParameterIdentityError(track.parameterIdentity)
          if (error) fail(`${trackPath}.parameterIdentity`, error)
        }
      } else {
        exactKeys(track, name === 'tracks' ? ['property', 'keyframes'] : ['elementId', 'propertyVersion', 'property', 'keyframes'], name === 'tracks' ? ['propertyVersion'] : [], trackPath)
        stringValue(track.property, `${trackPath}.property`, MAX_ANIMATION_PROPERTY_CHARACTERS)
        if (name === 'titleTracks') stringValue(track.elementId, `${trackPath}.elementId`, PROJECT_FILE_LIMITS.maxIdCharacters)
        if (track.propertyVersion !== undefined) safeInteger(track.propertyVersion, `${trackPath}.propertyVersion`, 1)
      }
      const keys = track.keyframes as unknown[]
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
        const keyPath = `${trackPath}.keyframes[${keyIndex}]`
        const key = record(keys[keyIndex], keyPath)
        exactKeys(key, sourceTicks === 'required' ? ['frame', 'sourceTimeTicks', 'value', 'easing'] : ['frame', 'value', 'easing'], [], keyPath)
        safeInteger(key.frame, `${keyPath}.frame`, -MAX_KEYFRAME_FRAME, MAX_KEYFRAME_FRAME)
        if (sourceTicks === 'required') safeInteger(key.sourceTimeTicks, `${keyPath}.sourceTimeTicks`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
        if (pathTrack) {
          // The path adapter already bounded the string. Count opaque values too.
          context.pathValueCharacters += (key.value as string).length
          if (context.pathValueCharacters > MASK_PATH_ANIMATION_LIMITS.projectValueCharacters) fail('$.sequences', 'exceeds 1,048,576 path-value characters')
        } else {
          finiteNumber(key.value, `${keyPath}.value`, -MAX_ANIMATED_FINITE_MAGNITUDE, MAX_ANIMATED_FINITE_MAGNITUDE)
          validateAnimationEasing(key.easing, `${keyPath}.easing`)
        }
      }
    }
  }
  const error = clipAnimationValidationError(animation as unknown as ClipAnimation)
  if (error) fail(path, error)
  const titleTracks = (animation as unknown as ClipAnimation).titleTracks
  if (titleTracks !== undefined) {
    const budget = titlePayloadBudget({ titleTracks })
    if (!budget.ok) fail(`${path}.titleTracks`, budget.reason)
  }
}
