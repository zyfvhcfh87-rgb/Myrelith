import type { AudioEffectDescriptor, Clip, ClipAnimation, ClipAnimationEasing, ClipAnimationProperty, ClipAudioSettings, ClipVisualSettings, Effect, FrameRate, SourceTimeMap, SourceTimeSpeedCurve, TextProps, Track, Transform } from '../schema';
import {
  ANIMATABLE_CLIP_PROPERTIES,
  clipAnimationKindError,
  clipAnimationValidationError,
  defaultClipAnimation,
  MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP,
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  MAX_KEYFRAMES_PER_TRACK,
} from '../clipAnimation';
import {
  clipAudioSettingsValidationError,
  clipVisualSettingsValidationError,
  MAX_AUDIO_BALANCE,
  MAX_CLIP_SCALE,
  MAX_CLIP_VOLUME,
  MIN_AUDIO_BALANCE,
  MIN_CLIP_SCALE,
  MIN_CLIP_VOLUME,
} from '../clipInspector';
import { microsecondsDurationToFrames } from '../time';
import { isProceduralTextAssetId, isSupportedTextColor, isSupportedTextFontFamily, TEXT_OVERLAY_LIMITS, textPropsValidationError, proceduralTextAssetId } from '../textOverlay';
import { blendModeIntentValidationError } from '../blendModes';
import { effectDescriptorBoundsError, effectDescriptorBudget } from '../effectBounds';
import { audioEffectDescriptorBudget } from '../audioEffectBounds';
import { sourceRangeForMap, sourceTimeSpeedCurveValidationError, sourceTimeMapValidationError, MAX_SOURCE_TIME_SPEED_FRAME, SOURCE_TIME_SPEED_EASINGS, SOURCE_TIME_TICKS_PER_FRAME } from '../sourceTimeMap';
import { PROJECT_FILE_LIMITS, type PortableAssetDescriptor } from './projectTypes';
import { booleanValue, boundedArray, exactKeys, fail, finiteNumber, record, safeInteger, stringValue, validateLensCorrectionIntent } from './validationPrimitives';

export function validateRange(value: unknown, path: string, minimumDuration: number): void {
  const range = record(value, path)
  exactKeys(range, ['startFrame', 'durationFrames'], [], path)
  safeInteger(range.startFrame, `${path}.startFrame`, 0)
  safeInteger(range.durationFrames, `${path}.durationFrames`, minimumDuration)
  if (!Number.isSafeInteger(range.startFrame + range.durationFrames)) {
    fail(path, 'range end exceeds safe integer precision')
  }
}

export function validateTransform(value: unknown, path: string): asserts value is Transform {
  const transform = record(value, path)
  exactKeys(
    transform,
    ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY'],
    [],
    path,
  )
  const magnitude = PROJECT_FILE_LIMITS.maxFiniteMagnitude
  finiteNumber(transform.x, `${path}.x`, -magnitude, magnitude)
  finiteNumber(transform.y, `${path}.y`, -magnitude, magnitude)
  finiteNumber(transform.scaleX, `${path}.scaleX`, MIN_CLIP_SCALE, MAX_CLIP_SCALE)
  finiteNumber(transform.scaleY, `${path}.scaleY`, MIN_CLIP_SCALE, MAX_CLIP_SCALE)
  finiteNumber(transform.rotation, `${path}.rotation`, -magnitude, magnitude)
  finiteNumber(transform.anchorX, `${path}.anchorX`, 0, 1)
  finiteNumber(transform.anchorY, `${path}.anchorY`, 0, 1)
}

export function validateClipVisual(
  value: unknown,
  path: string,
): asserts value is ClipVisualSettings {
  const visual = record(value, path)
  exactKeys(
    visual,
    ['crop', 'flipHorizontal', 'flipVertical', 'scaleLocked'],
    [],
    path,
  )
  const crop = record(visual.crop, `${path}.crop`)
  exactKeys(crop, ['left', 'right', 'top', 'bottom'], [], `${path}.crop`)
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    finiteNumber(crop[edge], `${path}.crop.${edge}`, 0, 0.99)
  }
  booleanValue(visual.flipHorizontal, `${path}.flipHorizontal`)
  booleanValue(visual.flipVertical, `${path}.flipVertical`)
  booleanValue(visual.scaleLocked, `${path}.scaleLocked`)
  const error = clipVisualSettingsValidationError(
    visual as unknown as ClipVisualSettings,
  )
  if (error) fail(path, error)
}

export function validateClipAudio(
  value: unknown,
  path: string,
  clipDurationFrames: number,
): asserts value is ClipAudioSettings {
  const audio = record(value, path)
  exactKeys(
    audio,
    ['enabled', 'balance', 'fadeInFrames', 'fadeOutFrames'],
    [],
    path,
  )
  booleanValue(audio.enabled, `${path}.enabled`)
  finiteNumber(audio.balance, `${path}.balance`, -1, 1)
  safeInteger(audio.fadeInFrames, `${path}.fadeInFrames`, 0, clipDurationFrames)
  safeInteger(audio.fadeOutFrames, `${path}.fadeOutFrames`, 0, clipDurationFrames)
  const error = clipAudioSettingsValidationError(
    audio as unknown as ClipAudioSettings,
    clipDurationFrames,
  )
  if (error) fail(path, error)
}

export function validateAnimationEasing(
  value: unknown,
  path: string,
): asserts value is ClipAnimationEasing {
  const easing = record(value, path)
  if (easing.type === 'linear' || easing.type === 'hold') {
    exactKeys(easing, ['type'], [], path)
    return
  }
  if (easing.type !== 'cubic-bezier') {
    fail(`${path}.type`, 'expected hold, linear, or cubic-bezier')
  }
  exactKeys(easing, ['type', 'x1', 'y1', 'x2', 'y2'], [], path)
  for (const key of ['x1', 'y1', 'x2', 'y2'] as const) {
    finiteNumber(easing[key], `${path}.${key}`, 0, 1)
  }
}

export function validateClipAnimation(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is ClipAnimation {
  const animation = record(value, path)
  exactKeys(animation, ['tracks', 'effectTracks'], [], path)
  boundedArray(
    animation.tracks,
    `${path}.tracks`,
    ANIMATABLE_CLIP_PROPERTIES.length,
  )
  const properties = new Set<ClipAnimationProperty>()
  for (let trackIndex = 0; trackIndex < animation.tracks.length; trackIndex++) {
    const trackPath = `${path}.tracks[${trackIndex}]`
    const track = record(animation.tracks[trackIndex], trackPath)
    exactKeys(track, ['property', 'keyframes'], [], trackPath)
    if (
      typeof track.property !== 'string'
      || !ANIMATABLE_CLIP_PROPERTIES.includes(
        track.property as ClipAnimationProperty,
      )
    ) {
      fail(`${trackPath}.property`, 'unsupported animated property')
    }
    const property = track.property as ClipAnimationProperty
    if (properties.has(property)) fail(`${trackPath}.property`, 'duplicate animation track')
    properties.add(property)
    boundedArray(track.keyframes, `${trackPath}.keyframes`, MAX_KEYFRAMES_PER_TRACK)
    if (track.keyframes.length === 0) fail(`${trackPath}.keyframes`, 'must not be empty')
    context.keyframeCount += track.keyframes.length
    if (context.keyframeCount > PROJECT_FILE_LIMITS.maxTotalKeyframes) {
      fail(
        '$.sequences',
        `exceeds ${PROJECT_FILE_LIMITS.maxTotalKeyframes} keyframes in total`,
      )
    }
    let previousFrame: number | null = null
    for (let keyframeIndex = 0; keyframeIndex < track.keyframes.length; keyframeIndex++) {
      const keyframePath = `${trackPath}.keyframes[${keyframeIndex}]`
      const keyframe = record(track.keyframes[keyframeIndex], keyframePath)
      exactKeys(
        keyframe,
        ['frame', 'sourceTimeTicks', 'value', 'easing'],
        [],
        keyframePath,
      )
      safeInteger(
        keyframe.frame,
        `${keyframePath}.frame`,
        -MAX_KEYFRAME_FRAME,
        MAX_KEYFRAME_FRAME,
      )
      safeInteger(
        keyframe.sourceTimeTicks,
        `${keyframePath}.sourceTimeTicks`,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      )
      if (previousFrame !== null && keyframe.frame <= previousFrame) {
        fail(`${keyframePath}.frame`, 'must be strictly increasing and unique')
      }
      const minimum = property === 'opacity' ? 0
        : property === 'volume' ? MIN_CLIP_VOLUME
          : property === 'balance' ? MIN_AUDIO_BALANCE
            : property === 'scale-x' || property === 'scale-y' ? MIN_CLIP_SCALE
              : -MAX_ANIMATED_FINITE_MAGNITUDE
      const maximum = property === 'opacity' ? 1
        : property === 'volume' ? MAX_CLIP_VOLUME
          : property === 'balance' ? MAX_AUDIO_BALANCE
            : property === 'scale-x' || property === 'scale-y' ? MAX_CLIP_SCALE
              : MAX_ANIMATED_FINITE_MAGNITUDE
      finiteNumber(keyframe.value, `${keyframePath}.value`, minimum, maximum)
      validateAnimationEasing(keyframe.easing, `${keyframePath}.easing`)
      previousFrame = keyframe.frame
    }
  }
  boundedArray(
    animation.effectTracks,
    `${path}.effectTracks`,
    MAX_EFFECT_ANIMATION_TRACKS_PER_CLIP,
  )
  const effectTargets = new Set<string>()
  for (let trackIndex = 0; trackIndex < animation.effectTracks.length; trackIndex++) {
    const trackPath = `${path}.effectTracks[${trackIndex}]`
    const track = record(animation.effectTracks[trackIndex], trackPath)
    exactKeys(track, ['effectId', 'parameter', 'keyframes'], [], trackPath)
    stringValue(track.effectId, `${trackPath}.effectId`, PROJECT_FILE_LIMITS.maxIdCharacters)
    stringValue(track.parameter, `${trackPath}.parameter`, PROJECT_FILE_LIMITS.maxNameCharacters)
    const target = `${String(track.effectId)}\u0000${String(track.parameter)}`
    if (effectTargets.has(target)) fail(trackPath, 'duplicate effect animation track')
    effectTargets.add(target)
    boundedArray(track.keyframes, `${trackPath}.keyframes`, MAX_KEYFRAMES_PER_TRACK)
    if (track.keyframes.length === 0) fail(`${trackPath}.keyframes`, 'must not be empty')
    context.keyframeCount += track.keyframes.length
    if (context.keyframeCount > PROJECT_FILE_LIMITS.maxTotalKeyframes) {
      fail(
        '$.sequences',
        `exceeds ${PROJECT_FILE_LIMITS.maxTotalKeyframes} keyframes in total`,
      )
    }
    let previousFrame: number | null = null
    for (let keyframeIndex = 0; keyframeIndex < track.keyframes.length; keyframeIndex++) {
      const keyframePath = `${trackPath}.keyframes[${keyframeIndex}]`
      const keyframe = record(track.keyframes[keyframeIndex], keyframePath)
      exactKeys(
        keyframe,
        ['frame', 'sourceTimeTicks', 'value', 'easing'],
        [],
        keyframePath,
      )
      safeInteger(
        keyframe.frame,
        `${keyframePath}.frame`,
        -MAX_KEYFRAME_FRAME,
        MAX_KEYFRAME_FRAME,
      )
      safeInteger(
        keyframe.sourceTimeTicks,
        `${keyframePath}.sourceTimeTicks`,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      )
      if (previousFrame !== null && keyframe.frame <= previousFrame) {
        fail(`${keyframePath}.frame`, 'must be strictly increasing and unique')
      }
      finiteNumber(
        keyframe.value,
        `${keyframePath}.value`,
        -MAX_ANIMATED_FINITE_MAGNITUDE,
        MAX_ANIMATED_FINITE_MAGNITUDE,
      )
      validateAnimationEasing(keyframe.easing, `${keyframePath}.easing`)
      previousFrame = Number(keyframe.frame)
    }
  }
  const error = clipAnimationValidationError(animation as unknown as ClipAnimation)
  if (error) fail(path, error)
}

export function validateEffect(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is Effect {
  const effect = record(value, path)
  exactKeys(effect, ['id', 'type', 'version', 'enabled', 'params'], [], path)
  const boundsError = effectDescriptorBoundsError(effect)
  if (boundsError) fail(path, boundsError)
  const descriptor = effect as unknown as Effect
  if (context.effectIds.has(descriptor.id)) fail(`${path}.id`, 'duplicate effect id')
  context.effectIds.add(descriptor.id)
  const budget = effectDescriptorBudget(descriptor)
  context.effectParamCount += budget.params
  if (context.effectParamCount > PROJECT_FILE_LIMITS.maxTotalEffectParams) {
    fail(
      '$.sequences',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalEffectParams} effect parameters in total`,
    )
  }
  context.effectStringCharacterCount += budget.stringCharacters
  if (
    context.effectStringCharacterCount >
    PROJECT_FILE_LIMITS.maxTotalEffectStringCharacters
  ) {
    fail(
      '$.sequences',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalEffectStringCharacters} effect-string characters in total`,
    )
  }
}

export function validateAudioEffect(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is AudioEffectDescriptor {
  const effect = record(value, path)
  exactKeys(effect, ['id', 'type', 'version', 'enabled', 'params'], [], path)
  const boundsError = effectDescriptorBoundsError(effect)
  if (boundsError) fail(path, boundsError)
  const descriptor = effect as unknown as AudioEffectDescriptor
  if (context.audioEffectIds.has(descriptor.id)) {
    fail(`${path}.id`, 'duplicate audio effect id')
  }
  context.audioEffectIds.add(descriptor.id)
  const budget = audioEffectDescriptorBudget(descriptor)
  context.audioEffectParamCount += budget.params
  if (context.audioEffectParamCount > PROJECT_FILE_LIMITS.maxTotalAudioEffectParams) {
    fail(
      '$.sequences',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalAudioEffectParams} audio-effect parameters in total`,
    )
  }
  context.audioEffectStringCharacterCount += budget.stringCharacters
  if (
    context.audioEffectStringCharacterCount >
    PROJECT_FILE_LIMITS.maxTotalAudioEffectStringCharacters
  ) {
    fail(
      '$.sequences',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalAudioEffectStringCharacters} audio-effect-string characters in total`,
    )
  }
}

export function validateAudioEffectStack(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is AudioEffectDescriptor[] {
  boundedArray(value, path, PROJECT_FILE_LIMITS.maxAudioEffectsPerStack)
  context.audioEffectCount += value.length
  if (context.audioEffectCount > PROJECT_FILE_LIMITS.maxTotalAudioEffects) {
    fail(
      '$.sequences',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalAudioEffects} audio effects in total`,
    )
  }
  for (let index = 0; index < value.length; index++) {
    validateAudioEffect(value[index], `${path}[${index}]`, context)
  }
}

export function validateText(value: unknown, path: string): asserts value is TextProps {
  const text = record(value, path)
  exactKeys(
    text,
    [
      'content',
      'fontFamily',
      'fontSizePx',
      'color',
      'align',
      'bold',
      'italic',
      'boxWidthPx',
      'boxHeightPx',
      'paddingPx',
      'backgroundEnabled',
      'backgroundColor',
      'outlineEnabled',
      'outlineColor',
      'outlineWidthPx',
      'shadowEnabled',
      'shadowColor',
      'shadowBlurPx',
      'shadowOffsetXPx',
      'shadowOffsetYPx',
    ],
    [],
    path,
  )
  stringValue(text.content, `${path}.content`, PROJECT_FILE_LIMITS.maxTextCharacters, true)
  if (!isSupportedTextFontFamily(text.fontFamily)) {
    fail(`${path}.fontFamily`, 'expected a supported generic font family')
  }
  finiteNumber(
    text.fontSizePx,
    `${path}.fontSizePx`,
    TEXT_OVERLAY_LIMITS.minFontSizePx,
    TEXT_OVERLAY_LIMITS.maxFontSizePx,
  )
  if (!isSupportedTextColor(text.color)) {
    fail(`${path}.color`, 'expected a hexadecimal CSS color')
  }
  if (text.align !== 'left' && text.align !== 'center' && text.align !== 'right') {
    fail(`${path}.align`, 'expected left, center, or right')
  }
  booleanValue(text.bold, `${path}.bold`)
  booleanValue(text.italic, `${path}.italic`)
  finiteNumber(
    text.boxWidthPx,
    `${path}.boxWidthPx`,
    TEXT_OVERLAY_LIMITS.minBoxSizePx,
    TEXT_OVERLAY_LIMITS.maxBoxSizePx,
  )
  finiteNumber(
    text.boxHeightPx,
    `${path}.boxHeightPx`,
    TEXT_OVERLAY_LIMITS.minBoxSizePx,
    TEXT_OVERLAY_LIMITS.maxBoxSizePx,
  )
  finiteNumber(text.paddingPx, `${path}.paddingPx`, 0, TEXT_OVERLAY_LIMITS.maxPaddingPx)
  booleanValue(text.backgroundEnabled, `${path}.backgroundEnabled`)
  if (!isSupportedTextColor(text.backgroundColor)) {
    fail(`${path}.backgroundColor`, 'expected a hexadecimal CSS color')
  }
  booleanValue(text.outlineEnabled, `${path}.outlineEnabled`)
  if (!isSupportedTextColor(text.outlineColor)) {
    fail(`${path}.outlineColor`, 'expected a hexadecimal CSS color')
  }
  finiteNumber(
    text.outlineWidthPx,
    `${path}.outlineWidthPx`,
    0,
    TEXT_OVERLAY_LIMITS.maxOutlineWidthPx,
  )
  booleanValue(text.shadowEnabled, `${path}.shadowEnabled`)
  if (!isSupportedTextColor(text.shadowColor)) {
    fail(`${path}.shadowColor`, 'expected a hexadecimal CSS color')
  }
  finiteNumber(
    text.shadowBlurPx,
    `${path}.shadowBlurPx`,
    0,
    TEXT_OVERLAY_LIMITS.maxShadowBlurPx,
  )
  finiteNumber(
    text.shadowOffsetXPx,
    `${path}.shadowOffsetXPx`,
    -TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
    TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
  )
  finiteNumber(
    text.shadowOffsetYPx,
    `${path}.shadowOffsetYPx`,
    -TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
    TEXT_OVERLAY_LIMITS.maxShadowOffsetPx,
  )
  const error = textPropsValidationError(text as unknown as TextProps)
  if (error) fail(path, error)
}

export interface ValidationContext {
  assetIds: Set<string>
  assetsById: Map<string, PortableAssetDescriptor>
  documentFrameRate: FrameRate | null
  clipIds: Set<string>
  timelineItemIds: Set<string>
  effectIds: Set<string>
  audioEffectIds: Set<string>
  transitionIds: Set<string>
  linkGroupCounts: Map<string, number>
  clipCount: number
  adjustmentCount: number
  effectCount: number
  effectParamCount: number
  effectStringCharacterCount: number
  audioEffectCount: number
  audioEffectParamCount: number
  audioEffectStringCharacterCount: number
  textCharacterCount: number
  transitionCount: number
  keyframeCount: number
  speedPointCount: number
}

export function validateSourceTimeMap(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is SourceTimeMap {
  const map = record(value, path)
  exactKeys(map, ['sourceStartTicks', 'sourceDurationTicks', 'rate', 'speedCurve'], [], path)
  safeInteger(map.sourceStartTicks, `${path}.sourceStartTicks`, 0)
  safeInteger(map.sourceDurationTicks, `${path}.sourceDurationTicks`, 1)
  const rate = record(map.rate, `${path}.rate`)
  exactKeys(rate, ['numerator', 'denominator'], [], `${path}.rate`)
  safeInteger(rate.numerator, `${path}.rate.numerator`, 1)
  safeInteger(rate.denominator, `${path}.rate.denominator`, 1)
  const speedCurve = record(map.speedCurve, `${path}.speedCurve`)
  exactKeys(speedCurve, ['originFrame', 'points'], [], `${path}.speedCurve`)
  safeInteger(
    speedCurve.originFrame,
    `${path}.speedCurve.originFrame`,
    -MAX_SOURCE_TIME_SPEED_FRAME,
    MAX_SOURCE_TIME_SPEED_FRAME,
  )
  boundedArray(
    speedCurve.points,
    `${path}.speedCurve.points`,
    PROJECT_FILE_LIMITS.maxSpeedPointsPerClip,
  )
  context.speedPointCount += speedCurve.points.length
  if (context.speedPointCount > PROJECT_FILE_LIMITS.maxTotalSpeedPoints) {
    fail('$.sequences', `exceeds ${PROJECT_FILE_LIMITS.maxTotalSpeedPoints} speed points in total`)
  }
  for (let index = 0; index < speedCurve.points.length; index++) {
    const pointPath = `${path}.speedCurve.points[${index}]`
    const point = record(speedCurve.points[index], pointPath)
    exactKeys(point, ['frame', 'rate', 'easing'], [], pointPath)
    safeInteger(
      point.frame,
      `${pointPath}.frame`,
      -MAX_SOURCE_TIME_SPEED_FRAME,
      MAX_SOURCE_TIME_SPEED_FRAME,
    )
    const pointRate = record(point.rate, `${pointPath}.rate`)
    exactKeys(pointRate, ['numerator', 'denominator'], [], `${pointPath}.rate`)
    safeInteger(pointRate.numerator, `${pointPath}.rate.numerator`, 0)
    safeInteger(pointRate.denominator, `${pointPath}.rate.denominator`, 1)
    if (!(SOURCE_TIME_SPEED_EASINGS as readonly unknown[]).includes(point.easing)) {
      fail(`${pointPath}.easing`, 'expected hold, linear, or smooth')
    }
  }
  const curveError = sourceTimeSpeedCurveValidationError(
    speedCurve as unknown as SourceTimeSpeedCurve,
  )
  if (curveError) fail(`${path}.speedCurve`, curveError)
  const error = sourceTimeMapValidationError(map as unknown as SourceTimeMap)
  if (error) fail(path, error)
}

export function validateClip(value: unknown, path: string, trackKind: Track['kind'], context: ValidationContext): asserts value is Clip {
  const clip = record(value, path)
  exactKeys(
    clip,
    ['id', 'assetId', 'name', 'sourceMode', 'sourceRange', 'sourceTimeMap', 'timelineRange', 'transform', 'opacity', 'blendMode', 'volume', 'lensCorrection', 'visual', 'audio', 'effects', 'audioEffects'],
    ['animation', 'text', 'linkGroupId'],
    path,
  )
  stringValue(clip.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.clipIds.has(clip.id)) fail(`${path}.id`, 'duplicate clip id')
  context.clipIds.add(clip.id)
  if (context.timelineItemIds.has(clip.id)) fail(`${path}.id`, 'duplicate timeline item id')
  context.timelineItemIds.add(clip.id)
  stringValue(clip.assetId, `${path}.assetId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (
    clip.text !== undefined
    && clip.assetId !== proceduralTextAssetId(clip.id)
  ) {
    fail(`${path}.assetId`, 'text clips must use their reserved procedural asset id')
  }
  const asset = context.assetsById.get(clip.assetId)
  const proceduralText = clip.text !== undefined
    && isProceduralTextAssetId(clip.assetId)
  if (!asset && !proceduralText) {
    fail(`${path}.assetId`, 'references an unknown asset')
  }
  stringValue(clip.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  if (clip.sourceMode !== 'timed' && clip.sourceMode !== 'still') {
    fail(`${path}.sourceMode`, 'expected timed or still')
  }
  validateRange(clip.sourceRange, `${path}.sourceRange`, 1)
  validateSourceTimeMap(clip.sourceTimeMap, `${path}.sourceTimeMap`, context)
  validateRange(clip.timelineRange, `${path}.timelineRange`, 1)
  const sourceRange = clip.sourceRange as {
    startFrame: number
    durationFrames: number
  }
  const timelineRange = clip.timelineRange as { durationFrames: number }
  const stillSource = clip.sourceMode === 'still'
  if (
    stillSource
    && (sourceRange.startFrame !== 0 || sourceRange.durationFrames !== 1)
  ) {
    fail(`${path}.sourceRange`, 'still clips must use source frame 0 with duration 1')
  }
  if (!stillSource) {
    const envelope = sourceRangeForMap(
      clip.sourceTimeMap as SourceTimeMap,
      timelineRange.durationFrames,
    )
    if (
      envelope.startFrame !== sourceRange.startFrame
      || envelope.durationFrames !== sourceRange.durationFrames
    ) fail(path, 'durations must match the source-time mapping envelope')
  } else {
    const map = clip.sourceTimeMap as SourceTimeMap
    if (
      map.sourceStartTicks !== 0
      || map.sourceDurationTicks !== SOURCE_TIME_TICKS_PER_FRAME
      || map.rate.numerator !== 1
      || map.rate.denominator !== 1
      || map.speedCurve?.originFrame !== 0
      || map.speedCurve?.points.length !== 0
    ) fail(`${path}.sourceTimeMap`, 'still clips must use the canonical 1x map')
  }
  if (clip.text !== undefined) {
    if (stillSource) fail(`${path}.sourceMode`, 'text clips must use timed source mode')
    if (sourceRange.startFrame !== 0) {
      fail(`${path}.sourceRange.startFrame`, 'text clips must use procedural source start 0')
    }
    const map = clip.sourceTimeMap as SourceTimeMap
    if (
      map.sourceStartTicks !== 0
      || map.sourceDurationTicks
        !== sourceRange.durationFrames * SOURCE_TIME_TICKS_PER_FRAME
      || map.rate.numerator !== 1
      || map.rate.denominator !== 1
      || map.speedCurve?.originFrame !== 0
      || map.speedCurve?.points.length !== 0
    ) fail(`${path}.sourceTimeMap`, 'text clips must use the canonical 1x map')
  }
  if (clip.text === undefined && asset?.kind === 'image' && !stillSource) {
    fail(`${path}.sourceMode`, 'image clips must use still source mode')
  }
  if (stillSource && (asset?.kind !== 'image' || clip.text !== undefined)) {
    fail(`${path}.sourceMode`, 'still source mode requires an image media clip')
  }
  if (context.documentFrameRate === null) {
    fail('$.sequences', 'frame rate must be validated before clips')
  }
  const assetDurationFrames = asset
    ? microsecondsDurationToFrames(
        asset.durationMicroseconds,
        context.documentFrameRate,
      )
    : 0
  if (
    !stillSource
    && clip.text === undefined
    && sourceRange.startFrame + sourceRange.durationFrames > assetDurationFrames
  ) {
    fail(`${path}.sourceRange`, 'extends beyond the referenced asset duration')
  }
  validateTransform(clip.transform, `${path}.transform`)
  finiteNumber(clip.opacity, `${path}.opacity`, 0, 1)
  const blendModeError = blendModeIntentValidationError(clip.blendMode)
  if (blendModeError) fail(`${path}.blendMode`, blendModeError)
  finiteNumber(clip.volume, `${path}.volume`, 0, 2)
  validateLensCorrectionIntent(clip.lensCorrection, `${path}.lensCorrection`)
  if (
    clip.lensCorrection !== null
    && (trackKind !== 'video' || clip.text !== undefined)
  ) {
    fail(`${path}.lensCorrection`, 'manual lens correction requires a visual media clip')
  }
  validateClipVisual(clip.visual, `${path}.visual`)
  validateClipAudio(
    clip.audio,
    `${path}.audio`,
    timelineRange.durationFrames,
  )
  const animation = clip.animation ?? defaultClipAnimation()
  validateClipAnimation(animation, `${path}.animation`, context)
  const animationKindError = clipAnimationKindError(
    trackKind,
    clip.text !== undefined,
    animation,
  )
  if (animationKindError) fail(`${path}.animation`, animationKindError)
  boundedArray(clip.effects, `${path}.effects`, PROJECT_FILE_LIMITS.maxEffectsPerClip)
  context.effectCount += clip.effects.length
  if (context.effectCount > PROJECT_FILE_LIMITS.maxTotalEffects) {
    fail(
      '$.sequences',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalEffects} effects in total`,
    )
  }
  for (let index = 0; index < clip.effects.length; index++) {
    validateEffect(clip.effects[index], `${path}.effects[${index}]`, context)
  }
  validateAudioEffectStack(clip.audioEffects, `${path}.audioEffects`, context)
  if (clip.text !== undefined) {
    validateText(clip.text, `${path}.text`)
    context.textCharacterCount += clip.text.content.length
    if (context.textCharacterCount > PROJECT_FILE_LIMITS.maxTotalTextCharacters) {
      fail(
        '$.sequences',
        `exceeds ${PROJECT_FILE_LIMITS.maxTotalTextCharacters} text characters in total`,
      )
    }
  }
  if (clip.linkGroupId !== undefined) {
    stringValue(clip.linkGroupId, `${path}.linkGroupId`, PROJECT_FILE_LIMITS.maxIdCharacters)
    context.linkGroupCounts.set(
      clip.linkGroupId,
      (context.linkGroupCounts.get(clip.linkGroupId) ?? 0) + 1,
    )
  }
  if (trackKind === 'audio') {
    if (clip.text !== undefined) fail(path, 'text clips cannot be placed on audio tracks')
    if (!asset?.hasAudio) fail(`${path}.assetId`, 'audio-track clip references an asset without audio')
  } else if (clip.text === undefined && asset?.kind === 'audio') {
    fail(`${path}.assetId`, 'video-track clip references an audio-only asset')
  }
}
