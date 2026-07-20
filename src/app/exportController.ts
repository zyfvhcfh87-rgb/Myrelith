/**
 * app/exportController.ts — composition root for timeline export (Phase 5.2a).
 *
 * This is the sanctioned point where document/media stores meet the browser
 * export pipeline. UI code calls this facade; it never imports pipeline code.
 * Each run captures one immutable document + media-pool snapshot, shares one
 * cached Blob resolver between video and audio adapters, explicitly drains the
 * progress generator so its final ExportResult is retained, and serializes
 * cooperative cancellation at a generator yield boundary.
 */

import { MediaAssetRuntimeError } from '../domain/mediaCompatibility'
import type { AssetId, MediaAsset, TimelineDoc } from '../domain/schema'
import { audibleTracks, outputMediaAssetIds } from '../domain/selectors'
import {
  exportTimeline,
  type ExportDeps as PipelineExportDeps,
  type ExportMediaSource,
  type ExportResult,
  type ExportSettings,
} from '../pipeline/export'
import {
  createMediabunnyExportDeps,
  createMediabunnyExportMediaSource,
  type ExportAssetResolver,
} from '../pipeline/export-mediabunny'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import {
  captureMediaRuntimeGuard,
  reportMediaRuntimeFailure,
  type MediaRuntimeGuard,
} from './mediaCompatibilityController'

export type { ExportResult, ExportSettings } from '../pipeline/export'

type ExportRun = AsyncGenerator<number, ExportResult | undefined, void>

export interface ExportCallbacks {
  /** Receives every exact progress value yielded by the pipeline. */
  onProgress?: (progress: number) => void
}

/** Browser/pipeline seams injected by tests; production uses realDeps. */
export interface ExportControllerDeps {
  fetchBlob(url: string): Promise<Blob>
  createMediaSource(
    doc: TimelineDoc,
    resolveAsset: ExportAssetResolver,
  ): ExportMediaSource
  createPipelineDeps(resolveAsset: ExportAssetResolver): PipelineExportDeps
  runExport(
    doc: TimelineDoc,
    settings: ExportSettings,
    media: ExportMediaSource,
    deps: PipelineExportDeps,
  ): ExportRun
}

const realDeps: ExportControllerDeps = {
  fetchBlob: async (url) => {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Could not read export media (${response.status} ${response.statusText})`,
      )
    }
    return response.blob()
  },
  createMediaSource: createMediabunnyExportMediaSource,
  createPipelineDeps: createMediabunnyExportDeps,
  runExport: exportTimeline,
}

interface ExportSession {
  generator: ExportRun
  cancelRequested: boolean
  generatorDone: boolean
  returnPromise: Promise<void> | null
}

interface ActiveExport {
  token: object
  session: ExportSession | null
  completion: Promise<ExportResult | undefined>
}

const state: { active: ActiveExport | null } = { active: null }

function captureExportRuntimeGuards(
  assets: ReadonlyMap<AssetId, MediaAsset>,
): Map<AssetId, MediaRuntimeGuard> {
  const guards = new Map<AssetId, MediaRuntimeGuard>()
  for (const assetId of assets.keys()) {
    const guard = captureMediaRuntimeGuard(assetId)
    if (guard) guards.set(assetId, guard)
  }
  return guards
}

function reportExportRuntimeFailure(
  cause: unknown,
  guards: ReadonlyMap<AssetId, MediaRuntimeGuard>,
): void {
  if (
    !(cause instanceof MediaAssetRuntimeError)
    || cause.failure.surface !== 'export'
  ) return
  const guard = guards.get(cause.assetId)
  if (!guard) return
  try {
    reportMediaRuntimeFailure(guard, cause.failure)
  } catch {
    // Compatibility feedback must never replace the export's original error.
  }
}

/** One URL fetch per asset and one stable media snapshot for the whole run. */
function createAssetResolver(
  assets: ReadonlyMap<AssetId, MediaAsset>,
  fetchBlob: ExportControllerDeps['fetchBlob'],
): ExportAssetResolver {
  const blobPromises = new Map<AssetId, Promise<Blob>>()

  return (assetId) => {
    const cached = blobPromises.get(assetId)
    if (cached) return cached

    const asset = assets.get(assetId)
    if (!asset) {
      throw new Error(
        `Export media asset "${assetId}" is missing from the media pool`,
      )
    }

    // fetchBlob starts synchronously here. Pre-warming referenced ids before
    // the run is exposed therefore retains their Blobs before removeAsset can
    // revoke an object URL; later video/audio opens share the cached promise.
    let pending: Promise<Blob>
    try {
      pending = Promise.resolve(fetchBlob(asset.objectUrl))
    } catch (cause) {
      pending = Promise.reject(cause)
    }
    blobPromises.set(assetId, pending)
    return pending
  }
}

/** Start retaining every Blob the captured document can reference. */
function retainReferencedBlobs(
  doc: TimelineDoc,
  resolveAsset: ExportAssetResolver,
): void {
  const assetIds = new Set<AssetId>()
  for (const track of doc.tracks) {
    for (const clip of track.clips) assetIds.add(clip.assetId)
  }

  for (const assetId of assetIds) {
    try {
      // The pipeline remains the error owner when it requests this same
      // cached promise. This handler only prevents an unused hidden/muted
      // asset's eager rejection from becoming an unhandled rejection.
      void Promise.resolve(resolveAsset(assetId)).catch(() => undefined)
    } catch {
      // A referenced-but-unused missing asset is harmless. If a visible or
      // audible clip needs it, the pipeline's later resolve reports the id.
    }
  }
}

/** Fail closed if stale/corrupt clips target a track the import omitted. */
function partialTrackConflict(
  doc: TimelineDoc,
  assets: ReadonlyMap<AssetId, MediaAsset>,
): string | null {
  const audibleTrackIds = new Set(audibleTracks(doc).map((track) => track.id))
  for (const track of doc.tracks) {
    const contributes = track.kind === 'video'
      ? !track.hidden
      : audibleTrackIds.has(track.id)
    if (!contributes) continue
    for (const clip of track.clips) {
      if (
        clip.text
        || (track.kind === 'video' ? clip.opacity <= 0 : clip.volume <= 0)
      ) continue
      const asset = assets.get(clip.assetId)
      if (!asset) continue
      if (track.kind === 'audio' && !asset.hasAudio) {
        return `Audio clip "${clip.name}" cannot be exported because "${asset.fileName}" was imported without audio.`
      }
      if (track.kind === 'video' && asset.kind === 'audio') {
        return `Video clip "${clip.name}" cannot be exported because "${asset.fileName}" was imported as audio only.`
      }
    }
  }
  return null
}

/** Preserve setup as the primary failure while releasing pre-start ownership. */
async function rejectAfterClosingMedia(
  media: ExportMediaSource,
  setupFailure: unknown,
): Promise<never> {
  try {
    await media.close()
  } catch {
    // The setup error explains why the run never started and remains primary.
  }
  throw setupFailure
}

/**
 * The drain loop is the sole caller of generator.return(). This keeps return
 * serialized after any pending next(), rather than queueing competing commands
 * against the async generator while a codec/decode boundary is still running.
 */
function returnGenerator(session: ExportSession): Promise<void> {
  if (session.returnPromise) return session.returnPromise

  session.returnPromise = (async () => {
    try {
      const stopped = await session.generator.return(undefined)
      if (!stopped.done) {
        throw new Error('Export generator did not stop after cancellation')
      }
    } finally {
      session.generatorDone = true
    }
  })()
  return session.returnPromise
}

async function drainExport(
  session: ExportSession,
  firstStep: Promise<IteratorResult<number, ExportResult | undefined>>,
  onProgress: ExportCallbacks['onProgress'],
): Promise<ExportResult | undefined> {
  let pendingStep = firstStep

  try {
    while (true) {
      let step: IteratorResult<number, ExportResult | undefined>
      try {
        step = await pendingStep
      } catch (cause) {
        // An async-generator rejection closes its body/finally itself. Preserve
        // that operational error even when cancel was requested concurrently.
        session.generatorDone = true
        throw cause
      }

      if (session.cancelRequested) {
        await returnGenerator(session)
        return undefined
      }

      if (step.done) {
        session.generatorDone = true
        if (step.value === undefined) {
          throw new Error('Export completed without an export result')
        }
        return step.value
      }

      onProgress?.(step.value)
      // A progress callback may synchronously request cancellation, including
      // at progress 1. That remains cancellation and must not expose a result.
      if (session.cancelRequested) {
        await returnGenerator(session)
        return undefined
      }

      pendingStep = session.generator.next()
    }
  } catch (cause) {
    if (!session.generatorDone) {
      try {
        await returnGenerator(session)
      } catch {
        // Consumer/next failure stays primary over cancellation cleanup.
      }
    }
    throw cause
  }
}

/** Publish one completion promise and clear only its matching active slot. */
function trackActiveExport(
  session: ExportSession | null,
  pending: Promise<ExportResult | undefined>,
  runtimeGuards: ReadonlyMap<AssetId, MediaRuntimeGuard>,
): Promise<ExportResult | undefined> {
  const token = {}
  const completion = pending.catch((cause) => {
    reportExportRuntimeFailure(cause, runtimeGuards)
    throw cause
  }).finally(() => {
    if (state.active?.token === token) state.active = null
  })
  state.active = { token, session, completion }
  return completion
}

/**
 * Start one export of the current immutable editor snapshot.
 *
 * Success resolves with the finished MP4 buffer. User cancellation resolves
 * undefined. Setup, pipeline, observer, and cancellation-cleanup failures
 * reject. A second run is rejected until the first run's cleanup is complete.
 */
export function startExport(
  settings: ExportSettings,
  callbacks: ExportCallbacks = {},
  deps: ExportControllerDeps = realDeps,
): Promise<ExportResult | undefined> {
  if (state.active) {
    return Promise.reject(new Error('An export is already in progress'))
  }

  const doc = useDocumentStore.getState().doc
  const runSettings = { ...settings }
  const mediaState = useMediaStore.getState()
  const assets = new Map(mediaState.assets)
  const runtimeGuards = captureExportRuntimeGuards(assets)
  const offline = [...outputMediaAssetIds(doc)].filter(
    (assetId) => !assets.has(assetId),
  )
  if (offline.length > 0) {
    const names = offline.map(
      (assetId) => mediaState.descriptors.get(assetId)?.fileName ?? assetId,
    )
    return Promise.reject(new Error(
      `Reconnect ${offline.length} offline source${offline.length === 1 ? '' : 's'} before exporting: ${names.join(', ')}.`,
    ))
  }
  const trackConflict = partialTrackConflict(doc, assets)
  if (trackConflict) return Promise.reject(new Error(trackConflict))
  const resolveAsset = createAssetResolver(assets, deps.fetchBlob)
  retainReferencedBlobs(doc, resolveAsset)

  let media: ExportMediaSource | null = null
  let generator: ExportRun
  try {
    const pipelineDeps = deps.createPipelineDeps(resolveAsset)
    media = deps.createMediaSource(doc, resolveAsset)
    generator = deps.runExport(doc, runSettings, media, pipelineDeps)
  } catch (cause) {
    if (media) {
      return trackActiveExport(
        null,
        rejectAfterClosingMedia(media, cause),
        runtimeGuards,
      )
    }
    reportExportRuntimeFailure(cause, runtimeGuards)
    return Promise.reject(cause)
  }

  let firstStep: Promise<IteratorResult<number, ExportResult | undefined>>
  try {
    // Enter the generator body before publishing the active run. Calling
    // return(undefined) on a never-started generator would skip its finally.
    firstStep = generator.next()
  } catch (cause) {
    return trackActiveExport(
      null,
      rejectAfterClosingMedia(media, cause),
      runtimeGuards,
    )
  }

  const session: ExportSession = {
    generator,
    cancelRequested: false,
    generatorDone: false,
    returnPromise: null,
  }
  return trackActiveExport(
    session,
    drainExport(session, firstStep, callbacks.onProgress),
    runtimeGuards,
  )
}

/** Request cooperative cancellation and wait until pipeline cleanup settles. */
export async function cancelExport(): Promise<void> {
  const active = state.active
  if (!active) return
  if (active.session) active.session.cancelRequested = true
  await active.completion
}

/** Tests/HMR teardown; identical ownership semantics to user cancellation. */
export function disposeExport(): Promise<void> {
  return cancelExport()
}
