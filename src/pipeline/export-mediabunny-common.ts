import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import {
  MediaAssetRuntimeError,
  type MediaRuntimeFailure,
} from '../domain/mediaCompatibility'
import type { AssetId, AssetKind } from '../domain/schema'

/** Resolves one immutable session source and its local-fallback safety budget. */
export interface ResolvedExportAsset {
  blob: Blob
  budget: LocalDecoderBudget
  kind: AssetKind
}

export type ExportAssetResolver = (
  assetId: AssetId,
) => ResolvedExportAsset | Promise<ResolvedExportAsset>

function runtimeFailureDetail(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return detail.slice(0, 2_048)
}

export function exportAssetError(
  assetId: AssetId,
  trackKind: MediaRuntimeFailure['trackKind'],
  reason: MediaRuntimeFailure['reason'],
  cause: unknown,
): MediaAssetRuntimeError {
  if (
    cause instanceof MediaAssetRuntimeError
    && cause.assetId === assetId
    && cause.failure.surface === 'export'
    && cause.failure.trackKind === trackKind
  ) return cause
  return new MediaAssetRuntimeError(assetId, {
    surface: 'export',
    trackKind,
    reason,
    detail: runtimeFailureDetail(cause),
  }, cause)
}
