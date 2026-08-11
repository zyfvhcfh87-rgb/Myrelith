import { describe, expect, test } from 'vitest'
import {
  analyzeVideoScopes,
  VIDEO_SCOPE_MAX_PIXELS,
  VIDEO_SCOPE_VECTOR_SIZE,
  VIDEO_SCOPE_WAVEFORM_HEIGHT,
} from './videoScopes'

function legacyFloatAnalysis(rgba: Uint8ClampedArray, width: number, height: number) {
  const red = new Uint16Array(256)
  const green = new Uint16Array(256)
  const blue = new Uint16Array(256)
  const luma = new Uint16Array(256)
  const waveform = new Uint16Array(width * VIDEO_SCOPE_WAVEFORM_HEIGHT)
  const vectorscope = new Uint16Array(VIDEO_SCOPE_VECTOR_SIZE ** 2)
  let sampleCount = 0
  const increment = (array: Uint16Array, index: number): void => { array[index]++ }
  const byte = (value: number): number => Math.min(255, Math.max(0, Math.round(value * 255)))

  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4
    const alpha = rgba[offset + 3] / 255
    if (alpha === 0) continue
    const displayedRed = rgba[offset] / 255 * alpha
    const displayedGreen = rgba[offset + 1] / 255 * alpha
    const displayedBlue = rgba[offset + 2] / 255 * alpha
    const displayedLuma = displayedRed * 0.2126
      + displayedGreen * 0.7152
      + displayedBlue * 0.0722
    increment(red, byte(displayedRed))
    increment(green, byte(displayedGreen))
    increment(blue, byte(displayedBlue))
    increment(luma, byte(displayedLuma))
    const sourceX = pixel % width
    const waveformY = VIDEO_SCOPE_WAVEFORM_HEIGHT - 1
      - Math.round(displayedLuma * (VIDEO_SCOPE_WAVEFORM_HEIGHT - 1))
    increment(waveform, waveformY * width + sourceX)
    const cb = Math.min(1, Math.max(0, 0.5 + (displayedBlue - displayedLuma) / 1.8556))
    const cr = Math.min(1, Math.max(0, 0.5 + (displayedRed - displayedLuma) / 1.5748))
    const vectorX = Math.round(cb * (VIDEO_SCOPE_VECTOR_SIZE - 1))
    const vectorY = VIDEO_SCOPE_VECTOR_SIZE - 1
      - Math.round(cr * (VIDEO_SCOPE_VECTOR_SIZE - 1))
    increment(vectorscope, vectorY * VIDEO_SCOPE_VECTOR_SIZE + vectorX)
    sampleCount++
  }
  return { red, green, blue, luma, waveform, vectorscope, sampleCount }
}

describe('bounded SDR video scope fixtures', () => {
  test('analyzes visible pixels over black and ignores fully transparent samples', () => {
    const result = analyzeVideoScopes(new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 0, 255, 0,
    ]), 2, 1)

    expect(result.sampleCount).toBe(1)
    expect(result.histogram.red[255]).toBe(1)
    expect(result.histogram.green[0]).toBe(1)
    expect(result.histogram.blue[0]).toBe(1)
    expect(result.histogram.luma[54]).toBe(1)
    expect(result.waveform.density[(VIDEO_SCOPE_WAVEFORM_HEIGHT - 1 - 13) * 2]).toBe(1)
    expect(result.vectorscope.density[24]).toBe(1)
  })

  test('premultiplies partial alpha for the displayed-over-black scope signal', () => {
    const result = analyzeVideoScopes(
      new Uint8ClampedArray([255, 255, 255, 128]),
      1,
      1,
    )
    expect(result.sampleCount).toBe(1)
    expect(result.histogram.red[128]).toBe(1)
    expect(result.histogram.green[128]).toBe(1)
    expect(result.histogram.blue[128]).toBe(1)
    expect(result.histogram.luma[128]).toBe(1)
    expect(result.vectorscope.density).toHaveLength(
      VIDEO_SCOPE_VECTOR_SIZE * VIDEO_SCOPE_VECTOR_SIZE,
    )
  })

  test('uses one integer fixed-point contract at half-bin boundaries', () => {
    const result = analyzeVideoScopes(new Uint8ClampedArray([
      1, 254, 127, 127,
      254, 1, 128, 128,
      17, 201, 99, 199,
    ]), 3, 1)

    expect([...result.histogram.red.entries()].filter(([, count]) => count)).toEqual([
      [0, 1],
      [13, 1],
      [127, 1],
    ])
    expect([...result.histogram.green.entries()].filter(([, count]) => count)).toEqual([
      [1, 1],
      [127, 1],
      [157, 1],
    ])
    expect([...result.histogram.blue.entries()].filter(([, count]) => count)).toEqual([
      [63, 1],
      [64, 1],
      [77, 1],
    ])
    expect([...result.histogram.luma.entries()].filter(([, count]) => count)).toEqual([
      [32, 1],
      [95, 1],
      [121, 1],
    ])
    expect(result.sampleCount).toBe(3)
  })

  test('preserves the shipped float64 scope bins on a complete seeded sample', () => {
    const rgba = new Uint8ClampedArray(VIDEO_SCOPE_MAX_PIXELS * 4)
    let state = 0x71_75_10_ba
    for (let index = 0; index < rgba.length; index++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      rgba[index] = state >>> 24
    }
    const actual = analyzeVideoScopes(rgba, 160, 90)
    const legacy = legacyFloatAnalysis(rgba, 160, 90)

    expect(actual.sampleCount).toBe(legacy.sampleCount)
    expect(actual.histogram.red).toEqual(legacy.red)
    expect(actual.histogram.green).toEqual(legacy.green)
    expect(actual.histogram.blue).toEqual(legacy.blue)
    expect(actual.histogram.luma).toEqual(legacy.luma)
    expect(actual.waveform.density).toEqual(legacy.waveform)
    expect(actual.vectorscope.density).toEqual(legacy.vectorscope)
  })

  test('enforces exact input shape and the fixed sample ceiling', () => {
    expect(() => analyzeVideoScopes(new Uint8ClampedArray(4), 0, 1))
      .toThrow(/positive safe integer/)
    expect(() => analyzeVideoScopes(new Uint8ClampedArray(4), 1, 2))
      .toThrow(/does not match/)
    expect(() => analyzeVideoScopes(
      new Uint8ClampedArray((VIDEO_SCOPE_MAX_PIXELS + 1) * 4),
      VIDEO_SCOPE_MAX_PIXELS + 1,
      1,
    )).toThrow(/limited/)
  })
})
