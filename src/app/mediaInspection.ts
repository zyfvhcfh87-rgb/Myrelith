/**
 * The one real File -> MediaAsset inspection path used by import and relink.
 * The returned asset owns one live object URL; callers must either commit it
 * to mediaStore or revoke it on every rejected/cancelled path.
 */

import type { FrameRate, MediaAsset } from '../domain/schema'
import { loadAsset, type LoadedAsset } from '../pipeline/demux'

function discardLoadedAsset(loaded: LoadedAsset): void {
  try {
    loaded.input.dispose()
  } catch {
    // Preserve the useful inspection error while still releasing the URL.
  }
  URL.revokeObjectURL(loaded.asset.objectUrl)
}

export async function inspectMediaFile(
  file: File,
  documentRate: FrameRate,
): Promise<MediaAsset> {
  const loaded = await loadAsset(file, documentRate)
  if (loaded.asset.kind === 'video' && !loaded.asset.frameRate) {
    discardLoadedAsset(loaded)
    throw new Error(`"${file.name}" has no detectable video frame rate`)
  }
  try {
    loaded.input.dispose()
  } catch (cause) {
    URL.revokeObjectURL(loaded.asset.objectUrl)
    throw cause
  }
  return loaded.asset
}
