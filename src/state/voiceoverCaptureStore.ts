/** Small, serializable view of the app-owned capture session. */
import { create } from 'zustand'
import type { VoiceoverSession } from '../domain/voiceoverSession'

export interface VoiceoverCaptureTiming {
  anchorSample: number
  countInStartSample: number
  startFrame: number
  stopSample: number | null
  stopFrame: number | null
  /** No physical latency correction is inferred without calibration. */
  compensationSamples: number
  trackLatencySeconds: number | null
  outputLatencySeconds: number | null
}

export interface VoiceoverCaptureStatus {
  session: VoiceoverSession | null
  sourceLabel: string | null
  capturedSamples: number
  diagnostic: string | null
  timing: VoiceoverCaptureTiming | null
}

export const useVoiceoverCaptureStore = create<VoiceoverCaptureStatus>(() => ({
  session: null,
  sourceLabel: null,
  capturedSamples: 0,
  diagnostic: null,
  timing: null,
}))
