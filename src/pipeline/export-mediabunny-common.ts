import type { LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import {
  mediaAssetRuntimeError,
  type MediaAssetRuntimeError,
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

export function exportAssetError(
  assetId: AssetId,
  trackKind: MediaRuntimeFailure['trackKind'],
  reason: MediaRuntimeFailure['reason'],
  cause: unknown,
): MediaAssetRuntimeError {
  return mediaAssetRuntimeError(assetId, 'export', trackKind, reason, cause)
}
