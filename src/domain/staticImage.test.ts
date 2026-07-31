import { describe, expect, test } from 'vitest'
import {
  DEFAULT_STILL_IMAGE_DURATION_MICROSECONDS,
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

  test('retains the shared validation boundary', () => {
    expect(() => stillImageDurationFrames({ num: 30, den: 1 }, 1.5))
      .toThrow(TypeError)
    expect(() => stillImageDurationFrames({ num: 0, den: 1 }))
      .toThrow(TypeError)
  })
})
