/**
 * state/sourceMonitorStore.ts — session-only Source Monitor facts.
 *
 * No history middleware and no project-file fields. Playhead, In/Out, shuttle,
 * and which monitor owns the playback clock live here until project replacement
 * or an explicit close. Domain operations stay the authority; rejected edits
 * keep the current session reference so the store writes nothing.
 */

import { create } from 'zustand'
import { defaultSourcePatch } from '../domain/threePointEdit'
import {
  advanceSourcePlayhead,
  clearSourceIn,
  clearSourceMarks,
  clearSourceOut,
  closeSourceMonitor,
  jumpSourceToEnd,
  jumpSourceToIn,
  jumpSourceToOut,
  jumpSourceToStart,
  openSourceMonitor,
  parkSourcePlayback,
  requestMonitorPlayback,
  resetSourceSession,
  scrubSourcePlayhead,
  setSourceIn,
  setSourceOut,
  setSourcePlayhead,
  stepSourceFrame,
  stepSourceShuttle,
  stopSourcePlayback,
  type MonitorPlaybackHandoff,
  type MonitorPlaybackOwner,
  type SourceMonitorOpenInput,
  type SourceMonitorOpenRejection,
  type SourceMonitorOpenResult,
  type SourceMonitorSession,
  type SourceMonitorShuttleKey,
} from '../domain/sourceMonitor'

export interface SourceMonitorState {
  readonly session: SourceMonitorSession | null
  readonly playbackOwner: MonitorPlaybackOwner
  readonly lastOpenRejection: SourceMonitorOpenRejection | null
  readonly patchVideo: boolean
  readonly patchAudio: boolean
}

export interface SourceMonitorStore extends SourceMonitorState {
  openSource(input: SourceMonitorOpenInput): SourceMonitorOpenResult
  closeSource(): void
  setPlayhead(frame: number): void
  scrubPlayhead(frame: number): void
  stepFrame(deltaFrames: number): void
  advancePlayhead(deltaFrames: number): void
  stopPlayback(): void
  parkPlayback(): void
  jumpToStart(): void
  jumpToEnd(): void
  jumpToIn(): void
  jumpToOut(): void
  setIn(): void
  setOut(): void
  clearIn(): void
  clearOut(): void
  clearMarks(): void
  resetSession(): void
  stepShuttle(key: SourceMonitorShuttleKey): void
  requestPlayback(requested: 'program' | 'source'): MonitorPlaybackHandoff
  setSourcePatch(patch: { video?: boolean; audio?: boolean }): void
  /** Drop every source-monitor field when the active project is replaced. */
  resetSourceMonitor(): void
}

export const INITIAL_SOURCE_MONITOR_STATE: SourceMonitorState = Object.freeze({
  session: null,
  playbackOwner: 'none',
  lastOpenRejection: null,
  patchVideo: true,
  patchAudio: true,
})

let sourceMonitorResetRevision = 0

export function getSourceMonitorResetRevision(): number {
  return sourceMonitorResetRevision
}

type SessionUpdate = (
  session: SourceMonitorSession,
) => SourceMonitorSession

export const useSourceMonitorStore = create<SourceMonitorStore>()((set, get) => {
  function applySession(update: SessionUpdate): void {
    set((state) => {
      if (!state.session) return state
      const session = update(state.session)
      return session === state.session ? state : { session }
    })
  }

  return {
    ...INITIAL_SOURCE_MONITOR_STATE,

    openSource: (input) => {
      const result = openSourceMonitor(get().session, input)
      set((state) => {
        if (result.status === 'rejected') {
          return state.lastOpenRejection === result.reason
            ? state
            : { lastOpenRejection: result.reason }
        }
        const patch = input.asset
          ? defaultSourcePatch(input.asset)
          : { video: true, audio: true }
        if (
          state.session === result.session
          && state.lastOpenRejection === null
          && state.patchVideo === patch.video
          && state.patchAudio === patch.audio
        ) return state
        return {
          session: result.session,
          lastOpenRejection: null,
          patchVideo: patch.video,
          patchAudio: patch.audio,
        }
      })
      return result
    },

    closeSource: () => {
      set((state) => {
        const session = closeSourceMonitor(state.session)
        const playbackOwner = state.playbackOwner === 'source'
          ? 'none'
          : state.playbackOwner
        if (
          state.session === session
          && state.lastOpenRejection === null
          && state.playbackOwner === playbackOwner
        ) return state
        return {
          session,
          lastOpenRejection: null,
          playbackOwner,
        }
      })
    },

    setPlayhead: (frame) => applySession((session) => setSourcePlayhead(session, frame)),
    scrubPlayhead: (frame) => applySession((session) => scrubSourcePlayhead(session, frame)),
    stepFrame: (deltaFrames) => applySession((session) => stepSourceFrame(session, deltaFrames)),
    advancePlayhead: (deltaFrames) =>
      applySession((session) => advanceSourcePlayhead(session, deltaFrames)),
    stopPlayback: () => applySession(stopSourcePlayback),
    parkPlayback: () => applySession(parkSourcePlayback),
    jumpToStart: () => applySession(jumpSourceToStart),
    jumpToEnd: () => applySession(jumpSourceToEnd),
    jumpToIn: () => applySession(jumpSourceToIn),
    jumpToOut: () => applySession(jumpSourceToOut),
    setIn: () => applySession(setSourceIn),
    setOut: () => applySession(setSourceOut),
    clearIn: () => applySession(clearSourceIn),
    clearOut: () => applySession(clearSourceOut),
    clearMarks: () => applySession(clearSourceMarks),
    resetSession: () => applySession(resetSourceSession),
    stepShuttle: (key) => applySession((session) => stepSourceShuttle(session, key)),

    setSourcePatch: (patch) =>
      set((state) => {
        const patchVideo = patch.video ?? state.patchVideo
        const patchAudio = patch.audio ?? state.patchAudio
        return state.patchVideo === patchVideo && state.patchAudio === patchAudio
          ? state
          : { patchVideo, patchAudio }
      }),

    requestPlayback: (requested) => {
      const state = get()
      if (requested === 'source' && state.session === null) {
        return { owner: state.playbackOwner, pausedOwner: null }
      }
      const handoff = requestMonitorPlayback(state.playbackOwner, requested)
      if (handoff.owner !== state.playbackOwner) {
        set({ playbackOwner: handoff.owner })
      }
      return handoff
    },

    resetSourceMonitor: () => {
      sourceMonitorResetRevision += 1
      set({ ...INITIAL_SOURCE_MONITOR_STATE })
    },
  }
})
