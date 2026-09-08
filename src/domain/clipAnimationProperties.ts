/** Canonical current clip scalar catalog; durable unknown names remain outside this table. */
import type { Clip, ClipAnimationProperty } from './schema'
import { clipAudioSettings, clipVisualSettings, MAX_CLIP_SCALE, MAX_CLIP_VOLUME, MAX_CROP_SUM, MIN_AUDIO_BALANCE, MAX_AUDIO_BALANCE } from './clipInspector'
import { MAX_ANIMATED_FINITE_MAGNITUDE } from './scalarAnimation'

export const CROP_ANIMATION_PROPERTIES = ['crop-left', 'crop-right', 'crop-top', 'crop-bottom'] as const

export interface ClipScalarPropertySpec {
  readonly property: ClipAnimationProperty
  readonly propertyVersion: 1
  readonly label: string
  readonly unit: 'px' | 'degrees' | 'multiplier' | 'fraction' | 'balance'
  readonly min: number
  readonly max: number
  readonly step: number
}

const spec = (property: ClipAnimationProperty, label: string, unit: ClipScalarPropertySpec['unit'], min: number, max: number, step: number): ClipScalarPropertySpec =>
  Object.freeze({ property, propertyVersion: 1, label, unit, min, max, step })
const magnitude = MAX_ANIMATED_FINITE_MAGNITUDE
export const CLIP_SCALAR_PROPERTY_SPECS: Readonly<Record<ClipAnimationProperty, ClipScalarPropertySpec>> = Object.freeze({
  'position-x': spec('position-x', 'Position X', 'px', -magnitude, magnitude, 1),
  'position-y': spec('position-y', 'Position Y', 'px', -magnitude, magnitude, 1),
  'scale-x': spec('scale-x', 'Scale X', 'multiplier', 0, MAX_CLIP_SCALE, 0.01),
  'scale-y': spec('scale-y', 'Scale Y', 'multiplier', 0, MAX_CLIP_SCALE, 0.01),
  rotation: spec('rotation', 'Rotation', 'degrees', -magnitude, magnitude, 1),
  opacity: spec('opacity', 'Opacity', 'multiplier', 0, 1, 0.01),
  volume: spec('volume', 'Volume', 'multiplier', 0, MAX_CLIP_VOLUME, 0.01),
  balance: spec('balance', 'Balance', 'balance', MIN_AUDIO_BALANCE, MAX_AUDIO_BALANCE, 0.01),
  'crop-left': spec('crop-left', 'Crop left', 'fraction', 0, MAX_CROP_SUM, 0.01),
  'crop-right': spec('crop-right', 'Crop right', 'fraction', 0, MAX_CROP_SUM, 0.01),
  'crop-top': spec('crop-top', 'Crop top', 'fraction', 0, MAX_CROP_SUM, 0.01),
  'crop-bottom': spec('crop-bottom', 'Crop bottom', 'fraction', 0, MAX_CROP_SUM, 0.01),
})

export function clipScalarPropertySpec(property: string, version = 1): ClipScalarPropertySpec | null {
  return version === 1 && Object.hasOwn(CLIP_SCALAR_PROPERTY_SPECS, property)
    ? CLIP_SCALAR_PROPERTY_SPECS[property as ClipAnimationProperty] : null
}

export function readClipScalarProperty(clip: Clip, property: ClipAnimationProperty): number {
  switch (property) {
    case 'position-x': return clip.transform.x
    case 'position-y': return clip.transform.y
    case 'scale-x': return clip.transform.scaleX
    case 'scale-y': return clip.transform.scaleY
    case 'rotation': return clip.transform.rotation
    case 'opacity': return clip.opacity
    case 'volume': return clip.volume
    case 'balance': return clipAudioSettings(clip).balance
    case 'crop-left': return clipVisualSettings(clip).crop.left
    case 'crop-right': return clipVisualSettings(clip).crop.right
    case 'crop-top': return clipVisualSettings(clip).crop.top
    case 'crop-bottom': return clipVisualSettings(clip).crop.bottom
  }
}
