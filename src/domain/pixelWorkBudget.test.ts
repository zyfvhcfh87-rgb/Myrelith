import { describe, expect, test } from 'vitest'
import { DEFAULT_MASK_PARAMS, type CanvasPixelEffect, type MaskParams } from './effectStack'
import { COLOR_LUT_LIMITS } from './colorLut'
import { applyOrderedPixelEffectsToRgba, type PixelEffectGeometry, type PixelEffectWorkMetrics } from './effectPixels'
import { maskPixelWork } from './maskPixelWork'
import { peakPixelStackWork, pixelStackWorkBudget } from './pixelWorkBudget'
import { spatialEffectScratchBytes } from './spatialEffectPixels'
import type { SpatialPixelEffect } from './spatialEffectDefinitions'

const FULL_PATH = 'M 0 0 C 0 0 1 0 1 0 C 1 0 1 1 1 1 C 1 1 0 1 0 1 C 0 1 0 0 0 0 Z'
const UHD: PixelEffectGeometry = { surfaceWidth: 3840, surfaceHeight: 2160, projectWidth: 3840, projectHeight: 2160 }
const PIXELS = 3840 * 2160
function mask(patch: Partial<MaskParams> = {}): Extract<CanvasPixelEffect, { kind: 'mask' }> {
  return { kind: 'mask', params: { ...DEFAULT_MASK_PARAMS, shape: 'bezier',
    x: 0, y: 0, width: 1, height: 1, path: FULL_PATH, feather: 0.05, ...patch } }
}
const OUTLINE: SpatialPixelEffect = { kind: 'outline', params: { width: 32, opacity: 1, color: '#000000' } }

describe('pixel work ownership budgets', () => {
  test('accounts for plain full-frame Bezier readback and both mask arrays without grading', () => {
    expect(pixelStackWorkBudget([mask()], UHD, 'shared-scratch')).toMatchObject({
      reason: null, readbackBytes: PIXELS * 4, workingBytes: 0,
      maskInsideBytes: PIXELS, maskDistanceBytes: PIXELS * 4,
      gradingCacheBytes: 0, peakAdditionalBytes: PIXELS * 9,
    })
  })
  test.each([false, true])('clipped inverse=%s masks use the actual bounded surface region', (invert) => {
    const effect = mask({ x: 0.75, width: 0.5, invert })
    expect(maskPixelWork(effect.params, UHD)).toMatchObject({ insidePixels: PIXELS / 4, distancePixels: PIXELS / 4 })
    expect(pixelStackWorkBudget([effect], UHD, 'shared-scratch').peakAdditionalBytes).toBe(PIXELS * 5.25)
    expect(pixelStackWorkBudget([mask({ x: 2, invert })], UHD, 'shared-scratch').peakAdditionalBytes).toBe(PIXELS * 4)
  })
  test.each(['rectangle', 'ellipse'] as const)('%s requires readback but no Bezier arrays', (shape) => {
    expect(pixelStackWorkBudget([mask({ shape, feather: 0.5 })], UHD, 'shared-scratch')).toMatchObject({
      maskInsideBytes: 0, maskDistanceBytes: 0, peakAdditionalBytes: PIXELS * 4,
    })
  })
  test('zero feather omits distance allocation; reduced surfaces retain project-space geometry', () => {
    expect(pixelStackWorkBudget([mask({ feather: 0 })], UHD, 'shared-scratch').peakAdditionalBytes).toBe(PIXELS * 5)
    const reduced = { ...UHD, surfaceWidth: 1920, surfaceHeight: 1080 }
    expect(pixelStackWorkBudget([mask()], reduced, 'shared-scratch').peakAdditionalBytes).toBe(PIXELS / 4 * 9)
  })
  test('a later spatial effect adds its scratch to retained mask arrays in authored order', () => {
    const spatial = spatialEffectScratchBytes(OUTLINE, UHD)
    const forward = pixelStackWorkBudget([mask(), OUTLINE], UHD, 'shared-scratch')
    const reverse = pixelStackWorkBudget([OUTLINE, mask()], UHD, 'shared-scratch')
    expect(spatial).toBeGreaterThan(0)
    expect(forward.peakAdditionalBytes).toBe(PIXELS * 9 + spatial)
    expect(reverse.peakAdditionalBytes).toBe(PIXELS * 9)
    expect(pixelStackWorkBudget([mask(), OUTLINE], UHD, 'isolated-stages').peakAdditionalBytes).toBe(PIXELS * 9)
  })
  test('shared lists retain an earlier feather array when a later larger zero-feather mask grows inside scratch', () => {
    const stages = [mask({ width: 0.5, height: 0.5 }), mask({ feather: 0 })]
    expect(pixelStackWorkBudget(stages, UHD, 'shared-scratch').peakAdditionalBytes).toBe(PIXELS * 6)
    expect(pixelStackWorkBudget(stages, UHD, 'isolated-stages').peakAdditionalBytes).toBe(PIXELS * 5.25)
  })
  test('plugin transfer/result buffers end before subsequent mask or plugin stages', () => {
    const work = pixelStackWorkBudget([{ kind: 'plugin' }, mask(), { kind: 'plugin' }], UHD, 'plugin-stages', true)
    expect(work).toMatchObject({ readbackBytes: PIXELS * 4, workingBytes: PIXELS * 4,
      pluginInputBytes: PIXELS * 4, pluginResultBytes: PIXELS * 4,
      maskInsideBytes: PIXELS, maskDistanceBytes: PIXELS * 4,
      peakAdditionalBytes: PIXELS * 16 + COLOR_LUT_LIMITS.runtimeBytes })
    expect(pixelStackWorkBudget([{ kind: 'plugin' }], UHD, 'shared-scratch').reason).toMatch(/transactional/)
  })
  test('serial stacks take a peak while persistent grading remains included in every stack', () => {
    const first = pixelStackWorkBudget([mask()], UHD, 'isolated-stages', true)
    const second = pixelStackWorkBudget([OUTLINE], UHD, 'isolated-stages', true)
    expect(peakPixelStackWork([first, second]).peakAdditionalBytes).toBe(first.peakAdditionalBytes)
    expect(peakPixelStackWork([]).peakAdditionalBytes).toBe(0)
  })
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 16_385])(
    'invalid or oversized dimension %s rejects before mask geometry', (surfaceWidth) => {
      expect(pixelStackWorkBudget([mask()], { ...UHD, surfaceWidth }, 'shared-scratch').reason).toBeTruthy()
    },
  )
  test('actual small raster allocation metrics match the independent shared-scratch ledger', () => {
    const geometry = { surfaceWidth: 32, surfaceHeight: 32, projectWidth: 32, projectHeight: 32 }
    const stages: CanvasPixelEffect[] = [mask({ width: 0.5, height: 0.5 }), mask({ feather: 0 }), OUTLINE]
    const metrics: PixelEffectWorkMetrics = { maskScanlineEdgeTests: 0, maskDistanceSamples: 0 }
    const rgba = new Uint8ClampedArray(32 * 32 * 4).fill(255)
    applyOrderedPixelEffectsToRgba(rgba, stages, geometry, metrics)
    const work = pixelStackWorkBudget(stages, geometry, 'shared-scratch')
    expect(metrics.ownedScratchBytesPeak).toBe(work.peakAdditionalBytes - work.readbackBytes)
    expect(metrics.spatialScratchBytesPeak).toBe(work.spatialBytes)
    expect(metrics.maskInsideScratchPixelsPeak).toBe(work.maskInsideBytes)
    expect(metrics.maskDistanceScratchPixelsPeak! * 4).toBe(work.maskDistanceBytes)
  })
})
