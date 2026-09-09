/** Pure project-mask, CSS monitor and admitted affine-source geometry. */
import { clipVisualSettingsValidationError, transformScaleValidationError } from './clipInspector'
import { MASK_LIMITS } from './effectStack'
import { assertRenderSurfaceBudget } from './renderSurfaceBudget'
import type { MaskPoint } from './maskPath'
import type { ClipVisualSettings, Transform } from './schema'

export interface MaskDimensions { readonly width: number; readonly height: number }
export interface MaskBox extends MaskDimensions { readonly x: number; readonly y: number }
/** Measured canvas CSS rectangle; never the canvas backing-store dimensions. */
export interface MaskMonitorViewport extends MaskDimensions { readonly left: number; readonly top: number }
export type MaskBoxCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

function assertPoint(point: MaskPoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Coordinates must be finite.')
}

function assertBox(box: MaskBox): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (!Number.isFinite(box[key]) || box[key] < MASK_LIMITS[key].min || box[key] > MASK_LIMITS[key].max) {
      throw new RangeError(`Mask ${key} is outside its authored bounds.`)
    }
  }
}

function assertProject(project: MaskDimensions): void {
  assertRenderSurfaceBudget(project.width, project.height)
}

function assertViewport(viewport: MaskMonitorViewport): void {
  if (![viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0) throw new RangeError('The monitor viewport must have finite positive dimensions.')
}

function checked(point: MaskPoint): MaskPoint {
  assertPoint(point)
  return point
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function monitorPointToProject(point: MaskPoint, viewport: MaskMonitorViewport, project: MaskDimensions): MaskPoint {
  assertPoint(point); assertViewport(viewport); assertProject(project)
  return checked({ x: (point.x - viewport.left) / viewport.width * project.width, y: (point.y - viewport.top) / viewport.height * project.height })
}

export function projectPointToMonitor(point: MaskPoint, viewport: MaskMonitorViewport, project: MaskDimensions): MaskPoint {
  assertPoint(point); assertViewport(viewport); assertProject(project)
  return checked({ x: viewport.left + point.x / project.width * viewport.width, y: viewport.top + point.y / project.height * viewport.height })
}

export function maskPointToProject(point: MaskPoint, box: MaskBox, project: MaskDimensions): MaskPoint {
  assertPoint(point); assertBox(box); assertProject(project)
  return checked({ x: (box.x + point.x * box.width) * project.width, y: (box.y + point.y * box.height) * project.height })
}

/** Does not clamp: the edit command owns constraints, preserving pointer deltas. */
export function projectPointToMask(point: MaskPoint, box: MaskBox, project: MaskDimensions): MaskPoint {
  assertPoint(point); assertBox(box); assertProject(project)
  return checked({ x: (point.x / project.width - box.x) / box.width, y: (point.y / project.height - box.y) / box.height })
}

export function moveMaskBox(box: MaskBox, projectDelta: MaskPoint, project: MaskDimensions): MaskBox {
  assertBox(box); assertPoint(projectDelta); assertProject(project)
  const x = clamp(box.x + projectDelta.x / project.width, MASK_LIMITS.x.min, MASK_LIMITS.x.max)
  const y = clamp(box.y + projectDelta.y / project.height, MASK_LIMITS.y.min, MASK_LIMITS.y.max)
  return x === box.x && y === box.y ? box : { ...box, x, y }
}

/** The opposite corner is fixed; edges never cross or silently flip a mask. */
export function resizeMaskBox(box: MaskBox, corner: MaskBoxCorner, projectDelta: MaskPoint, project: MaskDimensions): MaskBox {
  assertBox(box); assertPoint(projectDelta); assertProject(project)
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(corner)) throw new RangeError('Unknown mask corner.')
  if (projectDelta.x === 0 && projectDelta.y === 0) return box
  const dx = projectDelta.x / project.width, dy = projectDelta.y / project.height
  const right = box.x + box.width, bottom = box.y + box.height
  const leftEdge = corner.endsWith('left'), topEdge = corner.startsWith('top')
  const x = leftEdge ? clamp(box.x + dx, Math.max(MASK_LIMITS.x.min, right - MASK_LIMITS.width.max), Math.min(MASK_LIMITS.x.max, right - MASK_LIMITS.width.min)) : box.x
  const y = topEdge ? clamp(box.y + dy, Math.max(MASK_LIMITS.y.min, bottom - MASK_LIMITS.height.max), Math.min(MASK_LIMITS.y.max, bottom - MASK_LIMITS.height.min)) : box.y
  const width = clamp(leftEdge ? right - x : box.width + dx, MASK_LIMITS.width.min, MASK_LIMITS.width.max)
  const height = clamp(topEdge ? bottom - y : box.height + dy, MASK_LIMITS.height.min, MASK_LIMITS.height.max)
  return x === box.x && y === box.y && width === box.width && height === box.height ? box : { x, y, width, height }
}

export interface MaskSourceProjectionFacts {
  readonly project: MaskDimensions
  readonly source: MaskDimensions
  readonly transform: Transform
  readonly visual: ClipVisualSettings
  /** Must be explicitly null: even disabled/future intent has no proven inverse. */
  readonly lensCorrection: unknown
}

export interface MaskSourceProjectMapper {
  sourceToProject(point: MaskPoint): MaskPoint
  projectToSource(point: MaskPoint): MaskPoint
  sourcePointVisible(point: MaskPoint): boolean
  clampSourceToCrop(point: MaskPoint): MaskPoint
}

export type MaskSourceProjectionResult =
  | { readonly ok: true; readonly mapper: MaskSourceProjectMapper }
  | { readonly ok: false; readonly reason: string }

/** Pins numeric facts; crop clips visibility and never rebases the source origin. */
export function createMaskSourceProjectMapper(facts: MaskSourceProjectionFacts): MaskSourceProjectionResult {
  if (facts.lensCorrection !== null) return { ok: false, reason: 'Source coordinates are unavailable while lens-correction intent is present.' }
  try { assertProject(facts.project); assertProject(facts.source) }
  catch { return { ok: false, reason: 'Source and project dimensions must fit the render bounds.' } }
  const transformError = transformScaleValidationError(facts.transform)
  if (transformError) return { ok: false, reason: transformError }
  if (facts.transform.scaleX === 0 || facts.transform.scaleY === 0) return { ok: false, reason: 'A zero-scale source has no coordinate inverse.' }
  const visualError = clipVisualSettingsValidationError(facts.visual)
  if (visualError) return { ok: false, reason: visualError }
  for (const key of ['x', 'y', 'rotation', 'anchorX', 'anchorY'] as const) {
    const value = facts.transform[key]
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000
      || (key.startsWith('anchor') && (value < 0 || value > 1))) return { ok: false, reason: `Source ${key} is outside its geometry bounds.` }
  }
  const { width, height } = facts.source
  const { x, y, scaleX, scaleY, rotation, anchorX, anchorY } = facts.transform
  const crop = { ...facts.visual.crop }
  const ax = anchorX * width, ay = anchorY * height
  const originX = (facts.project.width - width) / 2 + ax + x
  const originY = (facts.project.height - height) / 2 + ay + y
  const sx = scaleX * (facts.visual.flipHorizontal ? -1 : 1)
  const sy = scaleY * (facts.visual.flipVertical ? -1 : 1)
  const projectedMagnitude = Math.max(1, Math.abs(originX), Math.abs(originY))
    + width * Math.abs(sx) + height * Math.abs(sy)
  // Conservative arithmetic headroom also covers interior points between probes.
  if (64 * Number.EPSILON * projectedMagnitude / Math.min(Math.abs(sx), Math.abs(sy)) > 0.25) {
    return { ok: false, reason: 'Source geometry cannot preserve a quarter-pixel coordinate inverse.' }
  }
  const radians = rotation * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians)
  const mapper: MaskSourceProjectMapper = {
    sourceToProject(point) {
      assertPoint(point)
      const px = (point.x * width - ax) * sx, py = (point.y * height - ay) * sy
      return checked({ x: originX + c * px - s * py, y: originY + s * px + c * py })
    },
    projectToSource(point) {
      assertPoint(point)
      const dx = point.x - originX, dy = point.y - originY
      return checked({ x: (ax + (c * dx + s * dy) / sx) / width, y: (ay + (-s * dx + c * dy) / sy) / height })
    },
    sourcePointVisible(point) {
      assertPoint(point)
      return point.x >= crop.left && point.x <= 1 - crop.right && point.y >= crop.top && point.y <= 1 - crop.bottom
    },
    clampSourceToCrop(point) {
      assertPoint(point)
      return { x: clamp(point.x, crop.left, 1 - crop.right), y: clamp(point.y, crop.top, 1 - crop.bottom) }
    },
  }
  // Nonzero scales can still lose the inverse through floating-point cancellation.
  // Reject that geometry instead of returning a picker for a different source pixel.
  for (const point of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }]) {
    try {
      const inverse = mapper.projectToSource(mapper.sourceToProject(point))
      if (Math.abs(inverse.x - point.x) * width <= 0.25 && Math.abs(inverse.y - point.y) * height <= 0.25) continue
    } catch { /* The same unavailable result covers arithmetic overflow. */ }
    return { ok: false, reason: 'Source geometry cannot preserve a quarter-pixel coordinate inverse.' }
  }
  return { ok: true, mapper }
}
