import { describe, expect, test } from 'vitest'
import { defaultClipTransform, defaultClipVisualSettings, migrateLegacyClipInspectorSettings } from './clipInspector'
import {
  createMaskSourceProjectMapper, maskPointToProject, monitorPointToProject,
  moveMaskBox, projectPointToMask, projectPointToMonitor, resizeMaskBox,
  type MaskBox, type MaskBoxCorner, type MaskSourceProjectionFacts,
} from './maskGeometry'
import type { MaskPoint } from './maskPath'

const project = { width: 3840, height: 2160 }
const box = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 }
const facts = (): MaskSourceProjectionFacts => ({
  project, source: { width: 1920, height: 1080 }, lensCorrection: null,
  transform: defaultClipTransform(), visual: defaultClipVisualSettings(),
})
function mapper(input: MaskSourceProjectionFacts) {
  const result = createMaskSourceProjectMapper(input)
  if (!result.ok) throw new Error(result.reason)
  return result.mapper
}
function close(actual: MaskPoint, expected: MaskPoint, precision = 8) {
  expect(actual.x).toBeCloseTo(expected.x, precision)
  expect(actual.y).toBeCloseTo(expected.y, precision)
}

describe('project mask and monitor geometry', () => {
  test('uses measured CSS canvas bounds under responsive size and adaptive backing stores', () => {
    const local = { x: 0.25, y: 0.75 }
    const point = maskPointToProject(local, box, project)
    close(point, { x: 1152, y: 1458 })
    for (const width of [1920, 960, 480, 317.375]) {
      const viewport = { left: 89.25, top: 120.5, width, height: width * 9 / 16 }
      const screen = projectPointToMonitor(point, viewport, project)
      close(monitorPointToProject(screen, viewport, project), point)
      close(projectPointToMask(monitorPointToProject(screen, viewport, project), box, project), local)
    }
    // DPR/backing-store size is intentionally absent from the coordinate contract.
  })

  test('preserves project-edge and off-canvas coordinates without inverse clamping', () => {
    const outside = { x: -0.5, y: 1.7 }
    close(projectPointToMask(maskPointToProject(outside, box, project), box, project), outside)
    const wide = { x: -4, y: 4, width: 8, height: 8 }
    close(maskPointToProject({ x: 1, y: 1 }, wide, project), { x: 15360, y: 25920 })
  })

  test('moves a box in project pixels with stable size and exact no-op identity', () => {
    expect(moveMaskBox(box, { x: 0, y: 0 }, project)).toBe(box)
    expect(moveMaskBox(box, { x: 384, y: -216 }, project)).toEqual({ ...box, x: 0.30000000000000004, y: 0.19999999999999998 })
    expect(moveMaskBox(box, { x: 1e100, y: -1e100 }, project)).toEqual({ ...box, x: 4, y: -4 })
  })

  test.each<MaskBoxCorner>(['top-left', 'top-right', 'bottom-left', 'bottom-right'])('resizes %s around its opposite corner with legal extreme bounds', (corner) => {
    expect(resizeMaskBox(box, corner, { x: 0, y: 0 }, project)).toBe(box)
    for (const starting of [box, { x: 4, y: 4, width: 0.001, height: 0.001 }, { x: -4, y: -4, width: 8, height: 8 }]) {
      for (const delta of [{ x: 300, y: -100 }, { x: 1e100, y: -1e100 }, { x: -1e100, y: 1e100 }]) {
        const result = resizeMaskBox(starting, corner, delta, project)
        for (const axis of ['width', 'height'] as const) {
          expect(result[axis]).toBeGreaterThanOrEqual(0.001)
          expect(result[axis]).toBeLessThanOrEqual(8)
        }
        expect(result.x).toBeGreaterThanOrEqual(-4); expect(result.x).toBeLessThanOrEqual(4)
        expect(result.y).toBeGreaterThanOrEqual(-4); expect(result.y).toBeLessThanOrEqual(4)
        const fixed = (value: MaskBox) => ({
          x: value.x + (corner.endsWith('left') ? value.width : 0),
          y: value.y + (corner.startsWith('top') ? value.height : 0),
        })
        close(fixed(result), fixed(starting))
        expect(() => maskPointToProject({ x: 0, y: 0 }, result, project)).not.toThrow()
      }
    }
  })

  test('rejects unsafe geometry before coordinate arithmetic', () => {
    expect(() => monitorPointToProject({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 20 }, project)).toThrow()
    expect(() => projectPointToMonitor({ x: Number.NaN, y: 0 }, { left: 0, top: 0, width: 100, height: 100 }, project)).toThrow()
    expect(() => maskPointToProject({ x: 0, y: 0 }, { ...box, width: 0 }, project)).toThrow()
    expect(() => projectPointToMask({ x: 0, y: 0 }, box, { width: 3840.5, height: 2160 })).toThrow()
    expect(() => moveMaskBox(box, { x: Number.POSITIVE_INFINITY, y: 0 }, project)).toThrow()
  })
})

describe('admitted affine source projection', () => {
  test('matches independent centered/anchored quarter-turn reference coordinates', () => {
    const input = facts()
    const projection = mapper({ ...input, project: { width: 1000, height: 600 }, source: { width: 200, height: 100 },
      transform: { ...input.transform, x: 30, y: -10, anchorX: 0.25, anchorY: 0.8, rotation: 90, scaleX: 2, scaleY: 3 },
      visual: { ...input.visual, flipHorizontal: true, crop: { left: 0.1, right: 0.2, top: 0.05, bottom: 0.15 } },
    })
    // Authored anchor is at (480,320); source (100,25) is (-100,-165)
    // after flip/scale, then (165,-100) after a 90-degree clockwise turn.
    close(projection.sourceToProject({ x: 0.5, y: 0.25 }), { x: 645, y: 220 })
    close(projection.projectToSource({ x: 645, y: 220 }), { x: 0.5, y: 0.25 })
  })

  test('round-trips a dense grid through crop, anchors, rotation, scale and both flips', () => {
    for (const rotation of [0, 90, -180, 37.5, 719.5]) {
      for (const flipHorizontal of [false, true]) for (const flipVertical of [false, true]) {
        const input = facts()
        const projection = mapper({ ...input,
          transform: { ...input.transform, x: 117, y: -229, anchorX: 0.17, anchorY: 0.83, rotation, scaleX: 0.37, scaleY: 2.3 },
          visual: { ...input.visual, flipHorizontal, flipVertical, crop: { left: 0.13, right: 0.27, top: 0.18, bottom: 0.09 } },
        })
        for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) {
          const point = { x: x / 10, y: y / 10 }
          close(projection.projectToSource(projection.sourceToProject(point)), point)
        }
        expect(projection.sourcePointVisible({ x: 0, y: 0 })).toBe(false)
        expect(projection.sourcePointVisible({ x: 0.5, y: 0.5 })).toBe(true)
        close(projection.clampSourceToCrop({ x: -1, y: 2 }), { x: 0.13, y: 0.91 })
      }
    }
  })

  test('crop changes visibility, without rebasing source or project-mask coordinates', () => {
    const input = facts()
    const cropped = mapper({ ...input, visual: { ...input.visual, crop: { left: 0.4, right: 0.3, top: 0.2, bottom: 0.1 } } })
    const point = { x: 0.1, y: 0.1 }
    expect(cropped.sourceToProject(point)).toEqual(mapper(input).sourceToProject(point))
    expect(cropped.sourcePointVisible(point)).toBe(false)
    expect(maskPointToProject(point, box, project)).toEqual({ x: 921.6, y: 756 })
  })

  test('preserves legacy signed-scale output through explicit flip migration', () => {
    const input = facts()
    const migrated = migrateLegacyClipInspectorSettings({ ...input.transform, scaleX: -2, scaleY: -3 })
    const projection = mapper({ ...input, ...migrated })
    close(projection.sourceToProject({ x: 0.75, y: 0.25 }), { x: 960, y: 1890 })
    expect(createMaskSourceProjectMapper({ ...input, transform: { ...input.transform, scaleX: -2 } }).ok).toBe(false)
  })

  test('pins all facts so later caller changes cannot move an existing mapper', () => {
    const input = facts(), projection = mapper(input), point = { x: 0.2, y: 0.3 }
    const before = projection.sourceToProject(point)
    input.transform.x = 1000; input.visual.flipHorizontal = true; input.visual.crop.left = 0.5
    expect(projection.sourceToProject(point)).toEqual(before)
    expect(projection.sourcePointVisible(point)).toBe(true)
  })

  test('rejects lens intent, singular scales, invalid crop and unsafe dimensions', () => {
    for (const lensCorrection of [{ version: 1, enabled: false }, { version: 99 }, undefined]) {
      const result = createMaskSourceProjectMapper({ ...facts(), lensCorrection })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('lens')
    }
    const input = facts()
    for (const scaleX of [0, Number.MIN_VALUE, Number.NaN, Number.POSITIVE_INFINITY, 101]) {
      expect(createMaskSourceProjectMapper({ ...input, transform: { ...input.transform, scaleX } }).ok).toBe(false)
    }
    expect(createMaskSourceProjectMapper({ ...input, visual: { ...input.visual, crop: { left: 0.5, right: 0.5, top: 0, bottom: 0 } } }).ok).toBe(false)
    expect(createMaskSourceProjectMapper({ ...input, source: { width: 0, height: 100 } }).ok).toBe(false)
    expect(createMaskSourceProjectMapper({ ...input, transform: { ...input.transform, anchorY: 2 } }).ok).toBe(false)
    expect(createMaskSourceProjectMapper({ ...input, transform: { ...input.transform, x: 1e9, scaleX: 1e-12 } }).ok).toBe(false)
    expect(createMaskSourceProjectMapper({ ...input, transform: { ...input.transform, scaleX: 4 * Number.EPSILON } }).ok).toBe(false)
    expect(() => mapper(input).projectToSource({ x: Number.NaN, y: 0 })).toThrow()
  })
})
