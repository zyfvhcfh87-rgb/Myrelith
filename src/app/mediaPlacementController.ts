/**
 * Shared media-placement composition root.
 *
 * Internal Media Pool asset drops and OS file drops both resolve through
 * domain/mediaPlacement.ts, then commit with the existing insertClip(s)
 * history actions. OS files are imported first via mediaImportController;
 * a successful import is never rolled back if placement later fails.
 *
 * File objects stay in this call stack. They never enter a store.
 */

import { clipFromAsset } from '../domain/operations'
import { createLinkGroupId } from '../domain/linking'
import { compatibilityAllowsTimelineUse } from '../domain/mediaCompatibility'
import {
  planMediaAssetPlacement,
  resolveTimelineFileDropPolicy,
  TIMELINE_MULTI_FILE_DROP_MESSAGE,
  type MediaPlacementRejection,
} from '../domain/mediaPlacement'
import type { TrackId } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  useTransportStore,
  type MediaPlacementPreview,
} from '../state/transportStore'
import {
  importMedia,
  importMediaFiles,
  type MediaImportSelectionResult,
} from './mediaImportController'

export type PlaceImportedAssetResult =
  | { status: 'placed'; assetId: string }
  | { status: 'not-placed'; assetId: string; reason: MediaPlacementRejection }

export type TimelineFileDropResult =
  | PlaceImportedAssetResult
  | { status: 'refused'; message: string }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'unsupported'; assetId?: string }
  | { status: 'failed'; message: string }

let timelineDropGeneration = 0

function setStatus(status: string): void {
  useTransportStore.getState().setMediaPlacementStatus(status)
}

export function setMediaPlacementPreview(
  preview: MediaPlacementPreview | null,
): void {
  useTransportStore.getState().setMediaPlacementPreview(preview)
}

export function clearMediaPlacementPreview(): void {
  setMediaPlacementPreview(null)
}

export function announceMediaPoolFileDrop(fileCount: number): void {
  setStatus(
    fileCount === 1
      ? 'Importing 1 file.'
      : `Importing ${fileCount} files.`,
  )
}

export function importDroppedMediaFiles(
  files: readonly File[],
): Promise<MediaImportSelectionResult> {
  if (files.length === 0) {
    setStatus('No files to import.')
    return Promise.resolve({ status: 'cancelled' })
  }
  announceMediaPoolFileDrop(files.length)
  return importMediaFiles(files)
}

export function placeImportedAsset(
  expectedDocumentId: string,
  assetId: string,
  trackId: TrackId,
  startFrame: number,
  announce = false,
): PlaceImportedAssetResult {
  const documentStore = useDocumentStore.getState()
  if (documentStore.doc.id !== expectedDocumentId) {
    const result: PlaceImportedAssetResult = {
      status: 'not-placed',
      assetId,
      reason: 'stale-document',
    }
    if (announce) {
      const name = useMediaStore.getState().assets.get(assetId)?.fileName
        ?? 'media'
      setStatus(`Imported ${name}, but it could not be placed on that lane.`)
    }
    return result
  }

  const media = useMediaStore.getState()
  const asset = media.assets.get(assetId) ?? null
  const plan = planMediaAssetPlacement({
    doc: documentStore.doc,
    asset,
    trackId,
    startFrame,
    timelineCompatible: compatibilityAllowsTimelineUse(
      media.compatibility.get(assetId),
    ),
  })
  if (plan.status === 'reject' || !asset) {
    const result: PlaceImportedAssetResult = {
      status: 'not-placed',
      assetId,
      reason: plan.status === 'reject' ? plan.reason : 'missing-asset',
    }
    if (announce) {
      setStatus(
        `Imported ${asset?.fileName ?? 'media'}, but it could not be placed on that lane.`,
      )
    }
    return result
  }

  const pastLength = documentStore.past.length
  if (plan.status === 'place-linked') {
    const linkGroupId = createLinkGroupId(documentStore.doc)
    documentStore.insertClips([
      {
        trackId: plan.videoTrackId,
        clip: clipFromAsset(asset, plan.startFrame, linkGroupId),
      },
      {
        trackId: plan.audioTrackId,
        clip: clipFromAsset(asset, plan.startFrame, linkGroupId),
      },
    ])
  } else {
    documentStore.insertClip(
      plan.trackId,
      clipFromAsset(asset, plan.startFrame),
    )
  }

  if (useDocumentStore.getState().past.length === pastLength) {
    if (announce) {
      setStatus(
        `Imported ${asset.fileName}, but it could not be placed on that lane.`,
      )
    }
    return { status: 'not-placed', assetId, reason: 'commit-rejected' }
  }

  if (announce) setStatus(`Placed ${asset.fileName} on the timeline.`)
  return { status: 'placed', assetId }
}

export async function dropOsFilesOnTimeline(input: {
  documentId: string
  trackId: TrackId
  startFrame: number
  fileName?: string
  files: readonly File[]
}): Promise<TimelineFileDropResult> {
  const policy = resolveTimelineFileDropPolicy(input.files.length)
  if (policy.status === 'refuse') {
    clearMediaPlacementPreview()
    setStatus(policy.message)
    return { status: 'refused', message: policy.message }
  }

  const file = input.files[0]
  const generation = ++timelineDropGeneration
  const fileName = input.fileName ?? file.name
  setMediaPlacementPreview({
    trackId: input.trackId,
    startFrame: input.startFrame,
    durationFrames: null,
    valid: true,
    phase: 'pending',
  })
  setStatus(`Analyzing ${fileName} for placement.`)

  const imported = await importMedia(file)
  if (generation !== timelineDropGeneration) {
    return { status: 'cancelled' }
  }

  if (imported.status === 'busy') {
    clearMediaPlacementPreview()
    setStatus('Import already in progress.')
    return { status: 'busy' }
  }
  if (imported.status === 'cancelled') {
    clearMediaPlacementPreview()
    setStatus('Import cancelled.')
    return { status: 'cancelled' }
  }
  if (imported.status === 'limited' || imported.status === 'unsupported') {
    clearMediaPlacementPreview()
    setStatus(`Could not import ${fileName}.`)
    return { status: 'unsupported', assetId: imported.itemId }
  }
  if (imported.status === 'failed') {
    clearMediaPlacementPreview()
    setStatus(imported.message)
    return { status: 'failed', message: imported.message }
  }

  const placed = placeImportedAsset(
    input.documentId,
    imported.assetId,
    input.trackId,
    input.startFrame,
    true,
  )
  clearMediaPlacementPreview()
  return placed
}

export function teardownMediaPlacementUi(): void {
  timelineDropGeneration += 1
  clearMediaPlacementPreview()
  setStatus('')
}

export function resetMediaPlacementControllerForTest(): void {
  teardownMediaPlacementUi()
}

export { TIMELINE_MULTI_FILE_DROP_MESSAGE }
