import { describe, expect, test } from 'vitest'
import {
  DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
  isValidStillImageDurationMicroseconds,
  STILL_IMAGE_DURATION_PREFERENCE_LIMITS,
  stillImageDurationFrames,
} from './staticImage'

describe('still-image timing policy', () => {
  test('uses one canonical five-second duration across project rates', () => {
    expect(DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS).toBe(5_000_000)
    expect(stillImageDurationFrames({ num: 24, den: 1 })).toBe(120)
    expect(stillImageDurationFrames({ num: 30_000, den: 1_001 })).toBe(150)
    expect(stillImageDurationFrames({ num: 60, den: 1 })).toBe(300)
  })

  test('accepts a future preference as integer microseconds', () => {
    expect(stillImageDurationFrames({ num: 30, den: 1 }, 2_500_000)).toBe(75)
  })

  test('bounds the persisted preference from one tenth of a second to one hour', () => {
    expect(STILL_IMAGE_DURATION_PREFERENCE_LIMITS).toEqual({
      minMicroseconds: 100_000,
      maxMicroseconds: 3_600_000_000,
    })
    expect(isValidStillImageDurationMicroseconds(100_000)).toBe(true)
    expect(isValidStillImageDurationMicroseconds(3_600_000_000)).toBe(true)
    expect(isValidStillImageDurationMicroseconds(99_999)).toBe(false)
    expect(isValidStillImageDurationMicroseconds(3_600_000_001)).toBe(false)
  })

  test('retains the shared validation boundary', () => {
    expect(() => stillImageDurationFrames({ num: 30, den: 1 }, 1.5))
      .toThrow(TypeError)
    expect(() => stillImageDurationFrames({ num: 30, den: 1 }, 99_999))
      .toThrow(TypeError)
    expect(() => stillImageDurationFrames({ num: 0, den: 1 }))
      .toThrow(TypeError)
  })
})
