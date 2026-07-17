import { describe, expect, test } from 'vitest'
import {
  calculateTimelineZoomGeometry,
  sliderPositionForZoom,
  timelineRunwayFrames,
  zoomAtSliderPosition,
} from './timelineZoom'

const RATE = { num: 30, den: 1 }

describe('timeline zoom math', () => {
  test('derives viewport-relative Full, Detail, and endpoint scales', () => {
    const geometry = calculateTimelineZoomGeometry(1200, 6000, RATE)

    expect(geometry.fullZoom).toBeCloseTo((1200 - 36) / 6000, 12)
    expect(geometry.detailZoom).toBeCloseTo(1200 / (11 * 30), 12)
    expect(geometry.minZoom).toBeCloseTo(1200 / (33_000 * 30), 12)
    expect(geometry.maxZoom).toBeCloseTo(1200 / (1.8 * 30), 12)
  })

  test('long projects extend the nominal Full range instead of clipping', () => {
    const geometry = calculateTimelineZoomGeometry(1200, 2_000_000, RATE)
    const expectedFull = (1200 - 36) / 2_000_000

    expect(geometry.fullZoom).toBeCloseTo(expectedFull, 12)
    expect(geometry.minZoom).toBeCloseTo(expectedFull, 12)
  })

  test('Detail and Max stay exact at every project duration', () => {
    for (const durationFrames of [0, 6000, 12 * 3600 * 30, 2_000_000]) {
      const geometry = calculateTimelineZoomGeometry(
        2360,
        durationFrames,
        RATE,
      )

      expect(geometry.detailZoom).toBeCloseTo(2360 / (11 * 30), 12)
      expect(geometry.maxZoom).toBeCloseTo(2360 / (1.8 * 30), 12)
    }
  })

  test('the logical runway remains twelve hours and expands for longer docs', () => {
    expect(timelineRunwayFrames(0, RATE)).toBe(12 * 3600 * 30)
    expect(timelineRunwayFrames(2_000_000, RATE)).toBe(2_000_000)
  })

  test('the exponential midpoint is geometric, not arithmetic', () => {
    const minZoom = 0.01
    const maxZoom = 100
    const midpoint = zoomAtSliderPosition(0.5, minZoom, maxZoom)

    expect(midpoint).toBeCloseTo(Math.sqrt(minZoom * maxZoom), 12)
    expect(midpoint).not.toBeCloseTo((minZoom + maxZoom) / 2, 3)
    expect(sliderPositionForZoom(midpoint, minZoom, maxZoom)).toBeCloseTo(
      0.5,
      12,
    )
  })
})
