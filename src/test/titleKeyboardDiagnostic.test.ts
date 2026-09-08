import { describe, expect, test } from 'vitest'
import { clippedRegion, contrast, healthySession, inside, parseColor, requireNativeKeys, requireSessionLedger, requireTabBudget } from '../../tests/diagnostics/issue200/keyboard-model'

describe('keyboard evidence rejects false positives', () => {
  const box = { x: 10, y: 10, width: 20, height: 20 }, viewport = { x: 0, y: 0, width: 100, height: 100 }
  test('a present DOM rectangle can still be clipped, empty or nonfinite', () => {
    expect(inside(box, viewport)).toBe(true)
    expect(inside({ ...box, x: -3 }, viewport)).toBe(false)
    expect(inside({ ...box, width: 0 }, viewport)).toBe(false)
    expect(inside({ ...box, x: NaN }, viewport)).toBe(false)
    expect(inside(box, clippedRegion(viewport, { ...viewport, width: 15 }))).toBe(false)
  })
  test('the retained safe-guide checkbox fits while its inline label remains clipped', () => {
    // Unchanged b2fc657 native run: automatic Tab scroll exposes the input alone.
    const region = { x: 761, y: 101, width: 518, height: 218 }
    const checkbox = { x: 793, y: 305.171875, width: 13, height: 13 }
    const label = { x: 789, y: 306.171875, width: 222.75, height: 15 }
    expect(inside(checkbox, region)).toBe(true)
    expect(inside(label, region)).toBe(false)
  })
  test('both traversal bounds are independently enforced', () => {
    requireTabBudget(128, 512)
    for (const [target, total] of [[129, 200], [1, 513], [2, 1], [1.5, 2], [-1, 2]]) expect(() => requireTabBudget(target, total)).toThrow()
  })
  test('the reference black/white contrast is 21; identical paints do not pass', () => {
    const layers = [{ background: 'rgb(0, 0, 0)', opacity: 1, image: 'none' }]
    expect(contrast('rgb(255, 255, 255)', layers).ratio).toBe(21)
    expect(contrast('rgb(0, 0, 0)', layers).ratio).toBe(1)
  })
  test('nested opacity and translucent backgrounds are included in painted colors', () => {
    const measured = contrast('rgb(255, 255, 255)', [
      { background: 'transparent', opacity: 0.5, image: 'none' },
      { background: 'rgba(0, 0, 0, 0.5)', opacity: 0.5, image: 'none' },
      { background: 'rgb(255, 255, 255)', opacity: 1, image: 'none' },
    ])
    expect(measured.foregroundPaint).toEqual([0.875, 0.875, 0.875, 1])
    expect(measured.backgroundPaint).toEqual([0.75, 0.75, 0.75, 1])
    expect(measured.ratio).toBeLessThan(4.5)
  })
  test('unknown colors, image backgrounds and absent opaque ancestors fail closed', () => {
    expect(parseColor('color(srgb 1 0.5 0 / 0.5)')).toEqual([1, 0.5, 0, 0.5])
    expect(() => parseColor('CanvasText')).toThrow()
    expect(() => contrast('rgb(0, 0, 0)', [{ background: 'transparent', opacity: 1, image: 'none' }])).toThrow()
    expect(() => contrast('rgb(0, 0, 0)', [{ background: 'rgb(255, 255, 255)', opacity: 1, image: 'linear-gradient(white, black)' }])).toThrow()
  })
  test('a transient error or overflow cannot be cleared by a healthy final snapshot', () => {
    const good = { error: null, saveError: null, recoveryError: null, phase: 'idle', savePhase: 'idle', recoveryPhase: 'idle' }
    expect(healthySession(good)).toBe(true)
    expect(healthySession({ ...good, recoveryPhase: 'error' })).toBe(false)
    requireSessionLedger([{ healthy: true }], 0, [])
    for (const [events, dropped, issues] of [[[], 0, []], [[{ healthy: false }, { healthy: true }], 0, []], [[{ healthy: true }], 1, []], [[{ healthy: true }], 0, ['observer failed']]] as const) expect(() => requireSessionLedger(events, dropped, issues)).toThrow()
  })
  test('synthetic, missing and truncated keyboard ledgers cannot qualify traversal', () => {
    requireNativeKeys([{ trusted: true }], 0)
    expect(() => requireNativeKeys([], 0)).toThrow()
    expect(() => requireNativeKeys([{ trusted: false }, { trusted: true }], 0)).toThrow()
    expect(() => requireNativeKeys([{ trusted: true }], 1)).toThrow()
  })
})
