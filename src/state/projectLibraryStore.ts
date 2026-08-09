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

export interface LocalStorageSummary {
  /** Complete browser-origin usage, which may include browser bookkeeping. */
  browserUsageBytes: number | null
  browserQuotaBytes: number | null
  /** UTF-8 bytes in the complete recovery snapshots managed by Myrelith. */
  recoveryBytes: number
  disposableBytes: number
  disposableItemCount: number
  error: string | null
}

export interface ProjectLibraryState {
  phase: ProjectLibraryPhase
  recentProjectsSupported: boolean
  recentProjects: RecentProjectSummary[]
  recoveries: RecoveryJournalSummary[]
  storage: LocalStorageSummary
  error: string | null
}

export const INITIAL_LOCAL_STORAGE_SUMMARY: Readonly<LocalStorageSummary> =
  Object.freeze({
    browserUsageBytes: null,
    browserQuotaBytes: null,
    recoveryBytes: 0,
    disposableBytes: 0,
    disposableItemCount: 0,
    error: null,
  })

export const INITIAL_PROJECT_LIBRARY_STATE: Readonly<ProjectLibraryState> =
  Object.freeze({
    phase: 'idle',
    recentProjectsSupported: false,
    recentProjects: [],
    recoveries: [],
    storage: INITIAL_LOCAL_STORAGE_SUMMARY,
    error: null,
  })

export const useProjectLibraryStore = create<ProjectLibraryState>()(() => ({
  ...INITIAL_PROJECT_LIBRARY_STATE,
}))
