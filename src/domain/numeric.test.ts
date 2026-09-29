import { describe, expect, test } from 'vitest'
import {
  ceilDivide,
  clamp,
  isFiniteInRange,
  isFiniteNumber,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  requireNonNegativeSafeInteger,
  requirePositiveSafeInteger,
} from './numeric'

describe('numeric helpers', () => {
  test('clamp bounds a value and keeps NaN visible', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(Number.NaN, 0, 10)).toBeNaN()
  })

  test('finite checks reject non-numbers, NaN and infinities', () => {
    expect(isFiniteNumber(0)).toBe(true)
    for (const value of [Number.NaN, Infinity, '1', null]) {
      expect(isFiniteNumber(value)).toBe(false)
    }
    expect(isFiniteInRange(1, 0, 1)).toBe(true)
    expect(isFiniteInRange(0, 0, 1)).toBe(true)
    expect(isFiniteInRange(1.0001, 0, 1)).toBe(false)
    expect(isFiniteInRange('0.5', 0, 1)).toBe(false)
  })

  test('safe-integer checks match their sign rules', () => {
    const cases: Array<[unknown, boolean, boolean]> = [
      [1, true, true],
      [0, false, true],
      [-0, false, true],
      [-1, false, false],
      [1.5, false, false],
      [Number.MAX_SAFE_INTEGER, true, true],
      [Number.MAX_SAFE_INTEGER + 1, false, false],
      ['1', false, false],
      [Number.NaN, false, false],
    ]
    for (const [value, positive, nonNegative] of cases) {
      expect(isPositiveSafeInteger(value)).toBe(positive)
      expect(isNonNegativeSafeInteger(value)).toBe(nonNegative)
    }
  })

  test('require helpers return valid values and keep the shared RangeError wording', () => {
    expect(requirePositiveSafeInteger(3, 'Width')).toBe(3)
    expect(requireNonNegativeSafeInteger(0, 'Frame')).toBe(0)
    expect(() => requirePositiveSafeInteger(0, 'Width'))
      .toThrow(new RangeError('Width must be a positive safe integer'))
    expect(() => requireNonNegativeSafeInteger(-1, 'Frame'))
      .toThrow(new RangeError('Frame must be a non-negative safe integer'))
  })

  test('ceilDivide rounds a non-negative quotient up', () => {
    expect(ceilDivide(0n, 3n)).toBe(0n)
    expect(ceilDivide(6n, 3n)).toBe(2n)
    expect(ceilDivide(7n, 3n)).toBe(3n)
  })
})
