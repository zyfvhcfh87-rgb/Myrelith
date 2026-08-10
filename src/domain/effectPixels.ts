/** Pure ordered pixel-effect executor shared by preview and export composition. */

import { applyColorCorrectionsToRgba } from './colorCorrection'
import type {
  CanvasPixelEffect,
  ChromaKeyParams,
  MaskParams,
} from './effectStack'
import { parseMaskBezierPath, type MaskPoint } from './maskPath'

export interface PixelEffectGeometry {
  readonly surfaceWidth: number
  readonly surfaceHeight: number
  readonly projectWidth: number
  readonly projectHeight: number
}

/** Optional deterministic work evidence for performance regressions. */
export interface PixelEffectWorkMetrics {
  maskScanlineEdgeTests: number
  maskDistanceSamples: number
  maskEllipseDistanceSolves?: number
  maskInsideScratchPixelsPeak?: number
  maskDistanceScratchPixelsPeak?: number
}

interface PixelEffectScratch {
  polygonInside: Uint8Array
  polygonDistances: Float32Array
}

interface SurfaceBounds {
  readonly minimumX: number
  readonly maximumX: number
  readonly minimumY: number
  readonly maximumY: number
  readonly width: number
  readonly height: number
}

interface EllipseMaskGeometry {
  readonly centerX: number
  readonly centerY: number
  readonly radiusX: number
  readonly radiusY: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function parseHexColor(color: string): readonly [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ]
}

function smoothKeyStrength(distance: number, tolerance: number, softness: number): number {
  if (distance <= tolerance) return 1
  if (softness === 0 || distance >= tolerance + softness) return 0
  const amount = clamp01((distance - tolerance) / softness)
  const smooth = amount * amount * (3 - 2 * amount)
  return 1 - smooth
}

function applyChromaKey(rgba: Uint8ClampedArray, params: ChromaKeyParams): void {
  const [keyR, keyG, keyB] = parseHexColor(params.color)
  const maximumDistance = Math.sqrt(3 * 255 * 255)
  for (let index = 0; index < rgba.length; index += 4) {
    const red = rgba[index]
    const green = rgba[index + 1]
    const blue = rgba[index + 2]
    const distance = Math.sqrt(
      (red - keyR) ** 2 + (green - keyG) ** 2 + (blue - keyB) ** 2,
    ) / maximumDistance
    const strength = smoothKeyStrength(distance, params.tolerance, params.softness)
    if (strength === 0) continue
    const spillAmount = strength * params.spill
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
    rgba[index] = Math.round(red + (luma - red) * spillAmount)
    rgba[index + 1] = Math.round(green + (luma - green) * spillAmount)
    rgba[index + 2] = Math.round(blue + (luma - blue) * spillAmount)
    rgba[index + 3] = Math.round(rgba[index + 3] * (1 - strength))
  }
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

function distanceToSegment(
  x: number,
  y: number,
  start: MaskPoint,
  end: MaskPoint,
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const amount = lengthSquared === 0
    ? 0
    : clamp01(((x - start.x) * dx + (y - start.y) * dy) / lengthSquared)
  return Math.hypot(x - (start.x + dx * amount), y - (start.y + dy * amount))
}

function ensureInsideScratch(scratch: PixelEffectScratch, length: number): Uint8Array {
  if (scratch.polygonInside.length < length) {
    scratch.polygonInside = new Uint8Array(length)
  }
  const region = scratch.polygonInside.subarray(0, length)
  region.fill(0)
  return region
}

function ensureDistanceScratch(
  scratch: PixelEffectScratch,
  length: number,
  maximum: number,
): Float32Array {
  if (scratch.polygonDistances.length < length) {
    scratch.polygonDistances = new Float32Array(length)
  }
  const region = scratch.polygonDistances.subarray(0, length)
  region.fill(maximum)
  return region
}

function rasterizePolygonInside(
  points: readonly MaskPoint[],
  geometry: PixelEffectGeometry,
  bounds: SurfaceBounds,
  inside: Uint8Array,
  metrics?: PixelEffectWorkMetrics,
): void {
  if (points.length < 3) return
  const intersections: number[] = []
  const projectStepX = geometry.projectWidth / geometry.surfaceWidth
  const projectStepY = geometry.projectHeight / geometry.surfaceHeight
  for (let surfaceY = bounds.minimumY; surfaceY <= bounds.maximumY; surfaceY++) {
    const projectY = (surfaceY + 0.5) * projectStepY
    intersections.length = 0
    for (
      let current = 0, previous = points.length - 1;
      current < points.length;
      previous = current++
    ) {
      if (metrics) metrics.maskScanlineEdgeTests++
      const a = points[current]
      const b = points[previous]
      if ((a.y > projectY) !== (b.y > projectY)) {
        intersections.push(
          ((b.x - a.x) * (projectY - a.y)) / (b.y - a.y) + a.x,
        )
      }
    }
    intersections.sort((left, right) => left - right)
    let passed = 0
    const rowOffset = (surfaceY - bounds.minimumY) * bounds.width
    for (let surfaceX = bounds.minimumX; surfaceX <= bounds.maximumX; surfaceX++) {
      const projectX = (surfaceX + 0.5) * projectStepX
      while (passed < intersections.length && intersections[passed] <= projectX) passed++
      inside[rowOffset + surfaceX - bounds.minimumX] = (intersections.length - passed) % 2
    }
  }
}

function minimumSurfaceIndex(
  projectCoordinate: number,
  projectExtent: number,
  surfaceExtent: number,
): number {
  return Math.max(0, Math.ceil(projectCoordinate * surfaceExtent / projectExtent - 0.5))
}

function maximumSurfaceIndex(
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
): SurfaceBounds | null {
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

function rasterizePolygonEdgeDistances(
  points: readonly MaskPoint[],
  geometry: PixelEffectGeometry,
  bounds: SurfaceBounds,
  featherPixels: number,
  inside: Uint8Array,
  distances: Float32Array,
  metrics?: PixelEffectWorkMetrics,
): void {
  const projectStepX = geometry.projectWidth / geometry.surfaceWidth
  const projectStepY = geometry.projectHeight / geometry.surfaceHeight
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current++
  ) {
    const start = points[previous]
    const end = points[current]
    const minimumX = Math.max(bounds.minimumX, minimumSurfaceIndex(
      Math.min(start.x, end.x) - featherPixels,
      geometry.projectWidth,
      geometry.surfaceWidth,
    ))
    const maximumX = Math.min(bounds.maximumX, maximumSurfaceIndex(
      Math.max(start.x, end.x) + featherPixels,
      geometry.projectWidth,
      geometry.surfaceWidth,
    ))
    const minimumY = Math.max(bounds.minimumY, minimumSurfaceIndex(
      Math.min(start.y, end.y) - featherPixels,
      geometry.projectHeight,
      geometry.surfaceHeight,
    ))
    const maximumY = Math.min(bounds.maximumY, maximumSurfaceIndex(
      Math.max(start.y, end.y) + featherPixels,
      geometry.projectHeight,
      geometry.surfaceHeight,
    ))
    if (minimumX > maximumX || minimumY > maximumY) continue
    for (let surfaceY = minimumY; surfaceY <= maximumY; surfaceY++) {
      const projectY = (surfaceY + 0.5) * projectStepY
      const rowOffset = (surfaceY - bounds.minimumY) * bounds.width
      for (let surfaceX = minimumX; surfaceX <= maximumX; surfaceX++) {
        const index = rowOffset + surfaceX - bounds.minimumX
        if (inside[index] === 0) continue
        if (metrics) metrics.maskDistanceSamples++
        const projectX = (surfaceX + 0.5) * projectStepX
        distances[index] = Math.min(
          distances[index],
          distanceToSegment(projectX, projectY, start, end),
        )
      }
    }
  }
}

function rectangleSignedDistance(
  x: number,
  y: number,
  params: MaskParams,
  geometry: PixelEffectGeometry,
): number {
  const left = params.x * geometry.projectWidth
  const top = params.y * geometry.projectHeight
  const width = params.width * geometry.projectWidth
  const height = params.height * geometry.projectHeight
  const right = left + width
  const bottom = top + height
  const insideDistance = Math.min(x - left, right - x, y - top, bottom - y)
  if (insideDistance >= 0) return insideDistance
  const outsideX = Math.max(left - x, 0, x - right)
  const outsideY = Math.max(top - y, 0, y - bottom)
  return -Math.hypot(outsideX, outsideY)
}

function ellipseUnsignedBoundaryDistance(
  rawOffsetX: number,
  rawOffsetY: number,
  radiusX: number,
  radiusY: number,
): number {
  const coordinateEpsilon = Number.EPSILON * Math.max(
    1,
    radiusX,
    radiusY,
  ) * 8
  const offsetX = Math.abs(rawOffsetX) <= coordinateEpsilon ? 0 : rawOffsetX
  const offsetY = Math.abs(rawOffsetY) <= coordinateEpsilon ? 0 : rawOffsetY
  const majorRadius = Math.max(radiusX, radiusY)
  const minorRadius = Math.min(radiusX, radiusY)
  const majorOffset = Math.abs(radiusX >= radiusY ? offsetX : offsetY)
  const minorOffset = Math.abs(radiusX >= radiusY ? offsetY : offsetX)
  let distance: number

  if (majorRadius === minorRadius) {
    distance = Math.abs(Math.hypot(majorOffset, minorOffset) - majorRadius)
  } else if (minorOffset > 0) {
    if (majorOffset === 0) {
      distance = Math.abs(minorOffset - minorRadius)
    } else {
      // Robust bounded root from Eberly's point-to-ellipse construction.
      const normalizedMajor = majorOffset / majorRadius
      const normalizedMinor = minorOffset / minorRadius
      const extentRatio = (majorRadius / minorRadius) ** 2
      const initial = normalizedMajor ** 2 + normalizedMinor ** 2 - 1
      if (initial === 0) return 0
      const scaledMajor = extentRatio * normalizedMajor
      let lower = normalizedMinor - 1
      let upper = initial < 0
        ? 0
        : Math.hypot(scaledMajor, normalizedMinor) - 1
      let root = 0
      for (let iteration = 0; iteration < 32; iteration++) {
        root = (lower + upper) / 2
        if (root === lower || root === upper) break
        const majorRatio = scaledMajor / (root + extentRatio)
        const minorRatio = normalizedMinor / (root + 1)
        const value = majorRatio ** 2 + minorRatio ** 2 - 1
        if (value > 0) lower = root
        else if (value < 0) upper = root
        else break
      }
      const closestMajor = extentRatio * majorOffset / (root + extentRatio)
      const closestMinor = minorOffset / (root + 1)
      distance = Math.hypot(
        closestMajor - majorOffset,
        closestMinor - minorOffset,
      )
    }
  } else {
    const numerator = majorRadius * majorOffset
    const denominator = majorRadius ** 2 - minorRadius ** 2
    if (numerator < denominator) {
      const normalizedClosestMajor = numerator / denominator
      const closestMajor = majorRadius * normalizedClosestMajor
      const closestMinor = minorRadius * Math.sqrt(
        Math.max(0, 1 - normalizedClosestMajor ** 2),
      )
      distance = Math.hypot(
        closestMajor - majorOffset,
        closestMinor,
      )
    } else {
      distance = Math.abs(majorOffset - majorRadius)
    }
  }
  return distance
}

function ellipseInsideCoverage(
  x: number,
  y: number,
  ellipse: EllipseMaskGeometry,
  featherPixels: number,
  metrics?: PixelEffectWorkMetrics,
): number {
  const rawOffsetX = x - ellipse.centerX
  const rawOffsetY = y - ellipse.centerY
  const normalizedRadius = Math.hypot(
    rawOffsetX / ellipse.radiusX,
    rawOffsetY / ellipse.radiusY,
  )
  if (normalizedRadius > 1) return 0
  if (featherPixels === 0) return 1
  const conservativeDistance = Math.min(ellipse.radiusX, ellipse.radiusY)
    * (1 - normalizedRadius)
  if (conservativeDistance >= featherPixels) return 1
  if (metrics) {
    metrics.maskEllipseDistanceSolves = (metrics.maskEllipseDistanceSolves ?? 0) + 1
  }
  return clamp01(ellipseUnsignedBoundaryDistance(
    rawOffsetX,
    rawOffsetY,
    ellipse.radiusX,
    ellipse.radiusY,
  ) / featherPixels)
}

function applyBezierMask(
  rgba: Uint8ClampedArray,
  params: MaskParams,
  geometry: PixelEffectGeometry,
  points: readonly MaskPoint[],
  featherPixels: number,
  scratch: PixelEffectScratch,
  metrics?: PixelEffectWorkMetrics,
): void {
  const pixelCount = geometry.surfaceWidth * geometry.surfaceHeight
  const bounds = polygonSurfaceBounds(points, geometry)
  const scratchPixels = bounds === null ? 0 : bounds.width * bounds.height
  const inside = ensureInsideScratch(scratch, scratchPixels)
  if (metrics) {
    metrics.maskInsideScratchPixelsPeak = Math.max(
      metrics.maskInsideScratchPixelsPeak ?? 0,
      scratchPixels,
    )
  }
  if (bounds) rasterizePolygonInside(points, geometry, bounds, inside, metrics)
  const distances = featherPixels === 0
    ? null
    : ensureDistanceScratch(scratch, scratchPixels, featherPixels)
  if (metrics && distances) {
    metrics.maskDistanceScratchPixelsPeak = Math.max(
      metrics.maskDistanceScratchPixelsPeak ?? 0,
      scratchPixels,
    )
  }
  if (bounds && distances) {
    rasterizePolygonEdgeDistances(
      points,
      geometry,
      bounds,
      featherPixels,
      inside,
      distances,
      metrics,
    )
  }
  for (let index = 0; index < pixelCount; index++) {
    const surfaceX = index % geometry.surfaceWidth
    const surfaceY = Math.floor(index / geometry.surfaceWidth)
    const localIndex = bounds
      && surfaceX >= bounds.minimumX
      && surfaceX <= bounds.maximumX
      && surfaceY >= bounds.minimumY
      && surfaceY <= bounds.maximumY
      ? (surfaceY - bounds.minimumY) * bounds.width + surfaceX - bounds.minimumX
      : -1
    const insideCoverage = localIndex < 0 || inside[localIndex] === 0
      ? 0
      : distances === null ? 1 : clamp01(distances[localIndex] / featherPixels)
    const coverage = params.invert ? 1 - insideCoverage : insideCoverage
    const alphaIndex = index * 4 + 3
    rgba[alphaIndex] = Math.round(rgba[alphaIndex] * coverage)
  }
}

function applyMask(
  rgba: Uint8ClampedArray,
  params: MaskParams,
  geometry: PixelEffectGeometry,
  scratch: PixelEffectScratch,
  metrics?: PixelEffectWorkMetrics,
): void {
  const bezierPoints = params.shape === 'bezier'
    ? flattenedBezier(params, geometry)
    : []
  const featherPixels = params.feather
    * Math.min(geometry.projectWidth, geometry.projectHeight)
  if (params.shape === 'bezier') {
    applyBezierMask(
      rgba,
      params,
      geometry,
      bezierPoints,
      featherPixels,
      scratch,
      metrics,
    )
    return
  }
  const ellipse: EllipseMaskGeometry | null = params.shape === 'ellipse'
    ? (() => {
        const radiusX = params.width * geometry.projectWidth / 2
        const radiusY = params.height * geometry.projectHeight / 2
        return {
          centerX: params.x * geometry.projectWidth + radiusX,
          centerY: params.y * geometry.projectHeight + radiusY,
          radiusX,
          radiusY,
        }
      })()
    : null
  for (let surfaceY = 0; surfaceY < geometry.surfaceHeight; surfaceY++) {
    const projectY = (surfaceY + 0.5) * geometry.projectHeight / geometry.surfaceHeight
    for (let surfaceX = 0; surfaceX < geometry.surfaceWidth; surfaceX++) {
      const projectX = (surfaceX + 0.5) * geometry.projectWidth / geometry.surfaceWidth
      let insideCoverage: number
      if (ellipse) {
        insideCoverage = ellipseInsideCoverage(
          projectX,
          projectY,
          ellipse,
          featherPixels,
          metrics,
        )
      } else {
        const distance = rectangleSignedDistance(
          projectX,
          projectY,
          params,
          geometry,
        )
        insideCoverage = featherPixels === 0
          ? (distance >= 0 ? 1 : 0)
          : clamp01(distance / featherPixels)
      }
      const coverage = params.invert ? 1 - insideCoverage : insideCoverage
      const alphaIndex = (surfaceY * geometry.surfaceWidth + surfaceX) * 4 + 3
      rgba[alphaIndex] = Math.round(rgba[alphaIndex] * coverage)
    }
  }
}

/** Execute every command in authored order; each command clamps like a real stack stage. */
export function applyOrderedPixelEffectsToRgba(
  rgba: Uint8ClampedArray,
  effects: readonly CanvasPixelEffect[],
  geometry: PixelEffectGeometry,
  metrics?: PixelEffectWorkMetrics,
): void {
  if (
    !Number.isSafeInteger(geometry.surfaceWidth)
    || !Number.isSafeInteger(geometry.surfaceHeight)
    || geometry.surfaceWidth < 1
    || geometry.surfaceHeight < 1
    || !Number.isFinite(geometry.projectWidth)
    || !Number.isFinite(geometry.projectHeight)
    || geometry.projectWidth <= 0
    || geometry.projectHeight <= 0
    || rgba.length !== geometry.surfaceWidth * geometry.surfaceHeight * 4
  ) throw new RangeError('Pixel effect geometry does not match the RGBA buffer')

  const scratch: PixelEffectScratch = {
    polygonInside: new Uint8Array(0),
    polygonDistances: new Float32Array(0),
  }
  for (const effect of effects) {
    if (effect.kind === 'color-adjust') {
      applyColorCorrectionsToRgba(rgba, [effect.params])
    } else if (effect.kind === 'chroma-key') {
      applyChromaKey(rgba, effect.params)
    } else {
      applyMask(rgba, effect.params, geometry, scratch, metrics)
    }
  }
}
