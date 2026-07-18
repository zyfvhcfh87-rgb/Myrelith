/**
 * pipeline/visuals.test.ts — the pure math under the clip visuals.
 *
 * The async generators need WebCodecs + real media files, so they are
 * browser-verified (jsdom has neither); everything they lean on —
 * timestamp layout, width clamping, peak folding, waveform drawing — is
 * unit-tested here with plain data and a recording 2D-context stub.
 */

import { describe, expect, test } from 'vitest'
import {
  MediaVisualSourceError,
  accumulatePeaks,
  filmstripTimestamps,
  waveformPath,
  waveformWidth,
  WAVEFORM_HEIGHT,
} from './visuals'

describe('MediaVisualSourceError', () => {
  test('retains the pre-track Input construction cause', () => {
    const cause = new Error('source setup failed')
    const error = new MediaVisualSourceError(cause)

    expect(error.message).toBe(cause.message)
    expect(error.cause).toBe(cause)
  })
})

describe('filmstripTimestamps', () => {
  test('one tile per ~2s, sampled at bucket midpoints', () => {
    const ts = filmstripTimestamps(8) // 4 tiles of 2s
    expect(ts).toEqual([1, 3, 5, 7])
  })

  test('short files still get one tile, at their midpoint', () => {
    expect(filmstripTimestamps(0.5)).toEqual([0.25])
  })

  test('long files cap at 48 tiles and stay evenly spread', () => {
    const ts = filmstripTimestamps(600) // 10 min → 48, not 300
    expect(ts).toHaveLength(48)
    expect(ts[0]).toBeCloseTo(600 / 48 / 2)
    expect(ts[47]).toBeCloseTo(600 - 600 / 48 / 2)
  })

  test('zero, negative and non-finite durations yield no tiles', () => {
    expect(filmstripTimestamps(0)).toEqual([])
    expect(filmstripTimestamps(-3)).toEqual([])
    expect(filmstripTimestamps(Number.NaN)).toEqual([])
  })
})

describe('waveformWidth', () => {
  test('100 px per second between the clamps', () => {
    expect(waveformWidth(8)).toBe(800)
  })

  test('clamps: floor for blips, ceiling for hours', () => {
    expect(waveformWidth(0.01)).toBe(16)
    expect(waveformWidth(3600)).toBe(16000)
  })

  test('invalid durations yield 0 (no image)', () => {
    expect(waveformWidth(0)).toBe(0)
    expect(waveformWidth(Number.NaN)).toBe(0)
  })
})

describe('accumulatePeaks', () => {
  test('samples land in their time-mapped columns as max |value|', () => {
    const peaks = new Float32Array(4) // 4 columns over 4 seconds
    // 1 Hz "sample rate": one sample per second at t = 0, 1, 2, 3.
    accumulatePeaks(peaks, new Float32Array([0.5, -0.8, 0.1, 0]), 1, 0, 4)
    // float32 storage: compare with tolerance, not exact doubles
    expect(Array.from(peaks)).toEqual([
      0.5,
      expect.closeTo(0.8),
      expect.closeTo(0.1),
      0,
    ])
  })

  test('later chunks fold in at their own offset; max wins per column', () => {
    const peaks = new Float32Array(4)
    accumulatePeaks(peaks, new Float32Array([0.2, 0.2]), 1, 0, 4) // t=0,1
    accumulatePeaks(peaks, new Float32Array([0.9, 0.1]), 1, 1, 4) // t=1,2
    expect(Array.from(peaks)).toEqual([
      expect.closeTo(0.2),
      expect.closeTo(0.9),
      expect.closeTo(0.1),
      0,
    ])
  })

  test('samples past the reported duration clamp into the last column', () => {
    const peaks = new Float32Array(2)
    accumulatePeaks(peaks, new Float32Array([0.7]), 1, 99, 2) // way past 2s
    expect(peaks[1]).toBeCloseTo(0.7)
  })

  test('empty peaks / zero duration / zero rate are safe no-ops', () => {
    expect(() =>
      accumulatePeaks(new Float32Array(0), new Float32Array([1]), 48000, 0, 10),
    ).not.toThrow()
    const peaks = new Float32Array(2)
    accumulatePeaks(peaks, new Float32Array([1]), 48000, 0, 0)
    accumulatePeaks(peaks, new Float32Array([1]), 0, 0, 10)
    expect(Array.from(peaks)).toEqual([0, 0])
  })
})

describe('waveformPath', () => {
  test('builds a closed, linearly connected silhouette with true amplitude', () => {
    expect(waveformPath(new Float32Array([1, 0.5, 0.25]), WAVEFORM_HEIGHT)).toBe(
      'M0 0L1 11L2 16.5L3 16.5L3 27.5L2 27.5L1 33L0 44Z',
    )
  })

  test('keeps silence visible and rejects invalid geometry', () => {
    expect(waveformPath(new Float32Array([0]), WAVEFORM_HEIGHT)).toBe(
      'M0 21.5L1 21.5L1 22.5L0 22.5Z',
    )
    expect(waveformPath(new Float32Array([1.7]), WAVEFORM_HEIGHT)).toBe(
      'M0 0L1 0L1 44L0 44Z',
    )
    expect(waveformPath(new Float32Array(), WAVEFORM_HEIGHT)).toBe('')
    expect(waveformPath(new Float32Array([1]), 0)).toBe('')
  })
})
