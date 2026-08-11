import { describe, expect, test } from 'vitest'
import {
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
})
