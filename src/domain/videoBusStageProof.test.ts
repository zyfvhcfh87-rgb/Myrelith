import { expect, test } from 'vitest'
import { applyOrderedPixelEffectsToRgba } from './effectPixels'
import { registeredEffects, resolvePostCompositeEffectStack } from './effectStack'
import { spatialEffectKind, SPATIAL_EFFECT_PARAMETERS } from './spatialEffectDefinitions'
import { lensRemapSurfaceBudget, MAX_RENDER_AGGREGATE_SURFACE_BYTES } from './renderSurfaceBudget'

test('every admitted post-composite built-in explicitly preserves opaque input at its parameter extremes', () => {
  for (const registration of registeredEffects()) {
    if (!registration.surfaces.includes('post-composite')) continue
    expect(registration.preservesOpaqueInput, registration.type).toBe(true)
    const kind = spatialEffectKind(registration.type)
    const specs = kind ? SPATIAL_EFFECT_PARAMETERS[kind] : registration.animatableParams!
    for (const extreme of ['min', 'max'] as const) {
      const params = { ...registration.defaultParams }
      for (const [key, spec] of Object.entries(specs)) params[key] = spec[extreme]
      const effects = resolvePostCompositeEffectStack([{ id: 'proof', type: registration.type, version: registration.version, enabled: true, params }], true)
      const rgba = Uint8ClampedArray.from({ length: 17 * 13 * 4 }, (_, i) => i % 4 === 3 ? 255 : i * 71 % 256)
      applyOrderedPixelEffectsToRgba(rgba, effects.pixelEffects, { surfaceWidth: 17, surfaceHeight: 13, projectWidth: 17, projectHeight: 13 })
      expect([...rgba].filter((_, i) => i % 4 === 3).every((alpha) => alpha === 255), `${registration.type} ${extreme}`).toBe(true)
    }
  }
})

test('nested group allocation cannot be hidden in the existing 4K lens/export allowance', () => {
  const baseline = lensRemapSurfaceBudget(3840, 2160, 3840, 2160, true)
  expect(baseline.aggregateBytes).toBe(232_243_200)
  const frame = 3840 * 2160 * 4
  expect(baseline.aggregateBytes + frame * 2).toBeGreaterThan(MAX_RENDER_AGGREGATE_SURFACE_BYTES)
  // Sequential bus processing needs one ephemeral readback, not nesting-depth canvases.
  // This is conservative: the final encoded-output readback is later in export.
  expect(baseline.aggregateBytes + frame + 810_372).toBeLessThan(MAX_RENDER_AGGREGATE_SURFACE_BYTES)
})
