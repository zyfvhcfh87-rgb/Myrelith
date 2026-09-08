import { describe, expect, test } from 'vitest'
import { DEFAULT_MASK_BEZIER_PATH } from './effectStack'
import { parseMaskBezierPath, type MaskPoint, type ParsedMaskPath } from './maskPath'
import { appendMaskBezierDraftPoint, closeMaskBezierDraft, editMaskBezierPath, maskPathPartPoint, removeLastMaskBezierDraftPoint, serializeMaskBezierPath, type MaskPathEditResult } from './maskPathEdit'

const shape = 'M 0.2 0.2 C 0.3 0.1 0.7 0.1 0.8 0.2 C 0.9 0.5 0.3 0.8 0.2 0.2 Z'
const parsed = () => parseMaskBezierPath(shape)!
function accepted(result: MaskPathEditResult): Extract<MaskPathEditResult, { ok: true }> {
  if (!result.ok) throw new Error(result.reason)
  return result
}
function curve(path: ParsedMaskPath, index: number, t: number): MaskPoint {
  const segment = path.segments[index]
  const start = index === 0 ? path.start : path.segments[index - 1].end
  const a = 1 - t
  const component = (axis: 'x' | 'y') => a ** 3 * start[axis] + 3 * a ** 2 * t * segment.control1[axis]
    + 3 * a * t ** 2 * segment.control2[axis] + t ** 3 * segment.end[axis]
  return { x: component('x'), y: component('y') }
}

describe('bounded mask path commands', () => {
  test('keeps anchor zero and its closing endpoint identical without mutating input', () => {
    const result = accepted(editMaskBezierPath(shape, { kind: 'move-point', part: { kind: 'anchor', index: 0 }, delta: { x: 0.1, y: 0.1 } }))
    const path = parseMaskBezierPath(result.path)!
    expect(path.start).toEqual({ x: 0.3, y: 0.3 })
    expect(path.segments[1].end).toEqual(path.start)
    expect(path.segments[0].control1).toEqual({ x: 0.4, y: 0.2 })
    expect(path.segments[1].control2).toEqual({ x: 0.4, y: 0.9 })
    expect(path.segments[0].control2).toEqual(parsed().segments[0].control2)
    expect(shape).toBe('M 0.2 0.2 C 0.3 0.1 0.7 0.1 0.8 0.2 C 0.9 0.5 0.3 0.8 0.2 0.2 Z')
  })

  test('bounds the whole anchor group with one delta, preserving its control offsets', () => {
    const path = parseMaskBezierPath(accepted(editMaskBezierPath(shape, {
      kind: 'move-point', part: { kind: 'anchor', index: 1 }, delta: { x: 100, y: -100 },
    })).path)!
    expect(path.segments[0].end).toEqual({ x: 0.9, y: 0.1 })
    expect(path.segments[0].control2).toEqual({ x: 0.8, y: 0 })
    expect(path.segments[1].control1).toEqual({ x: 1, y: 0.4 })
  })

  test('moves an individual control without moving either anchor or its sibling', () => {
    const path = parseMaskBezierPath(accepted(editMaskBezierPath(shape, {
      kind: 'set-point', part: { kind: 'control', segment: 0, control: 2 }, point: { x: 0.1, y: 0.9 },
    })).path)!
    expect(path.segments[0]).toEqual({ ...parsed().segments[0], control2: { x: 0.1, y: 0.9 } })
    expect(path.start).toEqual(parsed().start)
    expect(path.segments[1]).toEqual(parsed().segments[1])
  })

  test('numeric and keyboard/pointer delta edits agree', () => {
    const part = { kind: 'anchor', index: 1 } as const
    const numeric = editMaskBezierPath(shape, { kind: 'set-point', part, point: { x: 0.7, y: 0.3 } })
    const delta = editMaskBezierPath(shape, { kind: 'move-point', part, delta: { x: -0.1, y: 0.1 } })
    expect(numeric).toEqual(delta)
  })

  test('zero movement and subprecision changes preserve an imported string exactly', () => {
    const imported = ' M 0.2000000001,0.2 C 0.3 0.1 0.7 0.1 0.8 0.2 C 0.9 0.5 0.3 0.8 0.2000000001 0.2 Z '
    for (const x of [0, 1e-10]) {
      const result = accepted(editMaskBezierPath(imported, { kind: 'move-point', part: { kind: 'anchor', index: 0 }, delta: { x, y: 0 } }))
      expect(result.path).toBe(imported)
      expect(result.changed).toBe(false)
    }
  })

  test('de Casteljau insertion preserves the geometric curve at every sampled parameter', () => {
    for (let index = 0; index < parsed().segments.length; index++) {
      const result = accepted(editMaskBezierPath(shape, { kind: 'split-segment', segment: index }))
      const next = parseMaskBezierPath(result.path)!
      expect(result.selected).toEqual({ kind: 'anchor', index: index + 1 })
      expect(next.segments).toHaveLength(3)
      for (let step = 0; step <= 100; step++) {
        const t = step / 100
        const actual = curve(next, t <= 0.5 ? index : index + 1, t <= 0.5 ? t * 2 : t * 2 - 1)
        const expected = curve(parsed(), index, t)
        expect(actual.x).toBeCloseTo(expected.x, 6)
        expect(actual.y).toBeCloseTo(expected.y, 6)
      }
    }
  })

  test('bounds insertion at eight segments, including closure insertion', () => {
    let path = DEFAULT_MASK_BEZIER_PATH
    for (let index = 4; index < 8; index++) path = accepted(editMaskBezierPath(path, { kind: 'split-segment', segment: 0 })).path
    expect(parseMaskBezierPath(path)!.segments).toHaveLength(8)
    expect(editMaskBezierPath(path, { kind: 'split-segment', segment: 0 }).ok).toBe(false)
    const geometry = parseMaskBezierPath(path)!
    expect(closeMaskBezierDraft(geometry).ok).toBe(true)
    const open = { ...geometry, start: { x: 0.123, y: 0.321 } }
    expect(closeMaskBezierDraft(open).ok).toBe(false)
  })

  test.each([0, 1])('deletes anchor %i and preserves a valid closed path with outer controls', (index) => {
    const result = accepted(editMaskBezierPath(shape, { kind: 'delete-anchor', index }))
    const path = parseMaskBezierPath(result.path)!
    expect(path.segments).toHaveLength(1)
    expect(path.segments[0].end).toEqual(path.start)
    const previous = parsed().segments[index === 0 ? 1 : 0], outgoing = parsed().segments[index]
    expect(path.segments[0].control1).toEqual(previous.control1)
    expect(path.segments[0].control2).toEqual(outgoing.control2)
    expect(editMaskBezierPath(result.path, { kind: 'delete-anchor', index: 0 }).ok).toBe(false)
  })

  test('deletes every possible anchor in a longer path without reopening it', () => {
    for (let index = 0; index < 4; index++) {
      const result = accepted(editMaskBezierPath(DEFAULT_MASK_BEZIER_PATH, { kind: 'delete-anchor', index }))
      const path = parseMaskBezierPath(result.path)!
      expect(path.segments).toHaveLength(3)
      expect(path.segments.at(-1)!.end).toEqual(path.start)
      expect(maskPathPartPoint(path, result.selected)).not.toBeNull()
    }
  })

  test('closes a bounded open draft using a straight cubic, without modifying it', () => {
    const draft = { start: { x: 0, y: 0 }, segments: [{ control1: { x: 0.2, y: 0 }, control2: { x: 0.5, y: 0.2 }, end: { x: 0.6, y: 0.3 } }] }
    const before = JSON.stringify(draft)
    const result = accepted(closeMaskBezierDraft(draft))
    const path = parseMaskBezierPath(result.path)!
    expect(path.segments.at(-1)).toEqual({ control1: { x: 0.4, y: 0.2 }, control2: { x: 0.2, y: 0.1 }, end: { x: 0, y: 0 } })
    expect(JSON.stringify(draft)).toBe(before)
  })

  test('rejects malformed/future grammar without rewriting author intent', () => {
    for (const value of ['', 'M 0 0 Q 0.5 0.5 0 0 Z', 'M 0 0 C NaN 0 0 0 0 0 Z', 'x'.repeat(2049)]) {
      expect(editMaskBezierPath(value, { kind: 'split-segment', segment: 0 }).ok).toBe(false)
    }
    for (const index of [-1, 0.5, 8, Number.NaN]) {
      expect(editMaskBezierPath(shape, { kind: 'delete-anchor', index }).ok).toBe(false)
      expect(editMaskBezierPath(shape, { kind: 'split-segment', segment: index }).ok).toBe(false)
    }
    expect(editMaskBezierPath(shape, { kind: 'set-point', part: { kind: 'anchor', index: 0 }, point: { x: 2, y: 0 } }).ok).toBe(false)
    expect(editMaskBezierPath(shape, { kind: 'move-point', part: { kind: 'anchor', index: 0 }, delta: { x: Number.NaN, y: 0 } }).ok).toBe(false)
  })

  test('preflights path complexity before reading segment data or serializing', () => {
    const segments = new Array(9)
    Object.defineProperty(segments, 0, { get() { throw new Error('Oversized geometry was traversed') } })
    expect(() => serializeMaskBezierPath({ start: { x: 0, y: 0 }, segments })).toThrow('eight')
    expect(closeMaskBezierDraft({ start: { x: 0, y: 0 }, segments }).ok).toBe(false)
  })

  test('serializer rejects invalid geometry and bounds maximum rounded output/error', () => {
    const point = { x: 0.123456499999, y: 0.987654499999 }
    const path = { start: point, segments: Array.from({ length: 8 }, () => ({ control1: point, control2: point, end: point })) }
    const serialized = serializeMaskBezierPath(path)
    expect(serialized.length).toBeLessThanOrEqual(470)
    const roundTrip = parseMaskBezierPath(serialized)!
    expect(Math.hypot((roundTrip.start.x - point.x) * 8 * 3840, (roundTrip.start.y - point.y) * 8 * 2160)).toBeLessThan(0.018)
    expect(serializeMaskBezierPath({ start: { x: -0, y: 0 }, segments: [{ control1: { x: 0, y: 0 }, control2: { x: 0, y: 0 }, end: { x: 0, y: 0 } }] })).not.toContain('-0')
    expect(() => serializeMaskBezierPath({ ...path, start: { x: Number.POSITIVE_INFINITY, y: 0 } })).toThrow()
    expect(() => serializeMaskBezierPath({ ...path, start: { x: 0.1, y: 0.2 } })).toThrow('ending at its start')
  })
})

describe('open mask point authoring', () => {
  test('places straight cubic segments immutably, removes points, and closes through the existing grammar', () => {
    const first = appendMaskBezierDraftPoint(null, { x: 0.1, y: 0.2 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = appendMaskBezierDraftPoint(first.draft, { x: 0.7, y: 0.2 })
    if (!second.ok) throw new Error(second.reason)
    expect(first.draft?.segments).toEqual([])
    expect(second.draft?.segments[0].control1.x).toBeCloseTo(0.3)
    expect(second.draft?.segments[0].control2.x).toBeCloseTo(0.5)
    const third = appendMaskBezierDraftPoint(second.draft, { x: 0.7, y: 0.8 })
    if (!third.ok) throw new Error(third.reason)
    const closed = accepted(closeMaskBezierDraft(third.draft!)), parsed = parseMaskBezierPath(closed.path)!
    expect(parsed.segments).toHaveLength(3)
    expect(parsed.segments.at(-1)!.end).toEqual(parsed.start)
    expect(removeLastMaskBezierDraftPoint(third.draft)).toEqual(second)
    expect(removeLastMaskBezierDraftPoint(first.draft)).toEqual({ ok: true, draft: null })
    expect(removeLastMaskBezierDraftPoint(null)).toEqual({ ok: true, draft: null })
  })

  test('reserves the eighth segment for Close and rejects a ninth point before traversing payload', () => {
    let draft: ParsedMaskPath | null = null
    for (let i = 0; i < 8; i++) {
      const next = appendMaskBezierDraftPoint(draft, { x: i / 10, y: i % 2 / 2 })
      if (!next.ok) throw new Error(next.reason)
      draft = next.draft
    }
    expect(draft!.segments).toHaveLength(7)
    expect(parseMaskBezierPath(accepted(closeMaskBezierDraft(draft!)).path)!.segments).toHaveLength(8)
    expect(appendMaskBezierDraftPoint(draft, { x: 0.9, y: 0.9 }).ok).toBe(false)
    const segments = new Array(9)
    Object.defineProperty(segments, 0, { get() { throw new Error('oversized draft was read') } })
    expect(appendMaskBezierDraftPoint({ start: { x: 0, y: 0 }, segments }, { x: 0.5, y: 0.5 }).ok).toBe(false)
    expect(removeLastMaskBezierDraftPoint({ start: { x: 0, y: 0 }, segments }).ok).toBe(false)
  })

  test('rejects invalid coordinates, consecutive duplicates and invalid existing geometry without mutation', () => {
    const draft = { start: { x: 0.5, y: 0.5 }, segments: [] }, before = JSON.stringify(draft)
    for (const point of [{ x: -0.1, y: 0 }, { x: 1.1, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }, draft.start]) {
      expect(appendMaskBezierDraftPoint(draft, point).ok).toBe(false)
    }
    expect(appendMaskBezierDraftPoint({ start: { x: NaN, y: 0 }, segments: [] }, { x: 0.1, y: 0.2 }).ok).toBe(false)
    expect(JSON.stringify(draft)).toBe(before)
  })
})
