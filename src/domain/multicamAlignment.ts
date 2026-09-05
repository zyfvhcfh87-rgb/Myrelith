/**
 * Bounded local audio alignment, approved in docs/MULTICAM_ALIGNMENT.md.
 * This consumes decoded PCM, owns no browser resource, and never edits a project.
 */
import type { FrameRate } from './schema'

export const MULTICAM_ALIGNMENT_LIMITS = Object.freeze({
  featureRate: 200,
  minBins: 1_000,
  maxBins: 6_000,
  minInputRate: 8_000,
  maxInputRate: 96_000,
  maxChannels: 2,
  maxBlockFrames: 4_096,
  maxSourceSeconds: 86_400,
  minLagBins: 200,
  maxLagBins: 1_000,
  minOverlapBins: 600,
  minOverlapRatio: 0.6,
  minScore: 0.8,
  minMargin: 0.06,
  minFeatureDeviation: 0.005,
  minMeanFeature: Math.log1p(1_000 * 0.0001),
  maxFeature: Math.log1p(1_000 * 16),
  maxPairComparisons: 12_006_000,
  yieldComparisons: 4_096,
})

const RATES = new Set([
  '24/1', '25/1', '30/1', '48/1', '50/1', '60/1',
  '24000/1001', '30000/1001', '60000/1001',
])

export function alignmentRateIsSupported(rate: FrameRate): boolean {
  return rate !== null && typeof rate === 'object'
    && typeof rate.num === 'number' && typeof rate.den === 'number'
    && RATES.has(`${rate.num}/${rate.den}`)
}

export interface AudioFingerprintRequest {
  readonly inputSampleRate: number
  readonly channels: number
  /** Index in the proven source-presentation sample grid, not a decoder-local cursor. */
  readonly startSample: number
  readonly binCount: number
}

export interface AudioFingerprint {
  readonly kind: 'log-rms-200-v1'
  readonly inputSampleRate: number
  readonly channels: number
  readonly startSample: number
  readonly sourceSampleCount: number
  readonly values: Float32Array<ArrayBuffer>
}

export interface AudioFingerprintBuilder {
  /** Consecutive, aligned planar PCM. The caller retains and closes its own block. */
  push(channels: readonly Float32Array[], firstSample: number): void
  /** Transfers the derived feature buffer exactly once; no PCM is retained. */
  finish(): AudioFingerprint
}

function validRequest(request: AudioFingerprintRequest): boolean {
  const limits = MULTICAM_ALIGNMENT_LIMITS
  return Number.isSafeInteger(request.inputSampleRate)
    && request.inputSampleRate >= limits.minInputRate
    && request.inputSampleRate <= limits.maxInputRate
    && Number.isSafeInteger(request.channels)
    && request.channels >= 1 && request.channels <= limits.maxChannels
    && Number.isSafeInteger(request.binCount)
    && request.binCount >= limits.minBins && request.binCount <= limits.maxBins
    && Number.isSafeInteger(request.startSample) && request.startSample >= 0
    && request.startSample + Math.ceil(request.binCount * request.inputSampleRate / limits.featureRate)
      <= limits.maxSourceSeconds * request.inputSampleRate
}

export function createAudioFingerprintBuilder(
  request: AudioFingerprintRequest,
): AudioFingerprintBuilder {
  if (!validRequest(request)) throw new RangeError('Invalid bounded audio window')
  // Copy primitive request facts: a caller mutation cannot change an admitted job.
  const { inputSampleRate, channels, startSample, binCount } = request
  const { featureRate, maxBlockFrames } = MULTICAM_ALIGNMENT_LIMITS
  const expectedSamples = Math.ceil(binCount * inputSampleRate / featureRate)
  let values: Float32Array<ArrayBuffer> | null = new Float32Array(binCount)
  let processed = 0
  let currentBin = 0
  let binEnergy = 0
  let binSamples = 0
  let failed = false

  const finishBin = (): void => {
    values![currentBin] = Math.log1p(1_000 * Math.sqrt(binEnergy / binSamples))
    binEnergy = 0
    binSamples = 0
  }

  return {
    push(planes, firstSample) {
      if (!values || failed) throw new Error('Audio fingerprint owner is terminal')
      const length = planes[0]?.length ?? 0
      if (
        planes.length !== channels || length < 1 || length > maxBlockFrames
        || planes.some((plane) => !(plane instanceof Float32Array) || plane.length !== length)
        || firstSample !== startSample + processed || processed + length > expectedSamples
      ) {
        failed = true
        values = null
        throw new RangeError('PCM must be bounded, continuous, and channel-aligned')
      }
      for (let index = 0; index < length; index++) {
        const nextBin = Math.floor(processed * featureRate / inputSampleRate)
        if (nextBin !== currentBin) {
          finishBin()
          currentBin = nextBin
        }
        let energy = 0
        for (const plane of planes) {
          const sample = plane[index]
          if (!Number.isFinite(sample) || Math.abs(sample) > 16) {
            failed = true
            values = null
            throw new RangeError('PCM contains a non-finite or out-of-envelope sample')
          }
          energy += sample * sample
        }
        binEnergy += energy / channels
        binSamples++
        processed++
      }
    },
    finish() {
      if (!values || failed) throw new Error('Audio fingerprint owner is terminal')
      if (processed !== expectedSamples) {
        failed = true
        values = null
        throw new RangeError('PCM does not cover the complete selected window')
      }
      finishBin()
      const result: AudioFingerprint = {
        kind: 'log-rms-200-v1', inputSampleRate, channels, startSample,
        sourceSampleCount: expectedSamples, values,
      }
      values = null
      return result
    },
  }
}

export function audioFingerprintIsValid(fingerprint: AudioFingerprint): boolean {
  if (!fingerprint || typeof fingerprint !== 'object') return false
  const values = fingerprint.values
  return fingerprint.kind === 'log-rms-200-v1'
    && values instanceof Float32Array
    && values.buffer instanceof ArrayBuffer
    && values.byteOffset === 0 && values.byteLength === values.buffer.byteLength
    && validRequest({ ...fingerprint, binCount: values.length })
    && fingerprint.sourceSampleCount === Math.ceil(
      values.length * fingerprint.inputSampleRate / MULTICAM_ALIGNMENT_LIMITS.featureRate,
    )
    && values.every((value) => (
      Number.isFinite(value) && value >= 0 && value <= MULTICAM_ALIGNMENT_LIMITS.maxFeature + 1e-6
    ))
}

/** Stable little-endian bytes, used only by the disposable cache. */
export function encodeAudioFingerprint(fingerprint: AudioFingerprint): Uint8Array<ArrayBuffer> {
  if (!audioFingerprintIsValid(fingerprint)) throw new TypeError('Invalid audio fingerprint')
  const bytes = new Uint8Array(fingerprint.values.length * 4)
  const view = new DataView(bytes.buffer)
  fingerprint.values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}

export function decodeAudioFingerprint(
  identity: AudioFingerprintRequest & { readonly sourceSampleCount: number },
  bytes: Uint8Array<ArrayBuffer>,
): AudioFingerprint {
  if (!validRequest(identity) || bytes.byteLength !== identity.binCount * 4
    || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
    throw new TypeError('Invalid cached audio feature length or coverage')
  }
  const view = new DataView(bytes.buffer)
  const values = Float32Array.from({ length: identity.binCount }, (_, i) => view.getFloat32(i * 4, true))
  const fingerprint: AudioFingerprint = {
    kind: 'log-rms-200-v1', values, inputSampleRate: identity.inputSampleRate,
    channels: identity.channels, startSample: identity.startSample,
    sourceSampleCount: identity.sourceSampleCount,
  }
  if (!audioFingerprintIsValid(fingerprint)) throw new TypeError('Invalid cached audio features')
  return fingerprint
}

export interface AudioCorrelationFacts {
  readonly score: number | null
  readonly alternativeScore: number | null
  readonly margin: number | null
  readonly overlapBins: number
  readonly evaluatedLags: number
  readonly comparisons: number
}

export type AudioAlignmentResult =
  | {
      readonly state: 'aligned'
      readonly offsetFrames: number
      readonly lagBins: number
      readonly facts: AudioCorrelationFacts
    }
  | {
      readonly state: 'ambiguous' | 'unavailable'
      readonly reason: 'invalid-input' | 'silent-or-flat' | 'insufficient-overlap'
        | 'weak-match' | 'repeated-match' | 'search-boundary'
      readonly facts: AudioCorrelationFacts
    }

export interface AudioCorrelationProgress {
  readonly comparisons: number
  readonly evaluatedLags: number
}

function informative(values: Float32Array): boolean {
  let sum = 0
  let squared = 0
  for (const value of values) {
    sum += value
    squared += value * value
  }
  const mean = sum / values.length
  return mean >= MULTICAM_ALIGNMENT_LIMITS.minMeanFeature
    && squared / values.length - mean * mean
      >= MULTICAM_ALIGNMENT_LIMITS.minFeatureDeviation ** 2
}

function signedRoundedRatio(numerator: bigint, denominator: bigint): number {
  const magnitude = numerator < 0n ? -numerator : numerator
  const rounded = (2n * magnitude + denominator) / (2n * denominator)
  return Number(numerator < 0n ? -rounded : rounded)
}

/** Exact window-origin arithmetic; only the final project frame is rounded. */
export function audioLagToOffsetFrames(
  reference: Pick<AudioFingerprint, 'startSample' | 'inputSampleRate'>,
  target: Pick<AudioFingerprint, 'startSample' | 'inputSampleRate'>,
  lagBins: number,
  rate: FrameRate,
): number {
  for (const source of [reference, target]) {
    if (
      !Number.isSafeInteger(source.inputSampleRate)
      || source.inputSampleRate < MULTICAM_ALIGNMENT_LIMITS.minInputRate
      || source.inputSampleRate > MULTICAM_ALIGNMENT_LIMITS.maxInputRate
      || !Number.isSafeInteger(source.startSample) || source.startSample < 0
      || source.startSample > MULTICAM_ALIGNMENT_LIMITS.maxSourceSeconds * source.inputSampleRate
    ) throw new RangeError('Invalid source sample origin')
  }
  if (
    !alignmentRateIsSupported(rate) || !Number.isSafeInteger(lagBins)
    || Math.abs(lagBins) > MULTICAM_ALIGNMENT_LIMITS.maxLagBins
  ) throw new RangeError('Invalid audio alignment frame conversion')
  const refRate = BigInt(reference.inputSampleRate)
  const targetRate = BigInt(target.inputSampleRate)
  const featureRate = BigInt(MULTICAM_ALIGNMENT_LIMITS.featureRate)
  const numerator = (
    BigInt(reference.startSample) * targetRate * featureRate
    - BigInt(target.startSample) * refRate * featureRate
    - BigInt(lagBins) * refRate * targetRate
  ) * BigInt(rate.num)
  return signedRoundedRatio(numerator, refRate * targetRate * featureRate * BigInt(rate.den))
}

/**
 * Borrow immutable derived buffers for this iterator's lifetime. The host checks
 * cancellation between yields and closes the iterator before releasing them.
 * Yielding is data-only; scheduling and AbortSignal ownership belong to app/worker.
 */
export function* correlateAudioFingerprints(
  reference: AudioFingerprint,
  target: AudioFingerprint,
  rate: FrameRate,
  maxLagBins: number = MULTICAM_ALIGNMENT_LIMITS.maxLagBins,
): Generator<AudioCorrelationProgress, AudioAlignmentResult> {
  const limits = MULTICAM_ALIGNMENT_LIMITS
  const emptyFacts: AudioCorrelationFacts = {
    score: null, alternativeScore: null, margin: null, overlapBins: 0,
    evaluatedLags: 0, comparisons: 0,
  }
  if (
    !audioFingerprintIsValid(reference) || !audioFingerprintIsValid(target)
    || !alignmentRateIsSupported(rate) || !Number.isSafeInteger(maxLagBins)
    || maxLagBins < limits.minLagBins || maxLagBins > limits.maxLagBins
  ) return { state: 'unavailable', reason: 'invalid-input', facts: emptyFacts }
  if (!informative(reference.values) || !informative(target.values)) {
    return { state: 'unavailable', reason: 'silent-or-flat', facts: emptyFacts }
  }
  const a = reference.values
  const b = target.values
  const minimumOverlap = Math.max(
    limits.minOverlapBins, Math.ceil(Math.min(a.length, b.length) * limits.minOverlapRatio),
  )
  const scores = new Float64Array(2 * maxLagBins + 1).fill(-Infinity)
  let comparisons = 0
  let evaluatedLags = 0
  let bestScore = -Infinity
  let bestLag = 0
  let bestOverlap = 0
  for (let lag = -maxLagBins; lag <= maxLagBins; lag++) {
    const start = Math.max(0, -lag)
    const end = Math.min(a.length, b.length - lag)
    const count = end - start
    if (count < minimumOverlap) continue
    let sumA = 0
    let sumB = 0
    let squareA = 0
    let squareB = 0
    let product = 0
    for (let index = start; index < end; index++) {
      const av = a[index]
      const bv = b[index + lag]
      sumA += av
      sumB += bv
      squareA += av * av
      squareB += bv * bv
      product += av * bv
      comparisons++
      if (comparisons % limits.yieldComparisons === 0) yield { comparisons, evaluatedLags }
    }
    evaluatedLags++
    const varianceA = squareA - sumA * sumA / count
    const varianceB = squareB - sumB * sumB / count
    if (
      varianceA / count < limits.minFeatureDeviation ** 2
      || varianceB / count < limits.minFeatureDeviation ** 2
      || sumA / count < limits.minMeanFeature || sumB / count < limits.minMeanFeature
    ) continue
    const score = Math.max(-1, Math.min(1,
      (product - sumA * sumB / count) / Math.sqrt(varianceA * varianceB),
    ))
    scores[lag + maxLagBins] = score
    if (
      score > bestScore
      || (score === bestScore && Math.abs(lag) < Math.abs(bestLag))
    ) {
      bestScore = score
      bestLag = lag
      bestOverlap = count
    }
  }
  if (!Number.isFinite(bestScore)) return {
    state: 'unavailable', reason: 'insufficient-overlap',
    facts: { ...emptyFacts, evaluatedLags, comparisons },
  }
  // Adjacent lag estimates within one project frame are the same tolerance neighborhood.
  const neighborhood = Math.floor(limits.featureRate * rate.den / rate.num)
  let alternativeScore = -1
  for (let lag = -maxLagBins; lag <= maxLagBins; lag++) {
    if (Math.abs(lag - bestLag) > neighborhood) {
      alternativeScore = Math.max(alternativeScore, scores[lag + maxLagBins])
    }
  }
  const facts: AudioCorrelationFacts = {
    score: bestScore, alternativeScore, margin: bestScore - alternativeScore,
    overlapBins: bestOverlap, evaluatedLags, comparisons,
  }
  if (bestScore < limits.minScore) return { state: 'unavailable', reason: 'weak-match', facts }
  if (facts.margin! < limits.minMargin) return { state: 'ambiguous', reason: 'repeated-match', facts }
  if (Math.abs(bestLag) === maxLagBins) return { state: 'unavailable', reason: 'search-boundary', facts }
  return {
    state: 'aligned', lagBins: bestLag,
    offsetFrames: audioLagToOffsetFrames(reference, target, bestLag, rate), facts,
  }
}
