import { describe, expect, test } from 'vitest'
import { formatFrameRate } from './frameRateLabel'

describe('formatFrameRate', () => {
  test('prints whole rates plainly and trims fractional rates to three places', () => {
    expect(formatFrameRate({ num: 30, den: 1 })).toBe('30')
    expect(formatFrameRate({ num: 60, den: 2 })).toBe('30')
    expect(formatFrameRate({ num: 30_000, den: 1_001 })).toBe('29.97')
    expect(formatFrameRate({ num: 24_000, den: 1_001 })).toBe('23.976')
    expect(formatFrameRate({ num: 60_000, den: 1_001 })).toBe('59.94')
    expect(formatFrameRate({ num: 25, den: 2 })).toBe('12.5')
  })
})
