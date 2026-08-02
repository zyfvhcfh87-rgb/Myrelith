/** Stable facade for the split Mediabunny export adapters. */

import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type { ExportDeps } from './export'
import type { PreparedExportFileCapability } from './export-file-target'
import { createMediabunnyExportSink } from './export-mediabunny-sink'
import type { ExportAssetResolver } from './export-mediabunny-common'
import { compositeFrame } from './render'

export type {
  ExportAssetResolver,
  ResolvedExportAsset,
} from './export-mediabunny-common'
export { createMediabunnyExportMediaSource } from './export-mediabunny-visual-source'
export { createMediabunnyExportAudioSource } from './export-mediabunny-audio-source'
export { createMediabunnyExportSink } from './export-mediabunny-sink'

/** Production dependencies for exportTimeline, closed over the Blob resolver. */
export function createMediabunnyExportDeps(
  resolveAsset: ExportAssetResolver,
  sourceBounds: SourceBoundsCatalog = new Map(),
  fileDestination?: PreparedExportFileCapability,
): ExportDeps {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }
  return {
    composite: compositeFrame,
    createVideoSink: (doc, settings) =>
      createMediabunnyExportSink(
        doc,
        settings,
        resolveAsset,
        sourceBounds,
        fileDestination,
      ),
  }
}
