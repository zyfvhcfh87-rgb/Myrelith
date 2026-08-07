/**
 * The composition-root bridge from connected media to disposable timeline
 * visuals. Analysis is generation-safe, cancelable, priority-aware, and
 * bounded by MediaJobScheduler; the store remains the exact URL owner after a
 * successful transfer.
 */

import type { AssetId, MediaAsset, TimelineDoc } from '../domain/schema'
import type { MediaRuntimeFailure } from '../domain/mediaCompatibility'
import { findClip } from '../domain/selectors'
import {
  mediaAssetDecoderBudget,
} from '../codecs/mediaCodecFallbacks'
import type {
  FilmstripResult,
  MediaVisualDecodeOptions,
  WaveformResult,
} from '../pipeline/visuals'
import { StaticImageDecodeError } from '../pipeline/static-image'
import { StaticImageInspectionError } from '../pipeline/static-image-inspection'
import {
  generateStaticImageThumbnail,
  StaticImageThumbnailError,
  type StaticImageThumbnailOptions,
} from '../pipeline/static-image-thumbnail'
import {
  MediaVisualDecodeError,
  MediaVisualSourceError,
  generateFilmstrip,
  generateWaveform,
} from '../pipeline/visuals'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import {
  MediaJobExecutionError,
  MediaJobScheduler,
  type MediaJobContext,
  type MediaJobPriority,
  type MediaJobSchedulerOptions,
  type MediaJobSchedulerSnapshot,
} from './mediaJobScheduler'
import {
  captureMediaRuntimeGuard,
  mediaRuntimeFailure,
  reportMediaRuntimeFailure,
} from './mediaCompatibilityController'

export interface VisualsDeps {
  fetchBlob: (url: string, signal: AbortSignal) => Promise<Blob>
  generateFilmstrip: (
    file: Blob,
    options: MediaVisualDecodeOptions,
  ) => Promise<FilmstripResult | null>
  generateWaveform: (
    file: Blob,
    options: MediaVisualDecodeOptions,
  ) => Promise<WaveformResult | null>
  generateStaticImageThumbnail: (
    file: Blob,
    options?: StaticImageThumbnailOptions,
  ) => Promise<FilmstripResult>
}

export interface MediaVisualTimelineViewport {
  readonly startFrame: number
  readonly endFrame: number
}

export interface MediaVisualsControllerOptions {
  readonly scheduler?: MediaJobSchedulerOptions
}

const realDeps: VisualsDeps = {
  fetchBlob: async (url, signal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) {
      throw new Error(`Media source returned HTTP ${response.status}`)
    }
    return response.blob()
  },
  generateFilmstrip,
  generateWaveform,
  generateStaticImageThumbnail,
}

interface AssetJobRecord {
  readonly objectUrl: string
  readonly generation: number
  selfDisconnecting: boolean
  status: 'queued' | 'running' | 'settled'
}

interface ControllerState {
  readonly jobs: Map<AssetId, AssetJobRecord>
  scheduler: MediaJobScheduler | null
  unsubscribeMedia: (() => void) | null
  unsubscribeDocument: (() => void) | null
  unsubscribeTransport: (() => void) | null
  viewport: MediaVisualTimelineViewport | null
  nextGeneration: number
}

const state: ControllerState = {
  jobs: new Map(),
  scheduler: null,
  unsubscribeMedia: null,
  unsubscribeDocument: null,
  unsubscribeTransport: null,
  viewport: null,
  nextGeneration: 0,
}

function abortError(): Error {
  const error = new Error('Media visual generation was cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function isCancellation(cause: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (cause instanceof Error && cause.name === 'AbortError')
}

function revokeGenerated(
  filmstrip: FilmstripResult | null,
  waveform: WaveformResult | null,
): void {
  if (filmstrip) URL.revokeObjectURL(filmstrip.url)
  if (waveform) URL.revokeObjectURL(waveform.url)
}

function visualTaskCount(asset: MediaAsset): number {
  return Number(asset.kind === 'video' || asset.kind === 'image')
    + Number(asset.hasAudio)
}

function connectedAssetStillMatches(asset: MediaAsset): boolean {
  return useMediaStore.getState().assets.get(asset.id)?.objectUrl === asset.objectUrl
}

export function mediaVisualPriorityForAsset(
  assetId: AssetId,
  document: TimelineDoc,
  selectedClipId: string | null,
  viewport: MediaVisualTimelineViewport | null,
): MediaJobPriority {
  const selected = selectedClipId ? findClip(document, selectedClipId) : null
  if (selected?.assetId === assetId) return 'selected'
  if (!viewport || viewport.endFrame <= viewport.startFrame) return 'background'

  for (const track of document.tracks) {
    for (const clip of track.clips) {
      if (
        clip.assetId === assetId
        && clip.timelineRange.startFrame < viewport.endFrame
        && clip.timelineRange.startFrame + clip.timelineRange.durationFrames
          > viewport.startFrame
      ) return 'visible'
    }
  }
  return 'background'
}

interface MediaVisualPriorityContext {
  readonly selectedAssetId: AssetId | null
  readonly visibleAssetIds: ReadonlySet<AssetId>
}

function mediaVisualPriorityContext(
  document: TimelineDoc,
  selectedClipId: string | null,
  viewport: MediaVisualTimelineViewport | null,
): MediaVisualPriorityContext {
  let selectedAssetId: AssetId | null = null
  const visibleAssetIds = new Set<AssetId>()
  const hasViewport = viewport !== null && viewport.endFrame > viewport.startFrame

  for (const track of document.tracks) {
    for (const clip of track.clips) {
      if (selectedClipId !== null && clip.id === selectedClipId) {
        selectedAssetId = clip.assetId
      }
      if (
        hasViewport
        && clip.timelineRange.startFrame < viewport.endFrame
        && clip.timelineRange.startFrame + clip.timelineRange.durationFrames
          > viewport.startFrame
      ) visibleAssetIds.add(clip.assetId)
    }
  }
  return { selectedAssetId, visibleAssetIds }
}

function priorityFromContext(
  assetId: AssetId,
  context: MediaVisualPriorityContext,
): MediaJobPriority {
  if (context.selectedAssetId === assetId) return 'selected'
  if (context.visibleAssetIds.has(assetId)) return 'visible'
  return 'background'
}

function currentPriority(assetId: AssetId): MediaJobPriority {
  return mediaVisualPriorityForAsset(
    assetId,
    useDocumentStore.getState().doc,
    useTransportStore.getState().selectedClipId,
    state.viewport,
  )
}

function reprioritizeQueuedJobs(): void {
  const scheduler = state.scheduler
  if (!scheduler) return
  const queuedIds = [...state.jobs]
    .filter(([, record]) => record.status === 'queued')
    .map(([id]) => id)
  if (queuedIds.length === 0) return

  const context = mediaVisualPriorityContext(
    useDocumentStore.getState().doc,
    useTransportStore.getState().selectedClipId,
    state.viewport,
  )
  for (const id of queuedIds) {
    scheduler.reprioritize(id, priorityFromContext(id, context))
  }
}

function visualFailureReason(
  cause: unknown,
): MediaRuntimeFailure['reason'] {
  if (cause instanceof MediaVisualSourceError) return 'resource-unavailable'
  if (cause instanceof MediaVisualDecodeError) return cause.failure.reason
  if (cause instanceof StaticImageThumbnailError) {
    return cause.reason === 'resource-limit'
      ? 'resource-limit'
      : 'decode-failed'
  }
  if (cause instanceof StaticImageInspectionError) {
    if (cause.reason === 'resource-limit') return 'resource-limit'
    return 'decode-failed'
  }
  if (cause instanceof StaticImageDecodeError) {
    if (cause.reason === 'resource-limit') return 'resource-limit'
    if (cause.reason === 'unsupported-runtime') return 'unsupported-codec'
    return 'decode-failed'
  }
  return 'decode-failed'
}

function jobFailure(
  reason: MediaRuntimeFailure['reason'],
  cause: unknown,
): MediaJobExecutionError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new MediaJobExecutionError(reason, detail, cause)
}

function reportFailureAndThrow(
  record: AssetJobRecord,
  guard: NonNullable<ReturnType<typeof captureMediaRuntimeGuard>>,
  asset: MediaAsset,
  failure: MediaRuntimeFailure,
  cause: unknown,
): never {
  record.selfDisconnecting = true
  console.warn(`[mediaVisuals] generation failed for "${asset.fileName}"`, cause)
  reportMediaRuntimeFailure(guard, failure)
  throw jobFailure(failure.reason, cause)
}

async function process(
  asset: MediaAsset,
  record: AssetJobRecord,
  deps: VisualsDeps,
  context: MediaJobContext,
): Promise<void> {
  const { signal } = context
  const guard = captureMediaRuntimeGuard(asset.id)
  if (!guard || guard.objectUrl !== asset.objectUrl) return
  context.reportProgress(0.05)

  let blob: Blob
  try {
    blob = await deps.fetchBlob(asset.objectUrl, signal)
  } catch (cause) {
    if (isCancellation(cause, signal)) throw abortError()
    if (!connectedAssetStillMatches(asset)) return
    reportFailureAndThrow(
      record,
      guard,
      asset,
      mediaRuntimeFailure(
        asset.kind === 'audio' ? 'waveform' : 'filmstrip',
        null,
        cause,
        'resource-unavailable',
      ),
      cause,
    )
  }
  throwIfAborted(signal)
  if (!connectedAssetStillMatches(asset)) return
  context.reportProgress(0.15)

  const decodeOptions: MediaVisualDecodeOptions = {
    sourceId: asset.id,
    budget: mediaAssetDecoderBudget(asset, blob.size),
    signal,
  }
  const tasks = visualTaskCount(asset)
  let activeDecoders = tasks
  let settledTasks = 0
  context.setActiveDecoderCount(activeDecoders)
  const track = async <T>(pending: Promise<T>): Promise<T> => {
    try {
      return await pending
    } finally {
      settledTasks++
      activeDecoders--
      context.setActiveDecoderCount(activeDecoders)
      context.reportProgress(0.15 + 0.75 * settledTasks / Math.max(1, tasks))
    }
  }

  let filmstripResult: PromiseSettledResult<FilmstripResult | null>
  let waveformResult: PromiseSettledResult<WaveformResult | null>
  try {
    ;[filmstripResult, waveformResult] = await Promise.allSettled([
      asset.kind === 'video'
        ? track(deps.generateFilmstrip(blob, decodeOptions))
        : asset.kind === 'image'
          ? track(deps.generateStaticImageThumbnail(blob, { signal }))
          : Promise.resolve(null),
      asset.hasAudio
        ? track(deps.generateWaveform(blob, decodeOptions))
        : Promise.resolve(null),
    ])
  } finally {
    context.setActiveDecoderCount(0)
  }

  const filmstrip = filmstripResult.status === 'fulfilled'
    ? filmstripResult.value
    : null
  const waveform = waveformResult.status === 'fulfilled'
    ? waveformResult.value
    : null
  if (signal.aborted) {
    revokeGenerated(filmstrip, waveform)
    throw abortError()
  }

  const failure = filmstripResult.status === 'rejected'
    ? {
        surface: 'filmstrip' as const,
        trackKind: asset.kind === 'image' ? null : 'video' as const,
        cause: filmstripResult.reason,
      }
    : waveformResult.status === 'rejected'
      ? {
          surface: 'waveform' as const,
          trackKind: 'audio' as const,
          cause: waveformResult.reason,
        }
      : null
  if (failure) {
    // Compatibility owns the complete connected source. A confirmed runtime
    // failure disconnects it, so a successful sibling URL must be released.
    revokeGenerated(filmstrip, waveform)
    if (isCancellation(failure.cause, signal)) throw abortError()
    if (!connectedAssetStillMatches(asset)) return
    reportFailureAndThrow(
      record,
      guard,
      asset,
      mediaRuntimeFailure(
        failure.surface,
        failure.cause instanceof MediaVisualSourceError
          ? null
          : failure.trackKind,
        failure.cause,
        visualFailureReason(failure.cause),
      ),
      failure.cause,
    )
  }

  if (!filmstrip && !waveform) return
  if (!connectedAssetStillMatches(asset)) {
    revokeGenerated(filmstrip, waveform)
    return
  }
  context.reportProgress(0.98)
  // The store takes URL ownership; disconnected late results are revoked.
  useMediaStore.getState().setAssetVisuals(asset.id, { filmstrip, waveform })
}

function scan(deps: VisualsDeps): void {
  const scheduler = state.scheduler
  if (!scheduler) return
  const media = useMediaStore.getState()

  for (const [id, record] of state.jobs) {
    const current = media.assets.get(id)
    if (current?.objectUrl === record.objectUrl) continue
    if (!record.selfDisconnecting) scheduler.cancel(id, current ? 'replaced' : 'removed')
    state.jobs.delete(id)
  }

  for (const [id, asset] of media.assets) {
    if (state.jobs.has(id) || media.visuals.has(id)) continue
    const record: AssetJobRecord = {
      objectUrl: asset.objectUrl,
      generation: ++state.nextGeneration,
      selfDisconnecting: false,
      status: 'queued',
    }
    state.jobs.set(id, record)
    scheduler.enqueue({
      id,
      generation: record.generation,
      priority: currentPriority(id),
      resources: { decoderSlots: visualTaskCount(asset) },
      run: async (context) => {
        record.status = 'running'
        try {
          await process(asset, record, deps, context)
        } finally {
          record.status = 'settled'
          const current = useMediaStore.getState().assets.get(id)
          if (
            current?.objectUrl !== record.objectUrl
            && state.jobs.get(id) === record
          ) state.jobs.delete(id)
        }
      },
    })
  }
}

/** Start watching connected media. Idempotent and StrictMode-safe. */
export function initMediaVisuals(
  deps: VisualsDeps = realDeps,
  options: MediaVisualsControllerOptions = {},
): void {
  if (state.scheduler) return
  state.scheduler = new MediaJobScheduler(options.scheduler)
  state.unsubscribeMedia = useMediaStore.subscribe((current, previous) => {
    if (current.assets !== previous.assets || current.visuals !== previous.visuals) {
      scan(deps)
    }
  })
  state.unsubscribeDocument = useDocumentStore.subscribe((current, previous) => {
    if (current.doc !== previous.doc) reprioritizeQueuedJobs()
  })
  state.unsubscribeTransport = useTransportStore.subscribe((current, previous) => {
    if (current.selectedClipId !== previous.selectedClipId) {
      reprioritizeQueuedJobs()
    }
  })
  scan(deps)
}

/** Exact on-screen timeline range, published by Timeline without persistence. */
export function setMediaVisualTimelineViewport(
  viewport: MediaVisualTimelineViewport | null,
): void {
  const normalized = viewport && Number.isFinite(viewport.startFrame)
    && Number.isFinite(viewport.endFrame)
    ? {
        startFrame: Math.max(0, Math.floor(viewport.startFrame)),
        endFrame: Math.max(0, Math.ceil(viewport.endFrame)),
      }
    : null
  if (
    state.viewport?.startFrame === normalized?.startFrame
    && state.viewport?.endFrame === normalized?.endFrame
  ) return
  state.viewport = normalized
  reprioritizeQueuedJobs()
}

export function getMediaVisualSchedulerSnapshot(): MediaJobSchedulerSnapshot | null {
  return state.scheduler?.snapshot() ?? null
}

export function waitForMediaVisualsIdle(): Promise<MediaJobSchedulerSnapshot | null> {
  return state.scheduler?.whenIdle() ?? Promise.resolve(null)
}

export function subscribeMediaVisualScheduler(
  listener: (snapshot: MediaJobSchedulerSnapshot) => void,
): () => void {
  return state.scheduler?.subscribe(listener) ?? (() => {})
}

/** Tear down tests/HMR and abort every queued or active generation. */
export function disposeMediaVisuals(): void {
  state.unsubscribeMedia?.()
  state.unsubscribeDocument?.()
  state.unsubscribeTransport?.()
  state.unsubscribeMedia = null
  state.unsubscribeDocument = null
  state.unsubscribeTransport = null
  state.scheduler?.dispose()
  state.scheduler = null
  state.jobs.clear()
  state.viewport = null
}
