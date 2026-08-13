/** Browser-free CPU oracle and bounded evidence facts for Issue #111. */

import {
  createValidatedLensCorrectionMap,
  DEFAULT_MANUAL_LENS_CORRECTION,
  lensCorrectionValidationError,
  type ManualLensCorrectionModel,
} from '../../domain/lensCorrection'
import {
  MAX_RENDER_AGGREGATE_SURFACE_BYTES,
  RENDER_SURFACE_BYTES_PER_PIXEL,
  renderSurfaceBudget,
} from '../../domain/renderSurfaceBudget'

export const LENS_REMAP_FIXTURE_VERSION = 'issue-111-lens-fixtures-v1'
export const LENS_REMAP_BACKEND_VERSION = 'webgl2-rgba8-manual-bilinear-v1'
export const LENS_REMAP_REUSABLE_SURFACE_COUNT = 2
export const LENS_REMAP_PIXEL_TOLERANCE = 1
export const LENS_REMAP_GEOMETRY_TOLERANCE_PIXELS = 0.25
export const LENS_REMAP_PREVIEW_P95_BUDGET_MS = 1_000 / 30

export const LENS_REMAP_SOURCE_STAGE_ORDER = Object.freeze([
  'decoded-oriented-source',
  'manual-lens-remap',
  'authored-crop',
  'clip-transform',
  'mask-and-chroma',
  'ordered-color-and-effects',
  'opacity-and-blend',
  'transition-group',
] as const)

export interface LensRemapFixture {
  readonly id:
    | 'neutral'
    | 'barrel'
    | 'pincushion'
    | 'tangential'
    | 'off-center'
    | 'strong-valid'
    | 'transparent-edge'
  readonly model: Readonly<ManualLensCorrectionModel>
  readonly transparentInput: boolean
}

function fixture(
  id: LensRemapFixture['id'],
  patch: Partial<ManualLensCorrectionModel>,
  transparentInput = false,
): LensRemapFixture {
  const model = Object.freeze({ ...DEFAULT_MANUAL_LENS_CORRECTION, ...patch })
  const error = lensCorrectionValidationError(model)
  if (error) throw new Error(`Invalid checked-in ${id} lens fixture: ${error}`)
  return Object.freeze({ id, model, transparentInput })
}

export const LENS_REMAP_FIXTURES = Object.freeze([
  fixture('neutral', {}),
  fixture('barrel', { k1: 0.16, k2: 0.025, outputScale: 1.24 }),
  fixture('pincushion', { k1: -0.12, k2: 0.018, outputScale: 1.08 }),
  fixture('tangential', { p1: 0.035, p2: -0.025, outputScale: 1.14 }),
  fixture('off-center', {
    centerX: 0.36,
    centerY: 0.61,
    focalX: 0.62,
    focalY: 0.54,
    k1: 0.11,
    p2: 0.018,
    outputScale: 1.2,
  }),
  fixture('strong-valid', {
    centerX: 0.47,
    centerY: 0.53,
    focalX: 0.46,
    focalY: 0.49,
    k1: 0.28,
    k2: 0.045,
    k3: 0.008,
    p1: 0.018,
    p2: -0.012,
    strength: 0.92,
    outputScale: 1.62,
  }),
  fixture('transparent-edge', { k1: 0.18, k2: 0.03 }, true),
] as const)

export interface LensRemapSurfaceBudget {
  readonly allowed: boolean
  readonly compositorBytes: number
  readonly remapReusableBytes: number
  readonly combinedRetainedBytes: number
  readonly exportReadbackBytes: number
  readonly combinedExportPeakBytes: number
  readonly reason: string | null
}

export function lensRemapSurfaceBudget(
  width: number,
  height: number,
): LensRemapSurfaceBudget {
  const compositor = renderSurfaceBudget(width, height)
  const frameBytes = compositor.allowed
    ? compositor.pixelCount * RENDER_SURFACE_BYTES_PER_PIXEL
    : Number.NaN
  const remapReusableBytes = frameBytes * LENS_REMAP_REUSABLE_SURFACE_COUNT
  const combinedRetainedBytes = compositor.aggregateBytes + remapReusableBytes
  const combinedExportPeakBytes = combinedRetainedBytes + frameBytes
  let reason = compositor.reason
  if (
    reason === null
    && (
      !Number.isSafeInteger(combinedExportPeakBytes)
      || combinedExportPeakBytes > MAX_RENDER_AGGREGATE_SURFACE_BYTES
    )
  ) {
    reason = 'Lens remap plus compositor/readback exceeds the render memory limit.'
  }
  return Object.freeze({
    allowed: reason === null,
    compositorBytes: compositor.aggregateBytes,
    remapReusableBytes,
    combinedRetainedBytes,
    exportReadbackBytes: frameBytes,
    combinedExportPeakBytes,
    reason,
  })
}

function assertRgba(
  input: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('Lens remap dimensions must be positive safe integers')
  }
  const expected = width * height * 4
  if (!Number.isSafeInteger(expected) || input.byteLength !== expected) {
    throw new RangeError('Lens remap input must be one tightly sized RGBA8 frame')
  }
  if (input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    throw new RangeError('Lens remap input must own its complete backing buffer')
  }
}

export function createLensRemapFixtureRgba(
  width: number,
  height: number,
  transparent: boolean,
): Uint8ClampedArray {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) throw new RangeError('Lens fixture dimensions must be positive safe integers')
  const bytes = width * height * 4
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new RangeError('Lens fixture dimensions are outside the byte envelope')
  }
  const pixels = new Uint8ClampedArray(bytes)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const checker = ((x >>> 4) + (y >>> 4)) & 1
      pixels[offset] = (x * 13 + y * 7 + checker * 71) & 0xff
      pixels[offset + 1] = (x * 3 + y * 17 + checker * 43) & 0xff
      pixels[offset + 2] = (x * 19 + y * 5 + checker * 29) & 0xff
      pixels[offset + 3] = transparent
        ? ((x * 11 + y * 23 + checker * 67) & 0xff)
        : 0xff
    }
  }
  return pixels
}

function abortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('Lens remap cancelled', 'AbortError')
  }
  const error = new Error('Lens remap cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export interface CpuLensRemapOptions {
  readonly signal?: AbortSignal
  readonly yieldEveryRows?: number
  readonly yieldControl?: () => Promise<void>
}

function sampleChannel(
  input: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
): number {
  if (x < 0 || x >= width || y < 0 || y >= height) return 0
  return input[(y * width + x) * 4 + channel]!
}

/** Straight RGBA8 / nonlinear-sRGB-code-value bilinear CPU oracle. */
export async function remapLensRgbaCpu(
  input: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  model: ManualLensCorrectionModel,
  options: CpuLensRemapOptions = {},
): Promise<Uint8ClampedArray> {
  assertRgba(input, width, height)
  const mapper = createValidatedLensCorrectionMap(model)
  const output = new Uint8ClampedArray(input.byteLength)
  const yieldEveryRows = options.yieldEveryRows ?? 0
  if (!Number.isSafeInteger(yieldEveryRows) || yieldEveryRows < 0 || yieldEveryRows > height) {
    throw new RangeError('CPU lens-remap yield interval is outside the frame')
  }
  throwIfAborted(options.signal)
  for (let y = 0; y < height; y++) {
    if (yieldEveryRows > 0 && y > 0 && y % yieldEveryRows === 0) {
      await (options.yieldControl ?? defaultYield)()
      throwIfAborted(options.signal)
    }
    const outputY = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const mapped = mapper.map({ x: (x + 0.5) / width, y: outputY })
      const sourceX = mapped.x * width - 0.5
      const sourceY = mapped.y * height - 0.5
      const x0 = Math.floor(sourceX)
      const y0 = Math.floor(sourceY)
      const tx = sourceX - x0
      const ty = sourceY - y0
      const topWeight = 1 - ty
      const leftWeight = 1 - tx
      const offset = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel++) {
        const top = sampleChannel(input, width, height, x0, y0, channel) * leftWeight
          + sampleChannel(input, width, height, x0 + 1, y0, channel) * tx
        const bottom = sampleChannel(input, width, height, x0, y0 + 1, channel) * leftWeight
          + sampleChannel(input, width, height, x0 + 1, y0 + 1, channel) * tx
        output[offset + channel] = Math.round(top * topWeight + bottom * ty)
      }
    }
  }
  throwIfAborted(options.signal)
  return output
}

export interface RgbaAgreement {
  readonly maximumChannelDelta: number
  readonly meanChannelDelta: number
  readonly differingChannels: number
}

export function compareLensRemapRgba(
  expected: Uint8Array | Uint8ClampedArray,
  actual: Uint8Array | Uint8ClampedArray,
): RgbaAgreement {
  if (expected.byteLength !== actual.byteLength) {
    throw new RangeError('Lens-remap parity frames must have identical byte lengths')
  }
  let maximumChannelDelta = 0
  let total = 0
  let differingChannels = 0
  for (let index = 0; index < expected.byteLength; index++) {
    const difference = Math.abs(expected[index]! - actual[index]!)
    maximumChannelDelta = Math.max(maximumChannelDelta, difference)
    total += difference
    if (difference > 0) differingChannels++
  }
  return Object.freeze({
    maximumChannelDelta,
    meanChannelDelta: expected.byteLength === 0 ? 0 : total / expected.byteLength,
    differingChannels,
  })
}

export function percentile95(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Timing samples must be a non-empty finite non-negative list')
  }
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!
}
