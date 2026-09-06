/** Streaming spatial effects: bounded line/ring scratch, no full-frame clones. */
import type { PixelEffectGeometry } from './effectPixels'
import { spatialEffectIsIdentity, type SpatialPixelEffect } from './spatialEffectDefinitions'

export interface SpatialEffectWork { scratchBytesPeak: number; pixelVisits: number }
const rounded = (value: number): number => Math.round(value)
const clamped = (value: number, end: number): number => Math.max(0, Math.min(end, value))
function record(work: SpatialEffectWork | undefined, scratch: number, visits: number) {
  if (work) { work.scratchBytesPeak = Math.max(work.scratchBytesPeak, scratch); work.pixelVisits += visits }
}
function radius(value: number, surface: number, project: number): number { return Math.max(0, Math.round(value * surface / project)) }

function blurAxis(rgba: Uint8ClampedArray, width: number, height: number, r: number, horizontal: boolean, work?: SpatialEffectWork) {
  if (r === 0) return
  const length = horizontal ? width : height, lines = horizontal ? height : width
  const line = new Uint8ClampedArray(length * 4)
  record(work, line.byteLength, width * height * 3)
  const divisor = r * 2 + 1
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < length; i++) {
      const at = horizontal ? (l * width + i) * 4 : (i * width + l) * 4
      line[i * 4] = rgba[at]; line[i * 4 + 1] = rgba[at + 1]; line[i * 4 + 2] = rgba[at + 2]; line[i * 4 + 3] = rgba[at + 3]
    }
    let a = 0, red = 0, green = 0, blue = 0
    const add = (i: number, weight: number) => {
      const at = i * 4, alpha = line[at + 3] * weight
      a += alpha; red += line[at] * alpha; green += line[at + 1] * alpha; blue += line[at + 2] * alpha
    }
    add(0, r + 1)
    for (let i = 1; i <= Math.min(r, length - 1); i++) add(i, 1)
    if (r > length - 1) add(length - 1, r - length + 1)
    for (let i = 0; i < length; i++) {
      const at = horizontal ? (l * width + i) * 4 : (i * width + l) * 4
      rgba[at] = a > 0 ? rounded(red / a) : 0
      rgba[at + 1] = a > 0 ? rounded(green / a) : 0
      rgba[at + 2] = a > 0 ? rounded(blue / a) : 0
      rgba[at + 3] = rounded(a / divisor)
      add(clamped(i - r, length - 1), -1); add(clamped(i + r + 1, length - 1), 1)
    }
  }
}

function sharpen(rgba: Uint8ClampedArray, geometry: PixelEffectGeometry, amount: number, work?: SpatialEffectWork) {
  const { surfaceWidth: width, surfaceHeight: height } = geometry
  const stride = width * 4
  const rows = [new Uint8ClampedArray(stride), new Uint8ClampedArray(stride), new Uint8ClampedArray(stride)]
  rows[0].set(rgba.subarray(0, stride)); rows[1].set(rows[0])
  rows[2].set(rgba.subarray(height > 1 ? stride : 0, height > 1 ? stride * 2 : stride))
  // Bilinear sampling of the one-project-pixel cross for reduced previews.
  const wx = Math.min(1, width / geometry.projectWidth), wy = Math.min(1, height / geometry.projectHeight)
  record(work, stride * 3, width * height * 5)
  for (let y = 0; y < height; y++) {
    const [above, center, below] = rows
    for (let x = 0; x < width; x++) {
      const at = x * 4, left = Math.max(0, x - 1) * 4, right = Math.min(width - 1, x + 1) * 4
      const alpha = center[at + 3], out = y * stride + at
      if (alpha === 0) { rgba[out] = rgba[out + 1] = rgba[out + 2] = 0; continue }
      const wc = 5 - 2 * wx - 2 * wy
      const denominator = alpha * wc + wx * (center[left + 3] + center[right + 3]) + wy * (above[at + 3] + below[at + 3])
      for (let c = 0; c < 3; c++) {
        const mean = (center[at + c] * alpha * wc + wx * (center[left + c] * center[left + 3] + center[right + c] * center[right + 3]) + wy * (above[at + c] * above[at + 3] + below[at + c] * below[at + 3])) / denominator
        rgba[out + c] = rounded(center[at + c] + amount * (center[at + c] - mean))
      }
    }
    const reusable = rows.shift()!
    rows.push(reusable)
    const next = Math.min(height - 1, y + 2) * stride
    // At the bottom edge duplicate the unmodified current buffer, not output.
    reusable.set(y + 2 >= height ? rows[1] : rgba.subarray(next, next + stride))
  }
}
function vignette(rgba: Uint8ClampedArray, geometry: PixelEffectGeometry, strength: number, clear: number, softness: number, work?: SpatialEffectWork) {
  const { surfaceWidth: width, surfaceHeight: height } = geometry
  record(work, 0, width * height)
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5) * 2 / height - 1
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5) * 2 / width - 1
      const t = Math.max(0, Math.min(1, (Math.sqrt((nx * nx + ny * ny) / 2) - clear) / softness))
      const factor = 1 - strength * t * t * (3 - 2 * t)
      const at = (y * width + x) * 4
      rgba[at] = rounded(rgba[at] * factor); rgba[at + 1] = rounded(rgba[at + 1] * factor); rgba[at + 2] = rounded(rgba[at + 2] * factor)
    }
  }
}
function under(rgba: Uint8ClampedArray, at: number, coverage: number, red: number, green: number, blue: number) {
  const source = rgba[at + 3] / 255
  const background = coverage * (1 - source), alpha = source + background
  if (alpha === 0) { rgba[at] = rgba[at + 1] = rgba[at + 2] = rgba[at + 3] = 0; return }
  rgba[at] = rounded((rgba[at] * source + red * background) / alpha)
  rgba[at + 1] = rounded((rgba[at + 1] * source + green * background) / alpha)
  rgba[at + 2] = rounded((rgba[at + 2] * source + blue * background) / alpha)
  rgba[at + 3] = rounded(alpha * 255)
}
function shadow(rgba: Uint8ClampedArray, geometry: PixelEffectGeometry, rx: number, ry: number, dx: number, dy: number, opacity: number, color: readonly number[], work?: SpatialEffectWork) {
  const { surfaceWidth: width, surfaceHeight: height } = geometry
  // Preserve original alpha rows before any output overwrites them, including
  // positive offsets that need source rows long after they were composited.
  const capacity = Math.min(height, 2 * ry + Math.abs(dy) + 2)
  const rows = new Uint8ClampedArray(capacity * width), sums = new Float64Array(width)
  record(work, rows.byteLength + sums.byteLength, width * height * 5)
  let generated = -1
  const generate = (through: number) => {
    while (generated < Math.min(height - 1, through)) {
      const y = ++generated, base = y * width * 4, target = y % capacity * width
      let sum = 0
      for (let x = 0; x <= Math.min(rx, width - 1); x++) sum += rgba[base + x * 4 + 3]
      for (let x = 0; x < width; x++) {
        rows[target + x] = rounded(sum / (2 * rx + 1))
        if (x - rx >= 0) sum -= rgba[base + (x - rx) * 4 + 3]
        if (x + rx + 1 < width) sum += rgba[base + (x + rx + 1) * 4 + 3]
      }
    }
  }
  generate(Math.max(0, -dy + ry))
  for (let row = Math.max(0, -dy - ry); row <= Math.min(height - 1, -dy + ry); row++) {
    for (let x = 0; x < width; x++) sums[x] += rows[row % capacity * width + x]
  }
  for (let y = 0; y < height; y++) {
    if (y > 0) {
      generate(Math.max(y, y - dy + ry))
      const entering = y - dy + ry, leaving = y - dy - ry - 1
      for (let x = 0; x < width; x++) {
        if (entering >= 0 && entering < height) sums[x] += rows[entering % capacity * width + x]
        if (leaving >= 0 && leaving < height) sums[x] -= rows[leaving % capacity * width + x]
      }
    }
    for (let x = 0; x < width; x++) {
      const sample = x - dx, alpha = sample >= 0 && sample < width ? sums[sample] / (2 * ry + 1) : 0
      under(rgba, (y * width + x) * 4, alpha / 255 * opacity, color[0], color[1], color[2])
    }
  }
}
function outline(rgba: Uint8ClampedArray, geometry: PixelEffectGeometry, rx: number, ry: number, opacity: number, color: readonly number[], work?: SpatialEffectWork) {
  const { surfaceWidth: width, surfaceHeight: height } = geometry
  rx = Math.min(rx, width - 1); ry = Math.min(ry, height - 1)
  const capacity = 2 * ry + 2
  // Relative row ages are bounded by the kernel. Uint16 indices cover the bounded
  // 16,384-pixel raster plus its clamped radius without wrapping.
  const values = new Uint8Array(width * capacity), ages = new Uint16Array(width * capacity)
  const heads = new Uint32Array(width), tails = new Uint32Array(width)
  const row = new Uint8Array(width), deque = new Int32Array(width + rx + 1)
  record(work, values.byteLength + ages.byteLength + heads.byteLength + tails.byteLength + row.byteLength + deque.byteLength, width * height * 8)
  for (let incomingY = 0; incomingY < height + ry; incomingY++) {
    if (incomingY < height) {
      let head = 0, tail = 0
      const base = incomingY * width * 4
      for (let t = 0; t < width + rx; t++) {
        while (head < tail && deque[head] < t - 2 * rx) head++
        const alpha = t < width ? rgba[base + t * 4 + 3] : 0
        while (head < tail && (deque[tail - 1] < width ? rgba[base + deque[tail - 1] * 4 + 3] : 0) <= alpha) tail--
        deque[tail++] = t
        if (t >= rx) row[t - rx] = deque[head] < width ? rgba[base + deque[head] * 4 + 3] : 0
      }
    } else row.fill(0)
    const outputY = incomingY - ry
    for (let x = 0; x < width; x++) {
      const base = x * capacity
      let head = heads[x], tail = tails[x]
      while (head !== tail && ages[base + head] + 2 * ry < incomingY) head = (head + 1) % capacity
      while (head !== tail && values[base + (tail + capacity - 1) % capacity] <= row[x]) tail = (tail + capacity - 1) % capacity
      values[base + tail] = row[x]; ages[base + tail] = incomingY; tail = (tail + 1) % capacity
      heads[x] = head; tails[x] = tail
      if (outputY >= 0) {
        const at = (outputY * width + x) * 4
        under(rgba, at, Math.max(0, values[base + head] - rgba[at + 3]) / 255 * opacity, color[0], color[1], color[2])
      }
    }
  }
}

export function applySpatialEffect(rgba: Uint8ClampedArray, effect: SpatialPixelEffect, geometry: PixelEffectGeometry, work?: SpatialEffectWork): void {
  const { kind, params } = effect
  if (spatialEffectIsIdentity(kind, params)) return
  const { surfaceWidth: width, surfaceHeight: height, projectWidth, projectHeight } = geometry
  if (kind === 'box-blur') {
    blurAxis(rgba, width, height, radius(Number(params.radius), width, projectWidth), true, work)
    blurAxis(rgba, width, height, radius(Number(params.radius), height, projectHeight), false, work)
  } else if (kind === 'sharpen') sharpen(rgba, geometry, Number(params.amount), work)
  else if (kind === 'vignette') vignette(rgba, geometry, Number(params.strength), Number(params.radius), Number(params.softness), work)
  else {
    const color = [1, 3, 5].map((start) => Number.parseInt(String(params.color).slice(start, start + 2), 16))
    if (kind === 'drop-shadow') shadow(rgba, geometry, radius(Number(params.radius), width, projectWidth), radius(Number(params.radius), height, projectHeight), Math.round(Number(params.offsetX) * width / projectWidth), Math.round(Number(params.offsetY) * height / projectHeight), Number(params.opacity), color, work)
    else outline(rgba, geometry, radius(Number(params.width), width, projectWidth), radius(Number(params.width), height, projectHeight), Number(params.opacity), color, work)
  }
}
