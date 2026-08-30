import { describe, expect, test } from 'vitest'
import {
  ADJUSTMENT_ADDITIONAL_SURFACE_COUNT,
  EXPORT_READBACK_SURFACE_COUNT,
  LENS_REMAP_REUSABLE_SURFACE_COUNT,
  MAX_RENDER_SURFACE_DIMENSION,
  MAX_RENDER_SURFACE_PIXELS,
  assertRenderSurfaceBudget,
  lensRemapSurfaceBudget,
  renderSurfaceBudget,
} from './renderSurfaceBudget'

describe('render surface budget', () => {
  test('accepts every reviewed 4K project orientation', () => {
    expect(renderSurfaceBudget(3_840, 2_160).allowed).toBe(true)
    expect(renderSurfaceBudget(2_160, 3_840).allowed).toBe(true)
  })

  test('rejects hostile dimensions before any canvas allocation', () => {
    expect(() => assertRenderSurfaceBudget(
      MAX_RENDER_SURFACE_DIMENSION + 1,
      1,
    )).toThrow(/dimension/i)
    expect(() => assertRenderSurfaceBudget(
      MAX_RENDER_SURFACE_PIXELS,
      2,
    )).toThrow(/pixel|memory/i)
  })

  test('accounts for every reusable compositor surface', () => {
    const budget = renderSurfaceBudget(3_840, 2_160)
    expect(budget.surfaceCount).toBe(4)
    expect(budget.aggregateBytes).toBe(3_840 * 2_160 * 4 * 4)
  })

  test('reuses compositor scratch for adjustment layers without raising the 4K peak', () => {
    const budget = renderSurfaceBudget(3_840, 2_160)
    expect(ADJUSTMENT_ADDITIONAL_SURFACE_COUNT).toBe(0)
    expect(budget.surfaceCount + ADJUSTMENT_ADDITIONAL_SURFACE_COUNT).toBe(4)
    expect(budget.aggregateBytes).toBe(132_710_400)
  })

  test('keeps the reviewed 4K lens-remap export peak at seven RGBA surfaces', () => {
    const budget = lensRemapSurfaceBudget(
      3_840,
      2_160,
      3_840,
      2_160,
      true,
    )

    expect(LENS_REMAP_REUSABLE_SURFACE_COUNT).toBe(2)
    expect(EXPORT_READBACK_SURFACE_COUNT).toBe(1)
    expect(budget).toMatchObject({
      allowed: true,
      compositorBytes: 132_710_400,
      remapReusableBytes: 66_355_200,
      exportReadbackBytes: 33_177_600,
      aggregateBytes: 232_243_200,
    })
  })

  test('budgets source remap and output presentation dimensions independently', () => {
    const budget = lensRemapSurfaceBudget(
      1_920,
      1_080,
      3_840,
      2_160,
      false,
    )

    expect(budget.compositorBytes).toBe(4 * 1_920 * 1_080 * 4)
    expect(budget.remapReusableBytes).toBe(2 * 3_840 * 2_160 * 4)
    expect(budget.aggregateBytes).toBe(
      4 * 1_920 * 1_080 * 4
      + 2 * 3_840 * 2_160 * 4,
    )
  })

  test('refuses lens allocations outside the shared surface budget', () => {
    expect(lensRemapSurfaceBudget(
      3_840,
      2_160,
      MAX_RENDER_SURFACE_DIMENSION,
      MAX_RENDER_SURFACE_DIMENSION,
      true,
    ).allowed).toBe(false)
  })
})
