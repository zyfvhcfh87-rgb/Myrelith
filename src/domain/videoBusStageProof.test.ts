import { expect, test } from 'vitest'
import type { EffectParamValue } from './schema'
import { ColorGradingRuntime } from '../pipeline/colorGradingRuntime'
import { COLOR_LUT_TYPE, parseCube, portableColorLut } from './colorLut'
import { registeredEffects, resolvePostCompositeEffectStack } from './effectStack'
import { spatialEffectKind, SPATIAL_EFFECT_PARAMETERS } from './spatialEffectDefinitions'
import { lensRemapSurfaceBudget, MAX_RENDER_AGGREGATE_SURFACE_BYTES } from './renderSurfaceBudget'

test('every admitted post-composite built-in explicitly preserves opaque input at its parameter extremes', async () => {
  const runtime = new ColorGradingRuntime(async () => {})
  runtime.setCatalog([portableColorLut('proof-lut', 'Proof', parseCube('LUT_1D_SIZE 2\n0.1 0.2 0.3\n0.8 0.7 0.6'))])
  try {
    for (const registration of registeredEffects()) {
      if (!registration.surfaces.includes('post-composite')) continue
      expect(registration.preservesOpaqueInput, registration.type).toBe(true)
      const kind = spatialEffectKind(registration.type)
      const specs = kind ? SPATIAL_EFFECT_PARAMETERS[kind] : registration.animatableParams!
      for (const extreme of ['min', 'max'] as const) {
        const params: Record<string, EffectParamValue> = { ...registration.defaultParams, ...(registration.type === COLOR_LUT_TYPE ? { lutId: 'proof-lut' } : {}) }
        for (const [key, spec] of Object.entries(specs)) params[key] = spec[extreme]
        const effects = resolvePostCompositeEffectStack([{ id: 'proof', type: registration.type, version: registration.version, enabled: true, params }], true, runtime.context)
        const rgba = Uint8ClampedArray.from({ length: 17 * 13 * 4 }, (_, i) => i % 4 === 3 ? 255 : i * 71 % 256)
        await runtime.apply(rgba, effects.pixelEffects, { surfaceWidth: 17, surfaceHeight: 13, projectWidth: 17, projectHeight: 13 })
        expect([...rgba].filter((_, i) => i % 4 === 3).every((alpha) => alpha === 255), `${registration.type} ${extreme}`).toBe(true)
      }
    }
  } finally { runtime.dispose() }
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
