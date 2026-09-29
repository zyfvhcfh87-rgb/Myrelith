/** Browser-free SDR color-correction reference math. */

export interface ColorCorrectionParameters {
  readonly exposure: number
  readonly contrast: number
  readonly saturation: number
  readonly temperature: number
  readonly tint: number
}

const LUMA_RED = 0.2126
const LUMA_GREEN = 0.7152
const LUMA_BLUE = 0.0722
const GAINS_PER_CORRECTION = 6

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Apply ordered corrections to unpremultiplied 8-bit, display-referred sRGB.
 *
 * Each descriptor uses float64 intermediates in this exact order: exposure,
 * contrast around 0.5, Rec.709-luma saturation, temperature red/blue gains,
 * then tint magenta/green gains. RGB clamps after every descriptor; the final
 * conversion rounds to the nearest 8-bit integer. Alpha is copied byte-exact.
 */
export function applyColorCorrectionsToRgba(
  rgba: Uint8ClampedArray,
  corrections: readonly ColorCorrectionParameters[],
): void {
  if (rgba.length % 4 !== 0) {
    throw new RangeError('RGBA input length must be divisible by four')
  }
  if (corrections.length === 0) return

  // Every gain depends only on its descriptor: evaluate each once, not per pixel.
  const gains = new Float64Array(corrections.length * GAINS_PER_CORRECTION)
  for (let index = 0; index < corrections.length; index++) {
    const correction = corrections[index]
    const base = index * GAINS_PER_CORRECTION
    gains[base] = 2 ** correction.exposure
    gains[base + 1] = 1 + correction.contrast
    gains[base + 2] = 1 + correction.saturation
    gains[base + 3] = 2 ** (correction.temperature * 0.5)
    gains[base + 4] = 2 ** (correction.tint * 0.125)
    gains[base + 5] = 2 ** (-correction.tint * 0.25)
  }

  for (let offset = 0; offset < rgba.length; offset += 4) {
    let red = rgba[offset] / 255
    let green = rgba[offset + 1] / 255
    let blue = rgba[offset + 2] / 255

    for (let base = 0; base < gains.length; base += GAINS_PER_CORRECTION) {
      const exposureGain = gains[base]
      red *= exposureGain
      green *= exposureGain
      blue *= exposureGain

      const contrastGain = gains[base + 1]
      red = (red - 0.5) * contrastGain + 0.5
      green = (green - 0.5) * contrastGain + 0.5
      blue = (blue - 0.5) * contrastGain + 0.5

      const luma = red * LUMA_RED + green * LUMA_GREEN + blue * LUMA_BLUE
      const saturationGain = gains[base + 2]
      red = luma + (red - luma) * saturationGain
      green = luma + (green - luma) * saturationGain
      blue = luma + (blue - luma) * saturationGain

      const warmGain = gains[base + 3]
      red *= warmGain
      blue /= warmGain

      const magentaGain = gains[base + 4]
      const greenGain = gains[base + 5]
      red *= magentaGain
      green *= greenGain
      blue *= magentaGain

      red = clampUnit(red)
      green = clampUnit(green)
      blue = clampUnit(blue)
    }

    rgba[offset] = Math.round(red * 255)
    rgba[offset + 1] = Math.round(green * 255)
    rgba[offset + 2] = Math.round(blue * 255)
  }
}
