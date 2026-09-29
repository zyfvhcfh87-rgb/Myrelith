import { describe, expect, test } from 'vitest'
import {
  applyColorCorrectionsToRgba,
  type ColorCorrectionParameters,
} from './colorCorrection'

const IDENTITY: ColorCorrectionParameters = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
}

describe('SDR color-correction reference fixtures', () => {
  test('keeps no-effect and default identity byte-exact, including alpha', () => {
    const source = new Uint8ClampedArray([
      0, 16, 255, 0,
      64, 128, 192, 17,
      255, 255, 255, 255,
    ])
    const noEffects = source.slice()
    const defaults = source.slice()

    applyColorCorrectionsToRgba(noEffects, [])
    applyColorCorrectionsToRgba(defaults, [IDENTITY])

    expect(noEffects).toEqual(source)
    expect(defaults).toEqual(source)
  })

  test('uses ordered display-referred sRGB math and clamps after each descriptor', () => {
    const exposure = new Uint8ClampedArray([64, 128, 192, 17])
    applyColorCorrectionsToRgba(exposure, [{ ...IDENTITY, exposure: 1 }])
    expect([...exposure]).toEqual([128, 255, 255, 17])

    const clipped = new Uint8ClampedArray([128, 128, 128, 200])
    applyColorCorrectionsToRgba(clipped, [
      { ...IDENTITY, exposure: 4 },
      { ...IDENTITY, exposure: -4 },
    ])
    expect([...clipped]).toEqual([16, 16, 16, 200])
  })

  test('has stable saturation, temperature, tint, and transparent-pixel fixtures', () => {
    const desaturated = new Uint8ClampedArray([255, 0, 0, 255])
    applyColorCorrectionsToRgba(desaturated, [{ ...IDENTITY, saturation: -1 }])
    expect([...desaturated]).toEqual([54, 54, 54, 255])

    const warm = new Uint8ClampedArray([128, 128, 128, 128])
    applyColorCorrectionsToRgba(warm, [{ ...IDENTITY, temperature: 1 }])
    expect([...warm]).toEqual([181, 128, 91, 128])

    const magenta = new Uint8ClampedArray([128, 128, 128, 0])
    applyColorCorrectionsToRgba(magenta, [{ ...IDENTITY, tint: 1 }])
    expect([...magenta]).toEqual([140, 108, 140, 0])
  })

  test('matches the per-pixel reference byte-for-byte for stacked random corrections', () => {
    // The original formulation: every gain re-evaluated for every pixel.
    const reference = (rgba: Uint8ClampedArray, corrections: readonly ColorCorrectionParameters[]) => {
      const clamp = (value: number) => Math.min(1, Math.max(0, value))
      for (let offset = 0; offset < rgba.length; offset += 4) {
        let red = rgba[offset] / 255
        let green = rgba[offset + 1] / 255
        let blue = rgba[offset + 2] / 255
        for (const correction of corrections) {
          const exposureGain = 2 ** correction.exposure
          red *= exposureGain
          green *= exposureGain
          blue *= exposureGain
          const contrastGain = 1 + correction.contrast
          red = (red - 0.5) * contrastGain + 0.5
          green = (green - 0.5) * contrastGain + 0.5
          blue = (blue - 0.5) * contrastGain + 0.5
          const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
          const saturationGain = 1 + correction.saturation
          red = luma + (red - luma) * saturationGain
          green = luma + (green - luma) * saturationGain
          blue = luma + (blue - luma) * saturationGain
          const warmGain = 2 ** (correction.temperature * 0.5)
          red *= warmGain
          blue /= warmGain
          const magentaGain = 2 ** (correction.tint * 0.125)
          const greenGain = 2 ** (-correction.tint * 0.25)
          red *= magentaGain
          green *= greenGain
          blue *= magentaGain
          red = clamp(red)
          green = clamp(green)
          blue = clamp(blue)
        }
        rgba[offset] = Math.round(red * 255)
        rgba[offset + 1] = Math.round(green * 255)
        rgba[offset + 2] = Math.round(blue * 255)
      }
    }
    let seed = 0x9e3779b9
    const next = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 4_294_967_296
    }
    const source = new Uint8ClampedArray(4 * 4_096)
    for (let index = 0; index < source.length; index++) source[index] = Math.floor(next() * 256)
    for (let round = 0; round < 24; round++) {
      const corrections = Array.from({ length: 1 + (round % 4) }, () => ({
        exposure: Math.round((next() * 8 - 4) * 10) / 10,
        contrast: next() * 2 - 1,
        saturation: next() * 2 - 1,
        temperature: next() * 2 - 1,
        tint: next() * 2 - 1,
      }))
      const expected = source.slice()
      const actual = source.slice()
      reference(expected, corrections)
      applyColorCorrectionsToRgba(actual, corrections)
      expect(actual).toEqual(expected)
    }
  })

  test('rejects incomplete RGBA input', () => {
    expect(() => applyColorCorrectionsToRgba(
      new Uint8ClampedArray([0, 1, 2]),
      [IDENTITY],
    )).toThrow(/divisible by four/)
  })
})
