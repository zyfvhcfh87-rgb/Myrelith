import type { SequenceProject } from '../domain/projectSequences'
import { projectMediaAssetIds } from '../domain/projectSequences'
import { useMediaStore } from '../state/mediaStore'
import {
  forgetImportedMediaHandle,
  removeMediaCompatibility,
} from './mediaImportController'

export function mediaAssetIsUsedOnTimeline(
  project: SequenceProject,
  assetId: string,
): boolean {
  return projectMediaAssetIds(project).has(assetId)
}

export function mediaAssetRemovalDisabledReason(
  project: SequenceProject,
  assetId: string,
): string | null {
  return mediaAssetIsUsedOnTimeline(project, assetId)
    ? 'Remove this media\'s clips from every sequence before removing its source.'
    : null
}

/** Revalidate and remove one exact Media Pool target without prompting. */
export function removeMediaAssetFromProject(
  project: SequenceProject,
  assetId: string,
): boolean {
  const media = useMediaStore.getState()
  const descriptor = media.descriptors.get(assetId)
  const compatibility = media.compatibility.get(assetId)
  if (!descriptor && !compatibility) return false
  if (mediaAssetRemovalDisabledReason(project, assetId)) return false
  if (!descriptor) {
    removeMediaCompatibility(assetId)
    return !useMediaStore.getState().compatibility.has(assetId)
  }
  forgetImportedMediaHandle(assetId)
  media.removeAsset(assetId)
  return !useMediaStore.getState().descriptors.has(assetId)
}
