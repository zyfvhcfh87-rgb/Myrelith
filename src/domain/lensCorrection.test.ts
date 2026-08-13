import { describe, expect, test } from 'vitest'
import {
  createValidatedLensCorrectionMap,
  DEFAULT_MANUAL_LENS_CORRECTION,
  lensCorrectionCoverage,
  lensCorrectionValidationError,
  mapLensCorrectionPoint,
} from './lensCorrection'

describe('manual lens correction model', () => {
  test('keeps the neutral model byte-geometry neutral', () => {
    expect(lensCorrectionValidationError(DEFAULT_MANUAL_LENS_CORRECTION)).toBeNull()
    const mapped = mapLensCorrectionPoint(
      DEFAULT_MANUAL_LENS_CORRECTION,
      { x: 0.17, y: 0.83 },
    )
    expect(mapped.x).toBeCloseTo(0.17, 12)
    expect(mapped.y).toBeCloseTo(0.83, 12)
    expect(lensCorrectionCoverage(DEFAULT_MANUAL_LENS_CORRECTION)).toMatchObject({
      covered: true,
      maximumOverscan: 0,
    })
  })

  test('rejects a finite but folding radial model', () => {
    expect(lensCorrectionValidationError({
      ...DEFAULT_MANUAL_LENS_CORRECTION,
      k1: -1.5,
    })).toMatch(/folds|non-bijective/)
  })

  test('makes undefined edge sampling and explicit output crop measurable', () => {
    const distorted = {
      ...DEFAULT_MANUAL_LENS_CORRECTION,
      k1: 0.18,
      k2: 0.03,
    }
    const uncropped = lensCorrectionCoverage(distorted)
    const cropped = lensCorrectionCoverage({ ...distorted, outputScale: 1.25 })
    expect(uncropped.covered).toBe(false)
    expect(uncropped.maximumOverscan).toBeGreaterThan(0)
    expect(cropped.maximumOverscan).toBeLessThan(uncropped.maximumOverscan)
  })

  test('freezes one validated model for bounded frame loops', () => {
    const authored = {
      ...DEFAULT_MANUAL_LENS_CORRECTION,
      centerX: 0.4,
      k1: 0.12,
      outputScale: 1.2,
    }
    const mapper = createValidatedLensCorrectionMap(authored)
    const expected = mapLensCorrectionPoint(authored, { x: 0.2, y: 0.8 })
    authored.k1 = 0

    expect(mapper.map({ x: 0.2, y: 0.8 })).toEqual(expected)
    expect(Object.isFrozen(mapper)).toBe(true)
    expect(Object.isFrozen(mapper.model)).toBe(true)
    expect(() => mapper.map({ x: -0.01, y: 0.5 })).toThrow(/output point/)
  })
})
