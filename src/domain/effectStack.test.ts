import { describe, expect, test } from 'vitest'
import type { EffectDescriptor } from './schema'
import {
  CANVAS_FILTER_EFFECT_CAPABILITY,
  CANVAS_PIXEL_EFFECT_CAPABILITY,
  COLOR_ADJUST_EFFECT_TYPE,
  COLOR_ADJUST_EFFECT_VERSION,
  createColorAdjustEffect,
  migrateEffectDescriptor,
  resolveCanvasEffectStack,
  resolveEffectStack,
  supportsCanvasEffectFilter,
} from './effectStack'

describe('effect registry and ordered evaluation', () => {
  test('creates independent versioned color-adjust defaults', () => {
    const first = createColorAdjustEffect('fx-a')
    const second = createColorAdjustEffect('fx-b')

    expect(first).toEqual({
      id: 'fx-a',
      type: COLOR_ADJUST_EFFECT_TYPE,
      version: COLOR_ADJUST_EFFECT_VERSION,
      enabled: true,
      params: {
        exposure: 0,
        contrast: 0,
        saturation: 0,
        temperature: 0,
        tint: 0,
      },
    })
    expect(first.params).not.toBe(second.params)
  })

  test('emits Canvas filters in authored stack order', () => {
    const first = createColorAdjustEffect('fx-a')
    first.params = { exposure: 1, contrast: 0.25, saturation: -0.5 }
    const second = createColorAdjustEffect('fx-b')
    second.params = { exposure: -1, contrast: -0.25, saturation: 0.5 }

    expect(resolveCanvasEffectStack([first, second], true).filter).toBe(
      'brightness(2) contrast(1.25) saturate(0.5) '
      + 'brightness(0.5) contrast(0.75) saturate(1.5)',
    )
  })

  test('keeps the no-effect path exact and reports unavailable capability', () => {
    expect(resolveCanvasEffectStack([], true)).toEqual({
      filter: null,
      pixelCorrections: [],
      effects: [],
    })

    const defaults = createColorAdjustEffect('fx-defaults')
    const defaultResolution = resolveCanvasEffectStack([defaults], false, false)
    expect(defaultResolution.filter).toBeNull()
    expect(defaultResolution.pixelCorrections).toEqual([])
    expect(defaultResolution.effects[0].status).toBe('ready')

    const [resolution] = resolveEffectStack(createStack(), new Set())
    expect(resolution.status).toBe('unsupported')
    expect(resolution.detail).toContain(CANVAS_FILTER_EFFECT_CAPABILITY)
    expect(resolution.canvasFilter).toBeNull()
    expect(supportsCanvasEffectFilter({ filter: 'none' })).toBe(true)
    expect(supportsCanvasEffectFilter({})).toBe(false)
  })

  test('routes temperature and tint through the ordered pixel contract', () => {
    const first = createColorAdjustEffect('fx-warm')
    first.params.temperature = 0.5
    const second = createColorAdjustEffect('fx-tint')
    second.params.tint = -0.25

    const unavailable = resolveCanvasEffectStack([first, second], true, false)
    expect(unavailable.filter).toBeNull()
    expect(unavailable.pixelCorrections).toEqual([])
    expect(unavailable.effects.map((effect) => effect.status)).toEqual([
      'unsupported',
      'unsupported',
    ])
    expect(unavailable.effects[0].detail).toContain(CANVAS_PIXEL_EFFECT_CAPABILITY)

    const supported = resolveCanvasEffectStack([first, second], true, true)
    expect(supported.filter).toBeNull()
    expect(supported.pixelCorrections).toEqual([first.params, second.params])
    expect(supported.effects.map((effect) => effect.status)).toEqual(['ready', 'ready'])
  })

  test('bypasses invalid and unknown effects without changing their payload', () => {
    const invalid = createColorAdjustEffect('fx-invalid')
    invalid.params.exposure = 99
    const unknown: EffectDescriptor = {
      id: 'fx-future',
      type: 'future.sparkle',
      version: 12,
      enabled: true,
      params: { seed: 42, mode: 'prismatic', preserveAlpha: true },
    }
    const before = JSON.stringify(unknown)
    const result = resolveCanvasEffectStack([invalid, unknown], true)

    expect(result.filter).toBeNull()
    expect(result.effects.map((effect) => effect.status)).toEqual(['invalid', 'unsupported'])
    expect(JSON.stringify(unknown)).toBe(before)
  })

  test('migrates owned legacy descriptors and clones unknown descriptors losslessly', () => {
    const legacy = {
      id: 'fx-color',
      type: COLOR_ADJUST_EFFECT_TYPE,
      version: 0,
      enabled: true,
      params: { exposure: 1, futureKnob: 'keep-me' },
    } satisfies EffectDescriptor
    expect(migrateEffectDescriptor(legacy)).toEqual({
      ...legacy,
      version: COLOR_ADJUST_EFFECT_VERSION,
      params: {
        exposure: 1,
        contrast: 0,
        saturation: 0,
        temperature: 0,
        tint: 0,
        futureKnob: 'keep-me',
      },
    })

    const unknown: EffectDescriptor = {
      id: 'fx-unknown',
      type: 'future.effect',
      version: 0,
      enabled: false,
      params: { opaque: 'yes' },
    }
    const migrated = migrateEffectDescriptor(unknown)
    expect(migrated).toEqual(unknown)
    expect(migrated).not.toBe(unknown)
    expect(migrated.params).not.toBe(unknown.params)
  })
})

function createStack(): EffectDescriptor[] {
  const effect = createColorAdjustEffect('fx-color')
  effect.params.exposure = 1
  return [effect]
}
