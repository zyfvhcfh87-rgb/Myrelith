/** Pure, bounded SDR histogram/waveform/vectorscope analysis. */

export const VIDEO_SCOPE_SAMPLE_WIDTH = 160
export const VIDEO_SCOPE_SAMPLE_HEIGHT = 90
export const VIDEO_SCOPE_MAX_PIXELS = VIDEO_SCOPE_SAMPLE_WIDTH * VIDEO_SCOPE_SAMPLE_HEIGHT
export const VIDEO_SCOPE_HISTOGRAM_BINS = 256
export const VIDEO_SCOPE_WAVEFORM_HEIGHT = 64
export const VIDEO_SCOPE_VECTOR_SIZE = 64

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

function byte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value * 255)))
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
    const alpha = rgba[offset + 3] / 255
    if (alpha === 0) continue
    const red = rgba[offset] / 255 * alpha
    const green = rgba[offset + 1] / 255 * alpha
    const blue = rgba[offset + 2] / 255 * alpha
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722

    increment(redBins, byte(red))
    increment(greenBins, byte(green))
    increment(blueBins, byte(blue))
    increment(lumaBins, byte(luma))

    const sourceX = pixel % width
    const waveformY = VIDEO_SCOPE_WAVEFORM_HEIGHT - 1
      - Math.round(luma * (VIDEO_SCOPE_WAVEFORM_HEIGHT - 1))
    increment(waveform, waveformY * width + sourceX)

    const cb = Math.min(1, Math.max(0, 0.5 + (blue - luma) / 1.8556))
    const cr = Math.min(1, Math.max(0, 0.5 + (red - luma) / 1.5748))
    const vectorX = Math.round(cb * (VIDEO_SCOPE_VECTOR_SIZE - 1))
    const vectorY = VIDEO_SCOPE_VECTOR_SIZE - 1
      - Math.round(cr * (VIDEO_SCOPE_VECTOR_SIZE - 1))
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
