/**
 * Shared typed File inspection facade for imports, Resume, and Relink.
 */

import type { FrameRate } from '../domain/schema'
import {
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
