import { create } from 'zustand'
import type { MulticamMonitorQuality } from '../domain/multicamMonitor'

export interface MulticamMonitorPresentation {
  readonly enabled: boolean
  readonly phase: 'off' | 'waiting' | 'starting' | 'live' | 'reduced' | 'paused'
  readonly detail: string
  readonly quality: MulticamMonitorQuality
  readonly angles: Readonly<Record<string, 'program' | 'waiting' | 'live' | 'gap'>>
}
export const INITIAL_MULTICAM_MONITOR: MulticamMonitorPresentation = {
  enabled: false, phase: 'off', detail: 'Paused angle previews are available.', quality: 'normal', angles: {},
}
/** Session presentation only. No media, canvases, source keys, clock or edit intent. */
export const useMulticamMonitorStore = create<MulticamMonitorPresentation>(() => ({ ...INITIAL_MULTICAM_MONITOR }))
