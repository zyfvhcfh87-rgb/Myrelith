import type { TimelineDoc } from '../domain/schema'
import { useMediaStore } from '../state/mediaStore'
import {
  forgetImportedMediaHandle,
  removeMediaCompatibility,
} from './mediaImportController'

export function mediaAssetIsUsedOnTimeline(
  doc: TimelineDoc,
  assetId: string,
): boolean {
  return doc.tracks.some((track) => track.clips.some(
    (clip) => clip.text === undefined && clip.assetId === assetId,
  ))
}

export function mediaAssetRemovalDisabledReason(
  doc: TimelineDoc,
  assetId: string,
): string | null {
  return mediaAssetIsUsedOnTimeline(doc, assetId)
    ? 'Remove this media\'s clips from the timeline before removing its source.'
    : null
}

/** Revalidate and remove one exact Media Pool target without prompting. */
export function removeMediaAssetFromProject(
  doc: TimelineDoc,
  assetId: string,
): boolean {
  const media = useMediaStore.getState()
  const descriptor = media.descriptors.get(assetId)
  const compatibility = media.compatibility.get(assetId)
  if (!descriptor && !compatibility) return false
  if (mediaAssetRemovalDisabledReason(doc, assetId)) return false
  if (!descriptor) {
    removeMediaCompatibility(assetId)
    return !useMediaStore.getState().compatibility.has(assetId)
  }
  forgetImportedMediaHandle(assetId)
  media.removeAsset(assetId)
  return !useMediaStore.getState().descriptors.has(assetId)
}
