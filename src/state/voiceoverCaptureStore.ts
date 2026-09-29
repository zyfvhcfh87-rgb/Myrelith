/** Small, serializable view of the app-owned capture session. */
import { create } from 'zustand'
import type { VoiceoverDraftAction, VoiceoverDraftClassification } from '../domain/voiceoverDrafts'
import type { VoiceoverSession } from '../domain/voiceoverSession'

export interface VoiceoverCaptureTiming {
  anchorSample: number
  countInStartSample: number
  startFrame: number
  stopSample: number | null
  stopFrame: number | null
  /** Signed user offset; physical latency is never inferred without calibration. */
  compensationSamples: number
  trackLatencySeconds: number | null
  outputLatencySeconds: number | null
}

export interface VoiceoverCaptureStatus {
  session: VoiceoverSession | null
  sourceLabel: string | null
  capturedSamples: number
  /** Peak absolute level of the most recent captured batch, 0..1. */
  inputPeak: number
  /** Timeline playback was deliberately left silent for this take. */
  playbackMuted: boolean
  /** Samples the audio thread skipped (padded with silence) or repeated (not rewritten). */
  renderGapSamples: number
  diagnostic: string | null
  timing: VoiceoverCaptureTiming | null
}

export const useVoiceoverCaptureStore = create<VoiceoverCaptureStatus>(() => ({
  session: null,
  sourceLabel: null,
  capturedSamples: 0,
  inputPeak: 0,
  playbackMuted: false,
  renderGapSamples: 0,
  diagnostic: null,
  timing: null,
}))

export interface VoiceoverInputDevice {
  readonly deviceId: string
  readonly label: string
}

export type VoiceoverDraftActionResult = VoiceoverDraftAction

/** Classified recordings-directory listing; metadata only, never file bytes. */
export interface VoiceoverDraftListing {
  drafts: readonly VoiceoverDraftClassification[] | null
  busy: boolean
  error: string | null
  lastAction: VoiceoverDraftActionResult | null
}

export const useVoiceoverDraftStore = create<VoiceoverDraftListing>(() => ({
  drafts: null,
  busy: false,
  error: null,
  lastAction: null,
}))

/** Recording setup choices kept for this editor session (not the project). */
export interface VoiceoverSetup {
  trackId: string | null
  countInSeconds: number
  compensationMs: number
  mutePlayback: boolean
  deviceId: string | null
  panelOpen: boolean
}

export const useVoiceoverSetupStore = create<VoiceoverSetup>(() => ({
  trackId: null,
  countInSeconds: 1,
  compensationMs: 0,
  mutePlayback: false,
  deviceId: null,
  panelOpen: false,
}))
