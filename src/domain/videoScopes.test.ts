import { describe, expect, test } from 'vitest'
import {
  analyzeVideoScopes,
  VIDEO_SCOPE_MAX_PIXELS,
  VIDEO_SCOPE_VECTOR_SIZE,
  VIDEO_SCOPE_WAVEFORM_HEIGHT,
} from './videoScopes'

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
