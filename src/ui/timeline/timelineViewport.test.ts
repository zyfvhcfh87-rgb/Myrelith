import { describe, expect, test } from 'vitest'
import {
  MAX_TIMELINE_SURFACE_PX,
  calculateTimelineViewport,
  frameAtTimelineLocalPx,
  frameToTimelineLocalPx,
  planTimelineAnchor,
  planTimelineEdgeRebase,
} from './timelineViewport'

describe('virtual timeline viewport math', () => {
  const laneWidth = 2360
  const maxZoom = laneWidth / (1.8 * 30)

  test('bounds a 12-hour max-zoom runway below browser layout limits', () => {
    const totalFrames = 12 * 3600 * 30
    const viewport = calculateTimelineViewport(totalFrames, maxZoom, 0)

    expect(viewport.virtualized).toBe(true)
    expect(viewport.surfaceWidth).toBeLessThanOrEqual(
      MAX_TIMELINE_SURFACE_PX,
    )
    expect(viewport.endFrame).toBeLessThan(totalFrames)
  })

  test('keeps zoom as the only scale around a far integer origin', () => {
    const originFrame = 1_000_000
    const zoom = 7.25
    const first = frameToTimelineLocalPx(1_000_120, originFrame, zoom)
    const second = frameToTimelineLocalPx(1_000_240, originFrame, zoom)

    expect(second - first).toBe((1_000_240 - 1_000_120) * zoom)
    expect(frameAtTimelineLocalPx(first, originFrame, zoom)).toBe(1_000_120)
  })

  test('centers a far playhead with bounded origin and scroll values', () => {
    const totalFrames = 2_000_000
    const anchorFrame = 1_500_000
    const plan = planTimelineAnchor(
      totalFrames,
      maxZoom,
      laneWidth,
      anchorFrame,
    )
    const viewport = calculateTimelineViewport(
      totalFrames,
      maxZoom,
      plan.originFrame,
    )

    expect(Number.isInteger(plan.originFrame)).toBe(true)
    expect(plan.originFrame).toBeGreaterThan(0)
    expect(plan.originFrame).toBeLessThanOrEqual(viewport.maxOriginFrame)
    expect(plan.scrollLeft).toBeGreaterThanOrEqual(0)
    expect(plan.scrollLeft).toBeLessThanOrEqual(
      viewport.surfaceWidth - laneWidth,
    )
    expect(
      frameToTimelineLocalPx(anchorFrame, plan.originFrame, maxZoom) -
        plan.scrollLeft,
    ).toBeCloseTo(laneWidth / 2, 6)
  })

  test('edge rebasing preserves the exact logical viewport start', () => {
    const totalFrames = 2_000_000
    const viewport = calculateTimelineViewport(totalFrames, maxZoom, 0)
    const maximumScrollLeft = viewport.surfaceWidth - laneWidth
    const oldScrollLeft = maximumScrollLeft - 100
    const plan = planTimelineEdgeRebase(
      viewport,
      maxZoom,
      laneWidth,
      oldScrollLeft,
    )

    expect(plan).not.toBeNull()
    const oldVisibleStart = viewport.originFrame + oldScrollLeft / maxZoom
    const newVisibleStart =
      (plan as NonNullable<typeof plan>).originFrame +
      (plan as NonNullable<typeof plan>).scrollLeft / maxZoom
    expect(newVisibleStart).toBeCloseTo(oldVisibleStart, 8)
  })

  test('rebases in both directions without logical-frame drift', () => {
    const totalFrames = 2_000_000
    const initial = calculateTimelineViewport(totalFrames, maxZoom, 0)
    const rightScroll = initial.surfaceWidth - laneWidth - 100
    const rightPlan = planTimelineEdgeRebase(
      initial,
      maxZoom,
      laneWidth,
      rightScroll,
    )
    expect(rightPlan).not.toBeNull()
    expect((rightPlan as NonNullable<typeof rightPlan>).originFrame).toBeGreaterThan(0)

    const shifted = calculateTimelineViewport(
      totalFrames,
      maxZoom,
      (rightPlan as NonNullable<typeof rightPlan>).originFrame,
    )
    const leftScroll = 100
    const leftPlan = planTimelineEdgeRebase(
      shifted,
      maxZoom,
      laneWidth,
      leftScroll,
    )
    expect(leftPlan).not.toBeNull()

    const beforeLeft = shifted.originFrame + leftScroll / maxZoom
    const afterLeft =
      (leftPlan as NonNullable<typeof leftPlan>).originFrame +
      (leftPlan as NonNullable<typeof leftPlan>).scrollLeft / maxZoom
    expect(afterLeft).toBeCloseTo(beforeLeft, 8)
    expect((leftPlan as NonNullable<typeof leftPlan>).originFrame).toBeLessThan(
      shifted.originFrame,
    )
  })

  test('frame-zero anchoring never invents a negative origin or scroll', () => {
    expect(
      planTimelineAnchor(2_000_000, maxZoom, laneWidth, 0),
    ).toEqual({ originFrame: 0, scrollLeft: 0 })
  })

  test('the true logical end remains reachable in the final window', () => {
    const totalFrames = 2_000_000
    const initial = calculateTimelineViewport(totalFrames, maxZoom, 0)
    const finalWindow = calculateTimelineViewport(
      totalFrames,
      maxZoom,
      initial.maxOriginFrame,
    )
    const maximumScrollLeft = finalWindow.surfaceWidth - laneWidth
    const visibleEndFrame =
      finalWindow.originFrame +
      (maximumScrollLeft + laneWidth) / maxZoom

    expect(finalWindow.endFrame).toBe(totalFrames)
    expect(visibleEndFrame).toBeCloseTo(totalFrames, 8)
  })
})
