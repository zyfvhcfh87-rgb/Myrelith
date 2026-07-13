/**
 * app/transportController.ts — Composition root for playback transport.
 * Phase 4.0.5 (transport bar).
 *
 * Same pattern as previewController: NOT a component, NOT engine/ — the
 * one sanctioned place where the playback engine meets the stores.
 * ui/TransportBar.tsx calls play/pause/toggle/stepFrame as its facade and
 * never touches engine/ itself.
 *
 * Wiring: live audio is primed through pipeline/playback-audio, which returns
 * the exact AudioContext anchor used by its scheduled buffers. PlaybackEngine
 * receives that SAME anchor, so video always derives its frame from the audio
 * clock (ARCHITECTURE rule 3). Scrubbing pauses playback: both would write the
 * playhead and the last writer would flicker-fight the other.
 *
 * Mid-play safety: every emitted frame is clamped against the CURRENT doc
 * duration (edits can shorten the doc while playing); hitting the end
 * pauses with the playhead on the last frame.
 */

import type { AssetId, MediaAsset, TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import { PlaybackEngine } from '../engine/playback-engine'
import type { PlaybackClock } from '../engine/playback-engine'
import {
  audioPlaybackAssetIds,
  audioPlaybackPlanKey,
  hasAudioPlaybackContent,
  startTimelineAudioPlayback,
} from '../pipeline/playback-audio'
import type {
  PlaybackAssetResolver,
  StartTimelineAudioOptions,
  TimelineAudioPlaybackDiagnostics,
  TimelineAudioPlaybackSession,
} from '../pipeline/playback-audio'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'

/** The slice of AudioContext we use (fake-able in tests). */
export interface ClockContext extends PlaybackClock {
  resume(): Promise<unknown>
  close?(): Promise<unknown>
}

/** Injection points so tests run without AudioContext/rAF. */
export interface TransportDeps {
  createContext(): ClockContext
  scheduleTick(cb: () => void): number
  cancelTick(id: number): void
  fetchBlob(url: string): Promise<Blob>
  startAudio(
    context: ClockContext,
    doc: TimelineDoc,
    fromFrame: number,
    resolveAsset: PlaybackAssetResolver,
    options: StartTimelineAudioOptions,
  ): Promise<TimelineAudioPlaybackSession>
}

const realDeps: TransportDeps = {
  createContext: () => new AudioContext(),
  scheduleTick: (cb) => requestAnimationFrame(cb),
  cancelTick: (id) => cancelAnimationFrame(id),
  fetchBlob: async (url) => {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Could not read playback media (${response.status} ${response.statusText})`,
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
  deps: TransportDeps
  engine: PlaybackEngine | null
  clockCtx: ClockContext | null
  audioSession: TimelineAudioPlaybackSession | null
  startupAbort: AbortController | null
  playGeneration: number
  audioPlanKey: string
  audioAssetsKey: string
  unsubscribes: Array<() => void>
  /** Async playback startups and stop work that project switching must drain. */
  playbackTasks: Set<Promise<void>>
  cleanupTasks: Set<Promise<void>>
}

const state: ControllerState = {
  deps: realDeps,
  engine: null,
  clockCtx: null,
  audioSession: null,
  startupAbort: null,
  playGeneration: 0,
  audioPlanKey: '',
  audioAssetsKey: '',
  unsubscribes: [],
  playbackTasks: new Set(),
  cleanupTasks: new Set(),
}

/** Last frame the playhead may rest on; 0 for an empty doc. */
function lastFrame(): number {
  return Math.max(0, docDurationFrames(useDocumentStore.getState().doc) - 1)
}

function warnAudio(message: string, cause: unknown): void {
  console.warn(
    `[transportController] ${message}:`,
    cause instanceof Error ? cause.message : cause,
  )
}

function audioAssetsKey(
  doc: TimelineDoc,
  fromFrame: number,
  assets: ReadonlyMap<AssetId, MediaAsset>,
): string {
  return audioPlaybackAssetIds(doc, fromFrame)
    .map((id) => `${id}:${assets.get(id)?.objectUrl ?? '<missing>'}`)
    .join('|')
}

/** Resolve from the immutable media snapshot; the live source owns caching. */
function createAssetResolver(
  assets: ReadonlyMap<AssetId, MediaAsset>,
  fetchBlob: TransportDeps['fetchBlob'],
): PlaybackAssetResolver {
  return (assetId) => {
    const asset = assets.get(assetId)
    if (!asset) {
      throw new Error(
        `Playback media asset "${assetId}" is missing from the media pool`,
      )
    }
    try {
      return Promise.resolve(fetchBlob(asset.objectUrl))
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
}

function trackCleanup(
  operation: Promise<unknown>,
  failureMessage: string,
): Promise<void> {
  const cleanup = operation.then(
    () => undefined,
    (cause) => warnAudio(failureMessage, cause),
  )
  state.cleanupTasks.add(cleanup)
  void cleanup.then(() => state.cleanupTasks.delete(cleanup))
  return cleanup
}

function stopAudioSession(): void {
  state.startupAbort?.abort()
  state.startupAbort = null
  const session = state.audioSession
  state.audioSession = null
  if (session) {
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(session.stop())
    } catch (cause) {
      pending = Promise.reject(cause)
    }
    void trackCleanup(pending, 'audio cleanup failed')
  }
}

function cancelPlaybackWork(): void {
  state.playGeneration++
  state.engine?.stop()
  stopAudioSession()
}

function ensureEngine(): PlaybackEngine {
  if (state.engine) return state.engine

  state.clockCtx = state.deps.createContext()
  state.engine = new PlaybackEngine({
    clock: state.clockCtx,
    scheduleTick: state.deps.scheduleTick,
    cancelTick: state.deps.cancelTick,
    onFrame: (frame) => {
      // Clamp against the CURRENT duration — edits may have shortened the
      // doc since start(). Reaching the end (either way) parks and pauses.
      const last = lastFrame()
      if (frame > last) {
        useTransportStore.getState().setPlayheadFrame(Math.min(frame, last))
        pause()
      } else {
        useTransportStore.getState().setPlayheadFrame(frame)
      }
    },
    onEnded: () => {
      cancelPlaybackWork()
      useTransportStore.getState().setIsPlaying(false)
    },
  })
  state.unsubscribes.push(
    // A scrub gesture takes over the playhead — playback yields.
    useTransportStore.subscribe((s, prev) => {
      if (s.isScrubbing && !prev.isScrubbing) pause()
    }),
    useDocumentStore.subscribe((s, prev) => {
      if (
        s.doc !== prev.doc
        && useTransportStore.getState().isPlaying
        && audioPlaybackPlanKey(s.doc) !== state.audioPlanKey
      ) {
        restartPlayback()
      }
    }),
    useMediaStore.subscribe((s, prev) => {
      if (
        s.assets !== prev.assets
        && useTransportStore.getState().isPlaying
      ) {
        const doc = useDocumentStore.getState().doc
        if (
          audioAssetsKey(doc, 0, s.assets)
          !== state.audioAssetsKey
        ) {
          restartPlayback()
        }
      }
    }),
  )
  return state.engine
}

/**
 * Swap the injected deps (tests). Must run before the first play() of a
 * controller lifetime; disposeTransport() restores the real ones.
 */
export function configureTransport(deps: Partial<TransportDeps>): void {
  state.deps = { ...realDeps, ...deps }
}

function startPlayback(fromFrame: number): void {
  const transport = useTransportStore.getState()
  const doc = useDocumentStore.getState().doc
  const durationFrames = docDurationFrames(doc)
  if (durationFrames <= 0) {
    transport.setIsPlaying(false)
    return
  }

  const from = Math.min(durationFrames - 1, Math.max(0, fromFrame))
  if (from !== transport.playheadFrame) transport.setPlayheadFrame(from)
  let engine: PlaybackEngine
  try {
    engine = ensureEngine()
  } catch (cause) {
    warnAudio('playback clock initialization failed', cause)
    transport.setIsPlaying(false)
    return
  }
  const context = state.clockCtx
  if (!context) {
    transport.setIsPlaying(false)
    return
  }

  const generation = ++state.playGeneration
  const abort = new AbortController()
  state.startupAbort = abort
  const assets = new Map(useMediaStore.getState().assets)
  state.audioPlanKey = audioPlaybackPlanKey(doc)
  // Keep the media fingerprint stable as the playhead advances; otherwise an
  // unrelated media-pool edit after an early clip ends would look like a
  // playback-asset removal and cause an unnecessary restart.
  state.audioAssetsKey = audioAssetsKey(doc, 0, assets)

  let resumePromise: Promise<unknown>
  try {
    // Called synchronously inside the Play click so browser autoplay policy
    // can unlock the context before any asynchronous decode work.
    resumePromise = Promise.resolve(context.resume())
  } catch (cause) {
    resumePromise = Promise.reject(cause)
  }
  void resumePromise.catch((cause) => {
    if (
      generation !== state.playGeneration
      || !useTransportStore.getState().isPlaying
    ) return
    warnAudio('AudioContext resume failed', cause)
    cancelPlaybackWork()
    useTransportStore.getState().setIsPlaying(false)
  })

  if (!hasAudioPlaybackContent(doc, from)) {
    state.startupAbort = null
    engine.start(from, durationFrames, doc.frameRate, context.currentTime)
    return
  }

  const resolveAsset = createAssetResolver(assets, state.deps.fetchBlob)
  const playbackTask = (async () => {
    const session = await state.deps.startAudio(
      context,
      doc,
      from,
      resolveAsset,
      {
        signal: abort.signal,
        onWarning: (clipId, cause) =>
          warnAudio(
            clipId
              ? `audio clip "${clipId}" was silenced`
              : 'audio refill failed',
            cause,
          ),
      },
    )
    if (
      abort.signal.aborted
      || generation !== state.playGeneration
      || !useTransportStore.getState().isPlaying
    ) {
      try {
        await session.stop()
      } catch (cause) {
        warnAudio('stale audio cleanup failed', cause)
      }
      return
    }

    state.startupAbort = null
    state.audioSession = session
    engine.start(from, durationFrames, doc.frameRate, session.anchorTime)
  })().catch((cause) => {
    if (
      abort.signal.aborted
      || generation !== state.playGeneration
      || !useTransportStore.getState().isPlaying
    ) return
    state.startupAbort = null
    warnAudio('audio playback disabled; continuing with video', cause)
    engine.start(from, durationFrames, doc.frameRate, context.currentTime)
  })
  state.playbackTasks.add(playbackTask)
  void playbackTask.then(() => state.playbackTasks.delete(playbackTask))
}

function restartPlayback(): void {
  const transport = useTransportStore.getState()
  if (!transport.isPlaying) return
  const frame = transport.playheadFrame
  cancelPlaybackWork()
  startPlayback(frame)
}

/**
 * Start playback from the current playhead; from the beginning when the
 * playhead already rests at/after the last frame. No-op on an empty doc.
 */
export function play(): void {
  const transport = useTransportStore.getState()
  if (transport.isPlaying) return

  const doc = useDocumentStore.getState().doc
  if (docDurationFrames(doc) <= 0) return
  const last = lastFrame()

  let from = transport.playheadFrame
  if (from >= last) {
    from = 0
    transport.setPlayheadFrame(0)
  }

  transport.setIsPlaying(true)
  startPlayback(from)
}

/** Stop advancing; the playhead stays exactly where it is. */
export function pause(): void {
  cancelPlaybackWork()
  useTransportStore.getState().setIsPlaying(false)
}

/** The play/pause button behavior. */
export function togglePlayback(): void {
  if (useTransportStore.getState().isPlaying) pause()
  else play()
}

/**
 * Nudge the playhead by a signed number of frames (buttons use ±1),
 * clamped to [0, last content frame]. Stepping while playing pauses
 * first — the standard NLE gesture for "let me look at this frame".
 */
export function stepFrame(delta: number): void {
  pause()
  const transport = useTransportStore.getState()
  const next = Math.min(lastFrame(), Math.max(0, transport.playheadFrame + delta))
  transport.setPlayheadFrame(next)
}

/**
 * Tear down engine + subscriptions and wait for every old audio consumer.
 * Project activation awaits this before revoking the outgoing media URLs.
 */
export async function disposeTransport(): Promise<void> {
  cancelPlaybackWork()
  const context = state.clockCtx
  state.engine = null
  state.clockCtx = null
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  state.audioPlanKey = ''
  state.audioAssetsKey = ''
  state.deps = realDeps

  await Promise.all([
    ...state.playbackTasks,
    ...state.cleanupTasks,
  ])
  if (context?.close) {
    try {
      await context.close()
    } catch (cause) {
      warnAudio('AudioContext close failed', cause)
    }
  }
}

/** Dev/browser verification hook; null while silent or still priming. */
export function getAudioPlaybackDiagnostics():
  | TimelineAudioPlaybackDiagnostics
  | null {
  return state.audioSession?.diagnostics() ?? null
}
