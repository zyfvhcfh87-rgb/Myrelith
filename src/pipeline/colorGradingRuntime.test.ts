import { describe, expect, test } from 'vitest'
import { ColorGradingRuntime, ColorGradingCancelledError } from './colorGradingRuntime'
import { COLOR_LUT_LIMITS, COLOR_LUT_TYPE, applyColorLut, decodeColorLut, parseCube, portableColorLut } from '../domain/colorLut'
import { COLOR_CURVES_TYPE, DEFAULT_COLOR_CURVES, materializeCurveChannels } from '../domain/colorCurves'
import { COLOR_WHEELS_TYPE, DEFAULT_COLOR_WHEELS, materializeWheelChannels } from '../domain/colorWheels'
import { applyChannelTables } from '../domain/colorChannels'
import { createColorAdjustEffect, effectRegistration, resolveCanvasEffectStack, resolveEffectStack, type CanvasPixelEffect } from '../domain/effectStack'
import { colorGradingPlanError } from '../domain/colorGradingBudget'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import type { EffectDescriptor } from '../domain/schema'

const table = (id = 'lut') => portableColorLut(id, 'Test', parseCube('LUT_1D_SIZE 2\n0.1 0.2 0.3\n0.8 0.7 0.6'))
const lutEffect: EffectDescriptor = { id: 'lut-effect', type: COLOR_LUT_TYPE, version: 1, enabled: true, params: { lutId: 'lut', strength: 0.7 } }
const curveParams = { ...DEFAULT_COLOR_CURVES, master: '[[0,0.05],[0.5,0.7],[1,0.95]]', red: '[[0,0],[1,0.8]]', strength: 0.8 }
const wheelParams = { ...DEFAULT_COLOR_WHEELS, liftR: -0.2, gammaG: 1.4, gainB: 0.7 }
const curveEffect: EffectDescriptor = { id: 'curves', type: COLOR_CURVES_TYPE, version: 1, enabled: true, params: curveParams }
const wheelEffect: EffectDescriptor = { id: 'wheels', type: COLOR_WHEELS_TYPE, version: 1, enabled: true, params: wheelParams }
const geometry = { surfaceWidth: 257, surfaceHeight: 33, projectWidth: 257, projectHeight: 33 }
const pixels = () => Uint8ClampedArray.from({ length: 257 * 33 * 4 }, (_, i) => i % 251)
const stages = (effects: readonly EffectDescriptor[], runtime: ColorGradingRuntime) => resolveCanvasEffectStack(effects, true, true, runtime.context).pixelEffects
function plan(effects: EffectDescriptor[]): VideoCompositionPlan { return { frame: 0, items: [{ kind: 'video-bus', target: 'master', trackId: '', sequenceId: 'root', frame: 0, instancePath: [], effects }] } }

describe('shared grading runtime', () => {
  test('uses the reference math in exact descriptor order, in place, across chunk boundaries', async () => {
    let yields = 0
    const runtime = new ColorGradingRuntime(async () => { yields++ })
    runtime.setCatalog([table()])
    const actual = pixels(), expected = pixels(), original = actual.buffer
    applyColorLut(expected, decodeColorLut(table()), 0.7)
    applyChannelTables(expected, materializeCurveChannels(curveParams))
    applyChannelTables(expected, materializeWheelChannels(wheelParams))
    try {
      await runtime.apply(actual, stages([lutEffect, curveEffect, wheelEffect], runtime), geometry)
      expect(actual).toEqual(expected)
      expect(actual.buffer).toBe(original)
      expect(yields).toBe(9)
      expect(runtime.ledger().bytes).toBe(48 + 768 * 2)
    } finally { runtime.dispose() }
    expect(runtime.ledger()).toMatchObject({ bytes: 0, entries: 0, ports: 0, pendingTasks: 0, active: false })
  })
  test('identities keep old filter selection and require no pixel capability or scratch', () => {
    const runtime = new ColorGradingRuntime(async () => {})
    runtime.setCatalog([portableColorLut('lut', 'Identity', parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1'))])
    const old = createColorAdjustEffect('old'); old.params.exposure = 1
    const neutral = [lutEffect, { ...curveEffect, params: DEFAULT_COLOR_CURVES }, { ...wheelEffect, params: DEFAULT_COLOR_WHEELS }]
    expect(resolveCanvasEffectStack([old, ...neutral], true, false, runtime.context).filter).toBe(resolveCanvasEffectStack([old], true, false).filter)
    expect(resolveCanvasEffectStack(neutral, true, false, runtime.context).pixelEffects).toEqual([])
    runtime.dispose()
  })
  test('resource errors and future versions are preserved, preview-bypassed and export-blocked; explicit bypass permits export', () => {
    const context = { colorLuts: [] }
    expect(resolveEffectStack([lutEffect], new Set(['canvas2d-filter', 'canvas2d-pixel-access']), context)[0]).toMatchObject({ status: 'unsupported', detail: expect.stringContaining('missing') })
    expect(colorGradingPlanError(plan([lutEffect]), 1280, 720, context, 'bypass', true)).toBeNull()
    expect(colorGradingPlanError(plan([lutEffect]), 1280, 720, context, 'fail', true)).toMatch(/missing/)
    expect(colorGradingPlanError(plan([{ ...lutEffect, enabled: false }]), 1280, 720, context, 'fail', true)).toBeNull()
    expect(colorGradingPlanError(plan([{ ...wheelEffect, version: 17 }]), 1280, 720, context, 'fail', true)).toMatch(/Version 17/)
    expect(colorGradingPlanError(plan([curveEffect]), 1280, 720, context, 'fail', false)).toMatch(/pixel-access/)
  })
  test('evicts before allocation and invalidates reused ids by catalog content', async () => {
    const large = (id: string, value: number) => portableColorLut(id, id, { kind: '3d', size: 33, title: '', domainMin: [0, 0, 0], domainMax: [1, 1, 1], samples: new Float64Array(33 ** 3 * 3).fill(value) })
    const runtime = new ColorGradingRuntime(async () => {})
    const catalog = [large('a', 0.1), large('b', 0.2), large('c', 0.3)]
    try {
      runtime.setCatalog(catalog)
      expect(runtime.ledger().entries).toBe(2)
      expect(runtime.ledger().peakBytes).toBeLessThanOrEqual(COLOR_LUT_LIMITS.runtimeBytes)
      const rgba = new Uint8ClampedArray([1, 2, 3, 255])
      const effect: CanvasPixelEffect = { kind: 'cube-lut', params: { lutId: 'a', strength: 1 } }
      await runtime.apply(rgba, [effect], { surfaceWidth: 1, surfaceHeight: 1, projectWidth: 1, projectHeight: 1 })
      expect([...rgba]).toEqual([26, 26, 26, 255])
      runtime.setCatalog([large('a', 0.9)])
      await runtime.apply(rgba, [effect], { surfaceWidth: 1, surfaceHeight: 1, projectWidth: 1, projectHeight: 1 })
      expect([...rgba]).toEqual([230, 230, 230, 255])
      expect(runtime.ledger().peakBytes).toBeLessThanOrEqual(COLOR_LUT_LIMITS.runtimeBytes)
    } finally { runtime.dispose() }
  })
  test('animated scalar materializations retain at most 256 entries', async () => {
    const runtime = new ColorGradingRuntime(async () => {})
    try {
      for (let i = 0; i < 300; i++) {
        const stage = effectRegistration(COLOR_WHEELS_TYPE)!.pixelEffect({ ...wheelEffect, params: { ...wheelParams, gainR: i / 100 } })!
        await runtime.apply(new Uint8ClampedArray([50, 100, 150, 255]), [stage], { surfaceWidth: 1, surfaceHeight: 1, projectWidth: 1, projectHeight: 1 })
      }
      expect(runtime.ledger().entries).toBe(256)
      expect(runtime.ledger().bytes).toBe(256 * 768)
    } finally { runtime.dispose() }
  })
  test.each(['cancelled', 'malformed'] as const)('%s catalog replacement preserves the published tables and can retry', async (failure) => {
    const runtime = new ColorGradingRuntime(async () => {}), original = [table()]
    runtime.setCatalog(original)
    const context = runtime.context
    const replacement = [table('candidate'), failure === 'malformed' ? { ...table('broken'), data: '!'.repeat(table().data.length) } : table('second')]
    let checks = 0
    try {
      expect(() => runtime.setCatalog(replacement, () => {
        if (++checks === 2 && failure === 'cancelled') throw new ColorGradingCancelledError()
      })).toThrow(failure === 'cancelled' ? /cancelled/ : /base64/)
      expect(runtime.context).toBe(context)
      expect(runtime.ledger()).toMatchObject({ bytes: 0, entries: 0, active: false })
      const actual = pixels(), expected = pixels()
      applyColorLut(expected, decodeColorLut(original[0]), 0.7)
      await runtime.apply(actual, stages([lutEffect], runtime), geometry)
      expect(actual).toEqual(expected)
      runtime.setCatalog(original)
      expect(runtime.context).toBe(context)
      const retry = portableColorLut('lut', 'Inverse', parseCube('LUT_1D_SIZE 2\n1 1 1\n0 0 0'))
      runtime.setCatalog([retry])
      actual.set(pixels()); expected.set(pixels())
      applyColorLut(expected, decodeColorLut(retry), 0.7)
      await runtime.apply(actual, stages([lutEffect], runtime), geometry)
      expect(actual).toEqual(expected)
      expect(runtime.ledger().peakBytes).toBeLessThanOrEqual(COLOR_LUT_LIMITS.runtimeBytes)
    } finally { runtime.dispose() }
    expect(runtime.ledger()).toMatchObject({ bytes: 0, entries: 0, ports: 0, pendingTasks: 0 })
  })
  test('checks currentness after the last table and never restores a disposed catalog', () => {
    const runtime = new ColorGradingRuntime(), original = [table()]
    runtime.setCatalog(original)
    const context = runtime.context
    let checks = 0
    expect(() => runtime.setCatalog([table('candidate')], () => {
      if (++checks === 2) throw new ColorGradingCancelledError()
    })).toThrow(/cancelled/)
    expect(runtime.context).toBe(context)
    expect(runtime.ledger()).toMatchObject({ bytes: 0, entries: 0 })
    expect(() => runtime.setCatalog([table('candidate')], () => runtime.dispose())).toThrow(/cancelled/)
    expect(runtime.context.colorLuts).toEqual([])
    expect(runtime.ledger()).toMatchObject({ bytes: 0, entries: 0, ports: 0, pendingTasks: 0 })
    expect(() => runtime.setCatalog(original)).toThrow(/cancelled/)
  })
  test('delivered cancellation stops at the next chunk and disposal retains borrowed buffers until settlement', async () => {
    let release!: () => void
    const runtime = new ColorGradingRuntime(() => new Promise<void>((resolve) => { release = resolve }))
    runtime.setCatalog([table()])
    const value = pixels(), original = pixels()
    const pending = runtime.apply(value, stages([lutEffect], runtime), geometry)
    const observed = expect(pending).rejects.toBeInstanceOf(ColorGradingCancelledError)
    expect(runtime.ledger().active).toBe(true)
    expect(() => runtime.setCatalog([table('changed')])).toThrow(/active frame/)
    runtime.dispose()
    expect(runtime.ledger().bytes).toBe(48)
    release(); await observed
    expect(value.slice(4096 * 4)).toEqual(original.slice(4096 * 4))
    expect(runtime.ledger()).toMatchObject({ active: false, bytes: 0, pendingTasks: 0 })
  })
  test('bounds grading pixel-stage visits across expanded buses independently of buffer admission', () => {
    const long = Array.from({ length: 17 }, (_, i) => ({ ...curveEffect, id: `curve-${i}` }))
    expect(colorGradingPlanError(plan(long), 3840, 2160, { colorLuts: [] }, 'fail', true)).toMatch(/pixel-stage/)
    expect(colorGradingPlanError(plan(long.slice(0, 16)), 3840, 2160, { colorLuts: [] }, 'fail', true)).toBeNull()
    // The common videoPixelWorkBudget now owns readback, mask, plugin and cache
    // lifetimes for every executable frame, including those without grading.
  })})
