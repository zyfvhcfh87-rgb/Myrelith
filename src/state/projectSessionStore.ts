/**
 * Serializable UI projection of the active-project session.
 * Files, Blobs, object URLs, and parsed candidate documents stay in the app
 * controller until activation commits them as one complete editor session.
 */

import { create } from 'zustand'
import type {
  AssetKind,
  FrameRate,
  PartialTrackImportSelection,
} from '../domain/schema'

export type ProjectScreen = 'home' | 'new-project' | 'resume' | 'editor'
export type ProjectSessionPhase =
  | 'idle'
  | 'reading-project'
  | 'relinking'
  | 'activating'
  | 'closing'
  | 'error'
export type ProjectSavePhase = 'idle' | 'saving' | 'error'
export type ProjectRecoveryPhase = 'idle' | 'saving' | 'error'

export interface RelinkAssetSummary {
  id: string
  fileName: string
  kind: AssetKind
  partialTrackSelection?: PartialTrackImportSelection
  /** Remembered means Chrome has the handle but needs one click for access. */
  status: 'missing' | 'remembered' | 'ready'
}

export interface ResumeProjectSummary {
  origin: 'file' | 'recent' | 'recovery'
  projectFileName: string
  projectName: string
  width: number
  height: number
  frameRate: FrameRate
  audioSampleRate: number
  assets: RelinkAssetSummary[]
}

export type ActiveMediaRelinkPhase =
  | 'idle'
  | 'scanning'
  | 'awaiting-choice'
  | 'complete'

export interface MediaRelinkFileCandidateSummary {
  token: string
  fileName: string
  relativePath: string
}

export interface MediaRelinkAmbiguitySummary {
  token: string
  assetId: string
  assetFileName: string
  candidates: readonly MediaRelinkFileCandidateSummary[]
}

/** Serializable projection only; Files, handles, URLs, and assets stay in app/. */
export interface ActiveMediaRelinkSummary {
  phase: ActiveMediaRelinkPhase
  scannedFileCount: number
  connectedCount: number
  skippedCount: number
  errors: readonly string[]
  ambiguity: MediaRelinkAmbiguitySummary | null
}

export const INITIAL_ACTIVE_MEDIA_RELINK: Readonly<ActiveMediaRelinkSummary> =
  Object.freeze({
    phase: 'idle',
    scannedFileCount: 0,
    connectedCount: 0,
    skippedCount: 0,
    errors: Object.freeze([]) as readonly string[],
    ambiguity: null,
  })

export interface ProjectSessionState {
  screen: ProjectScreen
  phase: ProjectSessionPhase
  activeProjectName: string | null
  activeProjectFileName: string | null
  hasUnsavedChanges: boolean
  savePhase: ProjectSavePhase
  liveSaveEnabled: boolean
  lastSavedAt: number | null
  saveError: string | null
  recoveryPhase: ProjectRecoveryPhase
  lastRecoveryAt: number | null
  recoveryError: string | null
  activeMediaRelink: ActiveMediaRelinkSummary
  candidate: ResumeProjectSummary | null
  error: string | null
}

export const INITIAL_PROJECT_SESSION_STATE: Readonly<ProjectSessionState> =
  Object.freeze({
    screen: 'home',
    phase: 'idle',
    activeProjectName: null,
    activeProjectFileName: null,
    hasUnsavedChanges: false,
    savePhase: 'idle',
    liveSaveEnabled: false,
    lastSavedAt: null,
    saveError: null,
    recoveryPhase: 'idle',
    lastRecoveryAt: null,
    recoveryError: null,
    activeMediaRelink: INITIAL_ACTIVE_MEDIA_RELINK,
    candidate: null,
    error: null,
  })

export const useProjectSessionStore = create<ProjectSessionState>()(() => ({
  ...INITIAL_PROJECT_SESSION_STATE,
}))
