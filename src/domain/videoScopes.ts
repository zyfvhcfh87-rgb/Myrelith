/** Pure, bounded SDR histogram/waveform/vectorscope analysis. */

export const VIDEO_SCOPE_SAMPLE_WIDTH = 160
export const VIDEO_SCOPE_SAMPLE_HEIGHT = 90
export const VIDEO_SCOPE_MAX_PIXELS = VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_SAMPLE_HEIGHT
export const VIDEO_SCOPE_HISTOGRAM_BINS = 256
export const VIDEO_SCOPE_WAVEFORM_HEIGHT = 64
export const VIDEO_SCOPE_VECTOR_SIZE = 64

const VIDEO_SCOPE_LUMA_RED = 2_126
const VIDEO_SCOPE_LUMA_GREEN = 7_152
const VIDEO_SCOPE_LUMA_BLUE = 722
const VIDEO_SCOPE_LUMA_DIVISOR = 10_000
const VIDEO_SCOPE_CB_DIVISOR = 18_556
const VIDEO_SCOPE_CR_DIVISOR = 15_748
const VIDEO_SCOPE_SIGNAL_DIVISOR = 255 * 255 * VIDEO_SCOPE_LUMA_DIVISOR
const VIDEO_SCOPE_LUMA_BYTE_DIVISOR = 255 * VIDEO_SCOPE_LUMA_DIVISOR

export interface VideoScopeAnalysis {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly sampleCount: number
  readonly histogram: {
    readonly red: Uint16Array
    readonly green: Uint16Array
    readonly blue: Uint16Array
    readonly luma: Uint16Array
  }
  readonly waveform: {
    readonly width: number
    readonly height: number
    readonly density: Uint16Array
  }
  readonly vectorscope: {
    readonly width: number
    readonly height: number
    readonly density: Uint16Array
  }
}

function increment(array: Uint16Array, index: number): void {
  if (array[index] < 65_535) array[index]++
}

function roundUnsignedDivision(numerator: number, divisor: number): number {
  return Math.floor((numerator + Math.floor(divisor / 2)) / divisor)
}

function displayedChannel(channel: number, alpha: number): number {
  return roundUnsignedDivision(channel * alpha, 255)
}

function weightedLuma(red: number, green: number, blue: number): number {
  return red * VIDEO_SCOPE_LUMA_RED
    + green * VIDEO_SCOPE_LUMA_GREEN
    + blue * VIDEO_SCOPE_LUMA_BLUE
}

function chromaBin(delta: number, divisor: number): number {
  const numerator = Math.min(
    divisor * 2,
    Math.max(0, divisor + delta * 2),
  )
  return roundUnsignedDivision(
    numerator * (VIDEO_SCOPE_VECTOR_SIZE - 1),
    divisor * 2,
  )
}

/** Analyze at most the fixed 160 x 90 worker sample budget. */
export function analyzeVideoScopes(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): VideoScopeAnalysis {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError('Scope width must be a positive safe integer')
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('Scope height must be a positive safe integer')
  }
  const pixels = width * height
  if (!Number.isSafeInteger(pixels) || pixels > VIDEO_SCOPE_MAX_PIXELS) {
    throw new RangeError(`Scope samples are limited to ${VIDEO_SCOPE_MAX_PIXELS} pixels`)
  }
  if (rgba.length !== pixels * 4) {
    throw new RangeError('Scope RGBA input does not match its dimensions')
  }

  const redBins = new Uint16Array(VIDEO_SCOPE_HISTOGRAM_BINS)
  const greenBins = new Uint16Array(VIDEO_SCOPE_HISTOGRAM_BINS)
  const blueBins = new Uint16Array(VIDEO_SCOPE_HISTOGRAM_BINS)
  const lumaBins = new Uint16Array(VIDEO_SCOPE_HISTOGRAM_BINS)
  const waveform = new Uint16Array(width * VIDEO_SCOPE_WAVEFORM_HEIGHT)
  const vectorscope = new Uint16Array(VIDEO_SCOPE_VECTOR_SIZE * VIDEO_SCOPE_VECTOR_SIZE)
  let sampleCount = 0

  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4
    const sourceRed = rgba[offset]
    const sourceGreen = rgba[offset + 1]
    const sourceBlue = rgba[offset + 2]
    const alpha = rgba[offset + 3]
    if (alpha === 0) continue
    const red = displayedChannel(sourceRed, alpha)
    const green = displayedChannel(sourceGreen, alpha)
    const blue = displayedChannel(sourceBlue, alpha)
    const weighted = weightedLuma(sourceRed, sourceGreen, sourceBlue)
    const lumaNumerator = alpha * weighted
    const luma = roundUnsignedDivision(lumaNumerator, VIDEO_SCOPE_LUMA_BYTE_DIVISOR)

    increment(redBins, red)
    increment(greenBins, green)
    increment(blueBins, blue)
    increment(lumaBins, luma)

    const sourceX = pixel % width
    const waveformY = VIDEO_SCOPE_WAVEFORM_HEIGHT - 1
      - roundUnsignedDivision(
        lumaNumerator * (VIDEO_SCOPE_WAVEFORM_HEIGHT - 1),
        VIDEO_SCOPE_SIGNAL_DIVISOR,
      )
    increment(waveform, waveformY * width + sourceX)

    const vectorX = chromaBin(
      alpha * (sourceBlue * VIDEO_SCOPE_LUMA_DIVISOR - weighted),
      255 * 255 * VIDEO_SCOPE_CB_DIVISOR,
    )
    const vectorY = VIDEO_SCOPE_VECTOR_SIZE - 1
      - chromaBin(
        alpha * (sourceRed * VIDEO_SCOPE_LUMA_DIVISOR - weighted),
        255 * 255 * VIDEO_SCOPE_CR_DIVISOR,
      )
    increment(vectorscope, vectorY * VIDEO_SCOPE_VECTOR_SIZE + vectorX)
    sampleCount++
  }

  return {
    sourceWidth: width,
    sourceHeight: height,
    sampleCount,
    histogram: {
      red: redBins,
      green: greenBins,
      blue: blueBins,
      luma: lumaBins,
    },
    waveform: {
      width,
      height: VIDEO_SCOPE_WAVEFORM_HEIGHT,
      density: waveform,
    },
    vectorscope: {
      width: VIDEO_SCOPE_VECTOR_SIZE,
      height: VIDEO_SCOPE_VECTOR_SIZE,
      density: vectorscope,
    },
  }
}
