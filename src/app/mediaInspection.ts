/**
 * Shared File inspection facades. Imports consume the typed compatibility
 * result; legacy project relink callers keep the ready-asset wrapper until
 * compatibility is threaded through that separate workflow.
 */

import type { FrameRate, MediaAsset } from '../domain/schema'
import {
  MediaCompatibilityError,
  probeMediaFile,
  type MediaProbeResult,
} from '../pipeline/mediaCompatibilityProbe'

export function inspectMediaFileCompatibility(
  file: File,
  documentRate: FrameRate,
  assetId: string,
  signal?: AbortSignal,
): Promise<MediaProbeResult> {
  return probeMediaFile(file, documentRate, assetId, signal)
}

export async function inspectMediaFile(
  file: File,
  documentRate: FrameRate,
): Promise<MediaAsset> {
  const result = await probeMediaFile(
    file,
    documentRate,
    `asset_${crypto.randomUUID()}`,
  )
  if (result.status !== 'ready') {
    throw new MediaCompatibilityError(result.compatibility)
  }
  return result.asset
}
