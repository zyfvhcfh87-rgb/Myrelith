import { describe, expect, test } from 'vitest'
import { PROJECT_RESOLUTION_PRESETS } from '../../domain/projectSettings'
import {
  compareLensRemapRgba,
  createLensRemapFixtureRgba,
  lensRemapSurfaceBudget,
  LENS_REMAP_FIXTURES,
  LENS_REMAP_FIXTURE_VERSION,
  LENS_REMAP_BACKEND_VERSION,
  LENS_REMAP_SOURCE_STAGE_ORDER,
  percentile95,
  remapLensRgbaCpu,
} from './lensRemapCore'

describe('Issue #111 lens-remap CPU oracle', () => {
  test('pins the complete versioned fixture and backend provenance', () => {
    expect(LENS_REMAP_FIXTURE_VERSION).toBe('issue-111-lens-fixtures-v1')
    expect(LENS_REMAP_BACKEND_VERSION).toBe('webgl2-rgba8-manual-bilinear-v1')
    expect(LENS_REMAP_FIXTURES.map((fixture) => fixture.id)).toEqual([
      'neutral',
      'barrel',
      'pincushion',
      'tangential',
      'off-center',
      'strong-valid',
      'transparent-edge',
    ])
    expect(new Set(LENS_REMAP_FIXTURES.map((fixture) => fixture.id)).size).toBe(7)
    expect(LENS_REMAP_FIXTURES.every((fixture) => Object.isFrozen(fixture.model))).toBe(true)
  })

  test('keeps the neutral model byte-identical', async () => {
    const input = createLensRemapFixtureRgba(32, 18, true)
    const output = await remapLensRgbaCpu(
      input,
      32,
      18,
      LENS_REMAP_FIXTURES[0].model,
    )
    expect(compareLensRemapRgba(input, output)).toEqual({
      maximumChannelDelta: 0,
      meanChannelDelta: 0,
      differingChannels: 0,
    })
  })

  test('makes undefined corrected edges transparent', async () => {
    const fixture = LENS_REMAP_FIXTURES.find(
      (candidate) => candidate.id === 'transparent-edge',
    )!
    const input = createLensRemapFixtureRgba(64, 36, false)
    const output = await remapLensRgbaCpu(input, 64, 36, fixture.model)
    const cornerAlpha = [
      output[3],
      output[(64 - 1) * 4 + 3],
      output[((36 - 1) * 64) * 4 + 3],
      output[(36 * 64 - 1) * 4 + 3],
    ]
    expect(cornerAlpha).toEqual([0, 0, 0, 0])
    expect(output[((18 * 64 + 32) * 4) + 3]).toBe(255)
  })

  test('cooperatively cancels without returning a partial frame', async () => {
    const controller = new AbortController()
    const input = createLensRemapFixtureRgba(96, 64, false)
    let yields = 0
    const operation = remapLensRgbaCpu(
      input,
      96,
      64,
      LENS_REMAP_FIXTURES[1].model,
      {
        signal: controller.signal,
        yieldEveryRows: 4,
        yieldControl: async () => {
          yields++
          controller.abort()
        },
      },
    )
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    expect(yields).toBe(1)
  })

  test('fits every selectable project size inside the combined finite envelope', () => {
    for (const preset of PROJECT_RESOLUTION_PRESETS) {
      const budget = lensRemapSurfaceBudget(preset.width, preset.height)
      expect(budget.allowed, `${preset.width}x${preset.height}: ${budget.reason}`)
        .toBe(true)
      expect(budget.combinedExportPeakBytes).toBeLessThanOrEqual(256 * 1024 * 1024)
    }
  })

  test('freezes source-space ordering before authored composition', () => {
    expect(LENS_REMAP_SOURCE_STAGE_ORDER).toEqual([
      'decoded-oriented-source',
      'manual-lens-remap',
      'authored-crop',
      'clip-transform',
      'mask-and-chroma',
      'ordered-color-and-effects',
      'opacity-and-blend',
      'transition-group',
    ])
    expect(Object.isFrozen(LENS_REMAP_SOURCE_STAGE_ORDER)).toBe(true)
  })

  test('computes deterministic p95 timing samples', () => {
    expect(percentile95([4, 2, 1, 3, 5])).toBe(5)
    expect(percentile95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19)
    expect(() => percentile95([])).toThrow(/non-empty/)
  })

  test('rejects visible views that hide a larger retained backing allocation', async () => {
    const oversized = new Uint8ClampedArray(4 * 4 * 4 + 4)
    const hiddenBacking = new Uint8ClampedArray(oversized.buffer, 0, 4 * 4 * 4)
    await expect(remapLensRgbaCpu(
      hiddenBacking,
      4,
      4,
      LENS_REMAP_FIXTURES[0].model,
    )).rejects.toThrow(/complete backing buffer/)
    expect(() => createLensRemapFixtureRgba(-4, -4, false)).toThrow(/positive/)
  })
})
