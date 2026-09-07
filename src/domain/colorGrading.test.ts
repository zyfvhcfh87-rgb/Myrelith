import { describe, expect, it } from 'vitest'
import { applyChannelTables, type Rgb } from './colorChannels'
import { compileColorCurve, DEFAULT_COLOR_CURVES, materializeCurveChannels, parseColorCurve } from './colorCurves'
import { COLOR_WHEEL_LIMITS, colorWheelAtPosition, colorWheelBrightness, colorWheelPosition, DEFAULT_COLOR_WHEELS, materializeWheelChannels } from './colorWheels'
import { applyColorLut, COLOR_LUT_LIMITS, decodeColorLut, parseCube, portableColorLut, sampleColorLut } from './colorLut'

function cube(size: number, sample: (r: number, g: number, b: number) => Rgb): string {
  const lines = [`LUT_3D_SIZE ${size}`]
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(sample(r / (size - 1), g / (size - 1), b / (size - 1)).join(' '))
  return lines.join('\n')
}
const one = 'LUT_1D_SIZE 2\n0 1 0\n1 0 0.5'
const decoded = (text: string) => decodeColorLut(portableColorLut('lut-one', 'Example', parseCube(text)))

describe('bounded local Cube profile', () => {
  it('preserves domain, decimals, BOM/CRLF, comments and exact binary64 across portable JSON', () => {
    const parsed = parseCube('\ufeff  # local\r\nTITLE "Example"\r\nDOMAIN_MIN -1 -2 -3\r\nDOMAIN_MAX 1 2 3\r\nLUT_1D_SIZE 2\r\n-0 +.2 3e-1\r\n1. 1 1\r\n')
    expect(parsed.domainMin).toEqual([-1, -2, -3])
    expect(parsed.title).toBe('Example')
    const portable = portableColorLut('lut-one', 'Example', parsed)
    expect([...decodeColorLut(JSON.parse(JSON.stringify(portable))).samples]).toEqual([0, 0.2, 0.3, 1, 1, 1])
  })
  it.each([
    '', '0 0 0', 'LUT_3D_SIZE 65', 'LUT_1D_SIZE 4097', 'LUT_1D_SIZE 2.0',
    `${one}\n0 0 0`, 'LUT_1D_SIZE 2\n0 0 0', `${one}\nTITLE "Late"`,
    `LUT_1D_SIZE 2\n${one}`, `LUT_3D_SIZE 2\n${one}`, `LUT_3D_INPUT_RANGE 0 1\n${one}`,
    one.replace('0 1 0', 'NaN 1 0'), one.replace('0 1 0', 'Infinity 1 0'),
    one.replace('0 1 0', '0x0 1 0'), one.replace('0 1 0', '17 1 0'),
    one.replace('0 1 0', '0 1 0 # comment'), one.replace('0 1 0', '0 1'),
    `DOMAIN_MIN 1 0 0\n${one}`, `DOMAIN_MAX 0.0000001 1 1\n${one}`,
    `TITLE "A"\nTITLE "B"\n${one}`, `TITLE "A" extra\n${one}`,
    `# ${'x'.repeat(249)}\n${one}`, `${one}\r`, `${one}\n\u0000`, `${one}\n# café`,
    one.replace('0 1 0', `${'0'.repeat(33)} 1 0`),
  ])('rejects malformed or unsupported input without guessing: %s', (text) => {
    expect(() => parseCube(text)).toThrow()
  })
  it('bounds total bytes and line count before creating an unbounded collection', () => {
    expect(() => parseCube(' '.repeat(COLOR_LUT_LIMITS.fileBytes + 1))).toThrow('4 MiB')
    expect(() => parseCube('\n'.repeat(COLOR_LUT_LIMITS.lines) + one)).toThrow('100,000')
  })
  it.each([2, 17, 33])('uses red-fastest identity tables at edge %i, preserving all byte values', (size) => {
    const lut = decoded(cube(size, (r, g, b) => [r, g, b]))
    expect(lut.identity).toBe(true)
    const rgba = new Uint8ClampedArray(Array.from({ length: 1024 }, (_, i) => i % 256))
    const before = rgba.slice()
    applyColorLut(rgba, lut, 1)
    expect(rgba).toEqual(before)
    if (size === 33) expect(lut.samples.byteLength).toBe(862488)
  })
  it('detects noncanonical and corrupted encoded values, lengths and metadata', () => {
    const portable = portableColorLut('lut-one', 'Example', parseCube(one))
    for (const change of [{ data: portable.data.slice(1) }, { data: `!${portable.data.slice(1)}` },
      { encoding: 'f32' }, { domainMax: [0, 1, 1] }, { size: 1 }, { extra: true }, { version: 2 }]) {
      expect(() => decodeColorLut({ ...portable, ...change } as typeof portable)).toThrow()
    }
    const nan = Buffer.alloc(48)
    nan.writeDoubleLE(Number.NaN)
    expect(() => decodeColorLut({ ...portable, data: nan.toString('base64') })).toThrow('invalid sample')
    nan.writeDoubleLE(-0)
    expect(() => decodeColorLut({ ...portable, data: nan.toString('base64') })).toThrow('invalid sample')
  })
  it('implements independent 1D interpolation and clamped per-channel domains', () => {
    const lut = decoded(`DOMAIN_MIN -1 0 0\nDOMAIN_MAX 1 2 1\n${one}`)
    const output = new Float64Array(3)
    sampleColorLut(lut, 0, 1, 0.5, output)
    expect([...output]).toEqual([0.5, 0.5, 0.25])
    sampleColorLut(lut, -5, 5, 5, output)
    expect([...output]).toEqual([0, 0, 0.5])
  })
  it.each<Rgb>([[0.8, 0.5, 0.2], [0.8, 0.2, 0.5], [0.5, 0.8, 0.2], [0.2, 0.8, 0.5], [0.5, 0.2, 0.8], [0.2, 0.5, 0.8], [0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0]])('matches the independent tetrahedral corner oracle at %s', (r, g, b) => {
    // Only the all-high corner is nonzero. Its barycentric weight is min(R,G,B),
    // unlike trilinear interpolation's product, including all six tetrahedra.
    const lut = decoded(cube(2, (red, green, blue) => red && green && blue ? [1, 2, 3] : [0, 0, 0]))
    const result = new Float64Array(3)
    sampleColorLut(lut, r, g, b, result)
    expect([...result]).toEqual([Math.min(r, g, b), 2 * Math.min(r, g, b), 3 * Math.min(r, g, b)])
  })
  it('proves asymmetric axis order, strength, alpha and chunk equivalence', () => {
    const lut = decoded(cube(2, (r, g, b) => [b, r, g]))
    const pixels = new Uint8ClampedArray([30, 90, 180, 255, 30, 90, 180, 128, 31, 92, 183, 0])
    const chunked = pixels.slice()
    applyColorLut(pixels, lut, 0.5)
    applyColorLut(chunked, lut, 0.5, 0, 1)
    applyColorLut(chunked, lut, 0.5, 1, 2)
    expect([...pixels]).toEqual([105, 60, 135, 255, 105, 60, 135, 128, 31, 92, 183, 0])
    expect(chunked).toEqual(pixels)
    expect(() => applyColorLut(pixels, lut, 1, -1, 1)).toThrow()
  })
})

describe('versioned RGB curves', () => {
  it.each(['[]', '[[0,0]]', '[[0,0],[0,1],[1,1]]', '[[0.1,0],[1,1]]', '[[0,0],[1,2]]', '[[0,0],[0.0001,0.5],[1,1]]', '[[0,0],[1,null]]', '[', ' '.repeat(2049)])('rejects invalid points %s', (text) => expect(() => parseColorCurve(text)).toThrow())
  it('matches hand-computed Hermite midpoints and interpolates knots exactly', () => {
    const curve = compileColorCurve([[0, 0], [0.5, 0.25], [1, 1]])
    expect(curve(0.25)).toBe(0.078125)
    expect(curve(0.75)).toBe(0.546875)
    expect([curve(0), curve(0.5), curve(1)]).toEqual([0, 0.25, 1])
  })
  it('preserves shape without overshoot through flat and decreasing segments', () => {
    for (const points of [[[0, 0], [0.25, 1], [0.75, 1], [1, 0]], [[0, 1], [0.4, 0.25], [1, 0]]] as const) {
      const curve = compileColorCurve(points)
      for (let i = 0; i < 4096; i++) {
        const x = i / 4095
        const segment = points.findIndex((_point, index) => index < points.length - 1 && x <= points[index + 1][0])
        const low = Math.min(points[segment][1], points[segment + 1][1]), high = Math.max(points[segment][1], points[segment + 1][1])
        expect(curve(x)).toBeGreaterThanOrEqual(low - 1e-12)
        expect(curve(x)).toBeLessThanOrEqual(high + 1e-12)
      }
    }
  })
  it('applies Master then RGB without intermediate rounding and has exact identity tables', () => {
    const identity = materializeCurveChannels({ ...DEFAULT_COLOR_CURVES })
    for (const channel of identity) expect([...channel]).toEqual(Array.from({ length: 256 }, (_, i) => i))
    const tables = materializeCurveChannels({ ...DEFAULT_COLOR_CURVES, master: '[[0,0.2],[1,0.8]]', red: '[[0,1],[1,0]]' })
    for (let i = 0; i < 256; i++) expect(tables[0][i]).toBe(Math.round(255 * (1 - (0.2 + i / 255 * 0.6))))
  })
})

describe('lift/gamma/gain and wheel editing', () => {
  it('has exact neutral tables and preserves transparent RGB/alpha', () => {
    const tables = materializeWheelChannels({ ...DEFAULT_COLOR_WHEELS })
    for (const channel of tables) expect([...channel]).toEqual(Array.from({ length: 256 }, (_, i) => i))
    const pixels = new Uint8ClampedArray([13, 90, 247, 0, 128, 128, 128, 31])
    applyChannelTables(pixels, materializeWheelChannels({ ...DEFAULT_COLOR_WHEELS, gainR: 2, gammaG: 2, liftB: -1 }))
    expect([...pixels]).toEqual([13, 90, 247, 0, 255, Math.round(255 * Math.sqrt(128 / 255)), 1, 31])
  })
  it('proves the formula independently at every input byte and extreme valid settings', () => {
    const params = { ...DEFAULT_COLOR_WHEELS, liftR: -1, gammaR: 0.25, gainR: 4, strength: 0.25 }
    const tables = materializeWheelChannels(params)
    for (let i = 0; i < 256; i++) {
      const c = i / 255, transformed = Math.max(0, 4 * (2 * c - 1)) ** 4
      expect(tables[0][i]).toBe(Math.round(255 * Math.min(1, c * 0.75 + transformed * 0.25)))
    }
    expect(() => materializeWheelChannels({ ...params, gammaR: 0 })).toThrow()
  })
  it.each(['lift', 'gamma', 'gain'] as const)('keeps %s wheel edits bounded and preserves brightness', (group) => {
    const { neutral, min, max } = COLOR_WHEEL_LIMITS[group]
    const original: Rgb = [neutral, neutral, neutral]
    for (const [x, y] of [[1, 0], [-1, 1], [0.3, -0.5], [100, -100]]) {
      const edited = colorWheelAtPosition(original, group, x, y)
      expect(edited.every((v) => v >= min && v <= max)).toBe(true)
      expect(colorWheelPosition(edited, group).mean).toBeCloseTo(neutral, 12)
      const position = colorWheelPosition(edited, group)
      const roundtrip = colorWheelAtPosition(edited, group, position.x, position.y)
      edited.forEach((v, i) => expect(roundtrip[i]).toBeCloseTo(v, 12))
      const brighter = colorWheelBrightness(edited, group, max)
      expect(brighter[0] - brighter[1]).toBeCloseTo(edited[0] - edited[1], 12)
      expect(Math.max(...brighter)).toBeCloseTo(max, 12)
    }
  })
  it('preserves descriptor order and per-stage quantization', () => {
    const curves = materializeCurveChannels({ ...DEFAULT_COLOR_CURVES, red: '[[0,1],[1,0]]' })
    const wheels = materializeWheelChannels({ ...DEFAULT_COLOR_WHEELS, gainR: 2 })
    const first = new Uint8ClampedArray([60, 20, 30, 255]), second = first.slice()
    applyChannelTables(first, curves); applyChannelTables(first, wheels)
    applyChannelTables(second, wheels); applyChannelTables(second, curves)
    expect(first[0]).toBe(255)
    expect(second[0]).toBe(135)
  })
})
