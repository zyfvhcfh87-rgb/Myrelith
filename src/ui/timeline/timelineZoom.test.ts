import { describe, expect, test } from 'vitest'
import {
  MAX_TIMELINE_LAYOUT_PX,
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

  test('high zoom keeps the real Chromium runway within its layout ceiling', () => {
    const geometry = calculateTimelineZoomGeometry(2360, 0, RATE)
    const runwayFrames = timelineRunwayFrames(0, RATE, geometry.maxZoom)

    expect(geometry.maxZoom).toBeCloseTo(2360 / (1.8 * 30), 12)
    expect(runwayFrames * geometry.maxZoom).toBeLessThanOrEqual(
      MAX_TIMELINE_LAYOUT_PX,
    )
    expect(runwayFrames).toBeLessThan(12 * 3600 * 30)
  })

  test('long projects cap only an impossible endpoint and remain reachable', () => {
    const durationFrames = 2_000_000
    const geometry = calculateTimelineZoomGeometry(2360, durationFrames, RATE)

    expect(geometry.maxZoom).toBeCloseTo(
      MAX_TIMELINE_LAYOUT_PX / durationFrames,
      12,
    )
    expect(
      timelineRunwayFrames(durationFrames, RATE, geometry.maxZoom),
    ).toBe(durationFrames)
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
