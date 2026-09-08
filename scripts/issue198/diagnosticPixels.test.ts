import { describe, expect, test } from 'vitest'
import { compositeReferenceOverBlack, DiagnosticPixelOwner, DiagnosticWorkOwner, DIAGNOSTIC_WORK_LIMITS, MAX_DIAGNOSTIC_PIXEL_BYTES, pixelErrors } from './diagnosticPixels'

describe('diagnostic statistics', () => {
  test('preserves the frozen max failure even when the mean passes; partitions every RGB channel', () => {
    const expected = new Uint8ClampedArray(4 * 20).fill(0), actual = expected.slice()
    expected[3] = 255; expected[7] = 128
    actual[0] = 19; actual[4] = 3; actual[8] = 2
    const result = pixelErrors(actual, expected, 20, 1)
    expect(result.maximumDelta).toBe(19)
    expect(result.meanDelta).toBe(24 / 60)
    expect(result.originalTolerance.satisfied).toBe(false)
    expect(result.histogram[0]).toBe(57)
    expect(result.histogram.reduce((a, b) => a + b)).toBe(60)
    expect(result.regions.opaque.totalAbsoluteDelta).toBe(19)
    expect(result.regions.feather.totalAbsoluteDelta).toBe(3)
    expect(result.regions.outside.totalAbsoluteDelta).toBe(2)
    expect(result.firstAbove12).toEqual([{ x: 0, y: 0, channel: 0, actual: 19, expected: 0, delta: 19, region: 'opaque' }])
  })
  test('keeps exact aggregate counts when coordinate evidence is capped', () => {
    const expected = new Uint8ClampedArray(100 * 4), actual = new Uint8ClampedArray(100 * 4).fill(19)
    const result = pixelErrors(actual, expected, 100, 1)
    expect(result.above12).toBe(300)
    expect(result.maximumCount).toBe(300)
    expect(result.firstAbove12).toHaveLength(64)
    expect(result.maximumCoordinates).toHaveLength(64)
  })
  test('black compositing rounds RGB while retaining alpha for region classification', () => {
    const pixels = new Uint8ClampedArray([191, 127, 64, 128, 200, 100, 50, 0])
    compositeReferenceOverBlack(pixels)
    expect([...pixels]).toEqual([96, 64, 32, 128, 0, 0, 0, 0])
  })
  test('rejects invalid extents and closes all actual caller-owned arrays once', () => {
    expect(() => pixelErrors(new Uint8ClampedArray(4), new Uint8ClampedArray(4), 2, 1)).toThrow('extent')
    const owner = new DiagnosticPixelOwner(), pixels = owner.own(new Uint8ClampedArray([9, 8, 7, 6]))
    expect(() => owner.own(pixels)).toThrow('already owned')
    owner.close(); expect([...pixels]).toEqual([0, 0, 0, 0])
    expect(owner.snapshot()).toMatchObject({ bytes: 0, buffers: 0, allocations: 1, releases: 1, peakBytes: 4 })
    expect(() => owner.release(pixels)).toThrow('twice')
  })
  test('rejects an oversized allocation before its factory can allocate any pixels', () => {
    const owner = new DiagnosticPixelOwner()
    let called = false
    expect(() => owner.create(MAX_DIAGNOSTIC_PIXEL_BYTES + 1, () => { called = true; return new Uint8ClampedArray(1) })).toThrow('before allocation')
    expect(called).toBe(false)
    expect(owner.snapshot().peakBytes).toBe(0)
  })
  test('caps the exact740 requests, six candidates and one composite without expanding on failure', () => {
    const owner = new DiagnosticWorkOwner()
    expect(() => owner.assertComplete()).toThrow('did not complete')
    for (const kind of Object.keys(DIAGNOSTIC_WORK_LIMITS) as (keyof typeof DIAGNOSTIC_WORK_LIMITS)[]) {
      for (let i = 0; i < DIAGNOSTIC_WORK_LIMITS[kind]; i++) owner.claim(kind)
      expect(() => owner.claim(kind)).toThrow('cap exceeded')
    }
    owner.assertComplete()
    expect(owner.snapshot()).toMatchObject({ publicSampleAndSourceRequests: 740, composite: 1, candidate: 6 })
  })
})
