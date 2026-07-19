/**
 * Realm-local, lazy registration for WebCut's reviewed decoder fallbacks.
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

export type LocalDecoderId = 'prores' | 'ac3'

export interface LocalDecoderBudget {
  fileBytes: number
  durationMicroseconds: number
  width?: number | null
  height?: number | null
  framesPerSecond?: number | null
  sampleRate?: number | null
  channels?: number | null
}

export const LOCAL_DECODER_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  maxDurationMicroseconds: 2 * 60 * 60 * 1_000_000,
  maxProresPixelsPerSecond: 4096 * 2160 * 30,
  maxAc3SampleRate: 48_000,
  maxAc3Channels: 8,
})

export interface DecoderCheckTarget {
  /** Mediabunny's normalized codec id, never a filename or MIME guess. */
  codec: string | null
  canDecode(): Promise<boolean>
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
  if (!family || !budget) return null
  const label = fallbackLabel(family)

  if (budget.fileBytes > LOCAL_DECODER_LIMITS.maxFileBytes) {
    return {
      reason: 'resource-limit',
      detail: `Local ${label} fallback is disabled above WebCut's ${gibibytes(LOCAL_DECODER_LIMITS.maxFileBytes)} GiB automatic decode budget. Create a smaller editing proxy and retry.`,
    }
  }
  if (
    budget.durationMicroseconds
    > LOCAL_DECODER_LIMITS.maxDurationMicroseconds
  ) {
    return {
      reason: 'resource-limit',
      detail: `Local ${label} fallback is disabled above WebCut's 2-hour automatic decode budget. Create a shorter editing proxy and retry.`,
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
        detail: 'Local ProRes fallback is disabled above WebCut\'s DCI 4K at 30 fps automatic decode budget. Create a lower-resolution or lower-frame-rate editing proxy and retry.',
      }
    }
  } else if (
    (budget.channels ?? 0) > LOCAL_DECODER_LIMITS.maxAc3Channels
    || (budget.sampleRate ?? 0) > LOCAL_DECODER_LIMITS.maxAc3SampleRate
  ) {
    return {
      reason: 'resource-limit',
      detail: `Local AC-3/E-AC-3 fallback is disabled above WebCut's ${LOCAL_DECODER_LIMITS.maxAc3Channels}-channel, ${LOCAL_DECODER_LIMITS.maxAc3SampleRate / 1000} kHz automatic decode budget. Create an editing proxy and retry.`,
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
}

/** Build an isolated registry (used by tests and once per production realm). */
export function createMediaCodecFallbackRegistry(
  loaders: MediaCodecFallbackLoaders = DEFAULT_LOADERS,
): MediaCodecFallbackRegistry {
  const registered = new Set<LocalDecoderId>()
  const pending = new Map<LocalDecoderId, Promise<void>>()

  const register = async (family: LocalDecoderId): Promise<void> => {
    if (registered.has(family)) return
    const existing = pending.get(family)
    if (existing) return existing

    const load = loaders[family]()
      .then(() => {
        registered.add(family)
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
    async ensureDecodable(
      target: DecoderCheckTarget,
      signal?: AbortSignal,
    ): Promise<DecoderCheckResult> {
      throwIfAborted(signal)
      const family = decoderFamily(target.codec)
      const initiallyDecodable = await target.canDecode()
      throwIfAborted(signal)

      if (initiallyDecodable) {
        return {
          decodable: true,
          path: family && registered.has(family)
            ? decoderPath(family)
            : 'native',
          attemptedFallback: null,
          failure: null,
        }
      }
      if (!family) {
        return {
          decodable: false,
          path: null,
          attemptedFallback: null,
          failure: {
            reason: 'unsupported-codec',
            detail: 'This browser cannot decode this media codec, and WebCut has no reviewed local fallback for it.',
          },
        }
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

      await register(family)
      throwIfAborted(signal)
      const decodable = await target.canDecode()
      throwIfAborted(signal)
      if (!decodable) {
        return {
          decodable: false,
          path: null,
          attemptedFallback: family,
          failure: {
            reason: 'unsupported-codec',
            detail: `WebCut's local ${fallbackLabel(family)} decoder does not support this track configuration.`,
          },
        }
      }
      return {
        decodable: true,
        path: decoderPath(family),
        attemptedFallback: family,
        failure: null,
      }
    },
  }
}

/** Shared by every decode surface in the current window or worker realm. */
export const mediaCodecFallbackRegistry = createMediaCodecFallbackRegistry()

export const ensureMediaDecoderSupport =
  mediaCodecFallbackRegistry.ensureDecodable
