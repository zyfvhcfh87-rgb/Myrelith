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
 * through registerSourcePlaybackStop. This slice does not audition source
 * audio and never starts a second Program mix.
 */

import { PlaybackEngine } from '../engine/playback-engine'
import type {
  MonitorPlaybackHandoff,
  SourceMonitorShuttleKey,
} from '../domain/sourceMonitor'
import {
  getSourceMonitorResetRevision,
  useSourceMonitorStore,
} from '../state/sourceMonitorStore'
import {
  getPlaybackClockContext,
  pause,
  registerSourcePlaybackStop,
  type ClockContext,
} from './transportController'

export interface SourcePlaybackDeps {
  scheduleTick(cb: () => void): number
  cancelTick(id: number): void
}

const realDeps: SourcePlaybackDeps = {
  scheduleTick: (cb) => requestAnimationFrame(cb),
  cancelTick: (id) => cancelAnimationFrame(id),
}

interface ControllerState {
  deps: SourcePlaybackDeps
  engine: PlaybackEngine | null
  playGeneration: number
  activeGeneration: number
  startedRevision: number
  unsubscribeReset: (() => void) | null
}

const state: ControllerState = {
  deps: realDeps,
  engine: null,
  playGeneration: 0,
  activeGeneration: -1,
  startedRevision: 0,
  unsubscribeReset: null,
}

function isCurrentRun(): boolean {
  return state.activeGeneration === state.playGeneration
    && state.startedRevision === getSourceMonitorResetRevision()
}

function haltSourceEngine(): void {
  state.playGeneration++
  state.engine?.stop()
}

function stopSourceClock(): void {
  haltSourceEngine()
  useSourceMonitorStore.getState().stopPlayback()
}

function subscribeSourceReset(): void {
  if (state.unsubscribeReset) return
  state.unsubscribeReset = useSourceMonitorStore.subscribe(() => {
    if (state.startedRevision !== getSourceMonitorResetRevision()) {
      haltSourceEngine()
    }
    if (useSourceMonitorStore.getState().session === null) {
      haltSourceEngine()
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

  engine.start(
    session.playheadFrame,
    session.source.durationFrames,
    session.source.rate,
    context.currentTime,
    session.shuttleStep,
  )
}

registerSourcePlaybackStop(stopSourceClock)

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
  haltSourceEngine()
  useSourceMonitorStore.getState().stopPlayback()
  state.engine = null
  state.activeGeneration = -1
  state.unsubscribeReset?.()
  state.unsubscribeReset = null
  state.deps = realDeps
}
