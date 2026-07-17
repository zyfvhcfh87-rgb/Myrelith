/**
 * Pure timeline-zoom math. `zoom` remains the single pixels-per-frame value;
 * these helpers only derive the three preset scales and slider mapping.
 */

import type { FrameRate } from '../../domain/schema'
import { secondsToFrames } from '../../domain/time'

export const MIN_VISIBLE_SECONDS = 9 * 3600 + 10 * 60
export const DETAIL_VISIBLE_SECONDS = 11
export const MAX_VISIBLE_SECONDS = 1.8
export const ZOOM_STEP = 1.25
/** Existing empty-project runway retained logically by the virtual viewport. */
export const TIMELINE_RUNWAY_SECONDS = 12 * 3600

export interface TimelineZoomGeometry {
  laneWidth: number
  minZoom: number
  maxZoom: number
  fullZoom: number
  detailZoom: number
}

export function clampTimelineZoom(
  zoom: number,
  minZoom: number,
  maxZoom: number,
): number {
  return Math.min(maxZoom, Math.max(minZoom, zoom))
}

export function zoomForVisibleSeconds(
  laneWidth: number,
  visibleSeconds: number,
  frameRate: FrameRate,
): number {
  const visibleFrames = Math.max(1, secondsToFrames(visibleSeconds, frameRate))
  return laneWidth / visibleFrames
}

export function calculateTimelineZoomGeometry(
  measuredLaneWidth: number,
  projectDurationFrames: number,
  frameRate: FrameRate,
): TimelineZoomGeometry {
  const laneWidth =
    Number.isFinite(measuredLaneWidth) && measuredLaneWidth > 0
      ? measuredLaneWidth
      : 1
  const durationFrames = Math.max(1, projectDurationFrames)
  const trailingPadding = Math.max(32, laneWidth * 0.03)
  const usableFullWidth = Math.max(Number.EPSILON, laneWidth - trailingPadding)
  const rawFullZoom = usableFullWidth / durationFrames
  const nominalMinZoom = zoomForVisibleSeconds(
    laneWidth,
    MIN_VISIBLE_SECONDS,
    frameRate,
  )
  const minZoom = Math.min(nominalMinZoom, rawFullZoom)
  const requestedMaxZoom = zoomForVisibleSeconds(
    laneWidth,
    MAX_VISIBLE_SECONDS,
    frameRate,
  )
  const maxZoom = Math.max(minZoom, requestedMaxZoom)

  return {
    laneWidth,
    minZoom,
    maxZoom,
    fullZoom: clampTimelineZoom(rawFullZoom, minZoom, maxZoom),
    detailZoom: clampTimelineZoom(
      zoomForVisibleSeconds(laneWidth, DETAIL_VISIBLE_SECONDS, frameRate),
      minZoom,
      maxZoom,
    ),
  }
}

/** Keep the familiar logical 12-hour runway; DOM width is virtualized. */
export function timelineRunwayFrames(
  projectDurationFrames: number,
  frameRate: FrameRate,
): number {
  const durationFrames = Math.max(0, projectDurationFrames)
  const nominalRunwayFrames = secondsToFrames(
    TIMELINE_RUNWAY_SECONDS,
    frameRate,
  )
  return Math.max(durationFrames, nominalRunwayFrames)
}

/** Exponential range mapping: the midpoint is the geometric mean. */
export function zoomAtSliderPosition(
  position: number,
  minZoom: number,
  maxZoom: number,
): number {
  const t = Math.min(1, Math.max(0, position))
  if (maxZoom <= minZoom) return minZoom
  return minZoom * (maxZoom / minZoom) ** t
}

/** Inverse of zoomAtSliderPosition, clamped for remembered out-of-range values. */
export function sliderPositionForZoom(
  zoom: number,
  minZoom: number,
  maxZoom: number,
): number {
  if (maxZoom <= minZoom) return 0
  const clamped = clampTimelineZoom(zoom, minZoom, maxZoom)
  return Math.log(clamped / minZoom) / Math.log(maxZoom / minZoom)
}
