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

  test('rejects incomplete RGBA input', () => {
    expect(() => applyColorCorrectionsToRgba(
      new Uint8ClampedArray([0, 1, 2]),
      [IDENTITY],
    )).toThrow(/divisible by four/)
  })
})
