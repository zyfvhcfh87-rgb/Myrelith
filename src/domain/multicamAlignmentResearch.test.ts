import { describe, expect, test } from 'vitest'
import {
  ALIGNMENT_RESEARCH_LIMITS as LIMITS,
  correlateResearchFingerprints,
  createResearchFingerprintBuilder,
  researchLagToOffsetFrames,
  type ResearchAudioFingerprint,
} from './multicamAlignmentResearch'
import {
  createResearchAudioFixture as fixture,
  runResearchCorrelation as correlate,
} from './multicamAlignmentResearchFixtures'

const F30 = { num: 30, den: 1 }
const mono = { inputSampleRate: 8_000, channels: 1, startSample: 0, binCount: 1_000 }

describe('Issue 194 streaming energy proof', () => {
  test('is independent of PCM block boundaries and never keeps borrowed PCM', () => {
    const wholeBlocks = fixture({ inputSampleRate: 44_100, durationSeconds: 5 })
    const uneven = fixture({ inputSampleRate: 44_100, durationSeconds: 5, blockFrames: 137 })
    expect(uneven).toEqual(wholeBlocks)
    expect(uneven.values.byteOffset).toBe(0)
    expect(uneven.values.buffer.byteLength).toBe(4_000)

    const builder = createResearchFingerprintBuilder(mono)
    const plane = new Float32Array(40).fill(0.125)
    for (let index = 0; index < 1_000; index++) builder.push([plane], index * 40)
    plane.fill(0)
    expect([...builder.finish().values].every((value) => Math.abs(value - Math.log1p(125)) < 1e-6)).toBe(true)
    expect(() => builder.finish()).toThrow(/terminal/)
    expect(() => builder.push([plane], 40_000)).toThrow(/terminal/)
  })

  test('averages channel energy without cancelling opposite stereo polarity', () => {
    const single = fixture({ inputSampleRate: 8_000, durationSeconds: 5 })
    const stereo = fixture({ inputSampleRate: 8_000, durationSeconds: 5, channels: 2, invertRightChannel: true })
    expect(stereo.values).toEqual(single.values)
    expect(correlate(single, stereo).result).toMatchObject({ state: 'aligned', offsetFrames: 0 })
  })

  test.each([
    { inputSampleRate: 7_999 }, { inputSampleRate: 96_001 }, { inputSampleRate: 44_100.5 },
    { channels: 0 }, { channels: 3 }, { binCount: 999 }, { binCount: 6_001 },
    { binCount: 1_000.5 }, { startSample: -1 }, { startSample: 86_400 * 8_000 },
    { startSample: Number.MAX_SAFE_INTEGER },
  ])('rejects the window before allocating outside its envelope: %j', (patch) => {
    expect(() => createResearchFingerprintBuilder({ ...mono, ...patch })).toThrow(RangeError)
  })

  test('copies admitted request facts before a caller can alter them', () => {
    const request = { ...mono }
    const builder = createResearchFingerprintBuilder(request)
    request.startSample = 123
    request.channels = 3
    for (let index = 0; index < 40_000; index += 4_000) {
      builder.push([new Float32Array(4_000)], index)
    }
    expect(builder.finish()).toMatchObject({ startSample: 0, channels: 1, sourceSampleCount: 40_000 })
  })

  test('rejects discontinuity, missing channels, and oversized blocks terminally', () => {
    for (const [planes, start] of [
      [[new Float32Array(100)], 1],
      [[new Float32Array(4_097)], 0],
      [[new Float32Array(100), new Float32Array(99)], 0],
      [[], 0],
    ] as const) {
      const builder = createResearchFingerprintBuilder(mono)
      expect(() => builder.push(planes, start)).toThrow(/continuous/)
      expect(() => builder.finish()).toThrow(/terminal/)
    }
  })

  test.each([NaN, Infinity, -Infinity, 17])('rejects invalid PCM %s and drops partial features', (value) => {
    const builder = createResearchFingerprintBuilder(mono)
    const plane = new Float32Array(100).fill(0.1)
    plane[99] = value
    expect(() => builder.push([plane], 0)).toThrow(/PCM contains/)
    expect(() => builder.finish()).toThrow(/terminal/)
  })

  test('requires full continuous coverage instead of padding a truncated decode', () => {
    const builder = createResearchFingerprintBuilder(mono)
    builder.push([new Float32Array(100)], 0)
    expect(() => builder.finish()).toThrow(/complete selected window/)
    expect(() => builder.push([new Float32Array(100)], 100)).toThrow(/terminal/)
  })
})

describe('Issue 194 bounded correlation quality', () => {
  test.each(['coded-tone', 'speech-shaped', 'noise'] as const)(
    'resolves signed subsecond offsets in %s within one project frame', (kind) => {
      const reference = fixture({ kind, inputSampleRate: 8_000 })
      for (const seconds of [-1.235, 0, 0.765]) {
        const target = fixture({ kind, inputSampleRate: 8_000, recordingStartSeconds: seconds })
        const { result } = correlate(reference, target)
        expect(result.state, JSON.stringify(result)).toBe('aligned')
        if (result.state !== 'aligned') throw new Error('Expected a measured alignment')
        expect(Math.abs(result.offsetFrames - Math.round(seconds * 30))).toBeLessThanOrEqual(1)
        expect(result.facts.score).toBeGreaterThanOrEqual(LIMITS.minScore)
        expect(result.facts.margin).toBeGreaterThanOrEqual(LIMITS.minMargin)
      }
    },
  )

  test.each([
    { num: 24, den: 1 }, { num: 25, den: 1 }, { num: 30, den: 1 },
    { num: 48, den: 1 }, { num: 50, den: 1 }, { num: 60, den: 1 },
    { num: 24_000, den: 1_001 }, { num: 30_000, den: 1_001 }, { num: 60_000, den: 1_001 },
  ])('keeps the declared tolerance at project rate %j', (rate) => {
    const reference = fixture({ inputSampleRate: 8_000 })
    const target = fixture({ inputSampleRate: 8_000, recordingStartSeconds: 0.237 })
    const { result } = correlate(reference, target, rate)
    expect(result.state, JSON.stringify(result)).toBe('aligned')
    if (result.state !== 'aligned') throw new Error('Expected alignment')
    expect(Math.abs(result.offsetFrames - Math.round(0.237 * rate.num / rate.den))).toBeLessThanOrEqual(1)
  })

  test('preserves nonzero source-window origins across different decode rates and gain', () => {
    const reference = fixture({ inputSampleRate: 44_100, startSeconds: 70, durationSeconds: 20 })
    const target = fixture({
      inputSampleRate: 48_000, channels: 2, invertRightChannel: true, gain: 0.25,
      startSeconds: 72, recordingStartSeconds: 1.25, durationSeconds: 15,
    })
    const { result } = correlate(reference, target)
    expect(result.state, JSON.stringify(result)).toBe('aligned')
    if (result.state !== 'aligned') throw new Error('Expected alignment')
    expect(Math.abs(result.offsetFrames - 38)).toBeLessThanOrEqual(1)
    expect(result.facts.overlapBins).toBeGreaterThanOrEqual(3_000 * LIMITS.minOverlapRatio)
  })

  test.each(['silence', 'steady-tone', 'repeated'] as const)('never proposes an offset for %s', (kind) => {
    const reference = fixture({ kind, inputSampleRate: 8_000 })
    const target = fixture({ kind, inputSampleRate: 8_000, recordingStartSeconds: 0.3 })
    const { result } = correlate(reference, target)
    expect(result.state).not.toBe('aligned')
    expect(result).not.toHaveProperty('offsetFrames')
  })

  test('names repeated matches even when the best correlation is nearly perfect', () => {
    const reference = fixture({ kind: 'repeated', inputSampleRate: 8_000 })
    const { result } = correlate(reference, reference)
    expect(result).toMatchObject({ state: 'ambiguous', reason: 'repeated-match' })
    expect(result.facts.score).toBeGreaterThan(0.99)
  })

  test('rejects unrelated recordings instead of returning the least bad offset', () => {
    const { result } = correlate(
      fixture({ kind: 'noise', inputSampleRate: 8_000 }),
      fixture({ kind: 'noise', inputSampleRate: 8_000, seed: 593 }),
    )
    expect(result).toMatchObject({ state: 'unavailable', reason: 'weak-match' })
    expect(result).not.toHaveProperty('offsetFrames')
  })

  test('rejects a peak at the search boundary', () => {
    const reference = fixture({ inputSampleRate: 8_000, durationSeconds: 20 })
    const target = fixture({ inputSampleRate: 8_000, durationSeconds: 20, recordingStartSeconds: 5 })
    expect(correlate(reference, target).result).toMatchObject({ state: 'unavailable', reason: 'search-boundary' })
  })

  test('bounds worst-case work and every cooperative cancellation interval', () => {
    const reference = fixture({ inputSampleRate: 8_000, durationSeconds: 30 })
    const { result, yields, maxWorkBetweenYields } = correlate(reference, reference)
    expect(result).toMatchObject({ state: 'aligned', offsetFrames: 0 })
    expect(result.facts.comparisons).toBeLessThanOrEqual(LIMITS.maxPairComparisons)
    expect(result.facts.evaluatedLags).toBe(2_001)
    expect(maxWorkBetweenYields).toBeLessThanOrEqual(LIMITS.yieldComparisons)
    expect(yields).toBeGreaterThan(1_000)
    expect(reference.values.byteLength * 8).toBe(192_000)
  })

  test('can close at the first checkpoint without evaluating the remaining search', () => {
    const reference = fixture({ inputSampleRate: 8_000 })
    const iterator = correlateResearchFingerprints(reference, reference, F30)
    for (const progress of iterator) {
      expect(progress.comparisons).toBe(LIMITS.yieldComparisons)
      break
    }
    expect(iterator.next()).toEqual({ done: true, value: undefined })
    expect(reference.values.byteLength).toBe(8_000)
  })

  test('rejects malformed features, pinned oversized buffers, and altered sample provenance', () => {
    const reference = fixture({ inputSampleRate: 8_000, durationSeconds: 5 })
    const nonFinite = new Float32Array(reference.values)
    nonFinite[5] = NaN
    for (const patch of [
      { kind: 'other' }, { sourceSampleCount: 1 }, { startSample: -1 },
      { channels: 3 }, { values: nonFinite }, { values: new Float32Array(6_001) },
      { values: new Float32Array(10_000).subarray(0, 1_000) },
    ]) {
      const invalid = { ...reference, ...patch } as ResearchAudioFingerprint
      expect(correlate(reference, invalid).result).toMatchObject({ state: 'unavailable', reason: 'invalid-input' })
    }
    for (const maxLag of [0, 199, 1_001, NaN, 200.5]) {
      expect(correlate(reference, reference, F30, maxLag).result).toMatchObject({ reason: 'invalid-input' })
    }
    expect(correlate(reference, reference, { num: 120, den: 1 }).result).toMatchObject({ reason: 'invalid-input' })
  })
})

describe('Issue 194 exact signed offset projection', () => {
  const zero = { startSample: 0, inputSampleRate: 48_000 }

  test('rounds ties away from zero and keeps reference exchange symmetric', () => {
    expect(researchLagToOffsetFrames(zero, zero, -10, F30)).toBe(2)
    expect(researchLagToOffsetFrames(zero, zero, 10, F30)).toBe(-2)
    const start = { startSample: 79_999 * 44_100 + 1, inputSampleRate: 44_100 }
    const other = { startSample: 79_998 * 48_000 + 19, inputSampleRate: 48_000 }
    const rate = { num: 30_000, den: 1_001 }
    const forward = researchLagToOffsetFrames(start, other, 87, rate)
    expect(forward).toBe(17)
    expect(researchLagToOffsetFrames(other, start, -87, rate)).toBe(-forward)
  })

  test('rejects invalid conversion inputs before BigInt conversion', () => {
    expect(() => researchLagToOffsetFrames(zero, zero, 1.1, F30)).toThrow(RangeError)
    expect(() => researchLagToOffsetFrames({ ...zero, startSample: Infinity }, zero, 0, F30)).toThrow(RangeError)
    expect(() => researchLagToOffsetFrames(zero, zero, 0, { num: 30, den: 0 })).toThrow(RangeError)
  })
})
