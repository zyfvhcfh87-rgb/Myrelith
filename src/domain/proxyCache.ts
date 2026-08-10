import type { FrameRate } from './schema'

export const PROXY_CACHE_SCHEMA_VERSION = 1 as const
export const PROXY_GENERATOR_VERSION = 'mediabunny-webcodecs-v1' as const
export const MAX_PROXY_CACHE_ENTRIES = 2_048

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

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validRate(value: unknown): value is FrameRate {
  if (typeof value !== 'object' || value === null) return false
  const rate = value as Partial<FrameRate>
  return positiveSafeInteger(rate.num) && positiveSafeInteger(rate.den)
}

function validParameters(value: unknown): value is ProxyGenerationParameters {
  if (typeof value !== 'object' || value === null) return false
  const parameters = value as Partial<ProxyGenerationParameters>
  return parameters.container === 'mp4'
    && parameters.videoCodec === 'avc'
    && positiveSafeInteger(parameters.bitrate)
    && positiveSafeInteger(parameters.maxWidth)
    && positiveSafeInteger(parameters.maxHeight)
    && typeof parameters.keyFrameIntervalSeconds === 'number'
    && Number.isFinite(parameters.keyFrameIntervalSeconds)
    && parameters.keyFrameIntervalSeconds > 0
}

function validFingerprint(value: unknown): value is ProxyOriginalFingerprint {
  if (typeof value !== 'object' || value === null) return false
  const fingerprint = value as Partial<ProxyOriginalFingerprint>
  return fingerprint.algorithm === 'sha256-sampled-v1'
    && typeof fingerprint.digest === 'string'
    && /^[a-f0-9]{64}$/.test(fingerprint.digest)
    && typeof fingerprint.fileName === 'string'
    && fingerprint.fileName.length > 0
    && nonNegativeSafeInteger(fingerprint.size)
    && nonNegativeSafeInteger(fingerprint.lastModified)
}

function validEntry(value: unknown): value is ProxyCacheEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<ProxyCacheEntry>
  return typeof entry.cacheKey === 'string'
    && /^[a-f0-9]{64}$/.test(entry.cacheKey)
    && typeof entry.assetId === 'string'
    && entry.assetId.length > 0
    && validFingerprint(entry.original)
    && validParameters(entry.parameters)
    && entry.generatorVersion === PROXY_GENERATOR_VERSION
    && typeof entry.fileName === 'string'
    && isProxyCacheFileName(entry.fileName)
    && entry.fileName.startsWith(`${entry.cacheKey}.`)
    && entry.mimeType === 'video/mp4'
    && positiveSafeInteger(entry.byteSize)
    && positiveSafeInteger(entry.width)
    && positiveSafeInteger(entry.height)
    && validRate(entry.frameRate)
    && positiveSafeInteger(entry.durationMicroseconds)
    && nonNegativeSafeInteger(entry.createdAt)
    && nonNegativeSafeInteger(entry.lastUsedAt)
}

/** Invalid or future manifests fail closed to an empty disposable cache. */
export function parseProxyCacheManifest(value: unknown): ProxyCacheManifest {
  if (typeof value !== 'object' || value === null) {
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
  for (const entry of candidate.entries) {
    if (!validEntry(entry)) throw new TypeError('Proxy cache manifest has an invalid entry')
    if (assetIds.has(entry.assetId) || cacheKeys.has(entry.cacheKey)) {
      throw new TypeError('Proxy cache manifest contains duplicate entries')
    }
    assetIds.add(entry.assetId)
    cacheKeys.add(entry.cacheKey)
  }
  return {
    schemaVersion: PROXY_CACHE_SCHEMA_VERSION,
    entries: candidate.entries.map((entry) => ({ ...entry })),
  }
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
  return Math.max(1, Math.ceil(payload * 1.08) + 64 * 1024)
}
