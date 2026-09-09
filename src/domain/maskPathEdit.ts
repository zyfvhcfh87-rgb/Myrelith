/** Bounded, immutable authoring commands for the existing closed cubic grammar. */
import {
  MAX_MASK_BEZIER_SEGMENTS,
  MAX_MASK_PATH_CHARACTERS,
  parseMaskBezierPath,
  type MaskCubicSegment,
  type MaskPoint,
  type ParsedMaskPath,
} from './maskPath'

export type MaskPathPart =
  | { readonly kind: 'anchor'; readonly index: number }
  | { readonly kind: 'control'; readonly segment: number; readonly control: 1 | 2 }

export type MaskPathEdit =
  | { readonly kind: 'move-point'; readonly part: MaskPathPart; readonly delta: MaskPoint }
  | { readonly kind: 'set-point'; readonly part: MaskPathPart; readonly point: MaskPoint }
  | { readonly kind: 'split-segment'; readonly segment: number }
  | { readonly kind: 'delete-anchor'; readonly index: number }

export type MaskPathEditResult =
  | { readonly ok: true; readonly path: string; readonly changed: boolean; readonly selected: MaskPathPart }
  | { readonly ok: false; readonly reason: string }

export type MaskPathDraftResult =
  | { readonly ok: true; readonly draft: ParsedMaskPath | null }
  | { readonly ok: false; readonly reason: string }

function finitePoint(point: MaskPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function normalizedPoint(point: MaskPoint): boolean {
  return finitePoint(point) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
}

function samePoint(left: MaskPoint, right: MaskPoint): boolean {
  return left.x === right.x && left.y === right.y
}

function pathGeometryError(path: ParsedMaskPath, closed: boolean): string | null {
  // Check count before walking/copying attacker-controlled geometry.
  if (path.segments.length > MAX_MASK_BEZIER_SEGMENTS) return 'A mask can have at most eight cubic segments.'
  if (!normalizedPoint(path.start)) return 'Mask points must be finite coordinates from 0 to 1.'
  for (const segment of path.segments) {
    if (![segment.control1, segment.control2, segment.end].every(normalizedPoint)) {
      return 'Mask points must be finite coordinates from 0 to 1.'
    }
  }
  if (closed && (path.segments.length === 0 || !samePoint(path.start, path.segments.at(-1)!.end))) {
    return 'A mask needs at least one cubic segment ending at its start.'
  }
  return null
}

function coordinate(value: number): string {
  // The largest possible output has 50 coordinates of at most eight characters.
  return String(Math.round(value * 1_000_000) / 1_000_000)
}

/** Only edited paths are canonicalized; untouched imported strings keep their bytes. */
export function serializeMaskBezierPath(path: ParsedMaskPath): string {
  const error = pathGeometryError(path, true)
  if (error) throw new RangeError(error)
  const point = (value: MaskPoint) => `${coordinate(value.x)} ${coordinate(value.y)}`
  const value = `M ${point(path.start)} ${path.segments.map((segment) => (
    `C ${point(segment.control1)} ${point(segment.control2)} ${point(segment.end)}`
  )).join(' ')} Z`
  if (value.length > MAX_MASK_PATH_CHARACTERS) throw new RangeError('The mask path exceeds its string limit.')
  return value
}

function validIndex(index: number, length: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < length
}

/** Anchor zero owns both the M point and the repeated closing endpoint. */
export function maskPathPartPoint(path: ParsedMaskPath, part: MaskPathPart): MaskPoint | null {
  if (part.kind === 'anchor') {
    if (!validIndex(part.index, path.segments.length)) return null
    return part.index === 0 ? path.start : path.segments[part.index - 1].end
  }
  if (part.kind !== 'control') return null
  if (!validIndex(part.segment, path.segments.length) || (part.control !== 1 && part.control !== 2)) return null
  const segment = path.segments[part.segment]
  return part.control === 1 ? segment.control1 : segment.control2
}

function interpolate(left: MaskPoint, right: MaskPoint, amount: number): MaskPoint {
  return { x: left.x + (right.x - left.x) * amount, y: left.y + (right.y - left.y) * amount }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function movePoint(path: ParsedMaskPath, part: MaskPathPart, requested: MaskPoint): ParsedMaskPath {
  const point = maskPathPartPoint(path, part)!
  const previous = part.kind === 'anchor'
    ? (part.index + path.segments.length - 1) % path.segments.length : 0
  const group = part.kind === 'anchor'
    ? [point, path.segments[previous].control2, path.segments[part.index].control1]
    : [point]
  // One shared delta preserves tangent vectors when an anchor reaches a bound.
  const dx = clamp(requested.x, -Math.min(...group.map((p) => p.x)), 1 - Math.max(...group.map((p) => p.x)))
  const dy = clamp(requested.y, -Math.min(...group.map((p) => p.y)), 1 - Math.max(...group.map((p) => p.y)))
  if (dx === 0 && dy === 0) return path
  const translate = (p: MaskPoint): MaskPoint => ({ x: clamp(p.x + dx, 0, 1), y: clamp(p.y + dy, 0, 1) })
  const segments = path.segments.map((segment) => ({ ...segment }))
  let start = path.start
  if (part.kind === 'control') {
    segments[part.segment][part.control === 1 ? 'control1' : 'control2'] = translate(point)
  } else {
    const moved = translate(point)
    if (part.index === 0) start = moved
    segments[previous].end = moved
    segments[previous].control2 = translate(segments[previous].control2)
    segments[part.index].control1 = translate(segments[part.index].control1)
  }
  return { start, segments }
}

/** Pointer deltas, keyboard deltas and numeric positions use this one command path. */
export function editMaskBezierPath(value: string, edit: MaskPathEdit): MaskPathEditResult {
  const path = parseMaskBezierPath(value)
  if (!path) return { ok: false, reason: 'The stored mask path is unavailable. It must be a bounded closed cubic path.' }
  let next: ParsedMaskPath
  let selected: MaskPathPart
  if (edit.kind === 'move-point' || edit.kind === 'set-point') {
    const current = maskPathPartPoint(path, edit.part)
    if (!current) return { ok: false, reason: 'The selected mask point no longer exists.' }
    if (edit.kind === 'set-point' && !normalizedPoint(edit.point)) return { ok: false, reason: 'Mask coordinates must be finite and from 0 to 1.' }
    const delta = edit.kind === 'move-point' ? edit.delta : { x: edit.point.x - current.x, y: edit.point.y - current.y }
    if (!finitePoint(delta)) return { ok: false, reason: 'Mask movement must be finite.' }
    next = movePoint(path, edit.part, delta)
    selected = edit.part
    if (next === path) return { ok: true, path: value, changed: false, selected }
  } else if (edit.kind === 'split-segment') {
    if (!validIndex(edit.segment, path.segments.length)) return { ok: false, reason: 'The selected mask segment no longer exists.' }
    if (path.segments.length === MAX_MASK_BEZIER_SEGMENTS) return { ok: false, reason: 'A mask can have at most eight cubic segments.' }
    const segment = path.segments[edit.segment]
    const start = edit.segment === 0 ? path.start : path.segments[edit.segment - 1].end
    const a = interpolate(start, segment.control1, 0.5)
    const b = interpolate(segment.control1, segment.control2, 0.5)
    const c = interpolate(segment.control2, segment.end, 0.5)
    const d = interpolate(a, b, 0.5), e = interpolate(b, c, 0.5)
    const middle = interpolate(d, e, 0.5)
    const segments = [...path.segments]
    segments.splice(edit.segment, 1, { control1: a, control2: d, end: middle }, { control1: e, control2: c, end: segment.end })
    next = { start: path.start, segments }
    selected = { kind: 'anchor', index: edit.segment + 1 }
  } else {
    if (!validIndex(edit.index, path.segments.length)) return { ok: false, reason: 'The selected mask point no longer exists.' }
    if (path.segments.length === 1) return { ok: false, reason: 'A closed mask needs at least one cubic segment.' }
    const previous = path.segments[(edit.index + path.segments.length - 1) % path.segments.length]
    const outgoing = path.segments[edit.index]
    const joined = { control1: previous.control1, control2: outgoing.control2, end: outgoing.end }
    const segments = [...path.segments]
    if (edit.index === 0) {
      next = { start: outgoing.end, segments: [...segments.slice(1, -1), joined] }
    } else {
      segments.splice(edit.index - 1, 2, joined)
      next = { start: path.start, segments }
    }
    selected = { kind: 'anchor', index: edit.index === 0 ? 0 : edit.index - 1 }
  }
  const serialized = serializeMaskBezierPath(next)
  // Decimal rounding below the authoring precision must not rewrite an imported path.
  if (serialized === serializeMaskBezierPath(path)) return { ok: true, path: value, changed: false, selected }
  return { ok: true, path: serialized, changed: true, selected }
}

/** Open paths exist only as drafts; Close appends one straight cubic if necessary. */
export function appendMaskBezierDraftPoint(draft: ParsedMaskPath | null, point: MaskPoint): MaskPathDraftResult {
  // Reserve one segment for explicit closure before inspecting or copying geometry.
  if (draft && draft.segments.length >= MAX_MASK_BEZIER_SEGMENTS - 1) return { ok: false, reason: 'A new mask can have at most eight points.' }
  if (!normalizedPoint(point)) return { ok: false, reason: 'Place the point inside the mask box, or enter coordinates from 0 to 100%.' }
  const error = draft && pathGeometryError(draft, false)
  if (error) return { ok: false, reason: error }
  const end = { ...point }
  if (!draft) return { ok: true, draft: { start: end, segments: [] } }
  const previous = draft.segments.at(-1)?.end ?? draft.start
  if (samePoint(previous, point)) return { ok: false, reason: 'Choose a different position for the next point.' }
  return { ok: true, draft: { start: draft.start, segments: [...draft.segments, {
    control1: interpolate(previous, end, 1 / 3), control2: interpolate(previous, end, 2 / 3), end,
  }] } }
}

/** Removing a draft point never consumes document undo history. */
export function removeLastMaskBezierDraftPoint(draft: ParsedMaskPath | null): MaskPathDraftResult {
  if (!draft) return { ok: true, draft: null }
  const error = pathGeometryError(draft, false)
  if (error) return { ok: false, reason: error }
  return { ok: true, draft: draft.segments.length === 0 ? null : { start: draft.start, segments: draft.segments.slice(0, -1) } }
}

export function closeMaskBezierDraft(draft: ParsedMaskPath): MaskPathEditResult {
  const error = pathGeometryError(draft, false)
  if (error) return { ok: false, reason: error }
  const last = draft.segments.at(-1)?.end ?? draft.start
  const needsClosing = draft.segments.length === 0 || !samePoint(last, draft.start)
  if (needsClosing && draft.segments.length === MAX_MASK_BEZIER_SEGMENTS) return { ok: false, reason: 'Closing this path would exceed eight cubic segments.' }
  const closing: MaskCubicSegment = {
    control1: interpolate(last, draft.start, 1 / 3),
    control2: interpolate(last, draft.start, 2 / 3),
    end: draft.start,
  }
  const path = serializeMaskBezierPath({ start: draft.start, segments: needsClosing ? [...draft.segments, closing] : draft.segments })
  return { ok: true, path, changed: true, selected: { kind: 'anchor', index: 0 } }
}
