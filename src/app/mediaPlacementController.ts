/**
 * Shared media-placement composition root.
 *
 * Internal Media Pool asset drops and OS file drops both resolve through
 * domain/mediaPlacement.ts, then commit with the existing insertClip(s)
 * history actions. OS files are imported first via mediaImportController;
 * a successful import is never rolled back if placement later fails.
 *
 * File objects stay in this call stack. They never enter a store. UI reads
 * placement decisions from this facade — it does not runtime-import the
 * domain planner.
 */

import { clipFromAsset } from '../domain/operations'
import { createLinkGroupId } from '../domain/linking'
import { compatibilityAllowsTimelineUse } from '../domain/mediaCompatibility'
import {
  planMediaAssetPlacement,
  resolveTimelineFileDropPolicy,
  timelineFrameFromPointer as domainTimelineFrameFromPointer,
  trackKindAcceptsAssetKind as domainTrackKindAcceptsAssetKind,
  visiblePlacementPreviewRange as domainVisiblePlacementPreviewRange,
  TIMELINE_MULTI_FILE_DROP_MESSAGE,
  type MediaPlacementPreviewRange,
  type MediaPlacementRejection,
} from '../domain/mediaPlacement'
import type { AssetKind, TrackId, TrackKind } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  useTransportStore,
  type MediaPlacementPreview,
} from '../state/transportStore'
import {
  importMedia,
  importMediaFiles,
  type MediaImportResult,
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
let previewEpoch = 0

function setStatus(status: string): void {
  useTransportStore.getState().setMediaPlacementStatus(status)
}

function bumpPreviewEpoch(): void {
  previewEpoch += 1
}

export function mediaPlacementPreviewEpoch(): number {
  return previewEpoch
}

export function invalidateMediaPlacementHover(): void {
  bumpPreviewEpoch()
}

function setMediaPlacementPreview(
  preview: MediaPlacementPreview | null,
): void {
  useTransportStore.getState().setMediaPlacementPreview(preview)
}

export function clearMediaPlacementPreview(): void {
  bumpPreviewEpoch()
  setMediaPlacementPreview(null)
}

/** Ignore a coalesced hover write after drop, leave, refusal, or teardown. */
export function applyMediaPlacementHoverPreview(
  preview: MediaPlacementPreview,
  epoch: number,
): void {
  if (epoch !== previewEpoch) return
  const current = useTransportStore.getState().mediaPlacementPreview
  if (current?.phase === 'pending') return
  setMediaPlacementPreview(preview)
}

export function trackKindAcceptsAssetKind(
  trackKind: TrackKind,
  assetKind: AssetKind,
): boolean {
  return domainTrackKindAcceptsAssetKind(trackKind, assetKind)
}

export function timelineFrameFromPointer(
  originFrame: number,
  localPx: number,
  zoom: number,
): number {
  return domainTimelineFrameFromPointer(originFrame, localPx, zoom)
}

export function visiblePlacementPreviewRange(
  startFrame: number,
  durationFrames: number | null,
  originFrame: number,
  windowEndFrame: number,
): MediaPlacementPreviewRange | null {
  return domainVisiblePlacementPreviewRange(
    startFrame,
    durationFrames,
    originFrame,
    windowEndFrame,
  )
}

export function previewImportedAssetPlacement(input: {
  trackId: TrackId
  startFrame: number
  assetId: string | null
  fallbackDurationFrames: number | null
}): MediaPlacementPreview {
  const media = useMediaStore.getState()
  const asset = input.assetId ? media.assets.get(input.assetId) ?? null : null
  const plan = planMediaAssetPlacement({
    doc: useDocumentStore.getState().doc,
    asset,
    trackId: input.trackId,
    startFrame: input.startFrame,
    timelineCompatible: compatibilityAllowsTimelineUse(
      input.assetId ? media.compatibility.get(input.assetId) : undefined,
    ),
  })
  return {
    trackId: input.trackId,
    startFrame: input.startFrame,
    durationFrames: asset?.durationFrames ?? input.fallbackDurationFrames,
    valid: plan.status !== 'reject',
    phase: 'hover',
  }
}

export function previewOsFilePlacement(
  trackId: TrackId,
  startFrame: number,
): MediaPlacementPreview {
  return {
    trackId,
    startFrame,
    durationFrames: null,
    valid: true,
    phase: 'hover',
  }
}

function liveLaneMatches(input: {
  documentId: string
  trackId: TrackId
  trackKind?: TrackKind
}): { status: 'ok' } | { status: 'reject'; reason: MediaPlacementRejection } {
  const live = useDocumentStore.getState().doc
  if (live.id !== input.documentId) {
    return { status: 'reject', reason: 'stale-document' }
  }
  const track = live.tracks.find((candidate) => candidate.id === input.trackId)
  if (!track) return { status: 'reject', reason: 'missing-track' }
  if (track.locked) return { status: 'reject', reason: 'locked-track' }
  if (input.trackKind !== undefined && track.kind !== input.trackKind) {
    return { status: 'reject', reason: 'wrong-kind' }
  }
  return { status: 'ok' }
}

function announcePlacementFailure(fileName: string): void {
  setStatus(`Imported ${fileName}, but it could not be placed on that lane.`)
}

function announceMediaPoolFileDrop(fileCount: number): void {
  setStatus(
    fileCount === 1
      ? 'Importing 1 file.'
      : `Importing ${fileCount} files.`,
  )
}

function importedFileName(assetId: string, fallback = 'media'): string {
  return useMediaStore.getState().assets.get(assetId)?.fileName
    ?? useMediaStore.getState().descriptors.get(assetId)?.fileName
    ?? fallback
}

function successfulImportMessage(fileCount: number): string {
  return fileCount === 1 ? 'Imported 1 file.' : `Imported ${fileCount} files.`
}

function unsupportedImportMessage(fileCount: number): string {
  return fileCount === 1
    ? 'Could not import the file.'
    : `Could not import ${fileCount} files.`
}

function terminalImportMessage(
  result: MediaImportResult,
  requestedCount: number,
): string {
  switch (result.status) {
    case 'imported':
      return successfulImportMessage(requestedCount)
    case 'busy':
      return 'Import already in progress.'
    case 'cancelled':
      return 'Import cancelled.'
    case 'limited':
    case 'unsupported':
      return unsupportedImportMessage(requestedCount)
    case 'failed':
      return result.message
  }
}

function announceBatchImportResult(
  results: readonly MediaImportResult[],
  requestedCount: number,
): void {
  const imported = results.filter((result) => result.status === 'imported')
  const failed = results.filter((result) => result.status === 'failed')

  if (imported.length === requestedCount && requestedCount > 0) {
    setStatus(successfulImportMessage(requestedCount))
    return
  }
  if (imported.length > 0) {
    setStatus(`Imported ${imported.length} of ${requestedCount} files.`)
    return
  }
  const terminal = results.find((result) => result.status === 'busy')
    ?? results.find((result) => result.status === 'cancelled')
    ?? results.find((result) => (
      result.status === 'limited' || result.status === 'unsupported'
    ))
    ?? failed[0]
  setStatus(terminal ? terminalImportMessage(terminal, requestedCount) : 'Import failed.')
}

function announceImportSelectionResult(
  result: MediaImportSelectionResult,
  requestedCount: number,
): void {
  if (result.status !== 'batch-complete') {
    setStatus(terminalImportMessage(result, requestedCount))
    return
  }
  announceBatchImportResult(result.results, requestedCount)
}

/** Single Media Pool OS-file drop entry: import, then announce a terminal state. */
export async function importDroppedMediaFiles(
  files: readonly File[],
): Promise<MediaImportSelectionResult> {
  if (files.length === 0) {
    setStatus('No files to import.')
    return { status: 'cancelled' }
  }
  announceMediaPoolFileDrop(files.length)
  try {
    const result = await importMediaFiles(files)
    announceImportSelectionResult(result, files.length)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed.'
    setStatus(message)
    return { status: 'failed', message }
  }
}

export function placeImportedAsset(
  expectedDocumentId: string,
  assetId: string,
  trackId: TrackId,
  startFrame: number,
  announce = false,
): PlaceImportedAssetResult {
  const lane = liveLaneMatches({
    documentId: expectedDocumentId,
    trackId,
  })
  if (lane.status === 'reject') {
    const result: PlaceImportedAssetResult = {
      status: 'not-placed',
      assetId,
      reason: lane.reason,
    }
    if (announce) {
      announcePlacementFailure(importedFileName(assetId))
    }
    return result
  }

  const documentStore = useDocumentStore.getState()
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
      announcePlacementFailure(asset?.fileName ?? 'media')
    }
    return result
  }

  const documentBefore = documentStore.doc
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

  if (useDocumentStore.getState().doc === documentBefore) {
    if (announce) announcePlacementFailure(asset.fileName)
    return { status: 'not-placed', assetId, reason: 'commit-rejected' }
  }

  if (announce) setStatus(`Placed ${asset.fileName} on the timeline.`)
  return { status: 'placed', assetId }
}

export async function dropOsFilesOnTimeline(input: {
  documentId: string
  trackId: TrackId
  trackKind?: TrackKind
  startFrame: number
  fileName?: string
  files: readonly File[]
}): Promise<TimelineFileDropResult> {
  bumpPreviewEpoch()
  const policy = resolveTimelineFileDropPolicy(input.files.length)
  if (policy.status === 'refuse') {
    setMediaPlacementPreview(null)
    setStatus(policy.message)
    return { status: 'refused', message: policy.message }
  }

  const beforeImport = liveLaneMatches(input)
  if (beforeImport.status === 'reject') {
    setMediaPlacementPreview(null)
    setStatus('The lane is no longer valid for this drop.')
    return {
      status: 'not-placed',
      assetId: '',
      reason: beforeImport.reason,
    }
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

  const afterImport = liveLaneMatches(input)
  if (afterImport.status === 'reject') {
    clearMediaPlacementPreview()
    announcePlacementFailure(fileName)
    return {
      status: 'not-placed',
      assetId: imported.assetId,
      reason: afterImport.reason,
    }
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
