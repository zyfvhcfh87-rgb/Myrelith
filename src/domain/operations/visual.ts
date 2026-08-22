import type { ClipAnimationProperty, ClipId, ClipVisualSettings, CropInsets, TimelineDoc, Transform } from '../schema';
import { clipVisualSettings, clipVisualSettingsValidationError, transformScaleValidationError } from '../clipInspector';
import { blendModeIntentValidationError, clipBlendModeIntent } from '../blendModes';
import { locateClip, reject, withTrack } from './operationInternals';

/** What updateClipTransform can change (the Inspector's surface, 4.3). */
export interface ClipTransformPatch {
  /** Transform fields to merge; omitted fields keep their current values. */
  transform?: Partial<Transform>
  /** New opacity. Clamped into [0, 1] (schema range). */
  opacity?: number
}

/**
 * Merge new visual properties into a clip: any subset of Transform fields
 * plus opacity. Purely presentational — ranges, neighbors and durations
 * cannot be affected. Rejected on an empty patch or any non-finite number
 * (NaN/Infinity from a parsed input must never enter the doc); opacity is
 * clamped rather than rejected, since 0..1 is a UI convention.
 */
export function updateClipTransform(
  doc: TimelineDoc,
  clipId: ClipId,
  patch: ClipTransformPatch,
): TimelineDoc {
  return updateClipVisual(doc, clipId, patch)
}

export interface ClipVisualSettingsPatch {
  crop?: Partial<CropInsets>
  flipHorizontal?: boolean
  flipVertical?: boolean
  scaleLocked?: boolean
}

/** Complete static video/text Inspector mutation surface. */
export interface ClipVisualPatch extends ClipTransformPatch {
  /** Exact serialized blend intent; unknown names remain durable and render safely. */
  blendMode?: string
  visual?: ClipVisualSettingsPatch
}

const TRANSFORM_KEYS = new Set<keyof Transform>([
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
  'anchorX',
  'anchorY',
])

const VISUAL_SETTING_KEYS = new Set<keyof ClipVisualSettings>([
  'crop',
  'flipHorizontal',
  'flipVertical',
  'scaleLocked',
])

const CROP_KEYS = new Set<keyof CropInsets>([
  'left',
  'right',
  'top',
  'bottom',
])

function sameCrop(left: CropInsets, right: CropInsets): boolean {
  return left.left === right.left
    && left.right === right.right
    && left.top === right.top
    && left.bottom === right.bottom
}

export function sameVisual(
  left: ClipVisualSettings,
  right: ClipVisualSettings,
): boolean {
  return sameCrop(left.crop, right.crop)
    && left.flipHorizontal === right.flipHorizontal
    && left.flipVertical === right.flipVertical
    && left.scaleLocked === right.scaleLocked
}

/**
 * Atomically edit transform, opacity, blend intent, crop, flips, and scale-lock state.
 * When locking previously independent scales, X is authoritative. While the
 * lock remains enabled, an edit to either scale updates both axes.
 */
export function updateClipVisual(
  doc: TimelineDoc,
  clipId: ClipId,
  patch: ClipVisualPatch,
): TimelineDoc {
  const op = 'updateClipVisual'
  const loc = locateClip(doc, clipId)
  if (!loc) return reject(doc, op, `clip ${clipId} not found`)
  if (loc.track.locked) return reject(doc, op, `track ${loc.track.id} is locked`)

  const transformPatch = patch.transform ?? {}
  const transformKeys = Object.keys(transformPatch) as Array<keyof Transform>
  for (const key of transformKeys) {
    if (!TRANSFORM_KEYS.has(key)) {
      return reject(doc, op, `unknown transform property ${String(key)}`)
    }
    const value = transformPatch[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return reject(doc, op, `transform.${key} must be a finite number, got ${value}`)
    }
  }

  const visualPatch = patch.visual ?? {}
  const visualKeys = Object.keys(visualPatch) as Array<keyof ClipVisualSettings>
  for (const key of visualKeys) {
    if (!VISUAL_SETTING_KEYS.has(key)) {
      return reject(doc, op, `unknown visual property ${String(key)}`)
    }
  }
  if (visualPatch.crop !== undefined) {
    const cropKeys = Object.keys(visualPatch.crop) as Array<keyof CropInsets>
    for (const key of cropKeys) {
      if (!CROP_KEYS.has(key)) {
        return reject(doc, op, `unknown crop property ${String(key)}`)
      }
    }
  }
  const hasOpacity = patch.opacity !== undefined
  if (hasOpacity && !Number.isFinite(patch.opacity)) {
    return reject(doc, op, `opacity must be a finite number, got ${patch.opacity}`)
  }
  const hasBlendMode = patch.blendMode !== undefined
  if (hasBlendMode) {
    const blendError = blendModeIntentValidationError(patch.blendMode)
    if (blendError) return reject(doc, op, blendError)
  }
  if (transformKeys.length === 0 && visualKeys.length === 0 && !hasOpacity && !hasBlendMode) {
    return reject(doc, op, 'empty patch — nothing to change')
  }

  const currentVisual = clipVisualSettings(loc.clip)
  const nextVisual: ClipVisualSettings = {
    ...currentVisual,
    ...visualPatch,
    crop: {
      ...currentVisual.crop,
      ...(visualPatch.crop ?? {}),
    },
  }
  const visualError = clipVisualSettingsValidationError(nextVisual)
  if (visualError) return reject(doc, op, visualError)

  const nextTransform: Transform = {
    ...loc.clip.transform,
    ...transformPatch,
  }
  if (nextVisual.scaleLocked) {
    const scaleX = transformPatch.scaleX
    const scaleY = transformPatch.scaleY
    if (scaleX !== undefined && scaleY !== undefined && scaleX !== scaleY) {
      return reject(doc, op, 'locked scale X and Y must match')
    }
    if (scaleX !== undefined || scaleY !== undefined) {
      const scale = (scaleX ?? scaleY) as number
      nextTransform.scaleX = scale
      nextTransform.scaleY = scale
    } else if (!currentVisual.scaleLocked && visualPatch.scaleLocked === true) {
      nextTransform.scaleY = nextTransform.scaleX
    }
  }
  const scaleError = transformScaleValidationError(nextTransform)
  if (scaleError) return reject(doc, op, scaleError)
  if (
    nextTransform.anchorX < 0
    || nextTransform.anchorX > 1
    || nextTransform.anchorY < 0
    || nextTransform.anchorY > 1
  ) {
    return reject(doc, op, 'anchor values must be from 0 to 1')
  }

  const opacity = hasOpacity
    ? Math.min(1, Math.max(0, patch.opacity as number))
    : loc.clip.opacity
  const blendMode = hasBlendMode
    ? patch.blendMode as string
    : clipBlendModeIntent(loc.clip)
  const transformUnchanged = [...TRANSFORM_KEYS].every(
    (key) => nextTransform[key] === loc.clip.transform[key],
  )
  if (
    transformUnchanged
    && opacity === loc.clip.opacity
    && blendMode === clipBlendModeIntent(loc.clip)
    && sameVisual(nextVisual, currentVisual)
  ) return doc

  const clips = loc.track.clips.slice()
  clips[loc.clipIndex] = {
    ...loc.clip,
    transform: nextTransform,
    opacity,
    blendMode,
    visual: nextVisual,
  }
  return withTrack(doc, loc.trackIndex, { ...loc.track, clips })
}

export const TRANSFORM_ANIMATION_PROPERTIES: Partial<
  Record<keyof Transform, ClipAnimationProperty>
> = {
  x: 'position-x',
  y: 'position-y',
  scaleX: 'scale-x',
  scaleY: 'scale-y',
  rotation: 'rotation',
}
