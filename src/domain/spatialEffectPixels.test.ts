import { expect, test } from 'vitest'
import { applySpatialEffect } from './spatialEffectPixels'
import { spatialEffectParams, type SpatialEffectKind } from './spatialEffectDefinitions'
import type { PixelEffectGeometry } from './effectPixels'
const geometry = (w: number, h: number): PixelEffectGeometry => ({ surfaceWidth: w, surfaceHeight: h, projectWidth: w, projectHeight: h })
const fixture = (w: number, h: number) => Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => i % 4 === 3 ? [0, 64, 128, 255][Math.floor(i / 4) % 4] : i * 71 % 256)
const color = [32, 64, 128]
function under(input: Uint8ClampedArray, out: Uint8ClampedArray, i: number, a: number) {
  const sa = input[i + 3] / 255, alpha = sa + a * (1 - sa)
  for (let c = 0; c < 3; c++) out[i + c] = alpha ? Math.round((input[i + c] * sa + color[c] * a * (1 - sa)) / alpha) : 0
  out[i + 3] = Math.round(alpha * 255)
}
function blurOracle(input: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  let source = input
  for (const horizontal of [true, false]) {
    const out = new Uint8ClampedArray(source.length)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0, 0]
      for (let k = -radius; k <= radius; k++) {
        const sx = horizontal ? Math.max(0, Math.min(w - 1, x + k)) : x
        const sy = horizontal ? y : Math.max(0, Math.min(h - 1, y + k))
        const at = (sy * w + sx) * 4, alpha = source[at + 3]
        sum[3] += alpha
        for (let c = 0; c < 3; c++) sum[c] += alpha * source[at + c]
      }
      const at = (y * w + x) * 4
      for (let c = 0; c < 3; c++) out[at + c] = sum[3] ? Math.round(sum[c] / sum[3]) : 0
      out[at + 3] = Math.round(sum[3] / (2 * radius + 1))
    }
    source = out
  }
  return source
}
test('streamed blur matches an independent full-image convolution, including tiny images and hidden RGB', () => {
  for (const [w, h] of [[1, 1], [1, 7], [9, 1], [7, 8]]) for (const radius of [1, 2, 5, 32]) {
    const input = fixture(w, h), output = input.slice()
    applySpatialEffect(output, { kind: 'box-blur', params: { radius } }, geometry(w, h))
    expect([...output], `${w}x${h} radius ${radius}`).toEqual([...blurOracle(input, w, h, radius)])
  }
  const edge = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0])
  applySpatialEffect(edge, { kind: 'box-blur', params: { radius: 1 } }, geometry(3, 1))
  expect([...edge]).toEqual([255, 0, 0, 170, 255, 0, 0, 85, 0, 0, 0, 0])
})
test('shadow streaming matches independent alpha convolution with positive and negative offsets', () => {
  const w = 7, h = 9, input = fixture(w, h)
  for (const r of [0, 1, 3, 32]) for (const dx of [-4, 0, 4]) for (const dy of [-6, 0, 6]) {
    const horizontal = new Uint8ClampedArray(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) if (x + k >= 0 && x + k < w) sum += input[(y * w + x + k) * 4 + 3]
      horizontal[y * w + x] = Math.round(sum / (2 * r + 1))
    }
    const expected = input.slice(), actual = input.slice()
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) if (x - dx >= 0 && x - dx < w && y - dy + k >= 0 && y - dy + k < h) sum += horizontal[(y - dy + k) * w + x - dx]
      under(input, expected, (y * w + x) * 4, sum / (2 * r + 1) / 255 * 0.6)
    }
    applySpatialEffect(actual, { kind: 'drop-shadow', params: { radius: r, offsetX: dx, offsetY: dy, opacity: 0.6, color: '#204080' } }, geometry(w, h))
    expect([...actual], `r${r}, dx${dx}, dy${dy}`).toEqual([...expected])
  }
})
test('outline deques match full square alpha dilation across image edges', () => {
  for (const [w, h] of [[1, 1], [1, 8], [8, 1], [9, 11], [3, 270]]) for (const r of [1, 2, 5, 32]) {
    const input = fixture(w, h), expected = input.slice(), actual = input.slice()
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let maximum = 0
      for (let sy = Math.max(0, y - r); sy <= Math.min(h - 1, y + r); sy++) for (let sx = Math.max(0, x - r); sx <= Math.min(w - 1, x + r); sx++) maximum = Math.max(maximum, input[(sy * w + sx) * 4 + 3])
      under(input, expected, (y * w + x) * 4, Math.max(0, maximum - input[(y * w + x) * 4 + 3]) / 255 * 0.75)
    }
    applySpatialEffect(actual, { kind: 'outline', params: { width: r, opacity: 0.75, color: '#204080' } }, geometry(w, h))
    expect([...actual], `${w}x${h} r${r}`).toEqual([...expected])
  }
})
test('sharpen preserves alpha and matches the alpha-weighted one-pixel cross', () => {
  for (const [w, h] of [[1, 1], [1, 7], [9, 1], [8, 9]]) {
    const input = fixture(w, h), expected = input.slice(), actual = input.slice()
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4
      const indices = [[x, y], [Math.max(0, x - 1), y], [Math.min(w - 1, x + 1), y], [x, Math.max(0, y - 1)], [x, Math.min(h - 1, y + 1)]].map(([sx, sy]) => (sy * w + sx) * 4)
      const alphaSum = indices.reduce((sum, i) => sum + input[i + 3], 0)
      for (let c = 0; c < 3; c++) expected[at + c] = input[at + 3] ? Math.round(input[at + c] + 2 * (input[at + c] - indices.reduce((sum, i) => sum + input[i + c] * input[i + 3], 0) / alphaSum)) : 0
    }
    applySpatialEffect(actual, { kind: 'sharpen', params: { amount: 2 } }, geometry(w, h))
    expect([...actual]).toEqual([...expected])
  }
})
test('vignette has explicit center and edge reference pixels and preserves alpha', () => {
  const rgba = new Uint8ClampedArray(3 * 3 * 4).fill(255)
  rgba[3] = 128
  applySpatialEffect(rgba, { kind: 'vignette', params: { strength: 1, radius: 0, softness: 1 } }, geometry(3, 3))
  expect([...rgba.slice(0, 4)]).toEqual([66, 66, 66, 128])
  expect([...rgba.slice(16, 20)]).toEqual([255, 255, 255, 255])
})
test.each(['box-blur', 'sharpen', 'vignette', 'drop-shadow', 'outline'] as SpatialEffectKind[])('%s identity keeps every byte and allocates no scratch', (kind) => {
  const input = fixture(3, 4), result = input.slice(), work = { scratchBytesPeak: 0, pixelVisits: 0 }
  applySpatialEffect(result, { kind, params: spatialEffectParams(kind, {}) }, geometry(3, 4), work)
  expect(result).toEqual(input)
  expect(work).toEqual({ scratchBytesPeak: 0, pixelVisits: 0 })
})

test('blur radius scales in authored project units at reduced preview resolution', () => {
  const rgba = fixture(9, 7), expected = blurOracle(rgba, 9, 7, 2)
  applySpatialEffect(rgba, { kind: 'box-blur', params: { radius: 4 } }, { ...geometry(9, 7), projectWidth: 18, projectHeight: 14 })
  expect(rgba).toEqual(expected)
})
