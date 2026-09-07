/** Version-1 shape-preserving cubic RGB curves, independent of browser/UI APIs. */
import { clampColorUnit, finiteColorNumber, materializeChannels, type ChannelTables } from './colorChannels'
import type { EffectParamValue } from './schema'

export const COLOR_CURVES_TYPE = 'builtin.rgb-curves'
export const COLOR_CURVE_CHANNELS = ['master', 'red', 'green', 'blue'] as const
export type ColorCurveChannel = typeof COLOR_CURVE_CHANNELS[number]
export type ColorCurvePoint = readonly [number, number]
export type ColorCurve = readonly ColorCurvePoint[]
export interface ColorCurveParams extends Record<string, EffectParamValue> {
  master: string; red: string; green: string; blue: string; strength: number
}
export const COLOR_CURVE_LIMITS = Object.freeze({ points: 16, characters: 2048, minimumGap: 1 / 4096 })
export const IDENTITY_COLOR_CURVE = '[[0,0],[1,1]]'
export const DEFAULT_COLOR_CURVES: Readonly<ColorCurveParams> = Object.freeze({
  master: IDENTITY_COLOR_CURVE, red: IDENTITY_COLOR_CURVE, green: IDENTITY_COLOR_CURVE, blue: IDENTITY_COLOR_CURVE, strength: 1,
})

export function parseColorCurve(text: unknown): ColorCurve {
  if (typeof text !== 'string' || text.length > COLOR_CURVE_LIMITS.characters) throw new RangeError('Curve exceeds 2,048 characters.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new TypeError('Curve points must be a JSON array.') }
  if (!Array.isArray(value) || value.length < 2 || value.length > COLOR_CURVE_LIMITS.points) throw new RangeError('A curve needs 2–16 points.')
  let previous = -1
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2 || !finiteColorNumber(point[0], 0, 1) || !finiteColorNumber(point[1], 0, 1)) throw new TypeError('Curve points must contain finite x/y values from 0 to 1.')
    if (previous >= 0 && point[0] - previous < COLOR_CURVE_LIMITS.minimumGap) throw new RangeError('Curve x values must increase by at least 1/4,096.')
    previous = point[0]
  }
  if (value[0][0] !== 0 || value[value.length - 1][0] !== 1) throw new RangeError('Curve endpoints must have x values 0 and 1.')
  return value as ColorCurvePoint[]
}

export function colorCurvesParamsError(params: Readonly<Record<string, EffectParamValue>>): string | null {
  for (const channel of COLOR_CURVE_CHANNELS) {
    try { parseColorCurve(params[channel] ?? DEFAULT_COLOR_CURVES[channel]) } catch (error) { return `${channel}: ${(error as Error).message}` }
  }
  return params.strength === undefined || finiteColorNumber(params.strength, 0, 1) ? null : 'Curve strength must be between 0 and 1.'
}

export function colorCurvesParams(params: Readonly<Record<string, EffectParamValue>>): ColorCurveParams {
  return { ...DEFAULT_COLOR_CURVES, ...params } as ColorCurveParams
}

/** Weighted harmonic interior slopes and one-sided, sign-limited endpoints. */
function curveSlopes(points: ColorCurve): number[] {
  const n = points.length
  const h = Array.from({ length: n - 1 }, (_, i) => points[i + 1][0] - points[i][0])
  const d = h.map((width, i) => (points[i + 1][1] - points[i][1]) / width)
  if (n === 2) return [d[0], d[0]]
  const slopes = new Array<number>(n).fill(0)
  const endpoint = (h0: number, h1: number, d0: number, d1: number): number => {
    const candidate = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
    if (Math.sign(candidate) !== Math.sign(d0)) return 0
    return Math.sign(d0) !== Math.sign(d1) && Math.abs(candidate) > Math.abs(3 * d0) ? 3 * d0 : candidate
  }
  slopes[0] = endpoint(h[0], h[1], d[0], d[1])
  slopes[n - 1] = endpoint(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || Math.sign(d[i - 1]) !== Math.sign(d[i])) continue
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]
    slopes[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
  }
  return slopes
}

export function compileColorCurve(points: ColorCurve): (value: number) => number {
  // Validate public point inputs too; callers cannot bypass the portable rules.
  parseColorCurve(JSON.stringify(points))
  const immutable = points.map(([x, y]) => [x, y] as const)
  const slopes = curveSlopes(immutable)
  return (value) => {
    const x = clampColorUnit(value)
    let i = 0
    while (i < immutable.length - 2 && x > immutable[i + 1][0]) i++
    const [x0, y0] = immutable[i], [x1, y1] = immutable[i + 1]
    const h = x1 - x0, t = (x - x0) / h
    if (immutable.length === 2) return y0 + t * (y1 - y0)
    const t2 = t * t, t3 = t2 * t
    return clampColorUnit((2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * slopes[i]
      + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * slopes[i + 1])
  }
}

export function colorCurvesAreIdentity(params: ColorCurveParams): boolean {
  return params.strength === 0 || COLOR_CURVE_CHANNELS.every((channel) => parseColorCurve(params[channel]).every(([x, y]) => x === y))
}

export function materializeCurveChannels(params: ColorCurveParams): ChannelTables {
  const error = colorCurvesParamsError(params)
  if (error) throw new TypeError(error)
  const master = compileColorCurve(parseColorCurve(params.master))
  const channels = [params.red, params.green, params.blue].map((curve) => compileColorCurve(parseColorCurve(curve)))
  return materializeChannels((value, channel) => value + params.strength * (channels[channel](master(value)) - value))
}
