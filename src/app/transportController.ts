/**
 * app/transportController.ts — Composition root for playback transport.
 * Phase 4.0.5 (transport bar).
 *
 * Same pattern as previewController: NOT a component, NOT engine/ — the
 * one sanctioned place where the playback engine meets the stores.
 * ui/TransportBar.tsx calls play/pause/toggle/stepFrame as its facade and
 * never touches engine/ itself.
 *
 * Wiring: engine.onFrame → transportStore.setPlayheadFrame (Preview and
 * Playhead already follow it, rAF-coalesced); engine.onEnded →
 * isPlaying=false. The real clock is an AudioContext created lazily on
 * first play() — inside the click gesture, so autoplay policy lets it run
 * (ARCHITECTURE rule 3: the audio clock is the master even while nothing
 * is audible yet). Scrubbing pauses playback: both would write
 * playheadFrame and the last writer would flicker-fight the other.
 *
 * Mid-play safety: every emitted frame is clamped against the CURRENT doc
 * duration (edits can shorten the doc while playing); hitting the end
 * pauses with the playhead on the last frame.
 */

import { docDurationFrames } from '../domain/selectors'
import { PlaybackEngine } from '../engine/playback-engine'
import type { PlaybackClock } from '../engine/playback-engine'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'

/** The slice of AudioContext we use (fake-able in tests). */
export interface ClockContext extends PlaybackClock {
  resume(): Promise<unknown>
}

/** Injection points so tests run without AudioContext/rAF. */
export interface TransportDeps {
  createContext(): ClockContext
  scheduleTick(cb: () => void): number
  cancelTick(id: number): void
}

const realDeps: TransportDeps = {
  createContext: () => new AudioContext(),
  scheduleTick: (cb) => requestAnimationFrame(cb),
  cancelTick: (id) => cancelAnimationFrame(id),
}

interface ControllerState {
  deps: TransportDeps
  engine: PlaybackEngine | null
  clockCtx: ClockContext | null
  unsubscribes: Array<() => void>
}

const state: ControllerState = {
  deps: realDeps,
  engine: null,
  clockCtx: null,
  unsubscribes: [],
}

/** Last frame the playhead may rest on; 0 for an empty doc. */
function lastFrame(): number {
  return Math.max(0, docDurationFrames(useDocumentStore.getState().doc) - 1)
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
      if (frame >= last) {
        useTransportStore.getState().setPlayheadFrame(Math.min(frame, last))
        pause()
      } else {
        useTransportStore.getState().setPlayheadFrame(frame)
      }
    },
    onEnded: () => {
      useTransportStore.getState().setIsPlaying(false)
    },
  })
  state.unsubscribes.push(
    // A scrub gesture takes over the playhead — playback yields.
    useTransportStore.subscribe((s, prev) => {
      if (s.isScrubbing && !prev.isScrubbing) pause()
    }),
  )
  return state.engine
}

/**
 * Swap the injected deps (tests). Must run before the first play() of a
 * controller lifetime; disposeTransport() restores the real ones.
 */
export function configureTransport(deps: TransportDeps): void {
  state.deps = deps
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

  const engine = ensureEngine()
  void state.clockCtx?.resume().catch(() => {
    /* clock stays suspended → playhead simply holds; nothing to break */
  })
  engine.start(from, last, doc.frameRate)
  transport.setIsPlaying(true)
}

/** Stop advancing; the playhead stays exactly where it is. */
export function pause(): void {
  state.engine?.stop()
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

/** Tear down engine + subscriptions (tests / real teardown). */
export function disposeTransport(): void {
  state.engine?.stop()
  state.engine = null
  state.clockCtx = null
  for (const unsubscribe of state.unsubscribes) unsubscribe()
  state.unsubscribes = []
  state.deps = realDeps
}
