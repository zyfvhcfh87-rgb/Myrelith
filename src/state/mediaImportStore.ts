/**
 * Ephemeral UI state for the centralized media-import flow.
 *
 * Browser resources and the selected File stay in app/mediaImportController;
 * this store exposes only small, serializable status needed by the UI.
 */

import { create } from 'zustand'
import type { FrameRate } from '../domain/schema'

export type MediaImportPhase =
  | 'idle'
  | 'analyzing'
  | 'awaiting-decision'
  | 'cancelling'
  | 'error'

export interface MediaImportPrompt {
  fileName: string
  projectRate: FrameRate
  sourceRate: FrameRate
  canMatchSource: boolean
  matchUnavailableReason: string | null
}

export interface MediaImportState {
  phase: MediaImportPhase
  fileName: string | null
  prompt: MediaImportPrompt | null
  error: string | null
}

export const INITIAL_MEDIA_IMPORT_STATE: Readonly<MediaImportState> =
  Object.freeze({
    phase: 'idle',
    fileName: null,
    prompt: null,
    error: null,
  })

export const useMediaImportStore = create<MediaImportState>()(() => ({
  ...INITIAL_MEDIA_IMPORT_STATE,
}))
