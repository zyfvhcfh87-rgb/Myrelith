/**
 * Centralized media-import composition root.
 *
 * A selected File is demuxed exactly once, kept outside application state
 * while the user decides about an FPS mismatch, and committed atomically only
 * after Keep/Match succeeds. The media store takes object-URL ownership on a
 * successful commit; every other terminal path revokes it here.
 */

import { isProjectFrameRatePreset } from '../domain/projectSettings'
import type { FrameRate, MediaAsset, TimelineDoc } from '../domain/schema'
import {
  microsecondsToFrames,
  rateEquals,
} from '../domain/time'
import { loadAsset, type LoadedAsset } from '../pipeline/demux'
import { useDocumentStore } from '../state/documentStore'
import {
  INITIAL_MEDIA_IMPORT_STATE,
  type MediaImportPrompt,
  type MediaImportState,
  useMediaImportStore,
} from '../state/mediaImportStore'
import { useMediaStore } from '../state/mediaStore'

export type MediaImportDecision =
  | 'keep-project-rate'
  | 'match-source-rate'
  | 'cancel'

export type MediaImportResult =
  | { status: 'imported'; assetId: string }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'failed'; message: string }

export interface MediaImportDeps {
  inspect(file: File, documentRate: FrameRate): Promise<MediaAsset>
  getDocument(): TimelineDoc
  replaceDocument(document: TimelineDoc): void
  hasAsset(assetId: string): boolean
  addAsset(asset: MediaAsset): boolean
  reconformAssets(rate: FrameRate): void
  revokeObjectURL(url: string): void
}

function discardLoadedAsset(loaded: LoadedAsset): void {
  try {
    loaded.input.dispose()
  } catch {
    // Rejection cleanup must preserve the useful import error.
  }
  URL.revokeObjectURL(loaded.asset.objectUrl)
}

const realDeps: MediaImportDeps = {
  inspect: async (file, documentRate) => {
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
  },
  getDocument: () => useDocumentStore.getState().doc,
  replaceDocument: (document) => useDocumentStore.getState().setDoc(document),
  hasAsset: (assetId) => useMediaStore.getState().assets.has(assetId),
  addAsset: (asset) => useMediaStore.getState().addAsset(asset),
  reconformAssets: (rate) => useMediaStore.getState().reconformAssets(rate),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
}

interface ActiveImport {
  cancelled: boolean
  resolveDecision: ((decision: MediaImportDecision) => void) | null
}

let activeImport: ActiveImport | null = null

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

function documentStillMatches(
  document: TimelineDoc,
  documentId: string,
  rate: FrameRate,
): boolean {
  return document.id === documentId && rateEquals(document.frameRate, rate)
}

/** Analyze and, after any required decision, commit one selected file. */
export async function importMedia(
  file: File,
  deps: MediaImportDeps = realDeps,
): Promise<MediaImportResult> {
  if (activeImport) return { status: 'busy' }

  const operation: ActiveImport = {
    cancelled: false,
    resolveDecision: null,
  }
  activeImport = operation
  const startingDocument = deps.getDocument()
  let analyzed: MediaAsset | null = null
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
    analyzed = await deps.inspect(file, startingDocument.frameRate)
    if (activeImport !== operation || operation.cancelled) {
      return { status: 'cancelled' }
    }

    const decisionDocument = deps.getDocument()
    if (decisionDocument.id !== startingDocument.id) {
      throw new Error('the active project changed while the file was being analyzed')
    }

    let decision: MediaImportDecision = 'keep-project-rate'
    let prompt: MediaImportPrompt | null = null
    if (
      analyzed.frameRate
      && !rateEquals(analyzed.frameRate, decisionDocument.frameRate)
    ) {
      prompt = promptFor(file.name, decisionDocument, analyzed.frameRate)
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

    if (deps.hasAsset(analyzed.id)) {
      throw new Error(`asset id ${analyzed.id} is already in use`)
    }

    let finalRate = commitDocument.frameRate
    if (decision === 'match-source-rate') {
      if (!analyzed.frameRate) {
        throw new Error('this source has no video frame rate to match')
      }
      const latestPrompt = promptFor(file.name, commitDocument, analyzed.frameRate)
      if (!latestPrompt.canMatchSource) {
        throw new Error(
          latestPrompt.matchUnavailableReason
            ?? 'the source frame rate cannot be used for this project',
        )
      }
      finalRate = analyzed.frameRate
    }

    const committedAsset: MediaAsset = {
      ...analyzed,
      durationFrames: microsecondsToFrames(
        analyzed.durationMicroseconds,
        finalRate,
      ),
    }
    if (!deps.addAsset(committedAsset)) {
      throw new Error(`asset id ${committedAsset.id} is already in use`)
    }
    committed = true

    if (decision === 'match-source-rate') {
      deps.replaceDocument({
        ...commitDocument,
        frameRate: cloneRate(finalRate),
      })
      deps.reconformAssets(finalRate)
    }

    setUi({ ...INITIAL_MEDIA_IMPORT_STATE })
    return { status: 'imported', assetId: committedAsset.id }
  } catch (cause) {
    if (activeImport !== operation || operation.cancelled) {
      return { status: 'cancelled' }
    }
    const message = errorMessage(file.name, cause)
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
        useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
      }
      activeImport = null
    }
  }
}

/** Resolve the visible FPS prompt. Invalid/disabled actions are ignored. */
export function resolveMediaImportDecision(
  decision: MediaImportDecision,
): boolean {
  const operation = activeImport
  if (!operation?.resolveDecision) return false
  const prompt = useMediaImportStore.getState().prompt
  if (decision === 'match-source-rate' && !prompt?.canMatchSource) return false
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
  operation.cancelled = true
  useMediaImportStore.setState((state) => ({
    ...state,
    phase: 'cancelling',
    prompt: null,
    error: null,
  }))
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
  if (operation) {
    operation.cancelled = true
    operation.resolveDecision?.('cancel')
  }
  activeImport = null
  useMediaImportStore.setState({ ...INITIAL_MEDIA_IMPORT_STATE })
}
