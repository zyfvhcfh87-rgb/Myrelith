/** Session-only derived loudness reading. Never writes gain. */

import { create } from 'zustand'
import type { LoudnessMeasurement } from '../domain/audioLoudness'

export type LoudnessJobStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'incomplete'
  | 'cancelled'
  | 'failed'

export interface LoudnessState {
  status: LoudnessJobStatus
  measurement: LoudnessMeasurement | null
  error: string | null
  framesDone: number
  frameCount: number
  generation: number
  setRunning(generation: number, frameCount: number): void
  setProgress(generation: number, framesDone: number, frameCount: number): void
  setResult(generation: number, measurement: LoudnessMeasurement): void
  setCancelled(generation: number): void
  setFailed(generation: number, error: string): void
  reset(): void
}

const INITIAL = {
  status: 'idle' as const,
  measurement: null,
  error: null,
  framesDone: 0,
  frameCount: 0,
  generation: 0,
}

export const useLoudnessStore = create<LoudnessState>()((set) => ({
  ...INITIAL,
  setRunning: (generation, frameCount) => set({
    status: 'running',
    measurement: null,
    error: null,
    framesDone: 0,
    frameCount,
    generation,
  }),
  setProgress: (generation, framesDone, frameCount) => set((state) => (
    state.generation !== generation
      ? state
      : { framesDone, frameCount }
  )),
  setResult: (generation, measurement) => set((state) => (
    state.generation !== generation
      ? state
      : {
          status: measurement.coverage === 'complete' ? 'complete' : 'incomplete',
          measurement,
          error: null,
        }
  )),
  setCancelled: (generation) => set((state) => (
    state.generation !== generation
      ? state
      : { status: 'cancelled', error: null }
  )),
  setFailed: (generation, error) => set((state) => (
    state.generation !== generation
      ? state
      : { status: 'failed', error }
  )),
  reset: () => set(INITIAL),
}))
