/**
 * Realm-local, lazy registration for Myrelith's reviewed decoder fallbacks.
 *
 * The window and render worker each get their own registry because
 * Mediabunny's custom decoders are registered per JavaScript realm. Literal
 * dynamic imports keep both decoder implementations in local, on-demand
 * chunks; no decoder code is downloaded from a third party at runtime.
 */

import type {
  MediaCompatibilityReason,
  MediaDecoderPath,
} from '../domain/mediaCompatibility'
import type { MediaAsset } from '../domain/schema'

export type LocalDecoderId = 'prores' | 'ac3'

export type MediaDecoderCapabilityBoundary =
  | 'probe'
  | 'render'
  | 'filmstrip'
  | 'waveform'
  | 'audio-playback'
  | 'export-video'
  | 'export-audio'

export type MediaDecoderCapabilityPolicy = 'reuse' | 'revalidate'

export type MediaDecoderConfiguration =
  | VideoDecoderConfig
  | AudioDecoderConfig

export interface LocalDecoderBudget {
  fileBytes: number
  durationMicroseconds: number
  width?: number | null
  height?: number | null
  framesPerSecond?: number | null
  sampleRate?: number | null
  channels?: number | null
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
}

function conservativeFileBytes(
  rememberedFileBytes: number,
  liveFileBytes: number,
): number {
  if (
    !Number.isSafeInteger(rememberedFileBytes)
    || rememberedFileBytes < 0
    || !Number.isSafeInteger(liveFileBytes)
    || liveFileBytes < 0
  ) return Number.NaN
  return Math.max(rememberedFileBytes, liveFileBytes)
}

/**
 * Add live video configuration cost without ever lowering probed facts.
 * Dimensions stay paired: rotated 4096x2160 and 2160x4096 frames have the
 * same decode cost and must not be inflated into a fictitious 4096x4096 frame.
 * Invalid immutable dimensions remain invalid so fallback use still fails
 * closed instead of being repaired by later, mutable runtime metadata.
 */
export function refineVideoDecoderBudget(
  budget: LocalDecoderBudget,
  liveFileBytes: number,
  configuration: VideoDecoderConfig | null | undefined,
): LocalDecoderBudget {
  const rememberedWidth = budget.width
  const rememberedHeight = budget.height
  const liveWidth = configuration?.codedWidth
  const liveHeight = configuration?.codedHeight
  let largerLiveDimensions: { width: number; height: number } | null = null
  if (
    isPositiveSafeInteger(rememberedWidth)
    && isPositiveSafeInteger(rememberedHeight)
    && isPositiveSafeInteger(liveWidth)
    && isPositiveSafeInteger(liveHeight)
    && liveWidth * liveHeight > rememberedWidth * rememberedHeight
  ) {
    largerLiveDimensions = { width: liveWidth, height: liveHeight }
  }

  return {
    ...budget,
    fileBytes: conservativeFileBytes(budget.fileBytes, liveFileBytes),
    ...(largerLiveDimensions ?? {}),
  }
}

/**
 * Add live audio configuration cost without lowering either independent
 * ceiling. Invalid immutable values remain invalid so local fallback use
 * continues to fail closed.
 */
export function refineAudioDecoderBudget(
  budget: LocalDecoderBudget,
  liveFileBytes: number,
  configuration: AudioDecoderConfig | null | undefined,
): LocalDecoderBudget {
  const sampleRate = isPositiveSafeInteger(budget.sampleRate)
    && isPositiveSafeInteger(configuration?.sampleRate)
    ? Math.max(budget.sampleRate, configuration.sampleRate)
    : budget.sampleRate
  const channels = isPositiveSafeInteger(budget.channels)
    && isPositiveSafeInteger(configuration?.numberOfChannels)
    ? Math.max(budget.channels, configuration.numberOfChannels)
    : budget.channels

  return {
    ...budget,
    fileBytes: conservativeFileBytes(budget.fileBytes, liveFileBytes),
    sampleRate,
    channels,
  }
}

/**
 * Build the conservative, session-only budget every runtime decode boundary
 * must carry. The connected asset is the immutable result of the import or
 * relink probe; the live Blob size is folded in so a mismatched source can
 * never lower the file-size ceiling.
 */
export function mediaAssetDecoderBudget(
  asset: Pick<
    MediaAsset,
    | 'size'
    | 'durationMicroseconds'
    | 'frameRate'
    | 'width'
    | 'height'
    | 'audioSampleRate'
    | 'audioChannels'
  >,
  blobSize: number = asset.size,
): LocalDecoderBudget {
  return {
    fileBytes: conservativeFileBytes(asset.size, blobSize),
    durationMicroseconds: asset.durationMicroseconds,
    width: asset.width,
    height: asset.height,
    framesPerSecond: asset.frameRate
      ? asset.frameRate.num / asset.frameRate.den
      : null,
    sampleRate: asset.audioSampleRate,
    channels: asset.audioChannels,
  }
}

export const LOCAL_DECODER_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  maxDurationMicroseconds: 2 * 60 * 60 * 1_000_000,
  maxProresPixelsPerSecond: 4096 * 2160 * 30,
  maxAc3SampleRate: 48_000,
  maxAc3Channels: 8,
})

/** Session-only bounds; oversized configurations are checked but not cached. */
export const MEDIA_DECODER_CAPABILITY_CACHE_LIMITS = Object.freeze({
  maxEntries: 256,
  maxSources: 1_024,
  maxConfigurationBytes: 1024 * 1024,
  maxConfigurationJsonCharacters: 16_384,
})

export interface DecoderCheckTarget {
  /** Mediabunny's normalized codec id, never a filename or MIME guess. */
  codec: string | null
  canDecode(): Promise<boolean>
  /** Exact WebCodecs configuration. Omission keeps the check uncached. */
  configuration?: MediaDecoderConfiguration | null
  /** Track kind is part of the exact capability identity. */
  trackKind?: 'video' | 'audio'
  /** Durable id scoped to this realm; source replacement calls beginSource. */
  sourceId?: string
  /** Decode surface; runtime boundaries deliberately do not share entries. */
  boundary?: MediaDecoderCapabilityBoundary
  /** Runtime boundaries always revalidate even when an entry is warm. */
  policy?: MediaDecoderCapabilityPolicy
  /** Injectable native-only check for fallback-family provenance tests. */
  canDecodeNatively?(): Promise<boolean>
  /** Supplied by the import probe before a local fallback may be loaded. */
  budget?: LocalDecoderBudget
}

export interface DecoderCheckFailure {
  reason: Extract<
    MediaCompatibilityReason,
    'unsupported-codec' | 'resource-limit'
  >
  detail: string
}

export type DecoderCheckResult =
  | {
      decodable: true
      path: MediaDecoderPath
      attemptedFallback: LocalDecoderId | null
      failure: null
    }
  | {
      decodable: false
      path: null
      attemptedFallback: LocalDecoderId | null
      failure: DecoderCheckFailure
    }

export interface MediaCodecFallbackLoaders {
  prores(): Promise<void>
  ac3(): Promise<void>
}

const DEFAULT_LOADERS: MediaCodecFallbackLoaders = {
  prores: async () => {
    const { registerProresDecoder } = await import('@mediabunny/prores')
    registerProresDecoder()
  },
  ac3: async () => {
    const { registerAc3Decoder } = await import('@mediabunny/ac3')
    registerAc3Decoder()
  },
}

function makeAbortError(): Error {
  const error = new Error('Media decoder check was cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError()
}

/**
 * Stop awaiting a non-abortable browser/module operation as soon as the caller
 * aborts. The underlying promise keeps its rejection handler and may finish
 * one-time realm registration in the background, but it can no longer publish
 * a result to the cancelled check.
 */
function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(makeAbortError())

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = (): void => {
      if (settled) return
      settled = true
      reject(makeAbortError())
    }
    signal.addEventListener('abort', abort, { once: true })

    void operation.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (cause: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        reject(cause)
      },
    )
  })
}

function exactBytes(source: unknown): Uint8Array | null {
  try {
    if (ArrayBuffer.isView(source)) {
      return new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      )
    }
    if (source && typeof source === 'object') {
      return new Uint8Array(source as ArrayBuffer)
    }
  } catch {
    // An exotic/invalid BufferSource simply makes this check uncacheable.
  }
  return null
}

function canonicalConfigurationValue(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new TypeError('Decoder configuration is too deeply nested')
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Decoder configuration contains a non-finite number')
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalConfigurationValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {}
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record).sort()) {
      const entry = record[key]
      if (entry !== undefined) {
        normalized[key] = canonicalConfigurationValue(entry, depth + 1)
      }
    }
    return normalized
  }
  throw new TypeError('Decoder configuration contains an unsupported value')
}

async function decoderCapabilityCacheKey(
  target: DecoderCheckTarget,
): Promise<string | null> {
  if (
    !target.configuration
    || !target.trackKind
    || !target.sourceId
    || !target.boundary
    || target.codec === null
    || target.codec.length > 256
  ) return null

  try {
    const configuration = target.configuration as unknown as Record<
      string,
      unknown
    >
    const { description, ...plainConfiguration } = configuration
    const descriptionBytes = description === undefined
      ? new Uint8Array(0)
      : exactBytes(description)
    if (!descriptionBytes) return null

    const canonical = JSON.stringify(canonicalConfigurationValue({
      ...plainConfiguration,
      descriptionPresent: description !== undefined,
    }))
    if (
      canonical.length
        > MEDIA_DECODER_CAPABILITY_CACHE_LIMITS.maxConfigurationJsonCharacters
    ) return null

    const encoder = new TextEncoder()
    const metadata = encoder.encode(canonical)
    if (
      metadata.byteLength + descriptionBytes.byteLength
        > MEDIA_DECODER_CAPABILITY_CACHE_LIMITS.maxConfigurationBytes
    ) return null

    const material = new Uint8Array(
      4 + metadata.byteLength + descriptionBytes.byteLength,
    )
    new DataView(material.buffer).setUint32(0, metadata.byteLength, false)
    material.set(metadata, 4)
    material.set(descriptionBytes, 4 + metadata.byteLength)

    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const digest = new Uint8Array(await subtle.digest('SHA-256', material))
    const fingerprint = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    return [
      target.boundary,
      target.trackKind,
      target.codec,
      fingerprint,
    ].join(':')
  } catch {
    // Capability checks remain correct when hashing is unavailable or unsafe.
    return null
  }
}

function decoderFamily(codec: string | null): LocalDecoderId | null {
  if (codec === 'prores') return 'prores'
  if (codec === 'ac3' || codec === 'eac3') return 'ac3'
  return null
}

function decoderPath(family: LocalDecoderId): MediaDecoderPath {
  return family === 'prores' ? 'local-prores' : 'local-ac3'
}

function fallbackLabel(family: LocalDecoderId): string {
  return family === 'prores' ? 'ProRes' : 'AC-3/E-AC-3'
}

function gibibytes(bytes: number): number {
  return bytes / (1024 * 1024 * 1024)
}

/**
 * Conservative automatic-decode ceilings for locally bundled WASM fallbacks.
 * Crossing one keeps the file visible with an exact resource-limit warning;
 * a later proxy/consent slice can offer an explicit override workflow.
 */
export function localDecoderBudgetProblem(
  codec: string | null,
  budget: LocalDecoderBudget | undefined,
): DecoderCheckFailure | null {
  const family = decoderFamily(codec)
  if (!family) return null
  const label = fallbackLabel(family)

  if (!budget) {
    return {
      reason: 'resource-limit',
      detail: `Local ${label} fallback is disabled because complete, valid source safety metadata is unavailable. Reconnect or re-import the source and retry.`,
    }
  }
  const commonBudgetIsValid = Number.isSafeInteger(budget.fileBytes)
    && budget.fileBytes >= 0
    && Number.isSafeInteger(budget.durationMicroseconds)
    && budget.durationMicroseconds > 0
  const familyBudgetIsValid = family === 'prores'
    ? Number.isSafeInteger(budget.width)
      && (budget.width ?? 0) > 0
      && Number.isSafeInteger(budget.height)
      && (budget.height ?? 0) > 0
      && Number.isFinite(budget.framesPerSecond)
      && (budget.framesPerSecond ?? 0) > 0
    : Number.isSafeInteger(budget.sampleRate)
      && (budget.sampleRate ?? 0) > 0
      && Number.isSafeInteger(budget.channels)
      && (budget.channels ?? 0) > 0
  if (!commonBudgetIsValid || !familyBudgetIsValid) {
    return {
      reason: 'resource-limit',
      detail: `Local ${label} fallback is disabled because complete, valid source safety metadata is unavailable. Reconnect or re-import the source and retry.`,
    }
  }

  if (budget.fileBytes > LOCAL_DECODER_LIMITS.maxFileBytes) {
    return {
      reason: 'resource-limit',
      detail: `Local ${label} fallback is disabled above Myrelith's ${gibibytes(LOCAL_DECODER_LIMITS.maxFileBytes)} GiB automatic decode budget. Create a smaller editing proxy and retry.`,
    }
  }
  if (
    budget.durationMicroseconds
    > LOCAL_DECODER_LIMITS.maxDurationMicroseconds
  ) {
    return {
      reason: 'resource-limit',
      detail: `Local ${label} fallback is disabled above Myrelith's 2-hour automatic decode budget. Create a shorter editing proxy and retry.`,
    }
  }

  if (family === 'prores') {
    const width = budget.width
    const height = budget.height
    const fps = budget.framesPerSecond
    if (
      width !== null
      && width !== undefined
      && height !== null
      && height !== undefined
      && fps !== null
      && fps !== undefined
      && width * height * fps > LOCAL_DECODER_LIMITS.maxProresPixelsPerSecond
    ) {
      return {
        reason: 'resource-limit',
        detail: 'Local ProRes fallback is disabled above Myrelith\'s DCI 4K at 30 fps automatic decode budget. Create a lower-resolution or lower-frame-rate editing proxy and retry.',
      }
    }
  } else if (
    (budget.channels ?? 0) > LOCAL_DECODER_LIMITS.maxAc3Channels
    || (budget.sampleRate ?? 0) > LOCAL_DECODER_LIMITS.maxAc3SampleRate
  ) {
    return {
      reason: 'resource-limit',
      detail: `Local AC-3/E-AC-3 fallback is disabled above Myrelith's ${LOCAL_DECODER_LIMITS.maxAc3Channels}-channel, ${LOCAL_DECODER_LIMITS.maxAc3SampleRate / 1000} kHz automatic decode budget. Create an editing proxy and retry.`,
    }
  }

  return null
}

export class LocalDecoderLoadError extends Error {
  readonly decoderId: LocalDecoderId

  constructor(decoderId: LocalDecoderId, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Local ${fallbackLabel(decoderId)} decoder failed to load: ${detail}`, {
      cause,
    })
    this.name = 'LocalDecoderLoadError'
    this.decoderId = decoderId
  }
}

export interface MediaCodecFallbackRegistry {
  ensureDecodable(
    target: DecoderCheckTarget,
    signal?: AbortSignal,
  ): Promise<DecoderCheckResult>
  /** Register a new source generation; repeated ids invalidate older facts. */
  beginSource(sourceId: string): void
  /** Drop settled facts and block late writes for a removed/replaced source. */
  invalidateSource(sourceId: string): void
  /** Runtime changed, but irreversible fallback registrations remain loaded. */
  invalidateRuntime(): void
  /** Test/HMR seam: clears capability facts and known source generations. */
  resetCapabilities(): void
}

interface CapabilityCacheEntry {
  result: DecoderCheckResult
  family: LocalDecoderId | null
  sourceId: string
}

interface CapabilityWriteToken {
  revision: number
  sequence: number
  sourceGeneration: number
}

function cloneDecoderCheckResult(
  result: DecoderCheckResult,
): DecoderCheckResult {
  if (result.decodable) {
    return {
      decodable: true,
      path: result.path,
      attemptedFallback: result.attemptedFallback,
      failure: null,
    }
  }
  return {
    decodable: false,
    path: null,
    attemptedFallback: result.attemptedFallback,
    failure: { ...result.failure },
  }
}

function cacheableDecoderCheckResult(
  result: DecoderCheckResult,
): DecoderCheckResult {
  const cached = cloneDecoderCheckResult(result)
  cached.attemptedFallback = null
  return cached
}

async function nativeOnlyDecoderSupport(
  target: DecoderCheckTarget,
): Promise<boolean | null> {
  if (!target.configuration || !target.trackKind) return null
  try {
    if (target.canDecodeNatively) return await target.canDecodeNatively()
    const decoders = globalThis as unknown as {
      VideoDecoder?: {
        isConfigSupported(
          config: VideoDecoderConfig,
        ): Promise<{ supported?: boolean }>
      }
      AudioDecoder?: {
        isConfigSupported(
          config: AudioDecoderConfig,
        ): Promise<{ supported?: boolean }>
      }
    }
    const result = target.trackKind === 'video'
      ? await decoders.VideoDecoder?.isConfigSupported(
          target.configuration as VideoDecoderConfig,
        )
      : await decoders.AudioDecoder?.isConfigSupported(
          target.configuration as AudioDecoderConfig,
        )
    return result ? result.supported === true : null
  } catch {
    // Mediabunny's effective check remains authoritative when the browser's
    // native-only query is absent or rejects an extension-specific config.
    return null
  }
}

function applyCurrentBudget(
  target: DecoderCheckTarget,
  result: DecoderCheckResult,
): DecoderCheckResult {
  if (!result.decodable || result.path === 'native') {
    return cloneDecoderCheckResult(result)
  }
  const family = decoderFamily(target.codec)
  const problem = localDecoderBudgetProblem(target.codec, target.budget)
  if (!family || !problem) return cloneDecoderCheckResult(result)
  return {
    decodable: false,
    path: null,
    attemptedFallback: family,
    failure: problem,
  }
}

/** Build an isolated registry (used by tests and once per production realm). */
export function createMediaCodecFallbackRegistry(
  loaders: MediaCodecFallbackLoaders = DEFAULT_LOADERS,
): MediaCodecFallbackRegistry {
  const registered = new Set<LocalDecoderId>()
  const pending = new Map<LocalDecoderId, Promise<void>>()
  const settledCapabilities = new Map<string, CapabilityCacheEntry>()
  const activeSources = new Set<string>()
  const sourceGenerations = new Map<string, number>()
  const latestWriteSequence = new Map<string, number>()
  let capabilityRevision = 0
  let writeSequence = 0
  let sourceGenerationSequence = 0

  const advanceRevision = (): void => {
    capabilityRevision = capabilityRevision === Number.MAX_SAFE_INTEGER
      ? 0
      : capabilityRevision + 1
    latestWriteSequence.clear()
  }

  const clearCapabilities = (): void => {
    settledCapabilities.clear()
    advanceRevision()
  }

  const invalidateFamily = (family: LocalDecoderId): void => {
    for (const [key, entry] of settledCapabilities) {
      if (entry.family === family) settledCapabilities.delete(key)
    }
    // Also blocks unrelated late writes. Losing one cache publication is safer
    // than allowing a pre-registration answer to reappear after the realm
    // gained a decoder.
    advanceRevision()
  }

  const readCapability = (
    key: string,
    sourceId: string,
  ): DecoderCheckResult | null => {
    const entry = settledCapabilities.get(key)
    if (!entry) return null
    settledCapabilities.delete(key)
    entry.sourceId = sourceId
    settledCapabilities.set(key, entry)
    return cloneDecoderCheckResult(entry.result)
  }

  const sourceGeneration = (sourceId: string | undefined): number | null => {
    if (!sourceId || !activeSources.has(sourceId)) return null
    return sourceGenerations.get(sourceId) ?? null
  }

  const sourceGenerationIsCurrent = (
    sourceId: string | undefined,
    generation: number | null,
  ): boolean => (
    sourceId !== undefined
    && generation !== null
    && activeSources.has(sourceId)
    && sourceGenerations.get(sourceId) === generation
  )

  const beginWrite = (
    key: string | null,
    generation: number | null,
  ): CapabilityWriteToken | null => {
    if (!key || generation === null) return null
    const sequence = ++writeSequence
    latestWriteSequence.set(key, sequence)
    return {
      revision: capabilityRevision,
      sequence,
      sourceGeneration: generation,
    }
  }

  const finishWrite = (
    key: string | null,
    token: CapabilityWriteToken | null,
    sourceId: string | undefined,
    family: LocalDecoderId | null,
    result: DecoderCheckResult,
  ): void => {
    if (!key || !token || !sourceId) return
    if (
      token.revision !== capabilityRevision
      || latestWriteSequence.get(key) !== token.sequence
      || !sourceGenerationIsCurrent(sourceId, token.sourceGeneration)
    ) return
    latestWriteSequence.delete(key)
    settledCapabilities.delete(key)
    settledCapabilities.set(key, {
      result: cacheableDecoderCheckResult(result),
      family,
      sourceId,
    })
    while (
      settledCapabilities.size
        > MEDIA_DECODER_CAPABILITY_CACHE_LIMITS.maxEntries
    ) {
      const oldest = settledCapabilities.keys().next().value as
        | string
        | undefined
      if (oldest === undefined) break
      settledCapabilities.delete(oldest)
    }
  }

  const releaseWrite = (
    key: string | null,
    token: CapabilityWriteToken | null,
  ): void => {
    if (
      key
      && token
      && latestWriteSequence.get(key) === token.sequence
    ) latestWriteSequence.delete(key)
  }

  const register = async (family: LocalDecoderId): Promise<void> => {
    if (registered.has(family)) return
    const existing = pending.get(family)
    if (existing) return existing

    const load = loaders[family]()
      .then(() => {
        registered.add(family)
        invalidateFamily(family)
      })
      .catch((cause: unknown) => {
        throw new LocalDecoderLoadError(family, cause)
      })
      .finally(() => {
        if (pending.get(family) === load) pending.delete(family)
      })
    pending.set(family, load)
    return load
  }

  return {
    beginSource(sourceId: string): void {
      if (!sourceId) return
      if (activeSources.has(sourceId)) clearCapabilities()
      if (sourceGenerationSequence === Number.MAX_SAFE_INTEGER) {
        activeSources.clear()
        sourceGenerations.clear()
        sourceGenerationSequence = 0
        clearCapabilities()
      }
      sourceGenerationSequence++
      activeSources.add(sourceId)
      sourceGenerations.set(sourceId, sourceGenerationSequence)
      if (
        activeSources.size
          > MEDIA_DECODER_CAPABILITY_CACHE_LIMITS.maxSources
      ) {
        activeSources.clear()
        sourceGenerations.clear()
        activeSources.add(sourceId)
        sourceGenerations.set(sourceId, sourceGenerationSequence)
        clearCapabilities()
      }
    },

    invalidateSource(sourceId: string): void {
      activeSources.delete(sourceId)
      sourceGenerations.delete(sourceId)
      for (const [key, entry] of settledCapabilities) {
        if (entry.sourceId === sourceId) settledCapabilities.delete(key)
      }
      // Even with no settled entry, prevent an in-flight check for this source
      // from repopulating the session cache after removal/replacement.
      advanceRevision()
    },

    invalidateRuntime(): void {
      clearCapabilities()
    },

    resetCapabilities(): void {
      activeSources.clear()
      sourceGenerations.clear()
      clearCapabilities()
    },

    async ensureDecodable(
      target: DecoderCheckTarget,
      signal?: AbortSignal,
    ): Promise<DecoderCheckResult> {
      throwIfAborted(signal)
      const family = decoderFamily(target.codec)
      const keyRevision = capabilityRevision
      const keySourceGeneration = sourceGeneration(target.sourceId)
      const cacheKey = await awaitWithAbort(
        decoderCapabilityCacheKey(target),
        signal,
      )
      throwIfAborted(signal)

      if (
        target.policy === 'reuse'
        && target.boundary === 'probe'
        && cacheKey
        && keyRevision === capabilityRevision
        && target.sourceId
        && sourceGenerationIsCurrent(
          target.sourceId,
          keySourceGeneration,
        )
      ) {
        const cached = readCapability(cacheKey, target.sourceId)
        if (cached) return applyCurrentBudget(target, cached)
      }

      let writeToken = keyRevision === capabilityRevision
        && sourceGenerationIsCurrent(
          target.sourceId,
          keySourceGeneration,
        )
        ? beginWrite(cacheKey, keySourceGeneration)
        : null
      const finish = (result: DecoderCheckResult): DecoderCheckResult => {
        finishWrite(
          cacheKey,
          writeToken,
          target.sourceId,
          family,
          result,
        )
        return applyCurrentBudget(target, result)
      }

      try {
        if (family && registered.has(family)) {
          const nativeSupport = await awaitWithAbort(
            nativeOnlyDecoderSupport(target),
            signal,
          )
          throwIfAborted(signal)
          if (nativeSupport === true) {
            return finish({
              decodable: true,
              path: 'native',
              attemptedFallback: null,
              failure: null,
            })
          }

          const resourceProblem = localDecoderBudgetProblem(
            target.codec,
            target.budget,
          )
          if (resourceProblem) {
            return {
              decodable: false,
              path: null,
              attemptedFallback: family,
              failure: resourceProblem,
            }
          }

          const effectivelyDecodable = await awaitWithAbort(
            target.canDecode(),
            signal,
          )
          throwIfAborted(signal)
          if (effectivelyDecodable) {
            return finish({
              decodable: true,
              path: decoderPath(family),
              attemptedFallback: null,
              failure: null,
            })
          }
          return finish({
            decodable: false,
            path: null,
            attemptedFallback: null,
            failure: {
              reason: 'unsupported-codec',
              detail: `Myrelith's local ${fallbackLabel(family)} decoder does not support this track configuration.`,
            },
          })
        }

        const initiallyDecodable = await awaitWithAbort(
          target.canDecode(),
          signal,
        )
        throwIfAborted(signal)

        if (initiallyDecodable) {
          return finish({
            decodable: true,
            path: 'native',
            attemptedFallback: null,
            failure: null,
          })
        }
        if (!family) {
          return finish({
            decodable: false,
            path: null,
            attemptedFallback: null,
            failure: {
              reason: 'unsupported-codec',
              detail: 'This browser cannot decode this media codec, and Myrelith has no reviewed local fallback for it.',
            },
          })
        }

        const resourceProblem = localDecoderBudgetProblem(
          target.codec,
          target.budget,
        )
        if (resourceProblem) {
          return {
            decodable: false,
            path: null,
            attemptedFallback: family,
            failure: resourceProblem,
          }
        }

        await awaitWithAbort(register(family), signal)
        throwIfAborted(signal)
        // Registration is a runtime change and deliberately invalidated the
        // old write token. The post-registration check is fresh evidence.
        writeToken = sourceGenerationIsCurrent(
          target.sourceId,
          keySourceGeneration,
        )
          ? beginWrite(cacheKey, keySourceGeneration)
          : null

        const nativeSupport = await awaitWithAbort(
          nativeOnlyDecoderSupport(target),
          signal,
        )
        throwIfAborted(signal)
        if (nativeSupport === true) {
          return finish({
            decodable: true,
            path: 'native',
            attemptedFallback: family,
            failure: null,
          })
        }

        const decodable = await awaitWithAbort(target.canDecode(), signal)
        throwIfAborted(signal)
        if (!decodable) {
          return finish({
            decodable: false,
            path: null,
            attemptedFallback: family,
            failure: {
              reason: 'unsupported-codec',
              detail: `Myrelith's local ${fallbackLabel(family)} decoder does not support this track configuration.`,
            },
          })
        }
        return finish({
          decodable: true,
          path: decoderPath(family),
          attemptedFallback: family,
          failure: null,
        })
      } finally {
        releaseWrite(cacheKey, writeToken)
      }
    },
  }
}

/** Shared by every decode surface in the current window or worker realm. */
export const mediaCodecFallbackRegistry = createMediaCodecFallbackRegistry()

export const ensureMediaDecoderSupport =
  mediaCodecFallbackRegistry.ensureDecodable

export const beginMediaDecoderSource =
  mediaCodecFallbackRegistry.beginSource

export const invalidateMediaDecoderSource =
  mediaCodecFallbackRegistry.invalidateSource

export const invalidateMediaDecoderRuntime =
  mediaCodecFallbackRegistry.invalidateRuntime

export const resetMediaDecoderCapabilities =
  mediaCodecFallbackRegistry.resetCapabilities
