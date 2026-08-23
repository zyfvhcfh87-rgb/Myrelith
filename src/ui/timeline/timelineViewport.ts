/**
 * Browser-safe timeline viewport math.
 *
 * `zoom` remains the only pixels-per-frame scale. A rare, integer-frame
 * origin keeps every DOM coordinate inside one conservative native scroll
 * surface; ordinary scrolling stays exactly 1 logical pixel per CSS pixel.
 */

/** Safely below Chromium's ~33.55Mpx and Firefox's smaller layout ceiling. */
export const MAX_TIMELINE_SURFACE_PX = 16_000_000
const MAX_REBASE_EDGE_PX = 2_000_000

export interface TimelineViewportGeometry {
  totalFrames: number
  originFrame: number
  endFrame: number
  surfaceFrames: number
  surfaceWidth: number
  maxOriginFrame: number
  virtualized: boolean
}

export interface TimelineViewportPlan {
  originFrame: number
  scrollLeft: number
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function safeWholeFrames(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Build one bounded physical window over an arbitrarily long frame range. */
export function calculateTimelineViewport(
  requestedTotalFrames: number,
  requestedZoom: number,
  requestedOriginFrame: number,
): TimelineViewportGeometry {
  const totalFrames = safeWholeFrames(requestedTotalFrames, 1)
  const zoom = finitePositive(requestedZoom, 1)
  const capacityFrames = safeWholeFrames(MAX_TIMELINE_SURFACE_PX / zoom, 1)
  const surfaceFrames = Math.min(totalFrames, capacityFrames)
  const maxOriginFrame = Math.max(0, totalFrames - surfaceFrames)
  const originFrame = clamp(
    safeWholeFrames(requestedOriginFrame, 0),
    0,
    maxOriginFrame,
  )

  return {
    totalFrames,
    originFrame,
    endFrame: originFrame + surfaceFrames,
    surfaceFrames,
    surfaceWidth: surfaceFrames * zoom,
    maxOriginFrame,
    virtualized: totalFrames > surfaceFrames,
  }
}

/** Frame position inside the current bounded surface. Call only in-window. */
export function frameToTimelineLocalPx(
  frame: number,
  originFrame: number,
  zoom: number,
): number {
  return (frame - originFrame) * zoom
}

/** Map a bounded surface coordinate back to the nearest global frame. */
export function frameAtTimelineLocalPx(
  localPx: number,
  originFrame: number,
  zoom: number,
): number {
  return Math.max(0, originFrame + Math.round(localPx / zoom))
}

/**
 * Shared pointer-to-global-frame conversion for ruler, lanes, clips, and
 * media drops. Bounds are inclusive so callers can retain an exact boundary
 * frame and let the command resolver explain why an edit is unavailable.
 */
export function frameAtTimelineClientX(
  clientX: number,
  surfaceLeftPx: number,
  originFrame: number,
  zoom: number,
  minimumFrame = 0,
  maximumFrame = Number.MAX_SAFE_INTEGER,
): number {
  const minimum = Math.max(0, Math.ceil(minimumFrame))
  const maximum = Math.max(minimum, Math.floor(maximumFrame))
  const frame = frameAtTimelineLocalPx(
    clientX - surfaceLeftPx,
    originFrame,
    zoom,
  )
  return Math.min(maximum, Math.max(minimum, frame))
}

/**
 * Plan a viewport whose requested frame lands at `anchorScreenPx` in the
 * lane. Products are formed only from frame differences bounded by the
 * physical surface, so very large global frame numbers stay precise.
 */
export function planTimelineAnchor(
  totalFrames: number,
  zoom: number,
  laneWidth: number,
  anchorFrame: number,
  anchorScreenPx = laneWidth / 2,
): TimelineViewportPlan {
  const geometry = calculateTimelineViewport(totalFrames, zoom, 0)
  const safeLaneWidth = Math.max(1, finitePositive(laneWidth, 1))
  const maximumScrollLeft = Math.max(
    0,
    geometry.surfaceWidth - safeLaneWidth,
  )
  const maximumViewportStart = Math.max(
    0,
    geometry.totalFrames - safeLaneWidth / zoom,
  )
  const desiredViewportStart = clamp(
    anchorFrame - anchorScreenPx / zoom,
    0,
    maximumViewportStart,
  )
  const targetScrollLeft = maximumScrollLeft / 2
  const originFrame = clamp(
    Math.round(desiredViewportStart - targetScrollLeft / zoom),
    0,
    geometry.maxOriginFrame,
  )
  const scrollLeft = clamp(
    (desiredViewportStart - originFrame) * zoom,
    0,
    maximumScrollLeft,
  )

  return { originFrame, scrollLeft }
}

/** Full Extent is the one deliberately non-anchored mode. */
export function planTimelineStart(): TimelineViewportPlan {
  return { originFrame: 0, scrollLeft: 0 }
}

/**
 * Rebase near either native-scroll edge while preserving the exact logical
 * viewport start. `scrollLeft` changes by the opposite origin distance, so
 * every rendered frame retains the same screen position.
 */
export function planTimelineEdgeRebase(
  geometry: TimelineViewportGeometry,
  zoom: number,
  laneWidth: number,
  scrollLeft: number,
): TimelineViewportPlan | null {
  const maximumScrollLeft = Math.max(0, geometry.surfaceWidth - laneWidth)
  if (!geometry.virtualized || maximumScrollLeft <= 0) return null

  const edgeBand = Math.min(MAX_REBASE_EDGE_PX, maximumScrollLeft / 4)
  const canMoveLeft = geometry.originFrame > 0
  const canMoveRight = geometry.originFrame < geometry.maxOriginFrame
  const nearLeft = canMoveLeft && scrollLeft < edgeBand
  const nearRight =
    canMoveRight && scrollLeft > maximumScrollLeft - edgeBand
  if (!nearLeft && !nearRight) return null

  const visibleStartFrame = geometry.originFrame + scrollLeft / zoom
  const targetScrollLeft = maximumScrollLeft / 2
  const originFrame = clamp(
    Math.round(visibleStartFrame - targetScrollLeft / zoom),
    0,
    geometry.maxOriginFrame,
  )
  if (originFrame === geometry.originFrame) return null

  return {
    originFrame,
    scrollLeft: clamp(
      (visibleStartFrame - originFrame) * zoom,
      0,
      maximumScrollLeft,
    ),
  }
}

/** The real sticky gutter owns viewport width; never duplicate its CSS size. */
export function measureTimelineLaneWidth(scroller: HTMLElement): number {
  const header = scroller.querySelector<HTMLElement>('[data-timeline-headers]')
  const rectWidth = header?.getBoundingClientRect().width ?? 0
  const headerWidth = rectWidth > 0 ? rectWidth : (header?.offsetWidth ?? 0)
  return Math.max(1, scroller.clientWidth - headerWidth)
}

export function findTimelineScroller(root: HTMLElement | null): HTMLElement | null {
  const scope = root?.closest('.app-shell') ?? root?.ownerDocument
  const scroller = scope?.querySelector('[data-timeline-scroll]')
  return scroller instanceof HTMLElement ? scroller : null
}
