import type { FrameRate } from './schema'
import { MAX_DOCUMENT_ID_CHARACTERS } from './projectLimits'

export const PROXY_CACHE_SCHEMA_VERSION = 1 as const
export const PROXY_GENERATOR_VERSION = 'mediabunny-webcodecs-v1' as const
export const MAX_PROXY_CACHE_ENTRIES = 2_048
export const MAX_PROXY_FILE_NAME_CHARACTERS = 4_096
export const MAX_PROXY_DIMENSION = 65_535
export const MAX_PROXY_BITRATE = 200_000_000
export const MAX_PROXY_KEY_FRAME_INTERVAL_SECONDS = 3_600
export const MAX_PROXY_RATE_PART = 1_000_000
export const MAX_PROXY_FRAMES_PER_SECOND = 1_000
export const MAX_PROXY_TIMESTAMP = 8_640_000_000_000_000

export interface ProxyOriginalFingerprint {
  readonly algorithm: 'sha256-sampled-v1'
  readonly digest: string
  readonly fileName: string
  readonly size: number
  readonly lastModified: number
}

export interface ProxyGenerationParameters {
  readonly container: 'mp4'
  readonly videoCodec: 'avc'
  readonly bitrate: number
  readonly maxWidth: number
  readonly maxHeight: number
  readonly keyFrameIntervalSeconds: number
}

export const DEFAULT_PROXY_PARAMETERS = Object.freeze({
  container: 'mp4',
  videoCodec: 'avc',
  bitrate: 2_000_000,
  maxWidth: 1_280,
  maxHeight: 720,
  keyFrameIntervalSeconds: 1,
}) satisfies ProxyGenerationParameters

export interface ProxyCacheEntry {
  readonly cacheKey: string
  readonly assetId: string
  readonly original: ProxyOriginalFingerprint
  readonly parameters: ProxyGenerationParameters
  readonly generatorVersion: typeof PROXY_GENERATOR_VERSION
  readonly fileName: string
  readonly mimeType: 'video/mp4'
  readonly byteSize: number
  readonly width: number
  readonly height: number
  readonly frameRate: FrameRate
  readonly durationMicroseconds: number
  readonly createdAt: number
  readonly lastUsedAt: number
}

export interface ProxyCacheManifest {
  readonly schemaVersion: typeof PROXY_CACHE_SCHEMA_VERSION
  readonly entries: readonly ProxyCacheEntry[]
}

const PROXY_FILE_NAME_PATTERN = /^[a-f0-9]{64}\.[a-f0-9]{32}\.mp4$/

export function isProxyCacheFileName(fileName: string): boolean {
  return PROXY_FILE_NAME_PATTERN.test(fileName)
}

export interface MediaRepresentationFacts {
  readonly purpose: 'preview' | 'export'
  readonly originalAvailable: boolean
  readonly proxy: 'missing' | 'fresh' | 'stale'
}

export type MediaRepresentationDecision =
  | { readonly representation: 'original' | 'proxy'; readonly reason: string }
  | { readonly representation: 'unavailable'; readonly reason: string }

/**
 * One browser-free representation policy shared by preview and final export.
 * A proxy is disposable acceleration only; final export never selects it.
 */
export function selectMediaRepresentation(
  facts: MediaRepresentationFacts,
): MediaRepresentationDecision {
  if (facts.purpose === 'export') {
    return facts.originalAvailable
      ? {
          representation: 'original',
          reason: 'Final export revalidates the original source.',
        }
      : {
          representation: 'unavailable',
          reason: 'The original source is offline; final export cannot use a proxy.',
        }
  }

  if (facts.proxy === 'fresh') {
    return {
      representation: 'proxy',
      reason: facts.originalAvailable
        ? 'Preview uses the fresh local proxy; the original remains project truth.'
        : 'Preview uses the fresh local proxy while the original is offline.',
    }
  }
  if (facts.originalAvailable) {
    return {
      representation: 'original',
      reason: facts.proxy === 'stale'
        ? 'The proxy is stale, so preview uses the original.'
        : 'No fresh proxy is available, so preview uses the original.',
    }
  }
  return {
    representation: 'unavailable',
    reason: facts.proxy === 'stale'
      ? 'The original is offline and the cached proxy is stale.'
      : 'The original is offline and no proxy is cached.',
  }
}

export function proxyFingerprintMatches(
  entry: ProxyCacheEntry,
  fingerprint: Pick<ProxyOriginalFingerprint, 'digest' | 'size' | 'lastModified'>,
): boolean {
  return entry.original.digest === fingerprint.digest
    && entry.original.size === fingerprint.size
    && entry.original.lastModified === fingerprint.lastModified
}

export function proxyDescriptorCouldMatch(
  entry: ProxyCacheEntry,
  descriptor: {
    readonly fileName: string
    readonly size: number
    readonly lastModified: number
  },
): boolean {
  return entry.original.fileName === descriptor.fileName
    && entry.original.size === descriptor.size
    && entry.original.lastModified === descriptor.lastModified
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length
    && keys.every((key) => expected.includes(key))
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
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

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validRate(value: unknown): value is FrameRate {
  if (!record(value) || !exactKeys(value, ['num', 'den'])) return false
  const rate = value as Partial<FrameRate>
  return positiveSafeInteger(rate.num)
    && rate.num <= MAX_PROXY_RATE_PART
    && positiveSafeInteger(rate.den)
    && rate.den <= MAX_PROXY_RATE_PART
    && greatestCommonDivisor(rate.num, rate.den) === 1
    && rate.num / rate.den <= MAX_PROXY_FRAMES_PER_SECOND
}

function validParameters(value: unknown): value is ProxyGenerationParameters {
  if (!record(value) || !exactKeys(value, [
    'container',
    'videoCodec',
    'bitrate',
    'maxWidth',
    'maxHeight',
    'keyFrameIntervalSeconds',
  ])) return false
  const parameters = value as Partial<ProxyGenerationParameters>
  return parameters.container === 'mp4'
    && parameters.videoCodec === 'avc'
    && positiveSafeInteger(parameters.bitrate)
    && parameters.bitrate <= MAX_PROXY_BITRATE
    && positiveSafeInteger(parameters.maxWidth)
    && parameters.maxWidth <= MAX_PROXY_DIMENSION
    && positiveSafeInteger(parameters.maxHeight)
    && parameters.maxHeight <= MAX_PROXY_DIMENSION
    && typeof parameters.keyFrameIntervalSeconds === 'number'
    && Number.isFinite(parameters.keyFrameIntervalSeconds)
    && parameters.keyFrameIntervalSeconds > 0
    && parameters.keyFrameIntervalSeconds <= MAX_PROXY_KEY_FRAME_INTERVAL_SECONDS
}

function validFingerprint(value: unknown): value is ProxyOriginalFingerprint {
  if (!record(value) || !exactKeys(value, [
    'algorithm',
    'digest',
    'fileName',
    'size',
    'lastModified',
  ])) return false
  const fingerprint = value as Partial<ProxyOriginalFingerprint>
  return fingerprint.algorithm === 'sha256-sampled-v1'
    && typeof fingerprint.digest === 'string'
    && /^[a-f0-9]{64}$/.test(fingerprint.digest)
    && boundedString(fingerprint.fileName, MAX_PROXY_FILE_NAME_CHARACTERS)
    && nonNegativeSafeInteger(fingerprint.size)
    && nonNegativeSafeInteger(fingerprint.lastModified)
    && fingerprint.lastModified <= MAX_PROXY_TIMESTAMP
}

function validEntry(value: unknown): value is ProxyCacheEntry {
  if (!record(value) || !exactKeys(value, [
    'cacheKey',
    'assetId',
    'original',
    'parameters',
    'generatorVersion',
    'fileName',
    'mimeType',
    'byteSize',
    'width',
    'height',
    'frameRate',
    'durationMicroseconds',
    'createdAt',
    'lastUsedAt',
  ])) return false
  const entry = value as Partial<ProxyCacheEntry>
  return typeof entry.cacheKey === 'string'
    && /^[a-f0-9]{64}$/.test(entry.cacheKey)
    && boundedString(entry.assetId, MAX_DOCUMENT_ID_CHARACTERS)
    && validFingerprint(entry.original)
    && validParameters(entry.parameters)
    && entry.generatorVersion === PROXY_GENERATOR_VERSION
    && typeof entry.fileName === 'string'
    && isProxyCacheFileName(entry.fileName)
    && entry.fileName.startsWith(`${entry.cacheKey}.`)
    && entry.mimeType === 'video/mp4'
    && positiveSafeInteger(entry.byteSize)
    && positiveSafeInteger(entry.width)
    && entry.width <= MAX_PROXY_DIMENSION
    && entry.width <= entry.parameters.maxWidth
    && entry.width % 2 === 0
    && positiveSafeInteger(entry.height)
    && entry.height <= MAX_PROXY_DIMENSION
    && entry.height <= entry.parameters.maxHeight
    && entry.height % 2 === 0
    && validRate(entry.frameRate)
    && positiveSafeInteger(entry.durationMicroseconds)
    && nonNegativeSafeInteger(entry.createdAt)
    && entry.createdAt <= MAX_PROXY_TIMESTAMP
    && nonNegativeSafeInteger(entry.lastUsedAt)
    && entry.lastUsedAt <= MAX_PROXY_TIMESTAMP
    && entry.lastUsedAt >= entry.createdAt
}

/** Invalid or future manifests fail closed to an empty disposable cache. */
export function parseProxyCacheManifest(value: unknown): ProxyCacheManifest {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'entries'])) {
    throw new TypeError('Proxy cache manifest must be an object')
  }
  const candidate = value as Partial<ProxyCacheManifest>
  if (candidate.schemaVersion !== PROXY_CACHE_SCHEMA_VERSION) {
    throw new TypeError('Unsupported proxy cache manifest version')
  }
  if (!Array.isArray(candidate.entries) || candidate.entries.length > MAX_PROXY_CACHE_ENTRIES) {
    throw new TypeError('Proxy cache manifest has an invalid entry list')
  }
  const assetIds = new Set<string>()
  const cacheKeys = new Set<string>()
  let aggregateBytes = 0
  for (const entry of candidate.entries) {
    if (!validEntry(entry)) throw new TypeError('Proxy cache manifest has an invalid entry')
    if (assetIds.has(entry.assetId) || cacheKeys.has(entry.cacheKey)) {
      throw new TypeError('Proxy cache manifest contains duplicate entries')
    }
    assetIds.add(entry.assetId)
    cacheKeys.add(entry.cacheKey)
    aggregateBytes += entry.byteSize
    if (!Number.isSafeInteger(aggregateBytes)) {
      throw new TypeError('Proxy cache manifest byte total exceeds the safe integer range')
    }
  }
  return {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    entries: candidate.entries.map((entry) => ({
      ...entry,
      original: { ...entry.original },
      parameters: { ...entry.parameters },
      frameRate: { ...entry.frameRate },
    })),
  }
}

export function proxyCacheByteSize(entries: readonly ProxyCacheEntry[]): number {
  let total = 0
  for (const entry of entries) {
    total += entry.byteSize
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('Proxy cache byte total exceeds the safe integer range')
    }
  }
  return total
}

export function proxyOutputDimensions(
  sourceWidth: number,
  sourceHeight: number,
  parameters: ProxyGenerationParameters = DEFAULT_PROXY_PARAMETERS,
): Readonly<{ width: number; height: number }> {
  if (!positiveSafeInteger(sourceWidth) || !positiveSafeInteger(sourceHeight)) {
    throw new RangeError('Proxy source dimensions must be positive safe integers')
  }
  const scale = Math.min(
    1,
    parameters.maxWidth / sourceWidth,
    parameters.maxHeight / sourceHeight,
  )
  const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)
  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  }
}

export function estimateProxyBytes(
  durationMicroseconds: number,
  bitrate: number = DEFAULT_PROXY_PARAMETERS.bitrate,
): number {
  if (!positiveSafeInteger(durationMicroseconds) || !positiveSafeInteger(bitrate)) {
    throw new RangeError('Proxy estimate requires a positive duration and bitrate')
  }
  const payload = Math.ceil(durationMicroseconds / 1_000_000 * bitrate / 8)
  const estimate = Math.max(1, Math.ceil(payload * 1.08) + 64 * 1024)
  if (!Number.isSafeInteger(estimate)) {
    throw new RangeError('Proxy byte estimate exceeds the safe integer range')
  }
  return estimate
}
