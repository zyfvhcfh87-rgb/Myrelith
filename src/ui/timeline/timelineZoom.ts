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
/** Existing empty-project runway retained whenever Chromium can lay it out. */
export const TIMELINE_RUNWAY_SECONDS = 12 * 3600
/**
 * Blink clamps a single horizontal layout surface near 2^25 CSS pixels.
 * Leave room for the sticky gutter and rounding instead of letting the final
 * ruler hours become silently unreachable at the 1.8-second endpoint.
 */
export const MAX_TIMELINE_LAYOUT_PX = 33_000_000

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
  // A project itself must always remain addressable. Short projects keep the
  // exact 1.8-second endpoint; Ruler shortens only the otherwise-empty runway
  // when that is necessary to stay below Chromium's layout ceiling.
  const projectSafeMaxZoom = MAX_TIMELINE_LAYOUT_PX / durationFrames
  const maxZoom = Math.max(
    minZoom,
    Math.min(requestedMaxZoom, projectSafeMaxZoom),
  )

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

/**
 * Keep the familiar 12-hour runway when it fits. At very high zoom on a wide
 * viewport, shorten only unused post-project runway so the real scrollWidth
 * remains reachable in Chromium. The document duration always wins.
 */
export function timelineRunwayFrames(
  projectDurationFrames: number,
  frameRate: FrameRate,
  zoom: number,
): number {
  const durationFrames = Math.max(0, projectDurationFrames)
  const nominalRunwayFrames = secondsToFrames(
    TIMELINE_RUNWAY_SECONDS,
    frameRate,
  )
  const safeRunwayFrames = Math.max(
    1,
    Math.floor(MAX_TIMELINE_LAYOUT_PX / Math.max(Number.EPSILON, zoom)),
  )
  return Math.max(
    durationFrames,
    Math.min(nominalRunwayFrames, safeRunwayFrames),
  )
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
