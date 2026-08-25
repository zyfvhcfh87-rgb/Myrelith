/**
 * app/sourceMonitorPlaybackController.ts — composition root for Source
 * Monitor playback.
 *
 * Owns the signed-rate PlaybackEngine that drives the source playhead from
 * the shared audio clock. UI must not import engine/; this file is the
 * sanctioned facade. Source session facts stay in sourceMonitorStore.
 *
 * Exclusive owner: requestPlayback('source') pauses Program first;
 * Program play() / pause-and-drain / dispose stop the source clock first
 * through registerSourcePlaybackStop, and pause-and-drain waits for this
 * controller's audio decoder teardown. Forward 1x with imported audio
 * auditions through the same AudioContext and startAudio pipeline as
 * Program, on a review TimelineDoc that never enters documentStore.
 * Reverse and 2/4/8 stay silent.
 */

import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'
import {
  createSourceBoundsCatalog,
  type SourceBoundsCatalog,
} from '../domain/crossfadePlan'
import { CURRENT_TIMELINE_SCHEMA_VERSION } from '../domain/projectFile'
import type { AssetId, Clip, MediaAsset, TimelineDoc, Track } from '../domain/schema'
import {
  sourceMonitorAudioAudition,
  type SourceMonitorSession,
  type SourceMonitorShuttleKey,
  type MonitorPlaybackHandoff,
} from '../domain/sourceMonitor'
import { PlaybackEngine } from '../engine/playback-engine'
import {
  hasAudioPlaybackContent,
  startTimelineAudioPlayback,
  type PlaybackAssetResolver,
  type StartTimelineAudioOptions,
  type TimelineAudioPlaybackDiagnostics,
  type TimelineAudioPlaybackSession,
  type TimelineAudioPlaybackWarning,
} from '../pipeline/playback-audio'
import { useMediaStore } from '../state/mediaStore'
import {
  getSourceMonitorResetRevision,
  useSourceMonitorStore,
} from '../state/sourceMonitorStore'
import {
  beginProgramPlaybackDrain,
  getPlaybackClockContext,
  pause,
  registerSourcePlaybackStop,
  type ClockContext,
  type TransportDeps,
} from './transportController'
import {
  captureMediaRuntimeGuard,
  mediaRuntimeFailure,
  reportMediaRuntimeFailure,
  type MediaRuntimeGuard,
} from './mediaCompatibilityController'
import { beginPreviewPlaybackDrain } from './previewController'

export interface SourcePlaybackDeps {
  scheduleTick(cb: () => void): number
  cancelTick(id: number): void
  fetchBlob(url: string): Promise<Blob>
  startAudio: TransportDeps['startAudio']
}

const IDENTITY_TRANSFORM = Object.freeze({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
})

const realDeps: SourcePlaybackDeps = {
  scheduleTick: (cb) => requestAnimationFrame(cb),
  cancelTick: (id) => cancelAnimationFrame(id),
  fetchBlob: async (url) => {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Could not read source playback media (${response.status} ${response.statusText})`,
      )
    }
    return response.blob()
  },
  startAudio: (context, doc, fromFrame, resolveAsset, options) =>
    startTimelineAudioPlayback(
      context as AudioContext,
      doc,
      fromFrame,
      resolveAsset,
      options,
    ),
}

interface ControllerState {
  deps: SourcePlaybackDeps
  engine: PlaybackEngine | null
  audioSession: TimelineAudioPlaybackSession | null
  startupAbort: AbortController | null
  playGeneration: number
  activeGeneration: number
  startedRevision: number
  unsubscribeReset: (() => void) | null
  playbackTasks: Set<Promise<void>>
  cleanupTasks: Set<Promise<void>>
}

const state: ControllerState = {
  deps: realDeps,
  engine: null,
  audioSession: null,
  startupAbort: null,
  playGeneration: 0,
  activeGeneration: -1,
  startedRevision: 0,
  unsubscribeReset: null,
  playbackTasks: new Set(),
  cleanupTasks: new Set(),
}

function isCurrentRun(): boolean {
  return state.activeGeneration === state.playGeneration
    && state.startedRevision === getSourceMonitorResetRevision()
}

function warnSourceAudio(message: string, cause: unknown): void {
  console.warn(
    `[sourceMonitorPlaybackController] ${message}:`,
    cause instanceof Error ? cause.message : cause,
  )
}

function trackCleanup(
  operation: Promise<unknown>,
  failureMessage: string,
): Promise<void> {
  const cleanup = operation.then(
    () => undefined,
    (cause) => warnSourceAudio(failureMessage, cause),
  )
  state.cleanupTasks.add(cleanup)
  void cleanup.then(() => state.cleanupTasks.delete(cleanup))
  return cleanup
}

function stopSourceAudioSession(): void {
  state.startupAbort?.abort()
  state.startupAbort = null
  const session = state.audioSession
  state.audioSession = null
  if (!session) return
  let pending: Promise<unknown>
  try {
    pending = Promise.resolve(session.stop())
  } catch (cause) {
    pending = Promise.reject(cause)
  }
  void trackCleanup(pending, 'source audio cleanup failed')
}

function haltSourceEngine(): void {
  state.playGeneration++
  state.engine?.stop()
  stopSourceAudioSession()
}

function stopSourceClock(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().stopPlayback()
}

/** Stop Source immediately while retaining its session and marks. */
export function suspendSourcePlayback(): void {
  stopSourceClock()
}

function subscribeSourceReset(): void {
  if (state.unsubscribeReset) return
  state.unsubscribeReset = useSourceMonitorStore.subscribe((current, previous) => {
    if (state.startedRevision !== getSourceMonitorResetRevision()) {
      haltSourceEngine()
    }
    if (current.session === null) {
      haltSourceEngine()
    }
    if (current.session?.source !== previous.session?.source) {
      stopSourceClock()
    }
  })
}

function ensureSourceEngine(): PlaybackEngine {
  if (state.engine) return state.engine

  const clock = getPlaybackClockContext()
  state.engine = new PlaybackEngine({
    clock,
    scheduleTick: state.deps.scheduleTick,
    cancelTick: state.deps.cancelTick,
    onFrame: (frame) => {
      if (!isCurrentRun()) return
      const store = useSourceMonitorStore.getState()
      const session = store.session
      if (!session || store.playbackOwner !== 'source') return
      store.advancePlayhead(frame - session.playheadFrame)
      const next = useSourceMonitorStore.getState().session
      if (!next || next.shuttleStep === 0) haltSourceEngine()
    },
    onEnded: () => {
      if (!isCurrentRun()) return
      haltSourceEngine()
      useSourceMonitorStore.getState().stopPlayback()
    },
  })
  subscribeSourceReset()
  return state.engine
}

function currentAsset(session: SourceMonitorSession): MediaAsset | undefined {
  return useMediaStore.getState().assets.get(session.source.assetId)
}

function reviewAudioClip(session: SourceMonitorSession): Clip {
  return {
    id: 'source-review-audio',
    assetId: session.source.assetId,
    name: session.source.fileName,
    sourceMode: 'timed',
    sourceRange: {
      startFrame: 0,
      durationFrames: session.source.durationFrames,
    },
    timelineRange: {
      startFrame: 0,
      durationFrames: session.source.durationFrames,
    },
    transform: { ...IDENTITY_TRANSFORM },
    opacity: 1,
    volume: 1,
    effects: [],
  }
}

function reviewAudioTrack(session: SourceMonitorSession): Track {
  return {
    id: 'source-review-A1',
    kind: 'audio',
    name: 'Source',
    clips: [reviewAudioClip(session)],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
  }
}

function buildSourceAudioReviewDocument(
  session: SourceMonitorSession,
  asset: MediaAsset | undefined,
): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id: `source-review:${session.source.assetId}`,
    name: session.source.fileName,
    frameRate: session.source.rate,
    width: Math.max(1, asset?.width ?? 1920),
    height: Math.max(1, asset?.height ?? 1080),
    audioSampleRate: asset?.audioSampleRate ?? 48_000,
    tracks: [reviewAudioTrack(session)],
  }
}

function currentSourceBoundsCatalog(): SourceBoundsCatalog {
  return createSourceBoundsCatalog(
    useMediaStore.getState().descriptors.values(),
  )
}

function createAssetResolver(
  assets: ReadonlyMap<AssetId, MediaAsset>,
  fetchBlob: SourcePlaybackDeps['fetchBlob'],
): PlaybackAssetResolver {
  return (assetId) => {
    const asset = assets.get(assetId)
    if (!asset) {
      throw new Error(
        `Source playback media asset "${assetId}" is missing from the media pool`,
      )
    }
    if (!asset.hasAudio) {
      throw new Error(
        `Source playback media asset "${asset.fileName}" has no imported audio track`,
      )
    }
    try {
      return Promise.resolve(fetchBlob(asset.objectUrl)).then((blob) => ({
        blob,
        budget: mediaAssetDecoderBudget(asset, blob.size),
      }))
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
}

function audioWarningMessage(warning: TimelineAudioPlaybackWarning): string {
  if (warning.scope === 'media') {
    if (warning.stage === 'source-open') {
      return `source audio clip "${warning.clipId}" source open failed`
    }
    if (warning.stage === 'decoded-timing') {
      return `source audio clip "${warning.clipId}" produced invalid decoded timing`
    }
    return `source audio clip "${warning.clipId}" decode failed`
  }
  if (warning.stage === 'output-schedule') {
    return 'source audio output scheduling failed'
  }
  if (warning.stage === 'pump') return 'source audio refill failed'
  return 'source audio cleanup failed'
}

function captureSourceAudioRuntimeGuard(
  session: SourceMonitorSession,
  asset: MediaAsset | undefined,
): MediaRuntimeGuard | null {
  if (!asset) return null
  const guard = captureMediaRuntimeGuard(session.source.assetId)
  if (!guard || guard.objectUrl !== asset.objectUrl) return null
  return guard
}

function startSourceEngine(
  engine: PlaybackEngine,
  session: SourceMonitorSession,
  anchorTime: number,
): void {
  engine.start(
    session.playheadFrame,
    session.source.durationFrames,
    session.source.rate,
    anchorTime,
    session.shuttleStep,
  )
}

function startSourceAudio(
  engine: PlaybackEngine,
  session: SourceMonitorSession,
  context: ClockContext,
  generation: number,
): void {
  const media = useMediaStore.getState()
  const asset = currentAsset(session)
  const doc = buildSourceAudioReviewDocument(session, asset)
  const catalog = currentSourceBoundsCatalog()
  if (!hasAudioPlaybackContent(doc, session.playheadFrame, catalog)) {
    startSourceEngine(engine, session, context.currentTime)
    return
  }

  const abort = new AbortController()
  state.startupAbort = abort
  const assets = new Map(media.assets)
  const guard = captureSourceAudioRuntimeGuard(session, asset)
  const resolveAsset = createAssetResolver(assets, state.deps.fetchBlob)
  const options: StartTimelineAudioOptions = {
    signal: abort.signal,
    sourceBoundsCatalog: catalog,
    onWarning: (warning) => {
      warnSourceAudio(audioWarningMessage(warning), warning.cause)
      if (warning.scope !== 'media' || !guard) return
      if (warning.assetId !== session.source.assetId) return
      reportMediaRuntimeFailure(
        guard,
        mediaRuntimeFailure(
          'audio-playback',
          warning.trackKind,
          warning.cause,
          warning.reason,
        ),
      )
    },
  }

  const playbackTask = (async () => {
    const audioSession = await state.deps.startAudio(
      context,
      doc,
      session.playheadFrame,
      resolveAsset,
      options,
    )
    if (
      abort.signal.aborted
      || generation !== state.playGeneration
      || !isCurrentRun()
    ) {
      try {
        await audioSession.stop()
      } catch (cause) {
        warnSourceAudio('stale source audio cleanup failed', cause)
      }
      return
    }
    const live = useSourceMonitorStore.getState()
    if (
      live.playbackOwner !== 'source'
      || !live.session
      || !sourceMonitorAudioAudition(live.session)
    ) {
      try {
        await audioSession.stop()
      } catch (cause) {
        warnSourceAudio('stale source audio cleanup failed', cause)
      }
      return
    }

    state.startupAbort = null
    state.audioSession = audioSession
    startSourceEngine(engine, live.session, audioSession.anchorTime)
  })().catch((cause) => {
    if (
      abort.signal.aborted
      || generation !== state.playGeneration
      || !isCurrentRun()
    ) return
    state.startupAbort = null
    warnSourceAudio('source audio playback disabled; continuing with video', cause)
    const live = useSourceMonitorStore.getState().session
    if (!live || live.shuttleStep === 0) return
    startSourceEngine(engine, live, context.currentTime)
  })
  state.playbackTasks.add(playbackTask)
  void playbackTask.then(() => state.playbackTasks.delete(playbackTask))
}

function startSourceClock(): void {
  const store = useSourceMonitorStore.getState()
  const session = store.session
  if (!session || session.shuttleStep === 0 || store.playbackOwner !== 'source') {
    haltSourceEngine()
    return
  }

  haltSourceEngine()
  let engine: PlaybackEngine
  let context: ClockContext
  try {
    engine = ensureSourceEngine()
    context = getPlaybackClockContext()
  } catch {
    return
  }

  const generation = state.playGeneration
  state.activeGeneration = generation
  state.startedRevision = getSourceMonitorResetRevision()

  let resumePromise: Promise<unknown>
  try {
    resumePromise = Promise.resolve(context.resume())
  } catch (cause) {
    resumePromise = Promise.reject(cause)
  }
  void resumePromise.catch(() => {
    if (state.activeGeneration !== generation) return
    haltSourceEngine()
    useSourceMonitorStore.getState().stopPlayback()
  })

  const startAdmittedSource = (): void => {
    if (
      generation !== state.playGeneration
      || !isCurrentRun()
    ) return
    const live = useSourceMonitorStore.getState()
    if (
      live.playbackOwner !== 'source'
      || !live.session
      || live.session.shuttleStep === 0
    ) return
    if (sourceMonitorAudioAudition(live.session)) {
      startSourceAudio(engine, live.session, context, generation)
      return
    }
    startSourceEngine(engine, live.session, context.currentTime)
  }
  const previewDrain = beginPreviewPlaybackDrain()
  const programDrain = beginProgramPlaybackDrain()
  if (!previewDrain && !programDrain) {
    startAdmittedSource()
    return
  }
  const admissionTask = Promise.all([
    previewDrain ?? Promise.resolve(),
    programDrain ?? Promise.resolve(),
  ]).then(startAdmittedSource).catch((cause) => {
    if (generation !== state.playGeneration || !isCurrentRun()) return
    warnSourceAudio('Program playback handoff failed', cause)
    stopSourceClock()
  })
  state.playbackTasks.add(admissionTask)
  void admissionTask.then(() => state.playbackTasks.delete(admissionTask))
}

registerSourcePlaybackStop(stopSourceClock, drainSourcePlayback)

/**
 * Swap the injected tick scheduler (tests). Must run before the first
 * source start of a controller lifetime; disposeSourcePlayback restores
 * the real ones.
 */
export function configureSourcePlayback(deps: Partial<SourcePlaybackDeps>): void {
  state.deps = { ...realDeps, ...deps }
}

export function requestPlayback(
  requested: 'program' | 'source',
): MonitorPlaybackHandoff {
  const store = useSourceMonitorStore.getState()
  if (requested === 'program') {
    stopSourceClock()
    return store.requestPlayback('program')
  }
  if (store.session === null) {
    return store.requestPlayback('source')
  }
  pause()
  const handoff = useSourceMonitorStore.getState().requestPlayback('source')
  startSourceClock()
  return handoff
}

export function stepShuttle(key: SourceMonitorShuttleKey): void {
  const store = useSourceMonitorStore.getState()
  store.stepShuttle(key)
  const session = useSourceMonitorStore.getState().session
  if (!session || session.shuttleStep === 0) {
    haltSourceEngine()
    return
  }
  requestPlayback('source')
}

export function scrubPlayhead(frame: number): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().scrubPlayhead(frame)
}

/** Stop Source playback and wait until its startup, audio, and cleanup work retires. */
export async function drainSourcePlayback(): Promise<void> {
  stopSourceClock()
  // Snapshot playback once. A later Source admission may wait on Program
  // drain, which can wait on a Program admission that waits on this drain.
  // Re-checking playbackTasks would pull that cycle in and hang.
  await Promise.all([
    ...state.playbackTasks,
    ...state.cleanupTasks,
  ])
  while (state.cleanupTasks.size > 0) {
    await Promise.all([...state.cleanupTasks])
  }
}

export function stepFrame(deltaFrames: number): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().stepFrame(deltaFrames)
}

export function jumpToStart(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().jumpToStart()
}

export function jumpToEnd(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().jumpToEnd()
}

export function jumpToIn(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().jumpToIn()
}

export function jumpToOut(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().jumpToOut()
}

export function closeSource(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().closeSource()
}

export function resetSession(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().resetSession()
}

/** Stop the source clock and drop the engine. Does not close Program's AudioContext. */
export async function disposeSourcePlayback(): Promise<void> {
  await drainSourcePlayback()
  state.engine = null
  state.activeGeneration = -1
  state.unsubscribeReset?.()
  state.unsubscribeReset = null
  state.deps = realDeps
}

/** Dev/browser verification hook; null while silent or still priming. */
export function getSourceAudioPlaybackDiagnostics():
  | TimelineAudioPlaybackDiagnostics
  | null {
  return state.audioSession?.diagnostics() ?? null
}
