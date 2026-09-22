/** Small, serializable view of the app-owned capture session. */
import { create } from 'zustand'
import type { VoiceoverSession } from '../domain/voiceoverSession'

export interface VoiceoverCaptureStatus {
  session: VoiceoverSession | null
  sourceLabel: string | null
  capturedSamples: number
  diagnostic: string | null
}

export const useVoiceoverCaptureStore = create<VoiceoverCaptureStatus>(() => ({
  session: null,
  sourceLabel: null,
  capturedSamples: 0,
  diagnostic: null,
}))
