/** Display-sRGB grading vocabulary. Resource binding is supplied by each owner. */
import type { EffectDescriptor, EffectParamValue } from './schema'
import type { EffectRegistration } from './effectStack'
import { COLOR_LUT_TYPE } from './colorLut'
import { COLOR_CURVES_TYPE, DEFAULT_COLOR_CURVES, colorCurvesAreIdentity, colorCurvesParams, colorCurvesParamsError, type ColorCurveParams } from './colorCurves'
import { COLOR_WHEELS_TYPE, DEFAULT_COLOR_WHEELS, COLOR_RGB, COLOR_WHEEL_GROUPS, COLOR_WHEEL_LIMITS, colorWheelsAreIdentity, colorWheelsParams, colorWheelsParamsError, type ColorWheelParams } from './colorWheels'

export interface ColorLutFact { readonly id: string; readonly identity: boolean; readonly error: string | null }
export interface ColorGradingContext { readonly colorLuts: readonly ColorLutFact[] }
export const EMPTY_COLOR_GRADING_CONTEXT: ColorGradingContext = Object.freeze({ colorLuts: [] })
export type ColorGradingPixelEffect =
  | { readonly kind: 'cube-lut'; readonly params: { readonly lutId: string; readonly strength: number } }
  | { readonly kind: 'rgb-curves'; readonly params: ColorCurveParams }
  | { readonly kind: 'lift-gamma-gain'; readonly params: ColorWheelParams }
export function isColorGradingType(type: string): boolean { return type === COLOR_LUT_TYPE || type === COLOR_CURVES_TYPE || type === COLOR_WHEELS_TYPE }
export function isColorGradingPixel(effect: { readonly kind: string }): effect is ColorGradingPixelEffect { return effect.kind === 'cube-lut' || effect.kind === 'rgb-curves' || effect.kind === 'lift-gamma-gain' }
export function colorLutParamsError(params: Readonly<Record<string, EffectParamValue>>): string | null {
  if (typeof params.lutId !== 'string' || !/^[a-z0-9_-]{1,256}$/iu.test(params.lutId)) return 'Choose an embedded LUT table.'
  return typeof params.strength !== 'number' || !Number.isFinite(params.strength) || params.strength < 0 || params.strength > 1 ? 'LUT strength must be from 0 to 1.' : null
}
export function colorGradingResourceError(effect: EffectDescriptor, context: ColorGradingContext): string | null {
  if (effect.type !== COLOR_LUT_TYPE) return null
  const fact = context.colorLuts.find((entry) => entry.id === effect.params.lutId)
  return fact ? fact.error : `Embedded LUT “${String(effect.params.lutId).slice(0, 256)}” is missing.`
}
function lutIdentity(effect: EffectDescriptor, context?: ColorGradingContext): boolean {
  return effect.params.strength === 0 || context?.colorLuts.some((fact) => fact.id === effect.params.lutId && !fact.error && fact.identity) === true
}
const strength = Object.freeze({ min: 0, max: 1, step: 0.01, label: 'Strength' })
const common = { version: 1, surfaces: ['source-layer', 'post-composite'] as const, preservesOpaqueInput: true as const,
  migrateLegacy: () => null, canvasFilter: () => '' }
export function colorGradingRegistrations(): readonly EffectRegistration[] {
  return [
    { ...common, type: COLOR_LUT_TYPE, label: 'LUT', defaultParams: { strength: 1 }, validateParams: colorLutParamsError,
      capabilities: (effect, context) => lutIdentity(effect, context) ? [] : ['canvas2d-pixel-access'],
      pixelEffect: (effect, context) => lutIdentity(effect, context) ? null : { kind: 'cube-lut', params: { lutId: effect.params.lutId as string, strength: effect.params.strength as number } },
      animatableParams: { strength } },
    { ...common, type: COLOR_CURVES_TYPE, label: 'RGB curves', defaultParams: DEFAULT_COLOR_CURVES, validateParams: colorCurvesParamsError,
      capabilities: (effect) => colorCurvesAreIdentity(colorCurvesParams(effect.params)) ? [] : ['canvas2d-pixel-access'],
      pixelEffect: (effect) => colorCurvesAreIdentity(colorCurvesParams(effect.params)) ? null : { kind: 'rgb-curves', params: colorCurvesParams(effect.params) },
      animatableParams: { strength } },
    { ...common, type: COLOR_WHEELS_TYPE, label: 'Lift / Gamma / Gain', defaultParams: DEFAULT_COLOR_WHEELS, validateParams: colorWheelsParamsError,
      capabilities: (effect) => colorWheelsAreIdentity(colorWheelsParams(effect.params)) ? [] : ['canvas2d-pixel-access'],
      pixelEffect: (effect) => colorWheelsAreIdentity(colorWheelsParams(effect.params)) ? null : { kind: 'lift-gamma-gain', params: colorWheelsParams(effect.params) },
      animatableParams: { ...Object.fromEntries(COLOR_WHEEL_GROUPS.flatMap((group) => COLOR_RGB.map((channel) => [`${group}${channel}`, { min: COLOR_WHEEL_LIMITS[group].min, max: COLOR_WHEEL_LIMITS[group].max, step: 0.01, label: `${group[0].toUpperCase()}${group.slice(1)} ${channel}` }]))), strength } },
  ]
}
