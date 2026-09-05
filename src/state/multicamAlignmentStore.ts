import { create } from 'zustand'
import type { AudioCorrelationFacts } from '../domain/multicamAlignment'

export interface MulticamAlignmentRow {
  readonly angleId: string
  readonly name: string
  readonly currentFrame: number
  readonly proposedFrame: number | null
  readonly state: 'reference' | 'aligned' | 'ambiguous' | 'unavailable'
  readonly detail: string
  readonly facts: AudioCorrelationFacts | null
  readonly fromCache: boolean
}
export interface MulticamAlignmentPresentation {
  readonly definitionId: string | null
  readonly phase: 'idle' | 'running' | 'ready' | 'cancelled' | 'stale' | 'error' | 'applied'
  readonly progress: number
  readonly detail: string
  readonly rows: readonly MulticamAlignmentRow[]
  readonly cacheHits: number
  readonly cacheWarning: string | null
}
export const INITIAL_MULTICAM_ALIGNMENT: MulticamAlignmentPresentation = {
  definitionId: null, phase: 'idle', progress: 0, detail: '', rows: [], cacheHits: 0, cacheWarning: null,
}
/** Presentation only: never buffers, URLs, cache keys, source evidence or project history. */
export const useMulticamAlignmentStore = create<MulticamAlignmentPresentation>(() => ({ ...INITIAL_MULTICAM_ALIGNMENT }))
