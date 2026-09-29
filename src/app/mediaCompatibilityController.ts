/**
 * Session compatibility composition root.
 *
 * Runtime consumers capture an exact connection guard before asynchronous
 * work. A later failure can disconnect only that same URL/report generation;
 * stale preview/audio/export work is therefore harmless after a relink.
 */

import { runtimeFailureDetail } from '../domain/errors'
import {
  withMediaRuntimeFailure,
  type MediaRuntimeFailure,
  type MediaRuntimeSurface,
} from '../domain/mediaCompatibility'
import { useMediaStore } from '../state/mediaStore'
import { invalidateMediaDecoderSource } from '../codecs/mediaCodecFallbacks'
import { compatibilityItemForAsset } from './mediaCompatibilityItems'

export interface MediaRuntimeGuard {
  assetId: string
  objectUrl: string
  compatibilityRequestId: string | null
}

let runtimeRequestId = 0

export function captureMediaRuntimeGuard(
  assetId: string,
): MediaRuntimeGuard | null {
  const media = useMediaStore.getState()
  const asset = media.assets.get(assetId)
  if (!asset) return null
  return {
    assetId,
    objectUrl: asset.objectUrl,
    compatibilityRequestId:
      media.compatibility.get(assetId)?.requestId ?? null,
  }
}

export function mediaRuntimeFailure(
  surface: MediaRuntimeSurface,
  trackKind: MediaRuntimeFailure['trackKind'],
  cause: unknown,
  reason: MediaRuntimeFailure['reason'] = 'decode-failed',
): MediaRuntimeFailure {
  return { surface, trackKind, reason, detail: runtimeFailureDetail(cause) }
}

/** Atomically expose a confirmed asset failure and leave its descriptor offline. */
export function reportMediaRuntimeFailure(
  guard: MediaRuntimeGuard,
  failure: MediaRuntimeFailure,
): boolean {
  const media = useMediaStore.getState()
  const asset = media.assets.get(guard.assetId)
  if (!asset || asset.objectUrl !== guard.objectUrl) return false
  const current = media.compatibility.get(guard.assetId)
  const requestId = current?.requestId
    ?? `runtime_${++runtimeRequestId}`
  const report = withMediaRuntimeFailure(current?.report ?? null, failure)
  const item = compatibilityItemForAsset(asset, requestId, 'error', report)
  const failed = media.failAssetCompatibility(
    guard.assetId,
    guard.objectUrl,
    guard.compatibilityRequestId,
    item,
  )
  if (failed) invalidateMediaDecoderSource(guard.assetId)
  return failed
}

/** Test/HMR seam; compatibility generations in state remain authoritative. */
export function resetMediaCompatibilityController(): void {
  runtimeRequestId = 0
}
