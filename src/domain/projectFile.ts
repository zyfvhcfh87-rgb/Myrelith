/**
 * Portable, versioned Myrelith project-file contract.
 *
 * This module is deliberately pure TypeScript. A project file contains the
 * durable timeline and enough source-file metadata to relink media, but none
 * of the session-owned Blob URLs, decoder state, generated visuals, browser
 * handles, local paths, or undo history.
 */

import type {
  AssetKind,
  Clip,
  ClipAnimation,
  ClipAnimationEasing,
  ClipAnimationProperty,
  ClipAudioSettings,
  ClipVisualSettings,
  ClipSourceMode,
  Effect,
  FrameRate,
  MediaSourceBounds,
  SourceTimestampBounds,
  TextProps,
  TimelineDoc,
  Track,
  Transform,
  PartialTrackImportSelection,
} from './schema'
import {
  ANIMATABLE_CLIP_PROPERTIES,
  clipAnimation,
  clipAnimationValidationError,
  cloneClipAnimation,
  defaultClipAnimation,
  MAX_ANIMATED_FINITE_MAGNITUDE,
  MAX_KEYFRAME_FRAME,
  MAX_KEYFRAMES_PER_TRACK,
} from './clipAnimation'
import {
  clipAudioSettings,
  clipAudioSettingsValidationError,
  clipVisualSettings,
  clipVisualSettingsValidationError,
  MAX_CLIP_SCALE,
  MIN_CLIP_SCALE,
  migrateLegacyClipInspectorSettings,
} from './clipInspector'
import { microsecondsDurationToFrames } from './time'
import { cloneMediaSourceBounds } from './sourceBounds'
import {
  defaultTextProps,
  isProceduralTextAssetId,
  isSupportedTextColor,
  isSupportedTextFontFamily,
  migrateLegacyProceduralTextAssetId,
  TEXT_OVERLAY_LIMITS,
  textPropsValidationError,
  proceduralTextAssetId,
} from './textOverlay'
import {
  MAX_DOCUMENT_ID_CHARACTERS,
  MAX_PROJECT_NAME_CHARACTERS,
} from './projectLimits'

export const PROJECT_FILE_FORMAT = 'myrelith-project' as const
/** Serialized format marker used by releases published before the rebrand. */
export const LEGACY_PROJECT_FILE_FORMAT = 'webcut-project' as const
export const PROJECT_FILE_EXTENSION = '.myrelith' as const
/** Portable project extension used before the Myrelith rebrand. */
export const LEGACY_PROJECT_FILE_EXTENSION = '.webcut' as const
export const SUPPORTED_PROJECT_FILE_EXTENSIONS = Object.freeze([
  PROJECT_FILE_EXTENSION,
  LEGACY_PROJECT_FILE_EXTENSION,
] as const)
export const CURRENT_PROJECT_FORMAT_VERSION = 4 as const
export const CURRENT_TIMELINE_SCHEMA_VERSION = 6 as const

/** Public bounds applied before or while walking untrusted project data. */
export const PROJECT_FILE_LIMITS = {
  maxSerializedCharacters: 10_000_000,
  maxAssets: 50_000,
  maxTracks: 256,
  maxClips: 100_000,
  maxEffectsPerClip: 256,
  maxEffectParams: 256,
  maxTotalEffects: 10_000,
  maxTotalEffectParams: 50_000,
  maxTotalEffectStringCharacters: 10_000_000,
  maxTransitions: 100_000,
  maxTotalKeyframes: 100_000,
  maxTotalTextCharacters: 10_000_000,
  maxIdCharacters: MAX_DOCUMENT_ID_CHARACTERS,
  maxNameCharacters: MAX_PROJECT_NAME_CHARACTERS,
  maxFileNameCharacters: 4_096,
  maxMimeTypeCharacters: 256,
  maxTextCharacters: TEXT_OVERLAY_LIMITS.maxCharacters,
  maxEffectStringCharacters: 65_536,
  maxDimension: 65_535,
  maxAudioSampleRate: 768_000,
  maxAudioChannels: 64,
  maxRatePart: 1_000_000,
  maxFramesPerSecond: 1_000,
  maxFiniteMagnitude: 1_000_000_000,
} as const

/** Durable effective-import metadata plus original-file relink identity. */
export interface PortableAssetDescriptor {
  id: string
  fileName: string
  mimeType: string
  size: number
  lastModified: number
  kind: AssetKind
  partialTrackSelection?: PartialTrackImportSelection
  durationMicroseconds: number
  sourceBounds: MediaSourceBounds
  nativeFrameRate: FrameRate | null
  width: number | null
  height: number | null
  hasAudio: boolean
  audioSampleRate: number | null
  audioChannels: number | null
}

export interface ProjectFileV4 {
  format: typeof PROJECT_FILE_FORMAT
  formatVersion: typeof CURRENT_PROJECT_FORMAT_VERSION
  document: TimelineDoc
  assets: PortableAssetDescriptor[]
}

export type ProjectFile = ProjectFileV4

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFileError'
  }
}

export function hasSupportedProjectFileExtension(fileName: string): boolean {
  const normalized = fileName.toLowerCase()
  return SUPPORTED_PROJECT_FILE_EXTENSIONS.some((extension) => (
    normalized.endsWith(extension)
  ))
}

type JsonRecord = Record<string, unknown>

function fail(path: string, problem: string): never {
  throw new ProjectFileError(`${path}: ${problem}`)
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail(path, 'expected an object')
  return value
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field')
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(path, `missing field ${key}`)
    }
  }
}

function stringValue(
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string') fail(path, 'expected a string')
  if (value.length > maxLength) fail(path, `exceeds ${maxLength} characters`)
  if (!allowEmpty && value.trim().length === 0) fail(path, 'must not be empty')
}

function booleanValue(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean')
}

function safeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `expected a safe integer from ${minimum} to ${maximum}`)
  }
}

function finiteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `expected a finite number from ${minimum} to ${maximum}`)
  }
}

function boundedArray(
  value: unknown,
  path: string,
  maximum: number,
): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  if (value.length > maximum) fail(path, `exceeds ${maximum} entries`)
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function validateFrameRate(value: unknown, path: string): asserts value is FrameRate {
  const candidate = record(value, path)
  exactKeys(candidate, ['num', 'den'], [], path)
  safeInteger(candidate.num, `${path}.num`, 1, PROJECT_FILE_LIMITS.maxRatePart)
  safeInteger(candidate.den, `${path}.den`, 1, PROJECT_FILE_LIMITS.maxRatePart)
  if (greatestCommonDivisor(candidate.num, candidate.den) !== 1) {
    fail(path, 'frame rate must be reduced to an exact rational')
  }
  if (candidate.num / candidate.den > PROJECT_FILE_LIMITS.maxFramesPerSecond) {
    fail(path, `frame rate exceeds ${PROJECT_FILE_LIMITS.maxFramesPerSecond} fps`)
  }
}

function validateNullableFrameRate(
  value: unknown,
  path: string,
): asserts value is FrameRate | null {
  if (value !== null) validateFrameRate(value, path)
}

function validateNullableSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number | null {
  if (value !== null) safeInteger(value, path, minimum, maximum)
}

function validateSourceTimestampBounds(
  value: unknown,
  path: string,
): asserts value is SourceTimestampBounds {
  const bounds = record(value, path)
  if (bounds.status === 'unknown') {
    exactKeys(bounds, ['status'], [], path)
    return
  }
  if (bounds.status !== 'exact') {
    fail(`${path}.status`, 'expected exact or unknown')
  }
  exactKeys(bounds, ['status', 'firstTimestampUs', 'endTimestampUs'], [], path)
  safeInteger(
    bounds.firstTimestampUs,
    `${path}.firstTimestampUs`,
    -Number.MAX_SAFE_INTEGER,
  )
  safeInteger(bounds.endTimestampUs, `${path}.endTimestampUs`, 0)
  if (bounds.endTimestampUs <= bounds.firstTimestampUs) {
    fail(path, 'endTimestampUs must be greater than firstTimestampUs')
  }
}

function validateMediaSourceBounds(
  value: unknown,
  path: string,
): asserts value is MediaSourceBounds {
  const bounds = record(value, path)
  exactKeys(bounds, ['video', 'audio'], [], path)
  if (bounds.video !== null) {
    validateSourceTimestampBounds(bounds.video, `${path}.video`)
  }
  if (bounds.audio !== null) {
    validateSourceTimestampBounds(bounds.audio, `${path}.audio`)
  }
}

function validateAsset(value: unknown, path: string): asserts value is PortableAssetDescriptor {
  const asset = record(value, path)
  exactKeys(
    asset,
    [
      'id',
      'fileName',
      'mimeType',
      'size',
      'lastModified',
      'kind',
      'durationMicroseconds',
      'sourceBounds',
      'nativeFrameRate',
      'width',
      'height',
      'hasAudio',
      'audioSampleRate',
      'audioChannels',
    ],
    ['partialTrackSelection'],
    path,
  )
  stringValue(asset.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (isProceduralTextAssetId(asset.id)) {
    fail(`${path}.id`, 'procedural text ids cannot be media asset ids')
  }
  stringValue(asset.fileName, `${path}.fileName`, PROJECT_FILE_LIMITS.maxFileNameCharacters)
  stringValue(asset.mimeType, `${path}.mimeType`, PROJECT_FILE_LIMITS.maxMimeTypeCharacters, true)
  safeInteger(asset.size, `${path}.size`, 0)
  safeInteger(asset.lastModified, `${path}.lastModified`, 0)
  if (asset.kind !== 'video' && asset.kind !== 'audio' && asset.kind !== 'image') {
    fail(`${path}.kind`, 'expected video, audio, or image')
  }
  if (
    asset.partialTrackSelection !== undefined
    && asset.partialTrackSelection !== 'video-only'
    && asset.partialTrackSelection !== 'audio-only'
  ) {
    fail(`${path}.partialTrackSelection`, 'expected video-only or audio-only')
  }
  safeInteger(asset.durationMicroseconds, `${path}.durationMicroseconds`, 0)
  validateMediaSourceBounds(asset.sourceBounds, `${path}.sourceBounds`)
  for (const [kind, bounds] of Object.entries(asset.sourceBounds)) {
    if (
      bounds?.status === 'exact'
      && bounds.endTimestampUs > asset.durationMicroseconds
    ) {
      fail(
        `${path}.sourceBounds.${kind}.endTimestampUs`,
        'cannot exceed the asset duration endpoint',
      )
    }
  }
  validateNullableFrameRate(asset.nativeFrameRate, `${path}.nativeFrameRate`)
  validateNullableSafeInteger(asset.width, `${path}.width`, 1, PROJECT_FILE_LIMITS.maxDimension)
  validateNullableSafeInteger(asset.height, `${path}.height`, 1, PROJECT_FILE_LIMITS.maxDimension)
  booleanValue(asset.hasAudio, `${path}.hasAudio`)
  validateNullableSafeInteger(
    asset.audioSampleRate,
    `${path}.audioSampleRate`,
    1,
    PROJECT_FILE_LIMITS.maxAudioSampleRate,
  )
  validateNullableSafeInteger(
    asset.audioChannels,
    `${path}.audioChannels`,
    1,
    PROJECT_FILE_LIMITS.maxAudioChannels,
  )

  const dimensionsBothNull = asset.width === null && asset.height === null
  const dimensionsBothPresent = asset.width !== null && asset.height !== null
  if (!dimensionsBothNull && !dimensionsBothPresent) {
    fail(path, 'width and height must both be present or both be null')
  }
  if (asset.kind === 'audio' && !dimensionsBothNull) {
    fail(path, 'audio-only assets cannot have visual dimensions')
  }
  if (asset.kind === 'image' && !dimensionsBothPresent) {
    fail(path, 'image assets require dimensions')
  }
  if (asset.kind !== 'video' && asset.nativeFrameRate !== null) {
    fail(path, 'only video assets may have a native frame rate')
  }
  if (asset.kind === 'audio' && !asset.hasAudio) {
    fail(path, 'audio assets must contain audio')
  }
  if (
    asset.partialTrackSelection === 'video-only'
    && (asset.kind !== 'video' || asset.hasAudio)
  ) {
    fail(path, 'video-only imports must be video assets without audio')
  }
  if (
    asset.partialTrackSelection === 'audio-only'
    && asset.kind !== 'audio'
  ) {
    fail(path, 'audio-only imports must be audio assets')
  }
  const audioMetadataPresent = asset.audioSampleRate !== null && asset.audioChannels !== null
  if (asset.hasAudio !== audioMetadataPresent) {
    fail(path, 'audio metadata must match hasAudio')
  }
  if (asset.kind === 'image' && (asset.sourceBounds.video !== null || asset.sourceBounds.audio !== null)) {
    fail(path, 'image assets cannot have timed source bounds')
  }
  if (asset.kind === 'video' && asset.sourceBounds.video === null) {
    fail(path, 'video assets require video source bounds')
  }
  if (asset.kind === 'audio' && asset.sourceBounds.video !== null) {
    fail(path, 'audio assets cannot have video source bounds')
  }
  if (asset.hasAudio !== (asset.sourceBounds.audio !== null)) {
    fail(path, 'audio source bounds must match hasAudio')
  }
}

function validateRange(value: unknown, path: string, minimumDuration: number): void {
  const range = record(value, path)
  exactKeys(range, ['startFrame', 'durationFrames'], [], path)
  safeInteger(range.startFrame, `${path}.startFrame`, 0)
  safeInteger(range.durationFrames, `${path}.durationFrames`, minimumDuration)
  if (!Number.isSafeInteger(range.startFrame + range.durationFrames)) {
    fail(path, 'range end exceeds safe integer precision')
  }
}

function validateTransform(value: unknown, path: string): asserts value is Transform {
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

function validateClipVisual(
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

function validateClipAudio(
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

function validateAnimationEasing(
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

function validateClipAnimation(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is ClipAnimation {
  const animation = record(value, path)
  exactKeys(animation, ['tracks'], [], path)
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
        '$.document.tracks',
        `exceeds ${PROJECT_FILE_LIMITS.maxTotalKeyframes} keyframes in total`,
      )
    }
    let previousFrame: number | null = null
    for (let keyframeIndex = 0; keyframeIndex < track.keyframes.length; keyframeIndex++) {
      const keyframePath = `${trackPath}.keyframes[${keyframeIndex}]`
      const keyframe = record(track.keyframes[keyframeIndex], keyframePath)
      exactKeys(keyframe, ['frame', 'value', 'easing'], [], keyframePath)
      safeInteger(
        keyframe.frame,
        `${keyframePath}.frame`,
        -MAX_KEYFRAME_FRAME,
        MAX_KEYFRAME_FRAME,
      )
      if (previousFrame !== null && keyframe.frame <= previousFrame) {
        fail(`${keyframePath}.frame`, 'must be strictly increasing and unique')
      }
      const minimum = property === 'opacity' ? 0
        : property === 'scale-x' || property === 'scale-y' ? MIN_CLIP_SCALE
          : -MAX_ANIMATED_FINITE_MAGNITUDE
      const maximum = property === 'opacity' ? 1
        : property === 'scale-x' || property === 'scale-y' ? MAX_CLIP_SCALE
          : MAX_ANIMATED_FINITE_MAGNITUDE
      finiteNumber(keyframe.value, `${keyframePath}.value`, minimum, maximum)
      validateAnimationEasing(keyframe.easing, `${keyframePath}.easing`)
      previousFrame = keyframe.frame
    }
  }
  const error = clipAnimationValidationError(animation as unknown as ClipAnimation)
  if (error) fail(path, error)
}

function validateEffect(
  value: unknown,
  path: string,
  context: ValidationContext,
): asserts value is Effect {
  const effect = record(value, path)
  exactKeys(effect, ['id', 'type', 'enabled', 'params'], [], path)
  stringValue(effect.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.effectIds.has(effect.id)) fail(`${path}.id`, 'duplicate effect id')
  context.effectIds.add(effect.id)
  stringValue(effect.type, `${path}.type`, PROJECT_FILE_LIMITS.maxNameCharacters)
  booleanValue(effect.enabled, `${path}.enabled`)
  const params = record(effect.params, `${path}.params`)
  const keys = Object.keys(params)
  if (keys.length > PROJECT_FILE_LIMITS.maxEffectParams) {
    fail(`${path}.params`, `exceeds ${PROJECT_FILE_LIMITS.maxEffectParams} entries`)
  }
  context.effectParamCount += keys.length
  if (context.effectParamCount > PROJECT_FILE_LIMITS.maxTotalEffectParams) {
    fail(
      '$.document.tracks',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalEffectParams} effect parameters in total`,
    )
  }
  for (const key of keys) {
    stringValue(key, `${path}.params key`, PROJECT_FILE_LIMITS.maxNameCharacters)
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      fail(`${path}.params.${key}`, 'unsafe parameter key')
    }
    const parameter = params[key]
    if (typeof parameter === 'number') {
      finiteNumber(
        parameter,
        `${path}.params.${key}`,
        -PROJECT_FILE_LIMITS.maxFiniteMagnitude,
        PROJECT_FILE_LIMITS.maxFiniteMagnitude,
      )
    } else if (typeof parameter === 'string') {
      stringValue(
        parameter,
        `${path}.params.${key}`,
        PROJECT_FILE_LIMITS.maxEffectStringCharacters,
        true,
      )
      context.effectStringCharacterCount += parameter.length
      if (
        context.effectStringCharacterCount >
        PROJECT_FILE_LIMITS.maxTotalEffectStringCharacters
      ) {
        fail(
          '$.document.tracks',
          `exceeds ${PROJECT_FILE_LIMITS.maxTotalEffectStringCharacters} effect-string characters in total`,
        )
      }
    } else if (typeof parameter !== 'boolean') {
      fail(`${path}.params.${key}`, 'expected a finite number, string, or boolean')
    }
  }
}

function validateText(value: unknown, path: string): asserts value is TextProps {
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

interface ValidationContext {
  assetIds: Set<string>
  assetsById: Map<string, PortableAssetDescriptor>
  documentFrameRate: FrameRate | null
  clipIds: Set<string>
  effectIds: Set<string>
  transitionIds: Set<string>
  linkGroupCounts: Map<string, number>
  clipCount: number
  effectCount: number
  effectParamCount: number
  effectStringCharacterCount: number
  textCharacterCount: number
  transitionCount: number
  keyframeCount: number
}

function validateClip(value: unknown, path: string, trackKind: Track['kind'], context: ValidationContext): asserts value is Clip {
  const clip = record(value, path)
  exactKeys(
    clip,
    ['id', 'assetId', 'name', 'sourceMode', 'sourceRange', 'timelineRange', 'transform', 'opacity', 'volume', 'visual', 'audio', 'effects'],
    ['animation', 'text', 'linkGroupId'],
    path,
  )
  stringValue(clip.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.clipIds.has(clip.id)) fail(`${path}.id`, 'duplicate clip id')
  context.clipIds.add(clip.id)
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
  if (!stillSource && sourceRange.durationFrames !== timelineRange.durationFrames) {
    fail(path, 'source and timeline durations must match')
  }
  if (clip.text !== undefined) {
    if (stillSource) fail(`${path}.sourceMode`, 'text clips must use timed source mode')
    if (sourceRange.startFrame !== 0) {
      fail(`${path}.sourceRange.startFrame`, 'text clips must use procedural source start 0')
    }
  }
  if (clip.text === undefined && asset?.kind === 'image' && !stillSource) {
    fail(`${path}.sourceMode`, 'image clips must use still source mode')
  }
  if (stillSource && (asset?.kind !== 'image' || clip.text !== undefined)) {
    fail(`${path}.sourceMode`, 'still source mode requires an image media clip')
  }
  if (context.documentFrameRate === null) {
    fail('$.document.frameRate', 'must be validated before clips')
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
  finiteNumber(clip.volume, `${path}.volume`, 0, 2)
  validateClipVisual(clip.visual, `${path}.visual`)
  validateClipAudio(
    clip.audio,
    `${path}.audio`,
    timelineRange.durationFrames,
  )
  const animation = clip.animation ?? defaultClipAnimation()
  validateClipAnimation(animation, `${path}.animation`, context)
  if (
    animation.tracks.length > 0
    && (trackKind !== 'video' || clip.text !== undefined)
  ) {
    fail(`${path}.animation`, 'keyframes are supported only on visual media clips')
  }
  boundedArray(clip.effects, `${path}.effects`, PROJECT_FILE_LIMITS.maxEffectsPerClip)
  context.effectCount += clip.effects.length
  if (context.effectCount > PROJECT_FILE_LIMITS.maxTotalEffects) {
    fail(
      '$.document.tracks',
      `exceeds ${PROJECT_FILE_LIMITS.maxTotalEffects} effects in total`,
    )
  }
  for (let index = 0; index < clip.effects.length; index++) {
    validateEffect(clip.effects[index], `${path}.effects[${index}]`, context)
  }
  if (clip.text !== undefined) {
    validateText(clip.text, `${path}.text`)
    context.textCharacterCount += clip.text.content.length
    if (context.textCharacterCount > PROJECT_FILE_LIMITS.maxTotalTextCharacters) {
      fail(
        '$.document.tracks',
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

interface ResolvedTransitionWindow {
  startFrame: number
  endFrame: number
}

function validateTransition(
  value: unknown,
  path: string,
  track: Track,
  clipIndexById: ReadonlyMap<string, number>,
  context: ValidationContext,
): ResolvedTransitionWindow {
  const transition = record(value, path)
  exactKeys(
    transition,
    ['id', 'type', 'fromClipId', 'toClipId', 'durationFrames', 'audio'],
    [],
    path,
  )
  stringValue(transition.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (context.transitionIds.has(transition.id)) fail(`${path}.id`, 'duplicate transition id')
  context.transitionIds.add(transition.id)
  if (transition.type !== 'crossfade') fail(`${path}.type`, 'expected crossfade')
  stringValue(transition.fromClipId, `${path}.fromClipId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  stringValue(transition.toClipId, `${path}.toClipId`, PROJECT_FILE_LIMITS.maxIdCharacters)
  safeInteger(transition.durationFrames, `${path}.durationFrames`, 1)
  const audio = record(transition.audio, `${path}.audio`)
  exactKeys(audio, ['enabled', 'curve'], [], `${path}.audio`)
  booleanValue(audio.enabled, `${path}.audio.enabled`)
  if (audio.curve !== 'linear' && audio.curve !== 'equal-power') {
    fail(`${path}.audio.curve`, 'expected linear or equal-power')
  }
  if (track.kind !== 'video') fail(path, 'transitions require a video track')

  const fromIndex = clipIndexById.get(transition.fromClipId)
  if (fromIndex === undefined || fromIndex + 1 >= track.clips.length) {
    fail(path, 'transition endpoints must be adjacent clips on the owning track')
  }
  const from = track.clips[fromIndex]
  const to = track.clips[fromIndex + 1]
  if (to.id !== transition.toClipId || from.id === to.id) {
    fail(path, 'transition endpoints must be ordered adjacent clips')
  }
  if (from.text !== undefined || to.text !== undefined) {
    fail(path, 'text clips cannot be transition endpoints')
  }
  const cutFrame = from.timelineRange.startFrame + from.timelineRange.durationFrames
  if (cutFrame !== to.timelineRange.startFrame) {
    fail(path, 'transition endpoints must touch')
  }
  const startFrame = cutFrame - Math.floor(transition.durationFrames / 2)
  const endFrame = startFrame + transition.durationFrames
  const toEnd = to.timelineRange.startFrame + to.timelineRange.durationFrames
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < from.timelineRange.startFrame ||
    endFrame > toEnd
  ) {
    fail(path, 'transition window does not fit its clips')
  }
  return { startFrame, endFrame }
}

function validateTrack(value: unknown, path: string, trackIds: Set<string>, context: ValidationContext): asserts value is Track {
  const track = record(value, path)
  exactKeys(
    track,
    ['id', 'kind', 'name', 'clips', 'transitions', 'hidden', 'muted', 'solo', 'locked'],
    [],
    path,
  )
  stringValue(track.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (trackIds.has(track.id)) fail(`${path}.id`, 'duplicate track id')
  trackIds.add(track.id)
  if (track.kind !== 'video' && track.kind !== 'audio') {
    fail(`${path}.kind`, 'expected video or audio')
  }
  stringValue(track.name, `${path}.name`, PROJECT_FILE_LIMITS.maxNameCharacters)
  boundedArray(track.clips, `${path}.clips`, PROJECT_FILE_LIMITS.maxClips)
  context.clipCount += track.clips.length
  if (context.clipCount > PROJECT_FILE_LIMITS.maxClips) {
    fail('$.document.tracks', `exceeds ${PROJECT_FILE_LIMITS.maxClips} clips in total`)
  }
  let previousEnd = -1
  const clipIndexById = new Map<string, number>()
  for (let index = 0; index < track.clips.length; index++) {
    const clipPath = `${path}.clips[${index}]`
    const clip = track.clips[index]
    validateClip(clip, clipPath, track.kind, context)
    if (clip.timelineRange.startFrame < previousEnd) {
      fail(clipPath, 'clips must be sorted and non-overlapping')
    }
    previousEnd = clip.timelineRange.startFrame + clip.timelineRange.durationFrames
    clipIndexById.set(clip.id, index)
  }
  boundedArray(track.transitions, `${path}.transitions`, PROJECT_FILE_LIMITS.maxTransitions)
  context.transitionCount += track.transitions.length
  if (context.transitionCount > PROJECT_FILE_LIMITS.maxTransitions) {
    fail('$.document.tracks', `exceeds ${PROJECT_FILE_LIMITS.maxTransitions} transitions in total`)
  }
  const windows: ResolvedTransitionWindow[] = []
  for (let index = 0; index < track.transitions.length; index++) {
    const window = validateTransition(
      track.transitions[index],
      `${path}.transitions[${index}]`,
      track as unknown as Track,
      clipIndexById,
      context,
    )
    windows.push(window)
  }
  windows.sort((left, right) => left.startFrame - right.startFrame)
  for (let index = 1; index < windows.length; index++) {
    if (windows[index].startFrame < windows[index - 1].endFrame) {
      fail(path, 'transition windows overlap')
    }
  }
  booleanValue(track.hidden, `${path}.hidden`)
  booleanValue(track.muted, `${path}.muted`)
  booleanValue(track.solo, `${path}.solo`)
  booleanValue(track.locked, `${path}.locked`)
}

function validateDocument(value: unknown, context: ValidationContext): asserts value is TimelineDoc {
  const document = record(value, '$.document')
  exactKeys(
    document,
    ['schemaVersion', 'id', 'name', 'frameRate', 'width', 'height', 'audioSampleRate', 'tracks'],
    [],
    '$.document',
  )
  safeInteger(document.schemaVersion, '$.document.schemaVersion', 1)
  if (document.schemaVersion > CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail('$.document.schemaVersion', `unsupported future timeline schema ${document.schemaVersion}`)
  }
  if (document.schemaVersion !== CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail('$.document.schemaVersion', `unsupported timeline schema ${document.schemaVersion}`)
  }
  stringValue(document.id, '$.document.id', PROJECT_FILE_LIMITS.maxIdCharacters)
  stringValue(document.name, '$.document.name', PROJECT_FILE_LIMITS.maxNameCharacters)
  validateFrameRate(document.frameRate, '$.document.frameRate')
  context.documentFrameRate = document.frameRate
  safeInteger(document.width, '$.document.width', 1, PROJECT_FILE_LIMITS.maxDimension)
  safeInteger(document.height, '$.document.height', 1, PROJECT_FILE_LIMITS.maxDimension)
  safeInteger(
    document.audioSampleRate,
    '$.document.audioSampleRate',
    1,
    PROJECT_FILE_LIMITS.maxAudioSampleRate,
  )
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const trackIds = new Set<string>()
  for (let index = 0; index < document.tracks.length; index++) {
    validateTrack(document.tracks[index], `$.document.tracks[${index}]`, trackIds, context)
  }
}

/**
 * Validate an already-current project value. The returned object is the same
 * reference; callers that need an isolated snapshot can parse serialized JSON.
 */
export function validateProjectFile(value: unknown): ProjectFile {
  const project = record(value, '$')
  exactKeys(project, ['format', 'formatVersion', 'document', 'assets'], [], '$')
  if (project.format !== PROJECT_FILE_FORMAT) {
    fail('$.format', `expected ${PROJECT_FILE_FORMAT}`)
  }
  safeInteger(project.formatVersion, '$.formatVersion', 1)
  if (project.formatVersion > CURRENT_PROJECT_FORMAT_VERSION) {
    fail('$.formatVersion', `unsupported future project format ${project.formatVersion}`)
  }
  if (project.formatVersion !== CURRENT_PROJECT_FORMAT_VERSION) {
    fail('$.formatVersion', `unsupported project format ${project.formatVersion}`)
  }
  boundedArray(project.assets, '$.assets', PROJECT_FILE_LIMITS.maxAssets)

  const assetIds = new Set<string>()
  const assetsById = new Map<string, PortableAssetDescriptor>()
  for (let index = 0; index < project.assets.length; index++) {
    const path = `$.assets[${index}]`
    const asset = project.assets[index]
    validateAsset(asset, path)
    if (assetIds.has(asset.id)) fail(`${path}.id`, 'duplicate asset id')
    assetIds.add(asset.id)
    assetsById.set(asset.id, asset)
  }

  const context: ValidationContext = {
    assetIds,
    assetsById,
    documentFrameRate: null,
    clipIds: new Set(),
    effectIds: new Set(),
    transitionIds: new Set(),
    linkGroupCounts: new Map(),
    clipCount: 0,
    effectCount: 0,
    effectParamCount: 0,
    effectStringCharacterCount: 0,
    textCharacterCount: 0,
    transitionCount: 0,
    keyframeCount: 0,
  }
  validateDocument(project.document, context)
  for (const [linkGroupId, count] of context.linkGroupCounts) {
    if (count < 2) fail('$.document', `link group ${linkGroupId} has no partner clip`)
  }
  return project as unknown as ProjectFile
}

/**
 * Upgrade one schema-1 timeline to the explicit schema-2 source contract.
 * Image media clips become canonical one-frame still sources while retaining
 * their authored timeline duration. Text clips remain timed even when their
 * historical backing asset is an image, because text renders its own payload
 * rather than the referenced media pixels.
 */
function migrateClipSourceModes(
  documentValue: unknown,
  assetsValue: unknown,
): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(
    assetsValue,
    '$.assets',
    PROJECT_FILE_LIMITS.maxAssets,
  )
  const assets = assetsValue
  const imageAssetIds = new Set<string>()
  for (let index = 0; index < assets.length; index++) {
    const asset = record(assets[index], `$.assets[${index}]`)
    if (typeof asset.id === 'string' && asset.kind === 'image') {
      imageAssetIds.add(asset.id)
    }
  }

  boundedArray(
    document.tracks,
    '$.document.tracks',
    PROJECT_FILE_LIMITS.maxTracks,
  )
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    const clips = track.clips.map((clipValue, clipIndex) => {
      const clip = record(
        clipValue,
        `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
      )
      const sourceMode: ClipSourceMode =
        clip.text === undefined
        && typeof clip.assetId === 'string'
        && imageAssetIds.has(clip.assetId)
          ? 'still'
          : 'timed'
      return {
        ...clip,
        sourceMode,
        ...(sourceMode === 'still'
          ? { sourceRange: { startFrame: 0, durationFrames: 1 } }
          : {}),
      }
    })
    return { ...track, clips }
  })
  return {
    ...document,
    schemaVersion: 2,
    tracks,
  }
}

/** Upgrade schema 2 transitions without claiming legacy audio behavior. */
function migrateTransitionAudio(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.transitions,
      `$.document.tracks[${trackIndex}].transitions`,
      PROJECT_FILE_LIMITS.maxTransitions,
    )
    return {
      ...track,
      transitions: track.transitions.map((transitionValue, transitionIndex) => ({
        ...record(
          transitionValue,
          `$.document.tracks[${trackIndex}].transitions[${transitionIndex}]`,
        ),
        audio: { enabled: false, curve: 'equal-power' },
      })),
    }
  })
  return { ...document, schemaVersion: 3, tracks }
}

/** Upgrade dormant schema-3 text payloads into bounded procedural overlays. */
function migrateTextOverlays(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const width = typeof document.width === 'number' && Number.isFinite(document.width)
    ? document.width
    : 1_920
  const height = typeof document.height === 'number' && Number.isFinite(document.height)
    ? document.height
    : 1_080
  const defaults = defaultTextProps(width, height)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    const clips = track.clips.map((clipValue, clipIndex) => {
      const clipPath = `$.document.tracks[${trackIndex}].clips[${clipIndex}]`
      const clip = record(clipValue, clipPath)
      if (clip.text === undefined) return clip
      const legacy = record(clip.text, `${clipPath}.text`)
      const timelineRange = record(clip.timelineRange, `${clipPath}.timelineRange`)
      return {
        ...clip,
        assetId: proceduralTextAssetId(String(clip.id)),
        sourceMode: 'timed',
        sourceRange: {
          startFrame: 0,
          durationFrames: timelineRange.durationFrames,
        },
        text: {
          ...defaults,
          content: legacy.content,
          fontFamily: legacy.fontFamily,
          fontSizePx: legacy.fontSizePx,
          color: legacy.color,
          align: legacy.align,
          bold: legacy.bold,
          italic: legacy.italic,
        },
      }
    })
    return { ...track, clips }
  })
  return { ...document, schemaVersion: 4, tracks }
}

/** Upgrade schema-4 clips to the complete static Inspector document model. */
function migrateClipInspector(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    const clips = track.clips.map((clipValue, clipIndex) => {
      const clipPath = `$.document.tracks[${trackIndex}].clips[${clipIndex}]`
      const clip = record(clipValue, clipPath)
      const transform = record(clip.transform, `${clipPath}.transform`)
      const migrated = migrateLegacyClipInspectorSettings(
        transform as unknown as Transform,
      )
      return {
        ...clip,
        transform: migrated.transform,
        visual: migrated.visual,
        audio: migrated.audio,
      }
    })
    return { ...track, clips }
  })
  return { ...document, schemaVersion: 5, tracks }
}

/** Upgrade schema-5 clips with a canonical empty animation container. */
function migrateClipAnimation(documentValue: unknown): JsonRecord {
  const document = record(documentValue, '$.document')
  boundedArray(document.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = document.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => ({
        ...record(
          clipValue,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
        ),
        animation: defaultClipAnimation(),
      })),
    }
  })
  return { ...document, schemaVersion: 6, tracks }
}

/**
 * Upgrade a parsed historical timeline to the current nested schema. The
 * outer project format and nested timeline schema are independent version
 * boundaries: previously shipped project files can still contain a schema-1
 * document and must therefore pass through this migration too.
 */
function migrateTimelineDocument(
  documentValue: unknown,
  assetsValue: unknown,
): JsonRecord {
  const document = record(documentValue, '$.document')
  safeInteger(document.schemaVersion, '$.document.schemaVersion', 1)
  if (document.schemaVersion > CURRENT_TIMELINE_SCHEMA_VERSION) {
    fail(
      '$.document.schemaVersion',
      `unsupported future timeline schema ${document.schemaVersion}`,
    )
  }
  let migrated = document
  if (migrated.schemaVersion === 1) {
    migrated = migrateClipSourceModes(migrated, assetsValue)
  }
  if (migrated.schemaVersion === 2) {
    migrated = migrateTransitionAudio(migrated)
  }
  if (migrated.schemaVersion === 3) {
    migrated = migrateTextOverlays(migrated)
  }
  if (migrated.schemaVersion === 4) {
    migrated = migrateClipInspector(migrated)
  }
  if (migrated.schemaVersion === 5) {
    migrated = migrateClipAnimation(migrated)
  }
  boundedArray(migrated.tracks, '$.document.tracks', PROJECT_FILE_LIMITS.maxTracks)
  const tracks = migrated.tracks.map((trackValue, trackIndex) => {
    const track = record(trackValue, `$.document.tracks[${trackIndex}]`)
    boundedArray(
      track.clips,
      `$.document.tracks[${trackIndex}].clips`,
      PROJECT_FILE_LIMITS.maxClips,
    )
    return {
      ...track,
      clips: track.clips.map((clipValue, clipIndex) => {
        const clip = record(
          clipValue,
          `$.document.tracks[${trackIndex}].clips[${clipIndex}]`,
        )
        return typeof clip.assetId === 'string'
          ? {
              ...clip,
              assetId: migrateLegacyProceduralTextAssetId(clip.assetId),
            }
          : clip
      }),
    }
  })
  return { ...migrated, tracks }
}

function migrateLegacyAssetBounds(assetsValue: unknown): JsonRecord[] {
  boundedArray(assetsValue, '$.assets', PROJECT_FILE_LIMITS.maxAssets)
  return assetsValue.map((assetValue, index) => {
    const asset = record(assetValue, `$.assets[${index}]`)
    const hasVideo = asset.kind === 'video'
    const hasAudio = asset.hasAudio === true
    return {
      ...asset,
      sourceBounds: {
        video: hasVideo ? { status: 'unknown' } : null,
        audio: hasAudio ? { status: 'unknown' } : null,
      },
    }
  })
}

/**
 * Upgrade a parsed historical value into the current format. Outer version 4
 * adds durable stream bounds; nested schema 3 adds transition audio settings,
 * and schema 4 adds bounded procedural text-overlay styling and geometry.
 */
export function migrateProjectFile(value: unknown): unknown {
  const project = record(value, '$')
  if (
    project.format !== PROJECT_FILE_FORMAT
    && project.format !== LEGACY_PROJECT_FILE_FORMAT
  ) {
    fail(
      '$.format',
      `expected ${PROJECT_FILE_FORMAT} or legacy ${LEGACY_PROJECT_FILE_FORMAT}`,
    )
  }
  const brandedProject = project.format === LEGACY_PROJECT_FILE_FORMAT
    ? { ...project, format: PROJECT_FILE_FORMAT }
    : project
  safeInteger(brandedProject.formatVersion, '$.formatVersion', 1)
  if (brandedProject.formatVersion > CURRENT_PROJECT_FORMAT_VERSION) {
    fail('$.formatVersion', `unsupported future project format ${brandedProject.formatVersion}`)
  }
  switch (brandedProject.formatVersion) {
    case 1:
    case 2:
    case 3: {
      const assets = migrateLegacyAssetBounds(brandedProject.assets)
      return {
        ...brandedProject,
        formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
        document: migrateTimelineDocument(brandedProject.document, assets),
        assets,
      }
    }
    case CURRENT_PROJECT_FORMAT_VERSION:
      return {
        ...brandedProject,
        document: migrateTimelineDocument(
          brandedProject.document,
          brandedProject.assets,
        ),
      }
    default:
      return fail(
        '$.formatVersion',
        `unsupported project format ${brandedProject.formatVersion}`,
      )
  }
}

function cloneEffectParams(params: Effect['params']): Effect['params'] {
  const copy: Effect['params'] = {}
  for (const key of Object.keys(params)) copy[key] = params[key]
  return copy
}

function portableProjectSnapshot(project: ProjectFile): ProjectFile {
  const document = project.document
  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document: {
      schemaVersion: document.schemaVersion,
      id: document.id,
      name: document.name,
      frameRate: { num: document.frameRate.num, den: document.frameRate.den },
      width: document.width,
      height: document.height,
      audioSampleRate: document.audioSampleRate,
      tracks: document.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          name: clip.name,
          sourceMode: clip.sourceMode,
          sourceRange: { ...clip.sourceRange },
          timelineRange: { ...clip.timelineRange },
          transform: { ...clip.transform },
          opacity: clip.opacity,
          volume: clip.volume,
          visual: {
            ...clipVisualSettings(clip),
            crop: { ...clipVisualSettings(clip).crop },
          },
          audio: { ...clipAudioSettings(clip) },
          animation: cloneClipAnimation(clipAnimation(clip)),
          effects: clip.effects.map((effect) => ({
            id: effect.id,
            type: effect.type,
            enabled: effect.enabled,
            params: cloneEffectParams(effect.params),
          })),
          ...(clip.text === undefined ? {} : { text: { ...clip.text } }),
          ...(clip.linkGroupId === undefined ? {} : { linkGroupId: clip.linkGroupId }),
        })),
        transitions: track.transitions.map((transition) => ({
          ...transition,
          audio: { ...transition.audio },
        })),
        hidden: track.hidden,
        muted: track.muted,
        solo: track.solo,
        locked: track.locked,
      })),
    },
    assets: project.assets
      .map((asset) => ({
        id: asset.id,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.size,
        lastModified: asset.lastModified,
        kind: asset.kind,
        ...(asset.partialTrackSelection === undefined
          ? {}
          : { partialTrackSelection: asset.partialTrackSelection }),
        durationMicroseconds: asset.durationMicroseconds,
        sourceBounds: cloneMediaSourceBounds(asset.sourceBounds),
        nativeFrameRate:
          asset.nativeFrameRate === null ? null : { ...asset.nativeFrameRate },
        width: asset.width,
        height: asset.height,
        hasAudio: asset.hasAudio,
        audioSampleRate: asset.audioSampleRate,
        audioChannels: asset.audioChannels,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  }
}

/**
 * Build one isolated portable snapshot from the active editor session's durable
 * descriptor catalog. Connected MediaAssets, session-only URLs, decoder state,
 * conformed frame counts, visuals, and undo history are intentionally absent.
 */
export function createProjectFileSnapshot(
  document: TimelineDoc,
  descriptors: Iterable<PortableAssetDescriptor>,
): ProjectFile {
  const assets = Array.from(descriptors)
  const project: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: CURRENT_PROJECT_FORMAT_VERSION,
    document,
    assets,
  }
  validateProjectFile(project)
  return portableProjectSnapshot(project)
}

interface SerializationBudget {
  remaining: number
}

function consumeSerializationBudget(
  budget: SerializationBudget,
  characters: number,
): void {
  if (characters > budget.remaining) {
    fail(
      '$',
      `serialized project exceeds ${PROJECT_FILE_LIMITS.maxSerializedCharacters} characters`,
    )
  }
  budget.remaining -= characters
}

function stableJson(value: unknown, budget: SerializationBudget): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value)
    consumeSerializationBudget(budget, serialized.length)
    return serialized
  }
  if (Array.isArray(value)) {
    consumeSerializationBudget(budget, 2)
    const items: string[] = []
    for (let index = 0; index < value.length; index++) {
      if (index > 0) consumeSerializationBudget(budget, 1)
      items.push(stableJson(value[index], budget))
    }
    return `[${items.join(',')}]`
  }
  const object = value as JsonRecord
  const keys = Object.keys(object).sort()
  consumeSerializationBudget(budget, 2)
  const entries: string[] = []
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const serializedKey = JSON.stringify(key)
    if (index > 0) consumeSerializationBudget(budget, 1)
    consumeSerializationBudget(budget, serializedKey.length + 1)
    entries.push(`${serializedKey}:${stableJson(object[key], budget)}`)
  }
  return `{${entries.join(',')}}`
}

/** Serialize an allowlisted, validated, deterministic portable snapshot. */
export function serializeProjectFile(project: ProjectFile): string {
  validateProjectFile(project)
  const snapshot = portableProjectSnapshot(project)
  validateProjectFile(snapshot)
  return stableJson(snapshot, {
    remaining: PROJECT_FILE_LIMITS.maxSerializedCharacters,
  })
}

/** Parse, migrate, and fully validate untrusted project-file JSON. */
export function parseProjectFile(serialized: string): ProjectFile {
  if (typeof serialized !== 'string') fail('$', 'project file must be text')
  if (serialized.length > PROJECT_FILE_LIMITS.maxSerializedCharacters) {
    fail('$', `project file exceeds ${PROJECT_FILE_LIMITS.maxSerializedCharacters} characters`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    fail('$', 'invalid JSON')
  }
  return validateProjectFile(migrateProjectFile(parsed))
}
