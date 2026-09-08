/** Display-referred lift/gamma/gain math and the canonical wheel/numeric mapping. */
import { finiteColorNumber, materializeChannels, type ChannelTables, type Rgb } from './colorChannels'
import type { EffectParamValue } from './schema'

export const COLOR_WHEELS_TYPE = 'builtin.lift-gamma-gain'
export const COLOR_WHEEL_GROUPS = ['lift', 'gamma', 'gain'] as const
export type ColorWheelGroup = typeof COLOR_WHEEL_GROUPS[number]
export const COLOR_RGB = ['R', 'G', 'B'] as const
export const COLOR_WHEEL_LIMITS = Object.freeze({
  lift: Object.freeze({ min: -1, max: 1, neutral: 0, scale: 4 / 3, step: 0.01 }),
  gamma: Object.freeze({ min: 0.25, max: 4, neutral: 1, scale: 2.5, step: 0.01 }),
  gain: Object.freeze({ min: 0, max: 4, neutral: 1, scale: 8 / 3, step: 0.01 }),
})
export interface ColorWheelParams extends Record<string, EffectParamValue> {
  liftR: number; liftG: number; liftB: number
  gammaR: number; gammaG: number; gammaB: number
  gainR: number; gainG: number; gainB: number
  strength: number
}
export const DEFAULT_COLOR_WHEELS: Readonly<ColorWheelParams> = Object.freeze({
  liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1, gainR: 1, gainG: 1, gainB: 1, strength: 1,
})

export function colorWheelsParams(params: Readonly<Record<string, EffectParamValue>>): ColorWheelParams {
  return { ...DEFAULT_COLOR_WHEELS, ...params } as ColorWheelParams
}
export function colorWheelsParamsError(params: Readonly<Record<string, EffectParamValue>>): string | null {
  for (const group of COLOR_WHEEL_GROUPS) {
    const limit = COLOR_WHEEL_LIMITS[group]
    for (const channel of COLOR_RGB) {
      const key = `${group}${channel}`
      if (params[key] !== undefined && !finiteColorNumber(params[key], limit.min, limit.max)) return `${key} must be between ${limit.min} and ${limit.max}.`
    }
  }
  return params.strength === undefined || finiteColorNumber(params.strength, 0, 1) ? null : 'Wheel strength must be between 0 and 1.'
}

export function colorWheelsAreIdentity(params: ColorWheelParams): boolean {
  return params.strength === 0 || COLOR_WHEEL_GROUPS.every((group) => COLOR_RGB.every((channel) => params[`${group}${channel}`] === COLOR_WHEEL_LIMITS[group].neutral))
}

export function materializeWheelChannels(params: ColorWheelParams): ChannelTables {
  const error = colorWheelsParamsError(params)
  if (error) throw new TypeError(error)
  return materializeChannels((value, channel) => {
    const suffix = COLOR_RGB[channel]
    const lift = Number(params[`lift${suffix}`]), gamma = Number(params[`gamma${suffix}`]), gain = Number(params[`gain${suffix}`])
    const graded = Math.max(0, gain * (value + lift * (1 - value))) ** (1 / gamma)
    return value + params.strength * (graded - value)
  })
}

function checkedWheel(values: Rgb, group: ColorWheelGroup): void {
  const { min, max } = COLOR_WHEEL_LIMITS[group]
  if (!values.every((v) => finiteColorNumber(v, min, max))) throw new RangeError('Wheel channels exceed their bounds.')
}
export function colorWheelPosition(values: Rgb, group: ColorWheelGroup): { x: number; y: number; mean: number } {
  checkedWheel(values, group)
  const mean = (values[0] + values[1] + values[2]) / 3
  const scale = COLOR_WHEEL_LIMITS[group].scale
  return { x: (values[0] - mean) / scale, y: (values[1] - values[2]) / (Math.sqrt(3) * scale), mean }
}

/** Absolute hue-plane position at the existing mean; shorten its ray at any bound. */
export function colorWheelAtPosition(values: Rgb, group: ColorWheelGroup, x: number, y: number): Rgb {
  const { mean } = colorWheelPosition(values, group)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Wheel position must be finite.')
  const { min, max, scale } = COLOR_WHEEL_LIMITS[group]
  const radius = Math.max(1, Math.hypot(x, y))
  const dx = x / radius * scale, dy = y / radius * scale
  const offsets = [dx, -dx / 2 + Math.sqrt(3) * dy / 2, -dx / 2 - Math.sqrt(3) * dy / 2]
  let amount = 1
  for (const offset of offsets) {
    if (offset > 0) amount = Math.min(amount, (max - mean) / offset)
    else if (offset < 0) amount = Math.min(amount, (min - mean) / offset)
  }
  const channel = (offset: number) => Math.min(max, Math.max(min, mean + amount * offset))
  return [channel(offsets[0]), channel(offsets[1]), channel(offsets[2])]
}

/** Common offset with one shared clamp, so a brightness edit preserves chroma. */
export function colorWheelBrightness(values: Rgb, group: ColorWheelGroup, requestedMean: number): Rgb {
  const { mean } = colorWheelPosition(values, group)
  if (!Number.isFinite(requestedMean)) throw new RangeError('Wheel brightness must be finite.')
  const { min, max } = COLOR_WHEEL_LIMITS[group]
  const delta = Math.min(max - Math.max(...values), Math.max(min - Math.min(...values), requestedMean - mean))
  return [values[0] + delta, values[1] + delta, values[2] + delta]
}
