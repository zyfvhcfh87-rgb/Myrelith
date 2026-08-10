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

function pointInPolygon(x: number, y: number, points: readonly MaskPoint[]): boolean {
  let inside = false
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const a = points[current]
    const b = points[previous]
    if (
      (a.y > y) !== (b.y > y)
      && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    ) inside = !inside
  }
  return inside
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

function polygonSignedDistance(x: number, y: number, points: readonly MaskPoint[]): number {
  if (points.length < 3) return Number.NEGATIVE_INFINITY
  let distance = Number.POSITIVE_INFINITY
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    distance = Math.min(distance, distanceToSegment(x, y, points[previous], points[current]))
  }
  return pointInPolygon(x, y, points) ? distance : -distance
}

function maskSignedDistance(
  x: number,
  y: number,
  params: MaskParams,
  geometry: PixelEffectGeometry,
  bezierPoints: readonly MaskPoint[],
): number {
  if (params.shape === 'bezier') return polygonSignedDistance(x, y, bezierPoints)
  const left = params.x * geometry.projectWidth
  const top = params.y * geometry.projectHeight
  const width = params.width * geometry.projectWidth
  const height = params.height * geometry.projectHeight
  if (params.shape === 'rectangle') {
    const right = left + width
    const bottom = top + height
    const insideDistance = Math.min(x - left, right - x, y - top, bottom - y)
    if (insideDistance >= 0) return insideDistance
    const outsideX = Math.max(left - x, 0, x - right)
    const outsideY = Math.max(top - y, 0, y - bottom)
    return -Math.hypot(outsideX, outsideY)
  }
  const radiusX = width / 2
  const radiusY = height / 2
  const normalizedDistance = Math.hypot(
    (x - left - radiusX) / radiusX,
    (y - top - radiusY) / radiusY,
  )
  return (1 - normalizedDistance) * Math.min(radiusX, radiusY)
}

function applyMask(
  rgba: Uint8ClampedArray,
  params: MaskParams,
  geometry: PixelEffectGeometry,
): void {
  const bezierPoints = params.shape === 'bezier'
    ? flattenedBezier(params, geometry)
    : []
  const featherPixels = params.feather
    * Math.min(geometry.projectWidth, geometry.projectHeight)
  for (let surfaceY = 0; surfaceY < geometry.surfaceHeight; surfaceY++) {
    const projectY = (surfaceY + 0.5) * geometry.projectHeight / geometry.surfaceHeight
    for (let surfaceX = 0; surfaceX < geometry.surfaceWidth; surfaceX++) {
      const projectX = (surfaceX + 0.5) * geometry.projectWidth / geometry.surfaceWidth
      const distance = maskSignedDistance(
        projectX,
        projectY,
        params,
        geometry,
        bezierPoints,
      )
      const insideCoverage = featherPixels === 0
        ? (distance >= 0 ? 1 : 0)
        : clamp01(distance / featherPixels)
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

  for (const effect of effects) {
    if (effect.kind === 'color-adjust') {
      applyColorCorrectionsToRgba(rgba, [effect.params])
    } else if (effect.kind === 'chroma-key') {
      applyChromaKey(rgba, effect.params)
    } else {
      applyMask(rgba, effect.params, geometry)
    }
  }
}
