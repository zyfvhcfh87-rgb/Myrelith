/** Proposed cache-key framing for Issue #194. This registers/writes no cache schema. */
import type { AnalysisSourceFingerprint } from './analysisCache'
import { isLocalProjectBindingId } from './localProjectBinding'
import type { FrameRate } from './schema'
import { ALIGNMENT_RESEARCH_LIMITS as LIMITS, alignmentResearchRateIsSupported } from './multicamAlignmentResearch'

export interface ResearchAudioFeatureIdentity {
  readonly projectBindingId: string
  readonly assetId: string
  readonly sourceFingerprint: AnalysisSourceFingerprint
  readonly audioStreamIndex: number
  readonly audioTrackId: string
  /** Exact codec config, decoder implementation/version, priming and timestamp policy. */
  readonly decodePolicyDigest: string
  readonly timestampOrigin: 'source-presentation-zero-continuous-v1'
  readonly inputSampleRate: number
  readonly channels: number
  readonly startSample: number
  readonly sourceSampleCount: number
  readonly binCount: number
}

export interface ResearchAudioPairIdentity {
  readonly referenceFeatureKey: string
  readonly targetFeatureKey: string
  readonly projectRate: FrameRate
  readonly maxLagBins: number
  /** Exact definition, ordered angle selection, placement and source-coverage snapshot. */
  readonly definitionDigest: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value)
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

/** Exact ordered JSON tuple. A future app owner hashes its UTF-8 bytes with SHA-256. */
export function researchAudioFeatureKeyPreimage(value: unknown): string {
  if (!record(value) || !exactKeys(value, [
    'projectBindingId', 'assetId', 'sourceFingerprint', 'audioStreamIndex', 'audioTrackId',
    'decodePolicyDigest', 'timestampOrigin', 'inputSampleRate', 'channels',
    'startSample', 'sourceSampleCount', 'binCount',
  ])) throw new TypeError('Invalid research audio feature identity')
  const source = value.sourceFingerprint
  if (
    !isLocalProjectBindingId(value.projectBindingId)
    || !boundedString(value.assetId, 256) || !boundedString(value.audioTrackId, 256)
    || !record(source) || !exactKeys(source, ['algorithm', 'digest', 'fileName', 'size', 'lastModified'])
    || source.algorithm !== 'sha256-sampled-v1' || !digest(source.digest)
    || !boundedString(source.fileName, 4_096) || !integer(source.size, 0, Number.MAX_SAFE_INTEGER)
    || !integer(source.lastModified, 0, 8_640_000_000_000_000)
    || !integer(value.audioStreamIndex, 0, 255) || !digest(value.decodePolicyDigest)
    || value.timestampOrigin !== 'source-presentation-zero-continuous-v1'
    || !integer(value.inputSampleRate, LIMITS.minInputRate, LIMITS.maxInputRate)
    || !integer(value.channels, 1, LIMITS.maxChannels)
    || !integer(value.startSample, 0, LIMITS.maxSourceSeconds * value.inputSampleRate)
    || !integer(value.binCount, LIMITS.minBins, LIMITS.maxBins)
    || !integer(value.sourceSampleCount, 1, LIMITS.maxInputRate * 30)
    || value.sourceSampleCount !== Math.ceil(value.binCount * value.inputSampleRate / LIMITS.featureRate)
    || value.startSample + value.sourceSampleCount > LIMITS.maxSourceSeconds * value.inputSampleRate
  ) throw new TypeError('Unproven or out-of-envelope research audio provenance')
  return JSON.stringify([
    'myrelith-audio-feature-research-v1',
    value.projectBindingId, value.assetId,
    [source.algorithm, source.digest, source.fileName, source.size, source.lastModified],
    value.audioStreamIndex, value.audioTrackId, value.decodePolicyDigest, value.timestampOrigin,
    value.inputSampleRate, value.channels, value.startSample, value.sourceSampleCount, value.binCount,
    ['log-rms-200-v1', LIMITS.featureRate, 'mean-channel-square', 'log1p', 1_000, 'float32-le'],
  ])
}

/** Results bind order/sign, project mapping, every quality policy, and the proposal snapshot. */
export function researchAudioPairKeyPreimage(value: unknown): string {
  if (!record(value) || !exactKeys(value, [
    'referenceFeatureKey', 'targetFeatureKey', 'projectRate', 'maxLagBins', 'definitionDigest',
  ])) throw new TypeError('Invalid research audio pair identity')
  const rate = value.projectRate
  if (
    !digest(value.referenceFeatureKey) || !digest(value.targetFeatureKey)
    || !digest(value.definitionDigest) || !record(rate) || !exactKeys(rate, ['num', 'den'])
    || typeof rate.num !== 'number' || typeof rate.den !== 'number'
    || !alignmentResearchRateIsSupported({ num: rate.num, den: rate.den })
    || !integer(value.maxLagBins, LIMITS.minLagBins, LIMITS.maxLagBins)
  ) throw new TypeError('Unproven or out-of-envelope research audio pair provenance')
  return JSON.stringify([
    'myrelith-audio-pair-research-v1', value.referenceFeatureKey, value.targetFeatureKey,
    [rate.num, rate.den], value.maxLagBins, value.definitionDigest,
    ['pearson-overlap-v1', LIMITS.minOverlapBins, LIMITS.minOverlapRatio,
      LIMITS.minScore, LIMITS.minMargin, LIMITS.minMeanFeature, LIMITS.minFeatureDeviation,
      'one-project-frame-neighborhood', 'reject-search-edge', 'nearest-ties-away-from-zero',
      'score-then-smallest-absolute-lag-then-negative', LIMITS.maxPairComparisons],
  ])
}
