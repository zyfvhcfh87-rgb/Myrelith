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
import { validateExportProfile } from '../domain/exportProfile'
import {
  createSourceBoundsCatalog,
  type SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
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
import { preflightExportProfile } from './exportCapabilitiesController'
import type { ExportFileDestinationCapability } from './exportFilePicker'

export type { ExportResult, ExportSettings } from '../pipeline/export'

type ExportRun = AsyncGenerator<number, ExportResult | undefined, void>

export interface ExportRunOptions {
  /** Receives every exact progress value yielded by the pipeline. */
  onProgress?: (progress: number) => void
  /** Ephemeral one-shot capability; never stored in project/preferences state. */
  fileDestination?: ExportFileDestinationCapability
}

export type ExportCallbacks = ExportRunOptions

/** Browser/pipeline seams injected by tests; production uses realDeps. */
export interface ExportControllerDeps {
  preflightProfile(
    doc: TimelineDoc,
    settings: ExportSettings,
    signal: AbortSignal,
  ): Promise<void>
  fetchBlob(url: string): Promise<Blob>
  createMediaSource(
    doc: TimelineDoc,
    resolveAsset: ExportAssetResolver,
    sourceBounds: SourceBoundsCatalog,
  ): ExportMediaSource
  createPipelineDeps(
    resolveAsset: ExportAssetResolver,
    sourceBounds: SourceBoundsCatalog,
    fileDestination?: ExportFileDestinationCapability,
  ): PipelineExportDeps
  runExport(
    doc: TimelineDoc,
    settings: ExportSettings,
    media: ExportMediaSource,
    deps: PipelineExportDeps,
  ): ExportRun
}

const realDeps: ExportControllerDeps = {
  preflightProfile: preflightExportProfile,
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
  createPipelineDeps: (resolveAsset, sourceBounds, fileDestination) =>
    createMediabunnyExportDeps(
      resolveAsset,
      sourceBounds,
      fileDestination,
    ),
  runExport: exportTimeline,
}

interface ExportSession {
  generator: ExportRun
  cancelRequested: boolean
  generatorDone: boolean
  returnPromise: Promise<void> | null
}

interface ExportLifecycle {
  cancelRequested: boolean
  preflightAbort: AbortController
  session: ExportSession | null
}

interface ActiveExport {
  token: object
  lifecycle: ExportLifecycle
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
  const assetPromises = new Map<
    AssetId,
    ReturnType<ExportAssetResolver>
  >()

  return (assetId) => {
    const cached = assetPromises.get(assetId)
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
    let pending: ReturnType<ExportAssetResolver>
    try {
      pending = Promise.resolve(fetchBlob(asset.objectUrl)).then((blob) => ({
        blob,
        budget: mediaAssetDecoderBudget(asset, blob.size),
        kind: asset.kind,
      }))
    } catch (cause) {
      pending = Promise.reject(cause)
    }
    assetPromises.set(assetId, pending)
    return pending
  }
}

/** Start retaining every Blob the captured document can reference. */
function retainReferencedBlobs(
  doc: TimelineDoc,
  resolveAsset: ExportAssetResolver,
  includeAudio: boolean,
): void {
  const assetIds = new Set<AssetId>()
  for (const track of doc.tracks) {
    if (track.kind === 'audio' && !includeAudio) continue
    for (const clip of track.clips) {
      if (clip.text === undefined) assetIds.add(clip.assetId)
    }
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
  includeAudio: boolean,
): string | null {
  const audibleTrackIds = new Set(audibleTracks(doc).map((track) => track.id))
  for (const track of doc.tracks) {
    const contributes = track.kind === 'video'
      ? !track.hidden
      : includeAudio && audibleTrackIds.has(track.id)
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

      if (step.done) {
        session.generatorDone = true
        if (step.value === undefined) {
          throw new Error('Export completed without an export result')
        }
        return step.value
      }

      if (session.cancelRequested) {
        await returnGenerator(session)
        return undefined
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

/** Reserve the singleton slot synchronously, before asynchronous preflight. */
function trackActiveExport(
  lifecycle: ExportLifecycle,
  start: () => Promise<ExportResult | undefined>,
  runtimeGuards: ReadonlyMap<AssetId, MediaRuntimeGuard>,
): Promise<ExportResult | undefined> {
  const token = {}
  const completion = Promise.resolve().then(start).catch((cause) => {
    reportExportRuntimeFailure(cause, runtimeGuards)
    throw cause
  }).finally(() => {
    if (state.active?.token === token) state.active = null
  })
  state.active = { token, lifecycle, completion }
  return completion
}

async function preflightAndRunExport(
  lifecycle: ExportLifecycle,
  doc: TimelineDoc,
  settings: ExportSettings,
  assets: ReadonlyMap<AssetId, MediaAsset>,
  callbacks: ExportCallbacks,
  deps: ExportControllerDeps,
): Promise<ExportResult | undefined> {
  if (lifecycle.cancelRequested) return undefined
  const includeAudio = settings.audioChannelLayout !== 'off'
  const resolveAsset = createAssetResolver(assets, deps.fetchBlob)
  const sourceBounds = createSourceBoundsCatalog(assets.values())
  // Acquire the captured source URLs before the first await. The media store
  // may revoke them while capability probing is pending; these cached Blob
  // promises are the lightweight snapshot lease. Decoder/encoder setup still
  // waits until the fresh profile probe succeeds.
  retainReferencedBlobs(doc, resolveAsset, includeAudio)

  const signal = lifecycle.preflightAbort.signal
  try {
    await deps.preflightProfile(doc, settings, signal)
  } catch (cause) {
    if (
      lifecycle.cancelRequested &&
      signal.aborted &&
      cause === signal.reason
    ) {
      return undefined
    }
    throw cause
  }
  // A probe is allowed to ignore AbortSignal. Cancellation still prevents all
  // decoder creation and pipeline work after it settles.
  if (lifecycle.cancelRequested) return undefined

  let media: ExportMediaSource | null = null
  let generator: ExportRun
  try {
    const pipelineDeps = deps.createPipelineDeps(
      resolveAsset,
      sourceBounds,
      callbacks.fileDestination,
    )
    media = deps.createMediaSource(doc, resolveAsset, sourceBounds)
    if (lifecycle.cancelRequested) {
      await media.close()
      return undefined
    }
    generator = deps.runExport(doc, settings, media, pipelineDeps)
    // Factories may synchronously re-enter cancellation. A never-started async
    // generator has no finally ownership, so close controller-owned media here.
    if (lifecycle.cancelRequested) {
      await media.close()
      return undefined
    }
  } catch (cause) {
    if (media) return rejectAfterClosingMedia(media, cause)
    throw cause
  }

  let firstStep: Promise<IteratorResult<number, ExportResult | undefined>>
  try {
    // Enter the generator body before exposing a running session. Calling
    // return(undefined) on a never-started generator would skip its finally.
    firstStep = generator.next()
  } catch (cause) {
    return rejectAfterClosingMedia(media, cause)
  }

  const session: ExportSession = {
    generator,
    cancelRequested: lifecycle.cancelRequested,
    generatorDone: false,
    returnPromise: null,
  }
  lifecycle.session = session
  return drainExport(session, firstStep, callbacks.onProgress)
}

/**
 * Start one export of the current immutable editor snapshot.
 *
 * Success resolves with buffered-download or committed-file metadata. User
 * cancellation resolves undefined. Setup, pipeline, observer, and cleanup
 * failures reject. A second run is rejected until exact cleanup finishes.
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
  let runSettings: Readonly<ExportSettings>
  try {
    runSettings = validateExportProfile(settings)
  } catch (cause) {
    return Promise.reject(cause)
  }
  if (
    callbacks.onProgress !== undefined
    && typeof callbacks.onProgress !== 'function'
  ) {
    return Promise.reject(new TypeError('Export progress callback must be a function'))
  }
  const runOptions: Readonly<ExportRunOptions> = Object.freeze({
    ...(callbacks.onProgress ? { onProgress: callbacks.onProgress } : {}),
    ...(callbacks.fileDestination
      ? { fileDestination: callbacks.fileDestination }
      : {}),
  })
  if (runSettings.destination === 'file' && !runOptions.fileDestination) {
    return Promise.reject(new TypeError(
      'Direct file export requires a user-selected file destination',
    ))
  }
  if (runSettings.destination === 'download' && runOptions.fileDestination) {
    return Promise.reject(new TypeError(
      'Browser download export cannot use a direct file destination',
    ))
  }
  const mediaState = useMediaStore.getState()
  const assets = new Map(mediaState.assets)
  const runtimeGuards = captureExportRuntimeGuards(assets)
  const includeAudio = runSettings.audioChannelLayout !== 'off'
  const offline = [...outputMediaAssetIds(doc, includeAudio)].filter(
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
  const trackConflict = partialTrackConflict(doc, assets, includeAudio)
  if (trackConflict) return Promise.reject(new Error(trackConflict))
  const lifecycle: ExportLifecycle = {
    cancelRequested: false,
    preflightAbort: new AbortController(),
    session: null,
  }
  return trackActiveExport(
    lifecycle,
    () => preflightAndRunExport(
      lifecycle,
      doc,
      runSettings,
      assets,
      runOptions,
      deps,
    ),
    runtimeGuards,
  )
}

/** Request cooperative cancellation and wait until pipeline cleanup settles. */
export async function cancelExport(): Promise<void> {
  const active = state.active
  if (!active) return
  active.lifecycle.cancelRequested = true
  active.lifecycle.preflightAbort.abort()
  if (active.lifecycle.session) {
    active.lifecycle.session.cancelRequested = true
  }
  await active.completion
}

/** Tests/HMR teardown; identical ownership semantics to user cancellation. */
export function disposeExport(): Promise<void> {
  return cancelExport()
}
