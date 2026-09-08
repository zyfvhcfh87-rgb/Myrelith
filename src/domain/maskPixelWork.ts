/** Bounded Bezier geometry shared by allocation admission and mask rasterization. */
import type { MaskParams } from './effectStack'
import type { PixelEffectGeometry } from './effectPixels'
import { parseMaskBezierPath, type MaskPoint } from './maskPath'

export interface MaskSurfaceBounds {
  readonly minimumX: number
  readonly maximumX: number
  readonly minimumY: number
  readonly maximumY: number
  readonly width: number
  readonly height: number
}

function cubicPoint(
  start: MaskPoint,
  control1: MaskPoint,
  control2: MaskPoint,
  end: MaskPoint,
  amount: number,
): MaskPoint {
  const inverse = 1 - amount
  return {
    x: inverse ** 3 * start.x
      + 3 * inverse * inverse * amount * control1.x
      + 3 * inverse * amount * amount * control2.x
      + amount ** 3 * end.x,
    y: inverse ** 3 * start.y
      + 3 * inverse * inverse * amount * control1.y
      + 3 * inverse * amount * amount * control2.y
      + amount ** 3 * end.y,
  }
}

function flattenedBezier(params: MaskParams, geometry: PixelEffectGeometry): MaskPoint[] {
  const path = parseMaskBezierPath(params.path)
  if (!path) return []
  const points: MaskPoint[] = []
  const projectPoint = (point: MaskPoint): MaskPoint => ({
    x: (params.x + point.x * params.width) * geometry.projectWidth,
    y: (params.y + point.y * params.height) * geometry.projectHeight,
  })
  let start = path.start
  points.push(projectPoint(start))
  for (const segment of path.segments) {
    for (let step = 1; step <= 8; step++) {
      points.push(projectPoint(cubicPoint(
        start,
        segment.control1,
        segment.control2,
        segment.end,
        step / 8,
      )))
    }
    start = segment.end
  }
  return points
}

export function minimumSurfaceIndex(
  projectCoordinate: number,
  projectExtent: number,
  surfaceExtent: number,
): number {
  return Math.max(0, Math.ceil(projectCoordinate * surfaceExtent / projectExtent - 0.5))
}

export function maximumSurfaceIndex(
  projectCoordinate: number,
  projectExtent: number,
  surfaceExtent: number,
): number {
  return Math.min(
    surfaceExtent - 1,
    Math.floor(projectCoordinate * surfaceExtent / projectExtent - 0.5),
  )
}

function polygonSurfaceBounds(
  points: readonly MaskPoint[],
  geometry: PixelEffectGeometry,
): MaskSurfaceBounds | null {
  if (points.length < 3) return null
  let projectMinimumX = Number.POSITIVE_INFINITY
  let projectMaximumX = Number.NEGATIVE_INFINITY
  let projectMinimumY = Number.POSITIVE_INFINITY
  let projectMaximumY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    projectMinimumX = Math.min(projectMinimumX, point.x)
    projectMaximumX = Math.max(projectMaximumX, point.x)
    projectMinimumY = Math.min(projectMinimumY, point.y)
    projectMaximumY = Math.max(projectMaximumY, point.y)
  }
  const minimumX = minimumSurfaceIndex(
    projectMinimumX,
    geometry.projectWidth,
    geometry.surfaceWidth,
  )
  const maximumX = maximumSurfaceIndex(
    projectMaximumX,
    geometry.projectWidth,
    geometry.surfaceWidth,
  )
  const minimumY = minimumSurfaceIndex(
    projectMinimumY,
    geometry.projectHeight,
    geometry.surfaceHeight,
  )
  const maximumY = maximumSurfaceIndex(
    projectMaximumY,
    geometry.projectHeight,
    geometry.surfaceHeight,
  )
  if (minimumX > maximumX || minimumY > maximumY) return null
  return {
    minimumX,
    maximumX,
    minimumY,
    maximumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  }
}

export interface MaskPixelWork {
  readonly points: readonly MaskPoint[]
  readonly bounds: MaskSurfaceBounds | null
  readonly featherPixels: number
  readonly insidePixels: number
  readonly distancePixels: number
}

/** No surface-sized allocation: at most the existing eight samples per cubic. */
export function maskPixelWork(params: MaskParams, geometry: PixelEffectGeometry): MaskPixelWork {
  const points = params.shape === 'bezier' ? flattenedBezier(params, geometry) : []
  const bounds = polygonSurfaceBounds(points, geometry)
  const insidePixels = bounds ? bounds.width * bounds.height : 0
  const featherPixels = params.feather * Math.min(geometry.projectWidth, geometry.projectHeight)
  return { points, bounds, featherPixels, insidePixels,
    distancePixels: featherPixels === 0 ? 0 : insidePixels }
}
