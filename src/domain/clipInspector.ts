/** Pure defaults and validation for Issue #34's static clip Inspector model. */

import type {
  Clip,
  ClipAudioSettings,
  ClipVisualSettings,
  CropInsets,
  Transform,
} from './schema'

/** Keep at least one percent of source width/height after opposing crops. */
export const MAX_CROP_SUM = 0.99
/** Zero-scale legacy clips remain valid (and render invisibly); UI floors edits above zero. */
export const MIN_CLIP_SCALE = 0
export const MAX_CLIP_SCALE = 100
export const MIN_AUDIO_BALANCE = -1
export const MAX_AUDIO_BALANCE = 1
/** Linear clip gain floor. Zero is valid and silent. */
export const MIN_CLIP_VOLUME = 0
/** Upper clip-volume bound: 200% gain, the usual NLE headroom. */
export const MAX_CLIP_VOLUME = 2

export const DEFAULT_CLIP_VISUAL_SETTINGS: Readonly<ClipVisualSettings> =
  Object.freeze({
    crop: Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 }),
    flipHorizontal: false,
    flipVertical: false,
    scaleLocked: true,
  })

export const DEFAULT_CLIP_AUDIO_SETTINGS: Readonly<ClipAudioSettings> =
  Object.freeze({
    enabled: true,
    balance: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  })

export function defaultClipVisualSettings(): ClipVisualSettings {
  return {
    ...DEFAULT_CLIP_VISUAL_SETTINGS,
    crop: { ...DEFAULT_CLIP_VISUAL_SETTINGS.crop },
  }
}

export function defaultClipAudioSettings(): ClipAudioSettings {
  return { ...DEFAULT_CLIP_AUDIO_SETTINGS }
}

export function clipVisualSettings(clip: Clip): ClipVisualSettings {
  return clip.visual ?? defaultClipVisualSettings()
}

export function clipAudioSettings(clip: Clip): ClipAudioSettings {
  return clip.audio ?? defaultClipAudioSettings()
}

function finite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

export function cropInsetsValidationError(crop: CropInsets): string | null {
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const value = crop[edge]
    if (!finite(value) || value < 0 || value > MAX_CROP_SUM) {
      return `crop.${edge} must be a finite number from 0 to ${MAX_CROP_SUM}`
    }
  }
  if (crop.left + crop.right > MAX_CROP_SUM) {
    return `crop.left + crop.right must be at most ${MAX_CROP_SUM}`
  }
  if (crop.top + crop.bottom > MAX_CROP_SUM) {
    return `crop.top + crop.bottom must be at most ${MAX_CROP_SUM}`
  }
  return null
}

export function clipVisualSettingsValidationError(
  visual: ClipVisualSettings,
): string | null {
  const cropError = cropInsetsValidationError(visual.crop)
  if (cropError) return cropError
  if (typeof visual.flipHorizontal !== 'boolean') {
    return 'flipHorizontal must be a boolean'
  }
  if (typeof visual.flipVertical !== 'boolean') {
    return 'flipVertical must be a boolean'
  }
  if (typeof visual.scaleLocked !== 'boolean') {
    return 'scaleLocked must be a boolean'
  }
  return null
}

export function clipAudioSettingsValidationError(
  audio: ClipAudioSettings,
  clipDurationFrames: number,
): string | null {
  if (typeof audio.enabled !== 'boolean') return 'enabled must be a boolean'
  if (
    !finite(audio.balance)
    || audio.balance < MIN_AUDIO_BALANCE
    || audio.balance > MAX_AUDIO_BALANCE
  ) {
    return `balance must be a finite number from ${MIN_AUDIO_BALANCE} to ${MAX_AUDIO_BALANCE}`
  }
  if (!Number.isSafeInteger(clipDurationFrames) || clipDurationFrames < 1) {
    return 'clip duration must be a positive safe integer'
  }
  for (const key of ['fadeInFrames', 'fadeOutFrames'] as const) {
    const value = audio[key]
    if (
      !Number.isSafeInteger(value)
      || value < 0
      || value > clipDurationFrames
    ) {
      return `${key} must be a safe integer from 0 to ${clipDurationFrames}`
    }
  }
  return null
}

/** Current documents use non-negative scale; mirroring is explicit visual state. */
export function transformScaleValidationError(transform: Transform): string | null {
  for (const key of ['scaleX', 'scaleY'] as const) {
    const value = transform[key]
    if (!finite(value) || value < MIN_CLIP_SCALE || value > MAX_CLIP_SCALE) {
      return `${key} must be a finite number from ${MIN_CLIP_SCALE} to ${MAX_CLIP_SCALE}`
    }
  }
  return null
}

/**
 * Schema-4 documents could encode flips as negative scale. Preserve their
 * rendered result while moving the sign into explicit schema-5 settings.
 */
export function migrateLegacyClipInspectorSettings(
  transform: Transform,
): { transform: Transform; visual: ClipVisualSettings; audio: ClipAudioSettings } {
  const scaleX = Math.abs(transform.scaleX)
  const scaleY = Math.abs(transform.scaleY)
  return {
    transform: {
      ...transform,
      scaleX,
      scaleY,
    },
    visual: {
      ...defaultClipVisualSettings(),
      flipHorizontal: transform.scaleX < 0,
      flipVertical: transform.scaleY < 0,
      scaleLocked: scaleX === scaleY,
    },
    audio: defaultClipAudioSettings(),
  }
}

/** Linear stereo balance with center preserving both source channels. */
export function stereoBalanceGains(balance: number): readonly [number, number] {
  if (!finite(balance) || balance < MIN_AUDIO_BALANCE || balance > MAX_AUDIO_BALANCE) {
    throw new RangeError(
      `Audio balance must be from ${MIN_AUDIO_BALANCE} to ${MAX_AUDIO_BALANCE}`,
    )
  }
  return balance < 0
    ? [1, 1 + balance]
    : [1 - balance, 1]
}
