/**
 * Pure compatibility-row builders shared by import, relink and project open.
 * Kept free of decoder runtime imports so the launcher can build rows without
 * loading the codec fallbacks that mediaCompatibilityController owns.
 */

import type { MediaCompatibilityItem } from '../domain/mediaCompatibility'
import type { MediaAsset } from '../domain/schema'

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
