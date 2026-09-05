/** Browser-free provenance and stale-result policy for derived analysis data. */

import { isLocalProjectBindingId } from './localProjectBinding'
import { MAX_DOCUMENT_ID_CHARACTERS } from './projectLimits'
import type { FrameRate } from './schema'
import { audioFeatureKeyPreimage, type AudioFeatureIdentity } from './multicamAlignmentProvenance'

export const ANALYSIS_CACHE_SCHEMA_VERSION = 2 as const
// Keep the physical root: schema 1 motion files migrate without moving bytes.
export const ANALYSIS_CACHE_ROOT = 'myrelith-derived/analysis-cache-v1'
export const MAX_ANALYSIS_CACHE_ENTRIES = 1_024
export const MAX_ANALYSIS_RESULT_BYTES = 256 * 1024 * 1024
export const MAX_ANALYSIS_SAMPLES = 1_000_000
export const ANALYSIS_CACHE_TARGET_BYTES = 512 * 1024 * 1024
export const ANALYSIS_CACHE_MINIMUM_HEADROOM_BYTES = 128 * 1024 * 1024
export const ANALYSIS_CACHE_TARGET_ORIGIN_USAGE_RATIO = 0.7
export const MAX_AUDIO_FEATURE_BYTES = 1024 * 1024
export const AUDIO_CACHE_PROJECT_BYTES = 16 * 1024 * 1024
export const AUDIO_CACHE_TOTAL_BYTES = 64 * 1024 * 1024

export type AnalysisKind = 'stabilization' | 'point-tracking' | 'box-tracking'

export interface AnalysisSourceFingerprint {
  readonly algorithm: 'sha256-sampled-v1'
  readonly digest: string
  readonly fileName: string
  readonly size: number
  readonly lastModified: number
}

export interface AnalysisSourceProvenance {
  readonly fingerprint: AnalysisSourceFingerprint
  readonly videoStreamIndex: number
  readonly width: number
  readonly height: number
  readonly frameRate: FrameRate
  readonly sourceStartMicroseconds: number
  readonly sourceEndMicroseconds: number
  readonly samplingIntervalFrames: number
}

export interface AnalysisClipAttachment {
  readonly clipId: string
  /** Hash of exact SourceTimeMap/source-range facts used by the analysis. */
  readonly sourceMappingDigest: string
  /** Hash of clip-local range/geometry facts used when results were projected. */
  readonly projectionDigest: string
}

export interface AnalysisAlgorithmProvenance {
  readonly kind: AnalysisKind
  readonly algorithmId: string
  readonly algorithmVersion: string
  readonly parametersDigest: string
}

export interface AnalysisCacheIdentity {
  readonly projectBindingId: string
  readonly assetId: string
  readonly source: AnalysisSourceProvenance
  readonly attachment: AnalysisClipAttachment
  readonly algorithm: AnalysisAlgorithmProvenance
}

export interface AnalysisCacheEntry extends AnalysisCacheIdentity {
  readonly cacheKind: 'motion'
  readonly cacheKey: string
  readonly resultFileName: string
  readonly resultBytes: number
  readonly sampleCount: number
  readonly createdAt: number
  readonly lastUsedAt: number
}

/** Audio provenance has no invented video dimensions or clip attachment. */
export interface AudioFeatureCacheEntry extends AudioFeatureIdentity {
  readonly cacheKind: 'audio-feature'
  readonly cacheKey: string
  readonly resultFileName: string
  readonly resultBytes: number
  readonly createdAt: number
  readonly lastUsedAt: number
}

export type DerivedAnalysisCacheEntry = AnalysisCacheEntry | AudioFeatureCacheEntry

export interface AnalysisCacheManifest {
  readonly schemaVersion: typeof ANALYSIS_CACHE_SCHEMA_VERSION
  readonly entries: readonly DerivedAnalysisCacheEntry[]
}

export type AnalysisCacheStaleReason =
  | 'project-binding'
  | 'asset'
  | 'source-fingerprint'
  | 'source-stream'
  | 'source-geometry'
  | 'source-rate'
  | 'source-range'
  | 'sampling'
  | 'clip'
  | 'source-mapping'
  | 'projection'
  | 'analysis-kind'
  | 'algorithm'
  | 'algorithm-version'
  | 'parameters'

export type AnalysisCacheFreshness =
  | { readonly state: 'fresh' }
  | { readonly state: 'stale'; readonly reasons: readonly AnalysisCacheStaleReason[] }

const MAX_STRING_CHARACTERS = 4_096
const MAX_TIMESTAMP = 8_640_000_000_000_000
const MAX_DIMENSION = 65_535
const MAX_RATE_PART = 1_000_000
const MAX_FRAME_RATE = 1_000
const RESULT_FILE_PATTERN = /^[a-f0-9]{64}\.[a-f0-9]{32}\.bin$/
const ANALYSIS_KIND_SET = new Set<AnalysisKind>([
  'stabilization',
  'point-tracking',
  'box-tracking',
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function boundedString(value: unknown, maximum = MAX_STRING_CHARACTERS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function boundedTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && Math.abs(value) <= MAX_TIMESTAMP
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function validRate(value: unknown): value is FrameRate {
  if (!record(value) || !exactKeys(value, ['num', 'den'])) return false
  return positiveSafeInteger(value.num)
    && value.num <= MAX_RATE_PART
    && positiveSafeInteger(value.den)
    && value.den <= MAX_RATE_PART
    && greatestCommonDivisor(value.num, value.den) === 1
    && value.num / value.den <= MAX_FRAME_RATE
}

function validFingerprint(value: unknown): value is AnalysisSourceFingerprint {
  return record(value)
    && exactKeys(value, ['algorithm', 'digest', 'fileName', 'size', 'lastModified'])
    && value.algorithm === 'sha256-sampled-v1'
    && digest(value.digest)
    && boundedString(value.fileName)
    && nonNegativeSafeInteger(value.size)
    && nonNegativeSafeInteger(value.lastModified)
    && value.lastModified <= MAX_TIMESTAMP
}

function validSource(value: unknown): value is AnalysisSourceProvenance {
  return record(value)
    && exactKeys(value, [
      'fingerprint',
      'videoStreamIndex',
      'width',
      'height',
      'frameRate',
      'sourceStartMicroseconds',
      'sourceEndMicroseconds',
      'samplingIntervalFrames',
    ])
    && validFingerprint(value.fingerprint)
    && nonNegativeSafeInteger(value.videoStreamIndex)
    && value.videoStreamIndex <= 255
    && positiveSafeInteger(value.width)
    && value.width <= MAX_DIMENSION
    && positiveSafeInteger(value.height)
    && value.height <= MAX_DIMENSION
    && validRate(value.frameRate)
    && boundedTimestamp(value.sourceStartMicroseconds)
    && boundedTimestamp(value.sourceEndMicroseconds)
    && value.sourceEndMicroseconds > value.sourceStartMicroseconds
    && positiveSafeInteger(value.samplingIntervalFrames)
    && value.samplingIntervalFrames <= MAX_ANALYSIS_SAMPLES
}

function validAttachment(value: unknown): value is AnalysisClipAttachment {
  return record(value)
    && exactKeys(value, ['clipId', 'sourceMappingDigest', 'projectionDigest'])
    && boundedString(value.clipId, MAX_DOCUMENT_ID_CHARACTERS)
    && digest(value.sourceMappingDigest)
    && digest(value.projectionDigest)
}

function validAlgorithm(value: unknown): value is AnalysisAlgorithmProvenance {
  return record(value)
    && exactKeys(value, ['kind', 'algorithmId', 'algorithmVersion', 'parametersDigest'])
    && typeof value.kind === 'string'
    && ANALYSIS_KIND_SET.has(value.kind as AnalysisKind)
    && boundedString(value.algorithmId, 256)
    && boundedString(value.algorithmVersion, 256)
    && digest(value.parametersDigest)
}

function validEntry(value: unknown): value is AnalysisCacheEntry {
  if (!record(value) || !exactKeys(value, [
    'cacheKind',
    'cacheKey',
    'projectBindingId',
    'assetId',
    'source',
    'attachment',
    'algorithm',
    'resultFileName',
    'resultBytes',
    'sampleCount',
    'createdAt',
    'lastUsedAt',
  ])) return false
  return value.cacheKind === 'motion' && digest(value.cacheKey)
    && isLocalProjectBindingId(value.projectBindingId)
    && boundedString(value.assetId, MAX_DOCUMENT_ID_CHARACTERS)
    && validSource(value.source)
    && validAttachment(value.attachment)
    && validAlgorithm(value.algorithm)
    && typeof value.resultFileName === 'string'
    && RESULT_FILE_PATTERN.test(value.resultFileName)
    && value.resultFileName.startsWith(`${value.cacheKey}.`)
    && positiveSafeInteger(value.resultBytes)
    && value.resultBytes <= MAX_ANALYSIS_RESULT_BYTES
    && positiveSafeInteger(value.sampleCount)
    && value.sampleCount <= MAX_ANALYSIS_SAMPLES
    && nonNegativeSafeInteger(value.createdAt)
    && value.createdAt <= MAX_TIMESTAMP
    && nonNegativeSafeInteger(value.lastUsedAt)
    && value.lastUsedAt <= MAX_TIMESTAMP
    && value.lastUsedAt >= value.createdAt
}

export function audioFeatureIdentity(entry: AudioFeatureCacheEntry): AudioFeatureIdentity {
  const { cacheKind: _kind, cacheKey: _key, resultFileName: _file, resultBytes: _bytes,
    createdAt: _created, lastUsedAt: _used, ...identity } = entry
  return identity
}

function validAudioEntry(value: unknown): value is AudioFeatureCacheEntry {
  if (!record(value) || value.cacheKind !== 'audio-feature') return false
  const { cacheKind: _kind, cacheKey, resultFileName, resultBytes, createdAt, lastUsedAt,
    ...identity } = value
  try { audioFeatureKeyPreimage(identity) } catch { return false }
  return digest(cacheKey)
    && typeof resultFileName === 'string' && RESULT_FILE_PATTERN.test(resultFileName)
    && resultFileName.startsWith(`${cacheKey}.`)
    && positiveSafeInteger(resultBytes) && resultBytes <= MAX_AUDIO_FEATURE_BYTES
    && resultBytes === (identity.binCount as number) * 4
    && nonNegativeSafeInteger(createdAt) && createdAt <= MAX_TIMESTAMP
    && nonNegativeSafeInteger(lastUsedAt) && lastUsedAt <= MAX_TIMESTAMP
    && lastUsedAt >= createdAt
}

/** Invalid/future disposable manifests fail closed instead of being repaired. */
export function parseAnalysisCacheManifest(value: unknown): AnalysisCacheManifest {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'entries'])) {
    throw new TypeError('Analysis cache manifest must be an exact object')
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== ANALYSIS_CACHE_SCHEMA_VERSION) {
    throw new TypeError('Unsupported analysis cache manifest version')
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ANALYSIS_CACHE_ENTRIES) {
    throw new TypeError('Analysis cache manifest has an invalid entry list')
  }
  const cacheKeys = new Set<string>()
  const fileNames = new Set<string>()
  const entries: DerivedAnalysisCacheEntry[] = []
  let aggregateBytes = 0
  for (const input of value.entries) {
    // Only schema 1 may omit the discriminator; never reinterpret an audio record.
    const rawEntry = value.schemaVersion === 1 && record(input) && !('cacheKind' in input)
      ? { ...input, cacheKind: 'motion' } : input
    if (value.schemaVersion === 1 && record(input) && 'cacheKind' in input) {
      throw new TypeError('Schema 1 only contains legacy motion entries')
    }
    if (!validEntry(rawEntry) && !validAudioEntry(rawEntry)) {
      throw new TypeError('Analysis cache manifest has an invalid entry')
    }
    if (cacheKeys.has(rawEntry.cacheKey) || fileNames.has(rawEntry.resultFileName)) {
      throw new TypeError('Analysis cache manifest contains duplicate identities')
    }
    aggregateBytes += rawEntry.resultBytes
    if (!Number.isSafeInteger(aggregateBytes)) {
      throw new TypeError('Analysis cache manifest byte total exceeds the safe integer range')
    }
    cacheKeys.add(rawEntry.cacheKey)
    fileNames.add(rawEntry.resultFileName)
    if (rawEntry.cacheKind === 'audio-feature') {
      entries.push({ ...rawEntry, sourceFingerprint: { ...rawEntry.sourceFingerprint } })
      continue
    }
    entries.push({
      ...rawEntry,
      source: {
        ...rawEntry.source,
        fingerprint: { ...rawEntry.source.fingerprint },
        frameRate: { ...rawEntry.source.frameRate },
      },
      attachment: { ...rawEntry.attachment },
      algorithm: { ...rawEntry.algorithm },
    })
  }
  return { schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION, entries }
}

function sameRate(left: FrameRate, right: FrameRate): boolean {
  return left.num === right.num && left.den === right.den
}

export function analysisCacheFreshness(
  entry: AnalysisCacheEntry,
  current: AnalysisCacheIdentity,
): AnalysisCacheFreshness {
  const reasons: AnalysisCacheStaleReason[] = []
  if (entry.projectBindingId !== current.projectBindingId) reasons.push('project-binding')
  if (entry.assetId !== current.assetId) reasons.push('asset')
  if (
    entry.source.fingerprint.digest !== current.source.fingerprint.digest
    || entry.source.fingerprint.size !== current.source.fingerprint.size
    || entry.source.fingerprint.lastModified !== current.source.fingerprint.lastModified
  ) reasons.push('source-fingerprint')
  if (entry.source.videoStreamIndex !== current.source.videoStreamIndex) reasons.push('source-stream')
  if (
    entry.source.width !== current.source.width
    || entry.source.height !== current.source.height
  ) reasons.push('source-geometry')
  if (!sameRate(entry.source.frameRate, current.source.frameRate)) reasons.push('source-rate')
  if (
    entry.source.sourceStartMicroseconds !== current.source.sourceStartMicroseconds
    || entry.source.sourceEndMicroseconds !== current.source.sourceEndMicroseconds
  ) reasons.push('source-range')
  if (entry.source.samplingIntervalFrames !== current.source.samplingIntervalFrames) {
    reasons.push('sampling')
  }
  if (entry.attachment.clipId !== current.attachment.clipId) reasons.push('clip')
  if (
    entry.attachment.sourceMappingDigest !== current.attachment.sourceMappingDigest
  ) reasons.push('source-mapping')
  if (entry.attachment.projectionDigest !== current.attachment.projectionDigest) {
    reasons.push('projection')
  }
  if (entry.algorithm.kind !== current.algorithm.kind) reasons.push('analysis-kind')
  if (entry.algorithm.algorithmId !== current.algorithm.algorithmId) reasons.push('algorithm')
  if (entry.algorithm.algorithmVersion !== current.algorithm.algorithmVersion) {
    reasons.push('algorithm-version')
  }
  if (entry.algorithm.parametersDigest !== current.algorithm.parametersDigest) {
    reasons.push('parameters')
  }
  return reasons.length === 0 ? { state: 'fresh' } : { state: 'stale', reasons }
}

export function analysisCacheByteSize(entries: readonly DerivedAnalysisCacheEntry[]): number {
  let total = 0
  for (const entry of entries) {
    total += entry.resultBytes
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('Analysis cache byte total exceeds the safe integer range')
    }
  }
  return total
}
