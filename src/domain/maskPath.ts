/** Pure parser for Myrelith's deliberately bounded normalized cubic paths. */

export const MAX_MASK_BEZIER_SEGMENTS = 8
export const MAX_MASK_PATH_CHARACTERS = 2_048

export interface MaskPoint {
  readonly x: number
  readonly y: number
}

export interface MaskCubicSegment {
  readonly control1: MaskPoint
  readonly control2: MaskPoint
  readonly end: MaskPoint
}

export interface ParsedMaskPath {
  readonly start: MaskPoint
  readonly segments: readonly MaskCubicSegment[]
}

function boundedCoordinate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null
}

/**
 * Grammar: `M x y C x1 y1 x2 y2 x y ... Z`, with normalized 0..1 numbers,
 * one to eight cubic segments, and no implicit/repeated commands.
 */
export function parseMaskBezierPath(value: string): ParsedMaskPath | null {
  if (value.length === 0 || value.length > MAX_MASK_PATH_CHARACTERS) return null
  const tokens = value.trim().split(/[\s,]+/)
  if (tokens[0] !== 'M' || tokens[tokens.length - 1] !== 'Z') return null
  const startX = boundedCoordinate(tokens[1])
  const startY = boundedCoordinate(tokens[2])
  if (startX === null || startY === null) return null
  const segments: MaskCubicSegment[] = []
  let index = 3
  while (index < tokens.length - 1) {
    if (tokens[index] !== 'C') return null
    const values = tokens.slice(index + 1, index + 7).map(boundedCoordinate)
    if (values.length !== 6 || values.some((item) => item === null)) return null
    segments.push({
      control1: { x: values[0]!, y: values[1]! },
      control2: { x: values[2]!, y: values[3]! },
      end: { x: values[4]!, y: values[5]! },
    })
    if (segments.length > MAX_MASK_BEZIER_SEGMENTS) return null
    index += 7
  }
  if (index !== tokens.length - 1 || segments.length === 0) return null
  const end = segments[segments.length - 1].end
  if (end.x !== startX || end.y !== startY) return null
  return { start: { x: startX, y: startY }, segments }
}

export function maskBezierPathValidationError(value: unknown): string | null {
  if (typeof value !== 'string') return 'path must be a string'
  if (value.length > MAX_MASK_PATH_CHARACTERS) {
    return `path exceeds ${MAX_MASK_PATH_CHARACTERS} characters`
  }
  return parseMaskBezierPath(value) === null
    ? 'path must be a closed normalized M/C/Z cubic path with 1 to 8 segments'
    : null
}
