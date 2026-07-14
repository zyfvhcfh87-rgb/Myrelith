/**
 * Serializable Home-screen projection for origin-local project conveniences.
 * File handles and recovery payloads remain in app-layer storage/controllers.
 */

import { create } from 'zustand'

export type ProjectLibraryPhase = 'idle' | 'loading' | 'ready' | 'error'
export type LocalProjectPermission = 'granted' | 'prompt' | 'denied' | 'unknown'

export interface RecentProjectSummary {
  documentId: string
  projectName: string
  fileName: string
  lastOpenedAt: number
  permission: LocalProjectPermission
}

export interface RecoveryJournalSummary {
  journalId: string
  documentId: string
  projectName: string
  projectFileName: string | null
  updatedAt: number
  generationCount: number
}

export interface ProjectLibraryState {
  phase: ProjectLibraryPhase
  recentProjectsSupported: boolean
  recentProjects: RecentProjectSummary[]
  recoveries: RecoveryJournalSummary[]
  error: string | null
}

export const INITIAL_PROJECT_LIBRARY_STATE: Readonly<ProjectLibraryState> =
  Object.freeze({
    phase: 'idle',
    recentProjectsSupported: false,
    recentProjects: [],
    recoveries: [],
    error: null,
  })

export const useProjectLibraryStore = create<ProjectLibraryState>()(() => ({
  ...INITIAL_PROJECT_LIBRARY_STATE,
}))
