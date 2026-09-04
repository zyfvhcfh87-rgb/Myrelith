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
  createCrossfadeAudioWindowIndex,
  createSourceBoundsCatalog,
  type CrossfadeAudioWindowIndex,
  type SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import type { AssetId, MediaAsset, TimelineDoc } from '../domain/schema'
import type { SequenceProject } from '../domain/projectSequences'
import {
  sequenceById,
  sequenceProjectFromTimeline,
} from '../domain/projectSequences'
import { sequenceInstances } from '../domain/nestedSequences'
import { createProjectTimelineAudioMixPlan } from '../domain/projectAudioMixPlan'
import { createMulticamPlanner } from '../domain/multicam'
import type { TimelineAudioMixPlan } from '../domain/audioMixPlan'
import type { PluginVideoEffectContributionSnapshot } from '../domain/pluginVideoEffectStagePlan'
import { selectMediaRepresentation } from '../domain/proxyCache'
import {
  audibleTracks,
  clipContributesDecodedAudioOutput,
  clipContributesVisualOutput,
  clipHasWholeWindowSilentRampedAudio,
  documentHasOutputPluginEffects,
  outputMediaAssetIds,
} from '../domain/selectors'
import {
  assertExportAdmission,
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
import { registerLoadedExportDisposer } from './exportLifecycle'
import { drainPreviewPlayback } from './previewController'
import { drainSourcePreviewPlayback } from './sourceMonitorPreviewController'
import { pauseAndDrainPlayback } from './transportController'
/* The later app composition wave owns the concrete prepared-attempt lifecycle. */
import {
  PluginExportAttemptError,
  type PluginExportAttemptController,
  type PluginExportAttemptToken,
  type PluginPreparedExportExecution,
} from './pluginExportAttemptController'
import type { VideoEffectStageExecutor } from '../pipeline/videoEffectStageExecution'

export type { ExportResult, ExportSettings } from '../pipeline/export'

interface ProjectExportTarget {
  readonly project: SequenceProject
  readonly sequenceId: string
}

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
  preparePlaybackForExport(): Promise<void>
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
    pluginSnapshot?: PluginVideoEffectContributionSnapshot,
    projectTarget?: ProjectExportTarget,
  ): ExportMediaSource
  createPipelineDeps(
    resolveAsset: ExportAssetResolver,
    sourceBounds: SourceBoundsCatalog,
    fileDestination?: ExportFileDestinationCapability,
    videoEffectStageExecutor?: VideoEffectStageExecutor | null,
    projectMixPlan?: TimelineAudioMixPlan,
    projectTarget?: ProjectExportTarget,
  ): PipelineExportDeps
  runExport(
    doc: TimelineDoc,
    settings: ExportSettings,
    media: ExportMediaSource,
    deps: PipelineExportDeps,
  ): ExportRun
}

const realDeps: ExportControllerDeps = {
  preparePlaybackForExport: async () => {
    await Promise.all([
      pauseAndDrainPlayback(),
      drainPreviewPlayback(),
      drainSourcePreviewPlayback(),
    ])
  },
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
  createPipelineDeps: (
    resolveAsset,
    sourceBounds,
    fileDestination,
    videoEffectStageExecutor,
    projectMixPlan,
    projectTarget,
  ) =>
    createMediabunnyExportDeps(
      resolveAsset,
      sourceBounds,
      fileDestination,
      videoEffectStageExecutor,
      projectMixPlan,
      projectTarget,
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
  pluginExecution: PluginPreparedExportExecution | null
  pluginClosePromise: Promise<void> | null
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
    const representation = selectMediaRepresentation({
      purpose: 'export',
      originalAvailable: asset !== undefined,
      // Export deliberately does not inspect cache state: a fresh proxy is
      // never eligible for this boundary.
      proxy: 'missing',
    })
    if (!asset || representation.representation !== 'original') {
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

/** Start retaining every Blob that can contribute to the captured output. */
function retainReferencedBlobs(
  assetIds: readonly AssetId[],
  resolveAsset: ExportAssetResolver,
): void {
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
  providedCrossfadeWindows?: CrossfadeAudioWindowIndex,
): string | null {
  const audibleTrackIds = new Set(audibleTracks(doc).map((track) => track.id))
  let crossfadeWindows = providedCrossfadeWindows
  for (const track of doc.tracks) {
    const contributes = track.kind === 'video'
      ? !track.hidden
      : includeAudio && audibleTrackIds.has(track.id)
    if (!contributes) continue
    for (const clip of track.clips) {
      if (track.kind === 'video') {
        if (!clipContributesVisualOutput(clip)) continue
      } else {
        const crossfadeWindow = clipHasWholeWindowSilentRampedAudio(clip)
          ? (crossfadeWindows ??= createCrossfadeAudioWindowIndex(doc)).get(clip.id) ?? null
          : null
        if (!clipContributesDecodedAudioOutput(
          clip,
          crossfadeWindow,
        )) continue
      }
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

function freezeRunOptions(callbacks: ExportCallbacks): Readonly<ExportRunOptions> {
  if (
    callbacks.onProgress !== undefined
    && typeof callbacks.onProgress !== 'function'
  ) throw new TypeError('Export progress callback must be a function')
  return Object.freeze({
    ...(callbacks.onProgress ? { onProgress: callbacks.onProgress } : {}),
    ...(callbacks.fileDestination
      ? { fileDestination: callbacks.fileDestination }
      : {}),
  })
}

function assertDestinationCapability(
  settings: Readonly<ExportSettings>,
  options: Readonly<ExportRunOptions>,
): void {
  if (settings.destination === 'file' && !options.fileDestination) {
    throw new TypeError('Direct file export requires a user-selected file destination')
  }
  if (settings.destination === 'download' && options.fileDestination) {
    throw new TypeError('Browser download export cannot use a direct file destination')
  }
}

interface CapturedExportInputs {
  readonly assets: ReadonlyMap<AssetId, MediaAsset>
  readonly retainedAssetIds: readonly AssetId[]
  readonly sourceBounds: SourceBoundsCatalog
  readonly runtimeGuards: Map<AssetId, MediaRuntimeGuard>
  readonly audioMixPlan: TimelineAudioMixPlan
}

function reachableSequences(target: ProjectExportTarget): readonly TimelineDoc[] {
  const reachable: TimelineDoc[] = []
  const visited = new Set<string>()
  const queue = [target.sequenceId]
  while (queue.length > 0) {
    const sequenceId = queue.shift()!
    if (visited.has(sequenceId)) continue
    visited.add(sequenceId)
    const sequence = sequenceById(target.project, sequenceId)
    if (!sequence) throw new RangeError(`Missing export sequence "${sequenceId}"`)
    reachable.push(sequence)
    for (const track of sequence.tracks) {
      for (const instance of sequenceInstances(track)) queue.push(instance.sequenceId)
    }
  }
  return reachable
}

function captureExportInputs(
  doc: TimelineDoc,
  settings: Readonly<ExportSettings>,
  projectTarget: ProjectExportTarget,
): CapturedExportInputs {
  if (doc.id !== projectTarget.sequenceId) {
    throw new RangeError('Export document does not match the project target')
  }
  const mediaState = useMediaStore.getState()
  const assets = new Map(mediaState.assets)
  const sourceBounds = createSourceBoundsCatalog(mediaState.descriptors.values())
  const includeAudio = settings.audioChannelLayout !== 'off'
  const audioMixPlan = createProjectTimelineAudioMixPlan(
    projectTarget.project,
    projectTarget.sequenceId,
    sourceBounds,
  )
  const retainedAssetIds = new Set<AssetId>()
  const reachable = reachableSequences(projectTarget)
  const multicams = new Map((projectTarget.project.multicams ?? []).map(
    (definition) => [definition.id, createMulticamPlanner(definition)],
  ))
  for (const sequence of reachable) {
    const hasSilentRamp = includeAudio && audibleTracks(sequence).some((track) => (
      track.clips.some(clipHasWholeWindowSilentRampedAudio)
    ))
    const crossfadeWindows = hasSilentRamp
      ? createCrossfadeAudioWindowIndex(sequence, sourceBounds)
      : undefined
    for (const assetId of outputMediaAssetIds(
      sequence,
      includeAudio,
      crossfadeWindows,
    )) retainedAssetIds.add(assetId)
    for (const track of sequence.tracks) {
      if (track.kind !== 'video' || track.hidden) continue
      for (const instance of track.multicamInstances ?? []) {
        const planner = multicams.get(instance.multicamId)
        if (!planner) continue
        for (const segment of planner.videoSegments(
          instance.sourceStartFrame,
          instance.sourceStartFrame + instance.timelineRange.durationFrames,
        )) retainedAssetIds.add(segment.assetId)
      }
    }
  }
  if (includeAudio) {
    for (const plan of audioMixPlan.clips) {
      if (plan.ramp?.silent) continue
      retainedAssetIds.add(plan.assetId)
    }
  }
  const retainedAssetIdList = [...retainedAssetIds]
  const offline = retainedAssetIdList.filter(
    (assetId) => !assets.has(assetId),
  )
  if (offline.length > 0) {
    const names = offline.map(
      (assetId) => mediaState.descriptors.get(assetId)?.fileName ?? assetId,
    )
    throw new Error(
      `Reconnect ${offline.length} offline source${offline.length === 1 ? '' : 's'} before exporting: ${names.join(', ')}.`,
    )
  }
  for (const sequence of reachable) {
    const crossfadeWindows = includeAudio
      ? createCrossfadeAudioWindowIndex(sequence, sourceBounds)
      : undefined
    const trackConflict = partialTrackConflict(
      sequence,
      assets,
      includeAudio,
      crossfadeWindows,
    )
    if (trackConflict) throw new Error(trackConflict)
  }
  return Object.freeze({
    assets,
    retainedAssetIds: Object.freeze(retainedAssetIdList),
    sourceBounds,
    runtimeGuards: captureExportRuntimeGuards(assets),
    audioMixPlan,
  })
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

function closePluginExecution(
  lifecycle: ExportLifecycle,
  reason: string,
): Promise<void> {
  if (lifecycle.pluginClosePromise) return lifecycle.pluginClosePromise
  const execution = lifecycle.pluginExecution
  if (!execution) return Promise.resolve()
  try {
    lifecycle.pluginClosePromise = Promise.resolve(execution.close(reason))
  } catch (cause) {
    lifecycle.pluginClosePromise = Promise.reject(cause)
  }
  return lifecycle.pluginClosePromise
}

function isPluginAttemptCancellation(cause: unknown): boolean {
  const seen = new Set<unknown>()
  let current = cause
  for (let depth = 0; depth < 8 && current !== undefined && !seen.has(current); depth++) {
    if (current instanceof PluginExportAttemptError && current.code === 'aborted') return true
    seen.add(current)
    if (typeof current !== 'object' || current === null || !('cause' in current)) return false
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

async function preflightAndRunExport(
  lifecycle: ExportLifecycle,
  doc: TimelineDoc,
  projectTarget: ProjectExportTarget,
  settings: ExportSettings,
  assets: ReadonlyMap<AssetId, MediaAsset>,
  retainedAssetIds: readonly AssetId[],
  sourceBounds: SourceBoundsCatalog,
  audioMixPlan: TimelineAudioMixPlan,
  callbacks: ExportCallbacks,
  deps: ExportControllerDeps,
  pluginExecution?: Pick<
    PluginPreparedExportExecution,
    'pluginSnapshot' | 'videoEffectStageExecutor'
  >,
): Promise<ExportResult | undefined> {
  if (lifecycle.cancelRequested) return undefined
  await deps.preparePlaybackForExport()
  if (lifecycle.cancelRequested) return undefined
  // Reject impossible work before Blob retention, profile probing, or the
  // cooperative per-asset visual schedule owned by createMediaSource().
  assertExportAdmission(doc, settings)
  let resolveAsset: ExportAssetResolver | null = null
  if (!pluginExecution) {
    resolveAsset = createAssetResolver(assets, deps.fetchBlob)
    // Legacy no-plugin exports retain captured object URLs across the profile
    // await. Prepared plugin exports deliberately defer every Blob until the
    // plugin attempt and encoding profile have both passed.
    retainReferencedBlobs(retainedAssetIds, resolveAsset)
  }
  // Blob retention calls an injected boundary synchronously. If it re-enters
  // cancellation, do not advance into profile/media ownership afterward.
  if (lifecycle.cancelRequested) return undefined

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
  if (!resolveAsset) {
    resolveAsset = createAssetResolver(assets, deps.fetchBlob)
    retainReferencedBlobs(retainedAssetIds, resolveAsset)
  }
  if (lifecycle.cancelRequested) return undefined

  let media: ExportMediaSource | null = null
  let generator: ExportRun
  try {
    const pipelineDeps = deps.createPipelineDeps(
      resolveAsset,
      sourceBounds,
      callbacks.fileDestination,
      pluginExecution?.videoEffectStageExecutor,
      audioMixPlan,
      projectTarget,
    )
    media = deps.createMediaSource(
      doc,
      resolveAsset,
      sourceBounds,
      pluginExecution?.pluginSnapshot,
      projectTarget,
    )
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

  const documentState = useDocumentStore.getState()
  const doc = documentState.doc
  const projectTarget = Object.freeze({
    project: documentState.project,
    sequenceId: documentState.activeSequenceId,
  })
  let runSettings: Readonly<ExportSettings>
  let runOptions: Readonly<ExportRunOptions>
  let captured: CapturedExportInputs
  try {
    runSettings = validateExportProfile(settings)
    runOptions = freezeRunOptions(callbacks)
    assertDestinationCapability(runSettings, runOptions)
    if (reachableSequences(projectTarget).some(documentHasOutputPluginEffects)) {
      throw new Error('Plugin-aware export requires a prepared one-shot attempt')
    }
    captured = captureExportInputs(doc, runSettings, projectTarget)
  } catch (cause) {
    return Promise.reject(cause)
  }
  const lifecycle: ExportLifecycle = {
    cancelRequested: false,
    preflightAbort: new AbortController(),
    session: null,
    pluginExecution: null,
    pluginClosePromise: null,
  }
  return trackActiveExport(
    lifecycle,
    () => preflightAndRunExport(
      lifecycle,
      doc,
      projectTarget,
      runSettings,
      captured.assets,
      captured.retainedAssetIds,
      captured.sourceBounds,
      captured.audioMixPlan,
      runOptions,
      deps,
    ),
    captured.runtimeGuards,
  )
}

/**
 * Consume one prepared plugin attempt, then enter the ordinary export path.
 * The attempt is already plugin-preflighted before profile probing, Blob
 * retention, decoder/media creation, file-handle consumption, or encoding.
 */
export function startPreparedExport(
  token: PluginExportAttemptToken,
  attemptController: Pick<PluginExportAttemptController, 'consume'>,
  callbacks: ExportCallbacks = {},
  deps: ExportControllerDeps = realDeps,
): Promise<ExportResult | undefined> {
  if (state.active) {
    return Promise.reject(new Error('An export is already in progress'))
  }
  let runOptions: Readonly<ExportRunOptions>
  try {
    runOptions = freezeRunOptions(callbacks)
  } catch (cause) {
    return Promise.reject(cause)
  }
  const lifecycle: ExportLifecycle = {
    cancelRequested: false,
    preflightAbort: new AbortController(),
    session: null,
    pluginExecution: null,
    pluginClosePromise: null,
  }
  const runtimeGuards = new Map<AssetId, MediaRuntimeGuard>()
  return trackActiveExport(
    lifecycle,
    async () => {
      let execution: PluginPreparedExportExecution | null = null
      let closeStarted = false
      try {
        execution = await attemptController.consume(
          token,
          lifecycle.preflightAbort.signal,
        )
        lifecycle.pluginExecution = execution
        assertDestinationCapability(execution.settings, runOptions)
        const documentState = useDocumentStore.getState()
        const projectTarget = execution.projectTarget
          ?? (documentState.doc === execution.document
          ? Object.freeze({
              project: documentState.project,
              sequenceId: documentState.activeSequenceId,
            })
          : Object.freeze({
              project: sequenceProjectFromTimeline(execution.document),
              sequenceId: execution.document.id,
            }))
        const captured = captureExportInputs(
          execution.document,
          execution.settings,
          projectTarget,
        )
        for (const [assetId, guard] of captured.runtimeGuards) {
          runtimeGuards.set(assetId, guard)
        }
        const result = await preflightAndRunExport(
          lifecycle,
          execution.document,
          projectTarget,
          execution.settings,
          captured.assets,
          captured.retainedAssetIds,
          captured.sourceBounds,
          captured.audioMixPlan,
          runOptions,
          deps,
          execution,
        )
        closeStarted = true
        await closePluginExecution(
          lifecycle,
          lifecycle.cancelRequested ? 'plugin-export-cancelled' : 'plugin-export-complete',
        )
        return result
      } catch (cause) {
        if (!execution
          && lifecycle.cancelRequested
          && lifecycle.preflightAbort.signal.aborted
          && cause instanceof PluginExportAttemptError
          && cause.code === 'aborted') return undefined
        let closeFailure: unknown
        if (execution && !closeStarted) {
          closeStarted = true
          try {
            await closePluginExecution(
              lifecycle,
              lifecycle.cancelRequested ? 'plugin-export-cancelled' : 'plugin-export-failed',
            )
          } catch (cleanupCause) {
            closeFailure = cleanupCause
          }
        }
        if (execution
          && lifecycle.cancelRequested
          && lifecycle.preflightAbort.signal.aborted
          && isPluginAttemptCancellation(cause)) {
          if (closeFailure !== undefined) throw closeFailure
          return undefined
        }
        // Operational export failures remain primary over ordinary cleanup.
        throw cause
      }
    },
    runtimeGuards,
  )
}

/** Request cooperative cancellation and wait until pipeline cleanup settles. */
export async function cancelExport(): Promise<void> {
  const active = state.active
  if (!active) return
  active.lifecycle.cancelRequested = true
  active.lifecycle.preflightAbort.abort()
  if (active.lifecycle.pluginExecution) {
    // Close pinned workers now even if the current profile/media boundary
    // ignores AbortSignal. The completion path observes the same idempotent
    // close promise and retains the established cleanup/error precedence.
    void closePluginExecution(active.lifecycle, 'plugin-export-cancelled')
      .catch(() => undefined)
  }
  if (active.lifecycle.session) {
    active.lifecycle.session.cancelRequested = true
  }
  await active.completion
}

/** Tests/HMR teardown; identical ownership semantics to user cancellation. */
export function disposeExport(): Promise<void> {
  return cancelExport()
}

registerLoadedExportDisposer(disposeExport)
