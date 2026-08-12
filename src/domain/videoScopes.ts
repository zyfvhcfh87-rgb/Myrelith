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
const VIDEO_SCOPE_CB_SIGNAL_DIVISOR = 255 * 255 * VIDEO_SCOPE_CB_DIVISOR
const VIDEO_SCOPE_CR_SIGNAL_DIVISOR = 255 * 255 * VIDEO_SCOPE_CR_DIVISOR

export const VIDEO_SCOPE_LEGACY_TIE_DOWN = {
  luma: 1 << 0,
  waveform: 1 << 1,
  cb: 1 << 2,
  cr: 1 << 3,
} as const

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

function isExactHalf(numerator: number, divisor: number): boolean {
  return (numerator % divisor) * 2 === divisor
}

function chromaNumerator(delta: number, divisor: number): number {
  return Math.min(
    divisor * 2,
    Math.max(0, divisor + delta * 2),
  )
}

function legacyTieRoundsDown(
  numerator: number,
  divisor: number,
  legacyRounded: number,
): boolean {
  return isExactHalf(numerator, divisor)
    && legacyRounded < roundUnsignedDivision(numerator, divisor)
}

function legacyScopeTieDownMask(
  red: number,
  green: number,
  blue: number,
  alpha: number,
  lumaNumerator: number,
  cbNumerator: number,
  crNumerator: number,
): number {
  if (alpha === 0) return 0
  const waveformNumerator = lumaNumerator * (VIDEO_SCOPE_WAVEFORM_HEIGHT - 1)

  const lumaIsHalf = isExactHalf(lumaNumerator, VIDEO_SCOPE_LUMA_BYTE_DIVISOR)
  const waveformIsHalf = isExactHalf(waveformNumerator, VIDEO_SCOPE_SIGNAL_DIVISOR)
  const cbIsHalf = isExactHalf(cbNumerator, VIDEO_SCOPE_CB_SIGNAL_DIVISOR * 2)
  const crIsHalf = isExactHalf(crNumerator, VIDEO_SCOPE_CR_SIGNAL_DIVISOR * 2)
  if (!lumaIsHalf && !waveformIsHalf && !cbIsHalf && !crIsHalf) return 0

  // Keep this evaluation order byte-for-byte aligned with the shipped Float64 path.
  const displayedAlpha = alpha / 255
  const displayedRed = red / 255 * displayedAlpha
  const displayedGreen = green / 255 * displayedAlpha
  const displayedBlue = blue / 255 * displayedAlpha
  const displayedLuma = (
    displayedRed * 0.2126
    + displayedGreen * 0.7152
    + displayedBlue * 0.0722
  )
  const displayedCb = Math.min(
    1,
    Math.max(0, 0.5 + (displayedBlue - displayedLuma) / 1.8556),
  )
  const displayedCr = Math.min(
    1,
    Math.max(0, 0.5 + (displayedRed - displayedLuma) / 1.5748),
  )

  let mask = 0
  if (lumaIsHalf && legacyTieRoundsDown(
    lumaNumerator,
    VIDEO_SCOPE_LUMA_BYTE_DIVISOR,
    Math.round(displayedLuma * 255),
  )) {
    mask |= VIDEO_SCOPE_LEGACY_TIE_DOWN.luma
  }
  if (waveformIsHalf && legacyTieRoundsDown(
    waveformNumerator,
    VIDEO_SCOPE_SIGNAL_DIVISOR,
    Math.round(displayedLuma * (VIDEO_SCOPE_WAVEFORM_HEIGHT - 1)),
  )) {
    mask |= VIDEO_SCOPE_LEGACY_TIE_DOWN.waveform
  }
  if (cbIsHalf && legacyTieRoundsDown(
    cbNumerator,
    VIDEO_SCOPE_CB_SIGNAL_DIVISOR * 2,
    Math.round(displayedCb * (VIDEO_SCOPE_VECTOR_SIZE - 1)),
  )) {
    mask |= VIDEO_SCOPE_LEGACY_TIE_DOWN.cb
  }
  if (crIsHalf && legacyTieRoundsDown(
    crNumerator,
    VIDEO_SCOPE_CR_SIGNAL_DIVISOR * 2,
    Math.round(displayedCr * (VIDEO_SCOPE_VECTOR_SIZE - 1)),
  )) {
    mask |= VIDEO_SCOPE_LEGACY_TIE_DOWN.cr
  }
  return mask
}

export function videoScopeLegacyTieDownMask(
  red: number,
  green: number,
  blue: number,
  alpha: number,
): number {
  const weighted = weightedLuma(red, green, blue)
  const cbNumerator = chromaNumerator(
    alpha * (blue * VIDEO_SCOPE_LUMA_DIVISOR - weighted),
    VIDEO_SCOPE_CB_SIGNAL_DIVISOR,
  ) * (VIDEO_SCOPE_VECTOR_SIZE - 1)
  const crNumerator = chromaNumerator(
    alpha * (red * VIDEO_SCOPE_LUMA_DIVISOR - weighted),
    VIDEO_SCOPE_CR_SIGNAL_DIVISOR,
  ) * (VIDEO_SCOPE_VECTOR_SIZE - 1)
  return legacyScopeTieDownMask(
    red,
    green,
    blue,
    alpha,
    alpha * weighted,
    cbNumerator,
    crNumerator,
  )
}

function chromaBin(
  numerator: number,
  divisor: number,
  tieRoundsDown: boolean,
): number {
  const rounded = roundUnsignedDivision(
    numerator,
    divisor * 2,
  )
  return tieRoundsDown ? rounded - 1 : rounded
}

function waveformLevel(lumaNumerator: number, tieRoundsDown: boolean): number {
  const rounded = roundUnsignedDivision(
    lumaNumerator * (VIDEO_SCOPE_WAVEFORM_HEIGHT - 1),
    VIDEO_SCOPE_SIGNAL_DIVISOR,
  )
  return tieRoundsDown ? rounded - 1 : rounded
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
    const cbNumerator = chromaNumerator(
      alpha * (sourceBlue * VIDEO_SCOPE_LUMA_DIVISOR - weighted),
      VIDEO_SCOPE_CB_SIGNAL_DIVISOR,
    ) * (VIDEO_SCOPE_VECTOR_SIZE - 1)
    const crNumerator = chromaNumerator(
      alpha * (sourceRed * VIDEO_SCOPE_LUMA_DIVISOR - weighted),
      VIDEO_SCOPE_CR_SIGNAL_DIVISOR,
    ) * (VIDEO_SCOPE_VECTOR_SIZE - 1)
    const legacyTieDownMask = legacyScopeTieDownMask(
      sourceRed,
      sourceGreen,
      sourceBlue,
      alpha,
      lumaNumerator,
      cbNumerator,
      crNumerator,
    )
    const luma = roundUnsignedDivision(lumaNumerator, VIDEO_SCOPE_LUMA_BYTE_DIVISOR)
      - (legacyTieDownMask & VIDEO_SCOPE_LEGACY_TIE_DOWN.luma ? 1 : 0)

    increment(redBins, red)
    increment(greenBins, green)
    increment(blueBins, blue)
    increment(lumaBins, luma)

    const sourceX = pixel % width
    const waveformBin = waveformLevel(
      lumaNumerator,
      Boolean(legacyTieDownMask & VIDEO_SCOPE_LEGACY_TIE_DOWN.waveform),
    )
    const waveformY = VIDEO_SCOPE_WAVEFORM_HEIGHT - 1
      - waveformBin
    increment(waveform, waveformY * width + sourceX)

    const vectorX = chromaBin(
      cbNumerator,
      VIDEO_SCOPE_CB_SIGNAL_DIVISOR,
      Boolean(legacyTieDownMask & VIDEO_SCOPE_LEGACY_TIE_DOWN.cb),
    )
    const vectorY = VIDEO_SCOPE_VECTOR_SIZE - 1
      - chromaBin(
        crNumerator,
        VIDEO_SCOPE_CR_SIGNAL_DIVISOR,
        Boolean(legacyTieDownMask & VIDEO_SCOPE_LEGACY_TIE_DOWN.cr),
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
