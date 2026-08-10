/** Session-only UI projection for bounded render-worker video scopes. */

import { create } from 'zustand'
import type { VideoScopeAnalysis } from '../domain/videoScopes'

export type VideoScopeMode = 'histogram' | 'waveform' | 'vectorscope'
export type VideoScopeStatus = 'idle' | 'waiting' | 'ready' | 'unsupported'

export interface VideoScopesState {
  enabled: boolean
  generation: number
  mode: VideoScopeMode
  status: VideoScopeStatus
  rendererSupported: boolean | null
  analysis: VideoScopeAnalysis | null
  frame: number | null
  analyzedAt: number | null
  setMode(mode: VideoScopeMode): void
  setEnabled(enabled: boolean, generation: number): void
  setRendererSupported(supported: boolean | null): void
  acceptAnalysis(
    generation: number,
    frame: number,
    analyzedAt: number,
    analysis: VideoScopeAnalysis,
  ): void
  reset(): void
}

const INITIAL = {
  enabled: false,
  generation: 0,
  mode: 'histogram' as const,
  status: 'idle' as const,
  rendererSupported: null,
  analysis: null,
  frame: null,
  analyzedAt: null,
}

export const useVideoScopesStore = create<VideoScopesState>()((set) => ({
  ...INITIAL,
  setMode: (mode) => set({ mode }),
  setEnabled: (enabled, generation) => set((state) => ({
    enabled,
    generation,
    analysis: null,
    frame: null,
    analyzedAt: null,
    status: !enabled
      ? 'idle'
      : state.rendererSupported === false ? 'unsupported' : 'waiting',
  })),
  setRendererSupported: (rendererSupported) => set((state) => ({
    rendererSupported,
    status: !state.enabled
      ? 'idle'
      : rendererSupported === false ? 'unsupported'
        : state.analysis ? 'ready' : 'waiting',
  })),
  acceptAnalysis: (generation, frame, analyzedAt, analysis) => set((state) => {
    if (!state.enabled || state.generation !== generation) return state
    return { analysis, frame, analyzedAt, status: 'ready' }
  }),
  reset: () => set(INITIAL),
}))
