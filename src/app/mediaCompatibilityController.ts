/**
 * Session compatibility composition root.
 *
 * Runtime consumers capture an exact connection guard before asynchronous
 * work. A later failure can disconnect only that same URL/report generation;
 * stale preview/audio/export work is therefore harmless after a relink.
 */

import {
  withMediaRuntimeFailure,
  type MediaCompatibilityItem,
  type MediaRuntimeFailure,
  type MediaRuntimeSurface,
} from '../domain/mediaCompatibility'
import type { MediaAsset } from '../domain/schema'
import { useMediaStore } from '../state/mediaStore'
import { invalidateMediaDecoderSource } from '../codecs/mediaCodecFallbacks'

export interface MediaRuntimeGuard {
  assetId: string
  objectUrl: string
  compatibilityRequestId: string | null
}

let runtimeRequestId = 0

function detailFrom(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return detail.slice(0, 2_048)
}

export function checkingCompatibilityItem(
  id: string,
  requestId: string,
  file: Pick<File, 'name' | 'type' | 'size' | 'lastModified'>,
): MediaCompatibilityItem {
  return {
    id,
    requestId,
    fileName: file.name,
    declaredMimeType: file.type,
    size: file.size,
    lastModified: file.lastModified,
    status: 'checking',
    report: null,
  }
}

export function compatibilityItemForAsset(
  asset: MediaAsset,
  requestId: string,
  status: MediaCompatibilityItem['status'],
  report: MediaCompatibilityItem['report'],
): MediaCompatibilityItem {
  return {
    id: asset.id,
    requestId,
    fileName: asset.fileName,
    declaredMimeType: asset.mimeType,
    size: asset.size,
    lastModified: asset.lastModified,
    status,
    report,
  }
}

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
  return { surface, trackKind, reason, detail: detailFrom(cause) }
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
