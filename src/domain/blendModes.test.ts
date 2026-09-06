import { describe, expect, test } from 'vitest'
import type { Clip } from './schema'
import {
  BLEND_MODE_NAMES,
  blendModeIntentValidationError,
  clipBlendModeIntent,
  compositeReferencePixel,
  DEFAULT_BLEND_MODE,
  resolveBlendMode,
  resolveTransitionGroupBlendMode,
  type BlendModeName,
} from './blendModes'

const opaqueExpected: Readonly<Record<BlendModeName, object>> = {
  normal: { r: 192, g: 96, b: 32, a: 255 },
  multiply: { r: 48, g: 48, b: 24, a: 255 },
  screen: { r: 208, g: 176, b: 200, a: 255 },
  overlay: { r: 96, g: 97, b: 145, a: 255 },
  darken: { r: 64, g: 96, b: 32, a: 255 },
  lighten: { r: 192, g: 128, b: 192, a: 255 },
  difference: { r: 128, g: 32, b: 160, a: 255 },
  exclusion: { r: 160, g: 128, b: 176, a: 255 },
}

const transparentExpected: Readonly<Record<BlendModeName, object>> = {
  normal: { r: 109, g: 102, b: 83, a: 160 },
  multiply: { r: 69, g: 78, b: 75, a: 160 },
  screen: { r: 110, g: 107, b: 98, a: 160 },
  overlay: { r: 75, g: 86, b: 80, a: 160 },
  darken: { r: 70, g: 83, b: 83, a: 160 },
  lighten: { r: 109, g: 102, b: 90, a: 160 },
  difference: { r: 102, g: 90, b: 77, a: 160 },
  exclusion: { r: 104, g: 99, b: 93, a: 160 },
}

function intent(blendMode?: string): Pick<Clip, 'blendMode'> {
  return { blendMode }
}

describe('blend-mode domain contract', () => {
  test('uses the explicit eight-name vocabulary and historical normal default', () => {
    expect(BLEND_MODE_NAMES).toEqual(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion'])
    expect(DEFAULT_BLEND_MODE).toBe('normal')
    expect(clipBlendModeIntent(intent())).toBe('normal')
  })

  test('preserves unknown and empty serialized intent while resolving safely', () => {
    expect(resolveBlendMode('future-soft-light')).toEqual({
      intent: 'future-soft-light',
      effective: 'normal',
      status: 'compatibility-fallback',
    })
    expect(resolveBlendMode('')).toEqual({
      intent: '',
      effective: 'normal',
      status: 'compatibility-fallback',
    })
    expect(blendModeIntentValidationError('future-soft-light')).toBeNull()
    expect(blendModeIntentValidationError('')).toBeNull()
    expect(blendModeIntentValidationError(42)).toBe('blend mode intent must be a string')
  })

  test('uses a non-normal transition group only when both isolated legs agree', () => {
    expect(resolveTransitionGroupBlendMode(intent('screen'), intent('screen'))).toMatchObject({
      effective: 'screen',
      status: 'supported',
    })
    expect(resolveTransitionGroupBlendMode(intent('screen'), intent('multiply'))).toMatchObject({
      effective: 'normal',
      status: 'compatibility-fallback',
    })
    expect(resolveTransitionGroupBlendMode(intent('future-mode'), intent('future-mode'))).toMatchObject({
      effective: 'normal',
      status: 'compatibility-fallback',
    })
  })

  test.each(BLEND_MODE_NAMES)('matches the opaque sRGB reference fixture for %s', (mode) => {
    expect(compositeReferencePixel(
      { r: 64, g: 128, b: 192, a: 255 },
      { r: 192, g: 96, b: 32, a: 255 },
      mode,
    )).toEqual(opaqueExpected[mode])
  })

  test.each(BLEND_MODE_NAMES)('matches premultiplied alpha and opacity for %s', (mode) => {
    expect(compositeReferencePixel(
      { r: 32, g: 64, b: 96, a: 128 },
      { r: 224, g: 160, b: 64, a: 128 },
      mode,
      0.5,
    )).toEqual(transparentExpected[mode])
  })

  test('keeps fully transparent output canonical and never invents color', () => {
    expect(compositeReferencePixel(
      { r: 80, g: 40, b: 20, a: 0 },
      { r: 200, g: 160, b: 120, a: 0 },
      'overlay',
    )).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })
})
