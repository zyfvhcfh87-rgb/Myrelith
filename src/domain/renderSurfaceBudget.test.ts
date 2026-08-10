import { describe, expect, test } from 'vitest'
import {
  MAX_RENDER_SURFACE_DIMENSION,
  MAX_RENDER_SURFACE_PIXELS,
  assertRenderSurfaceBudget,
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
})
