/**
 * Centralized media-import composition root.
 *
 * A selected File is demuxed exactly once, kept outside application state
 * while the user decides about an FPS mismatch, and committed atomically only
 * after Keep/Match succeeds. The media store takes object-URL ownership on a
 * successful commit; every other terminal path revokes it here.
 */

import { isProjectFrameRatePreset } from '../domain/projectSettings'
import type {
  MediaCompatibilityItem,
  MediaCompatibilityReport,
  MediaCompatibilityStatus,
} from '../domain/mediaCompatibility'
import {
  partialTrackImportOption,
  reapplyPartialTrackImport,
} from '../domain/mediaCompatibility'
import type {
  FrameRate,
  MediaAsset,
  PartialTrackImportSelection,
  TimelineDoc,
} from '../domain/schema'
import {
  microsecondsDurationToFrames,
  rateEquals,
} from '../domain/time'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_MEDIA_IMPORT_STATE,
  type MediaImportPrompt,
  type MediaImportState,
  useMediaImportStore,
} from '../state/mediaImportStore'
import { useMediaStore } from '../state/mediaStore'
import {
  isLocalMediaPickerCancellation,
  localMediaHandleRegistry,
  pickLocalMediaFiles,
  supportsLocalMediaHandles,
  type LocalMediaFileHandle,
} from './localMediaHandles'
import { inspectMediaFileCompatibility } from './mediaInspection'
import type { MediaProbeResult } from '../pipeline/mediaCompatibilityProbe'

export type MediaImportDecision =
  | 'keep-project-rate'
  | 'match-source-rate'
  | 'cancel'

export type MediaImportResult =
  | { status: 'imported'; assetId: string }
  | { status: 'limited'; itemId: string }
  | { status: 'unsupported'; itemId: string }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'failed'; message: string; itemId?: string }

export interface MediaImportDeps {
  createAssetId(): string
  createRequestId(): string
  inspect(
    file: File,
    documentRate: FrameRate,
    assetId: string,
    signal: AbortSignal,
  ): Promise<MediaProbeResult>
  getDocument(): TimelineDoc
  replaceDocument(document: TimelineDoc): void
  hasAsset(assetId: string): boolean
  addAsset(asset: MediaAsset): boolean
  reconformAssets(rate: FrameRate): void
  startCompatibility(item: MediaCompatibilityItem): boolean
  hasCompatibility(id: string, requestId: string): boolean
  getCompatibility(id: string): MediaCompatibilityItem | undefined
  setCompatibility(
    id: string,
    requestId: string,
    status: MediaCompatibilityStatus,
    report: MediaCompatibilityReport | null,
  ): boolean
  removeCompatibility(id: string): void
  rememberMediaHandle(
    documentId: string,
    assetId: string,
    handle: LocalMediaFileHandle,
  ): Promise<void>
  revokeObjectURL(url: string): void
}

const realDeps: MediaImportDeps = {
  createAssetId: () => `asset_${crypto.randomUUID()}`,
  createRequestId: () => `compat_${crypto.randomUUID()}`,
  inspect: inspectMediaFileCompatibility,
  getDocument: () => useDocumentStore.getState().doc,
  replaceDocument: (document) => useDocumentStore.getState().setDoc(document),
  hasAsset: (assetId) => useMediaStore.getState().descriptors.has(assetId),
  addAsset: (asset) => useMediaStore.getState().addAsset(asset),
  reconformAssets: (rate) => useMediaStore.getState().reconformAssets(rate),
  startCompatibility: (item) => (
    useMediaStore.getState().startCompatibility(item)
  ),
  hasCompatibility: (id, requestId) => (
    useMediaStore.getState().compatibility.get(id)?.requestId === requestId
  ),
  getCompatibility: (id) => useMediaStore.getState().compatibility.get(id),
  setCompatibility: (id, requestId, status, report) => (
    useMediaStore.getState().setCompatibility(id, requestId, status, report)
  ),
  removeCompatibility: (id) => (
    useMediaStore.getState().removeCompatibility(id)
  ),
  rememberMediaHandle: (documentId, assetId, handle) => (
    localMediaHandleRegistry.remember(documentId, assetId, handle)
  ),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
}

interface ActiveImport {
  itemId: string
  requestId: string
  deps: MediaImportDeps
  abortController: AbortController
  cancelled: boolean
  /** Limited row restored when a confirmed partial import is cancelled. */
  cancelFallback: MediaCompatibilityItem | null
  cancelledItemSettled: boolean
  resolveDecision: ((decision: MediaImportDecision) => void) | null
}

interface RetainedImport {
  file: File
  handle: LocalMediaFileHandle | null
  documentId: string
  deps: MediaImportDeps
}

let activeImport: ActiveImport | null = null
const retainedImports = new Map<string, RetainedImport>()

function cloneRate(rate: FrameRate): FrameRate {
  return { num: rate.num, den: rate.den }
}

function timelineHasClips(document: TimelineDoc): boolean {
  return document.tracks.some((track) => track.clips.length > 0)
}

function promptFor(
  fileName: string,
  document: TimelineDoc,
  sourceRate: FrameRate,
): MediaImportPrompt {
  let matchUnavailableReason: string | null = null
  if (!isProjectFrameRatePreset(sourceRate)) {
    matchUnavailableReason =
      'This source rate is not one of the supported project presets.'
  } else if (timelineHasClips(document)) {
    matchUnavailableReason =
      'Matching is unavailable after clips have been added to the timeline.'
  }
  return {
    fileName,
    projectRate: cloneRate(document.frameRate),
    sourceRate: cloneRate(sourceRate),
    canMatchSource: matchUnavailableReason === null,
    matchUnavailableReason,
  }
}

function errorMessage(fileName: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return `Could not import "${fileName}": ${detail}`
}

function unexpectedCompatibility(
  fileName: string,
  cause: unknown,
): MediaCompatibilityReport {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return {
    status: 'error',
    container: null,
    durationMicroseconds: null,
    tracks: [],
    reason: 'decode-failed',
    detail: `Could not check "${fileName}": ${detail}`,
  }
}

function checkingItem(
  id: string,
  requestId: string,
  file: File,
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

function settleCancelledCompatibility(
  operation: ActiveImport,
  preserveFallback: boolean,
): void {
  if (operation.cancelledItemSettled) return
  operation.cancelledItemSettled = true
  const fallback = preserveFallback ? operation.cancelFallback : null
  const restored = fallback
    ? operation.deps.setCompatibility(
        operation.itemId,
        operation.requestId,
        fallback.status,
        fallback.report,
      )
    : false
  if (!restored) {
    operation.deps.removeCompatibility(operation.itemId)
    retainedImports.delete(operation.itemId)
  }
}

function cancelOperation(
  operation: ActiveImport,
  preserveFallback = true,
): void {
  operation.cancelled = true
  operation.abortController.abort()
  settleCancelledCompatibility(operation, preserveFallback)
  operation.resolveDecision?.('cancel')
  operation.resolveDecision = null
}

function documentStillMatches(
  document: TimelineDoc,
  documentId: string,
  rate: FrameRate,
): boolean {
  return document.id === documentId && rateEquals(document.frameRate, rate)
}

async function rememberCommittedMediaHandle(
  deps: MediaImportDeps,
  documentId: string,
  assetId: string,
  handle: LocalMediaFileHandle,
): Promise<void> {
  try {
    await deps.rememberMediaHandle(documentId, assetId, handle)
  } catch (cause) {
    // The import is already committed. Remembering its browser capability is
    // an observed local convenience and must never roll media or UI state back.
    console.warn('Could not finish remembering the imported media file', cause)
  }
}

/** Analyze and, after any required decision, commit one selected file. */
async function importSelectedMedia(
  file: File,
  handle: LocalMediaFileHandle | null,
  deps: MediaImportDeps,
  existingItemId?: string,
  requestedPartialSelection?: PartialTrackImportSelection,
  cancelFallback: MediaCompatibilityItem | null = null,
): Promise<MediaImportResult> {
  if (activeImport) return { status: 'busy' }

  const itemId = existingItemId ?? deps.createAssetId()
  if (deps.hasAsset(itemId)) {
    return {
      status: 'failed',
      message: `Could not import "${file.name}": asset id ${itemId} is already in use`,
    }
  }
  const requestId = deps.createRequestId()
  if (!deps.startCompatibility(checkingItem(itemId, requestId, file))) {
    return {
      status: 'failed',
      message: `Could not start a compatibility check for "${file.name}".`,
      itemId,
    }
  }
  const operation: ActiveImport = {
    itemId,
    requestId,
    deps,
    abortController: new AbortController(),
    cancelled: false,
    cancelFallback,
    cancelledItemSettled: false,
    resolveDecision: null,
  }
  activeImport = operation
  const startingDocument = deps.getDocument()
  let analyzed: MediaAsset | null = null
  let probeReturned = false
  let committed = false

  const setUi = (next: MediaImportState): void => {
    if (activeImport === operation) useMediaImportStore.setState(next)
  }

  setUi({
    phase: 'analyzing',
    fileName: file.name,
    prompt: null,
    error: null,
  })

  try {
    const inspection = await deps.inspect(
      file,
      startingDocument.frameRate,
      itemId,
      operation.abortController.signal,
    )
    probeReturned = true
    if (inspection.asset) analyzed = inspection.asset
    if (
      activeImport !== operation
      || operation.cancelled
      || !deps.hasCompatibility(itemId, requestId)
    ) {
      return { status: 'cancelled' }
    }

    const decisionDocument = deps.getDocument()
    if (decisionDocument.id !== startingDocument.id) {
      throw new Error('the active project changed while the file was being analyzed')
    }

    const partialAcceptance = requestedPartialSelection && inspection.asset
      ? reapplyPartialTrackImport(
          inspection.asset,
          inspection.compatibility,
          requestedPartialSelection,
        )
      : null
    if (requestedPartialSelection && partialAcceptance === null) {
      const fallbackStatus = inspection.status === 'ready'
        ? cancelFallback?.status ?? 'limited'
        : inspection.status
      const fallbackReport = inspection.status === 'ready'
        ? cancelFallback?.report ?? inspection.compatibility
        : inspection.compatibility
      if (!deps.setCompatibility(
        itemId,
        requestId,
        fallbackStatus,
        fallbackReport,
      )) return { status: 'cancelled' }
      setUi({ ...INITIAL_MEDIA_IMPORT_STATE })
      return {
        status: 'failed',
        message: `The confirmed ${requestedPartialSelection} choice is no longer available after rechecking the file. Review the updated compatibility details.`,
        itemId,
      }
    }
    const acceptedAsset = partialAcceptance?.asset
      ?? (inspection.status === 'ready' ? inspection.asset : null)
    const acceptedCompatibility = partialAcceptance?.compatibility
      ?? (inspection.status === 'ready' ? inspection.compatibility : null)

    if (!acceptedAsset || !acceptedCompatibility) {
      if (!deps.setCompatibility(
        itemId,
        requestId,
        inspection.status,
        inspection.compatibility,
      )) {
        return { status: 'cancelled' }
      }
      retainedImports.set(itemId, {
        file,
        handle,
        documentId: startingDocument.id,
        deps,
      })
      setUi({ ...INITIAL_MEDIA_IMPORT_STATE })
      if (inspection.status === 'limited') {
        return { status: 'limited', itemId }
      }
      if (inspection.status === 'unsupported') {
        return { status: 'unsupported', itemId }
      }
      return {
        status: 'failed',
        message: inspection.compatibility.detail
          ?? `Could not check "${file.name}".`,
        itemId,
      }
    }

    const readyAsset = acceptedAsset
    deps.setCompatibility(
      itemId,
      requestId,
      'checking',
      acceptedCompatibility,
    )

    let decision: MediaImportDecision = 'keep-project-rate'
    let prompt: MediaImportPrompt | null = null
    if (
      readyAsset.frameRate
      && !rateEquals(readyAsset.frameRate, decisionDocument.frameRate)
    ) {
      prompt = promptFor(file.name, decisionDocument, readyAsset.frameRate)
      setUi({
        phase: 'awaiting-decision',
        fileName: file.name,
        prompt,
        error: null,
      })
      decision = await new Promise<MediaImportDecision>((resolve) => {
        operation.resolveDecision = resolve
      })
      operation.resolveDecision = null
    }

    if (
      activeImport !== operation
      || operation.cancelled
      || decision === 'cancel'
    ) {
      setUi({ ...INITIAL_MEDIA_IMPORT_STATE })
      return { status: 'cancelled' }
    }

    const commitDocument = deps.getDocument()
    const expectedRate = prompt?.projectRate ?? decisionDocument.frameRate
    if (!documentStillMatches(
      commitDocument,
      decisionDocument.id,
      expectedRate,
    )) {
      throw new Error('the project settings changed while the import decision was open')
    }

    if (deps.hasAsset(itemId)) {
      throw new Error(`asset id ${itemId} is already in use`)
    }

    let finalRate = commitDocument.frameRate
    if (decision === 'match-source-rate') {
      if (!readyAsset.frameRate) {
        throw new Error('this source has no video frame rate to match')
      }
      const latestPrompt = promptFor(
        file.name,
        commitDocument,
        readyAsset.frameRate,
      )
      if (!latestPrompt.canMatchSource) {
        throw new Error(
          latestPrompt.matchUnavailableReason
            ?? 'the source frame rate cannot be used for this project',
        )
      }
      finalRate = readyAsset.frameRate
    }

    const committedAsset: MediaAsset = {
      ...readyAsset,
      id: itemId,
      durationFrames: microsecondsDurationToFrames(
        readyAsset.durationMicroseconds,
        finalRate,
      ),
    }
    if (!deps.addAsset(committedAsset)) {
      throw new Error(`asset id ${committedAsset.id} is already in use`)
    }
    committed = true
    retainedImports.delete(itemId)
    deps.setCompatibility(
      itemId,
      requestId,
      'ready',
      acceptedCompatibility,
    )

    if (decision === 'match-source-rate') {
      deps.replaceDocument({
        ...commitDocument,
        frameRate: cloneRate(finalRate),
      })
      deps.reconformAssets(finalRate)
    }

    if (activeImport === operation) {
      activeImport = null
      useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
    }

    if (handle) {
      void rememberCommittedMediaHandle(
        deps,
        commitDocument.id,
        committedAsset.id,
        handle,
      )
    }
    return { status: 'imported', assetId: committedAsset.id }
  } catch (cause) {
    if (activeImport !== operation || operation.cancelled) {
      return { status: 'cancelled' }
    }
    const message = errorMessage(file.name, cause)
    if (!probeReturned && deps.hasCompatibility(itemId, requestId)) {
      const report = unexpectedCompatibility(file.name, cause)
      deps.setCompatibility(itemId, requestId, 'error', report)
      retainedImports.set(itemId, {
        file,
        handle,
        documentId: startingDocument.id,
        deps,
      })
      setUi({ ...INITIAL_MEDIA_IMPORT_STATE })
      return { status: 'failed', message, itemId }
    }
    deps.removeCompatibility(itemId)
    retainedImports.delete(itemId)
    setUi({
      phase: 'error',
      fileName: file.name,
      prompt: null,
      error: message,
    })
    return { status: 'failed', message }
  } finally {
    if (analyzed && !committed) deps.revokeObjectURL(analyzed.objectUrl)
    if (activeImport === operation) {
      if (operation.cancelled) {
        settleCancelledCompatibility(operation, true)
        useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
      }
      activeImport = null
    }
  }
}

/** Compatibility path for browsers whose file inputs cannot return handles. */
export function importMedia(
  file: File,
  deps: MediaImportDeps = realDeps,
): Promise<MediaImportResult> {
  return importSelectedMedia(file, null, deps)
}

/** Handle-aware path used by Chromium so later project resumes can reconnect. */
export function importMediaFromHandle(
  file: File,
  handle: LocalMediaFileHandle,
  deps: MediaImportDeps = realDeps,
): Promise<MediaImportResult> {
  return importSelectedMedia(file, handle, deps)
}

/** Re-run a settled compatibility check only after an explicit user action. */
export function retryMediaCompatibility(
  itemId: string,
  deps?: MediaImportDeps,
): Promise<MediaImportResult> {
  if (activeImport) return Promise.resolve({ status: 'busy' })
  const retained = retainedImports.get(itemId)
  if (!retained) {
    return Promise.resolve({
      status: 'failed',
      message: 'That media file is no longer available to retry.',
      itemId,
    })
  }
  const operationDeps = deps ?? retained.deps
  if (operationDeps.getDocument().id !== retained.documentId) {
    retainedImports.delete(itemId)
    operationDeps.removeCompatibility(itemId)
    return Promise.resolve({
      status: 'failed',
      message: 'The active project changed before this retry could start.',
      itemId,
    })
  }
  return importSelectedMedia(
    retained.file,
    retained.handle,
    operationDeps,
    itemId,
  )
}

/** Commit the single safe track kind offered by a visible Limited report. */
export function acceptPartialMediaImport(
  itemId: string,
  selection: PartialTrackImportSelection,
  deps?: MediaImportDeps,
): Promise<MediaImportResult> {
  if (activeImport) return Promise.resolve({ status: 'busy' })
  const retained = retainedImports.get(itemId)
  if (!retained) {
    return Promise.resolve({
      status: 'failed',
      message: 'That partial import is no longer available.',
      itemId,
    })
  }
  const operationDeps = deps ?? retained.deps
  const item = operationDeps.getCompatibility(itemId)
  if (
    item?.status !== 'limited'
    || partialTrackImportOption(item.report) !== selection
  ) {
    return Promise.resolve({
      status: 'failed',
      message: 'That partial import choice is no longer available.',
      itemId,
    })
  }
  if (operationDeps.getDocument().id !== retained.documentId) {
    retainedImports.delete(itemId)
    operationDeps.removeCompatibility(itemId)
    return Promise.resolve({
      status: 'failed',
      message: 'The active project changed before this partial import could start.',
      itemId,
    })
  }
  return importSelectedMedia(
    retained.file,
    retained.handle,
    operationDeps,
    itemId,
    selection,
    item,
  )
}

/** Remove a provisional compatibility row and invalidate any in-flight work. */
export function removeMediaCompatibility(itemId: string): boolean {
  const operation = activeImport
  if (operation?.itemId === itemId) {
    cancelOperation(operation, false)
    useMediaImportStore.setState((state) => ({
      ...state,
      phase: 'cancelling',
      prompt: null,
      error: null,
    }))
    return true
  }
  const retained = retainedImports.get(itemId)
  if (!retained) return false
  retainedImports.delete(itemId)
  retained.deps.removeCompatibility(itemId)
  return true
}

export function canRememberImportedMedia(): boolean {
  return supportsLocalMediaHandles()
}

/** Open the picker directly from the Import click, then run the one-analysis path. */
export async function chooseMediaForImport(
  deps: MediaImportDeps = realDeps,
): Promise<MediaImportResult> {
  if (activeImport) return { status: 'busy' }
  try {
    const [selection] = await pickLocalMediaFiles(false)
    if (!selection) return { status: 'cancelled' }
    return importMediaFromHandle(selection.file, selection.handle, deps)
  } catch (cause) {
    if (isLocalMediaPickerCancellation(cause)) return { status: 'cancelled' }
    const detail = cause instanceof Error ? cause.message : String(cause)
    const message = `Could not choose media: ${detail}`
    useMediaImportStore.setState({
      phase: 'error',
      fileName: null,
      prompt: null,
      error: message,
    })
    return { status: 'failed', message }
  }
}

/** Forget a removed asset's local capability without affecting store removal. */
export function forgetImportedMediaHandle(assetId: string): void {
  const documentId = useDocumentStore.getState().doc.id
  void localMediaHandleRegistry.forget(documentId, assetId).catch((cause) => {
    console.warn('Could not forget the removed media file', cause)
  })
}

/** Resolve the visible FPS prompt. Invalid/disabled actions are ignored. */
export function resolveMediaImportDecision(
  decision: MediaImportDecision,
): boolean {
  const operation = activeImport
  if (!operation?.resolveDecision) return false
  const prompt = useMediaImportStore.getState().prompt
  if (decision === 'match-source-rate' && !prompt?.canMatchSource) return false
  if (decision === 'cancel') {
    cancelOperation(operation)
    return true
  }
  const resolve = operation.resolveDecision
  operation.resolveDecision = null
  resolve(decision)
  return true
}

/** Cancel analysis or choose Cancel in the FPS prompt. */
export function cancelMediaImport(): boolean {
  const operation = activeImport
  if (!operation) return false
  if (operation.resolveDecision) {
    return resolveMediaImportDecision('cancel')
  }
  useMediaImportStore.setState((state) => ({
    ...state,
    phase: 'cancelling',
    prompt: null,
    error: null,
  }))
  cancelOperation(operation)
  return true
}

export function dismissMediaImportError(): void {
  if (useMediaImportStore.getState().phase === 'error') {
    useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
  }
}

/** Test/teardown seam: invalidates late work without letting it touch UI state. */
export function resetMediaImportController(): void {
  const operation = activeImport
  if (operation) cancelOperation(operation, false)
  for (const [itemId, retained] of retainedImports) {
    retained.deps.removeCompatibility(itemId)
  }
  retainedImports.clear()
  activeImport = null
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
}
