/**
 * Serializable UI projection of the active-project session.
 * Files, Blobs, object URLs, and parsed candidate documents stay in the app
 * controller until activation commits them as one complete editor session.
 */

import { create } from 'zustand'
import type { AssetKind, FrameRate } from '../domain/schema'

export type ProjectScreen = 'home' | 'new-project' | 'resume' | 'editor'
export type ProjectSessionPhase =
  | 'idle'
  | 'reading-project'
  | 'relinking'
  | 'activating'
  | 'closing'
  | 'error'
export type ProjectSavePhase = 'idle' | 'saving' | 'error'

export interface RelinkAssetSummary {
  id: string
  fileName: string
  kind: AssetKind
  status: 'missing' | 'ready'
}

export interface ResumeProjectSummary {
  projectFileName: string
  projectName: string
  width: number
  height: number
  frameRate: FrameRate
  audioSampleRate: number
  assets: RelinkAssetSummary[]
}

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
    candidate: null,
    error: null,
  })

export const useProjectSessionStore = create<ProjectSessionState>()(() => ({
  ...INITIAL_PROJECT_SESSION_STATE,
}))
