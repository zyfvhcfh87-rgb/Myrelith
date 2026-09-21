/** Serializable Issue #208 portable-core facts. Browser-free; no engine names. */

export const PORTABLE_CORE_CONTRACT = 'issue-208-portable-core-v1' as const
export const PORTABLE_CORE_SCHEMA_VERSION = 1 as const

export type PortableCoreDecisionKind = 'go' | 'no-go'

export type PortableImportStatus =
  | 'ready'
  | 'limited'
  | 'unsupported'
  | 'error'
  | 'missing'

export type PortableAutoPreset = 'modern' | 'web' | 'compatibility'

export type PortableCoreReason =
  | 'import-not-usable'
  | 'edit-not-committed'
  | 'preview-empty'
  | 'preview-frame-not-integer'
  | 'audio-clock-not-running'
  | 'audio-clock-did-not-advance'
  | 'playhead-did-not-advance'
  | 'save-not-downloaded'
  | 'save-not-portable-project'
  | 'live-save-left-enabled'
  | 'save-cleared-dirty-state'
  | 'save-status-not-downloaded-copy'
  | 'recovery-missed'
  | 'relink-missed'
  | 'export-not-download'
  | 'export-auto-missing'
  | 'explicit-export-selection'
  | 'export-did-not-reopen'
  | 'file-destination-not-disabled'
  | 'file-destination-reason-missing'
  | 'remembered-project-files-offered'
  | 'remembered-media-import-offered'
  | 'plugin-isolation-claimed'
  | 'public-support-claim'
  | 'resource-leak'

export interface PortablePlaybackFacts {
  readonly audioContextState: string
  readonly clockAdvanced: boolean
  readonly playheadBefore: number
  readonly playheadAfter: number
}

export interface PortableSaveFacts {
  readonly downloaded: boolean
  readonly extension: string | null
  readonly liveSaveEnabled: boolean
  readonly statusText: string
  readonly stillDirty: boolean
}

export interface PortableExportFacts {
  readonly destination: 'download' | 'file' | 'directory' | 'missing'
  readonly autoPreset: PortableAutoPreset | null
  readonly explicitSelectionLeftAtAuto: boolean
  readonly reopenedVideo: boolean
  readonly fileDestinationDisabled: boolean
  readonly fileDestinationReason: string | null
}

export interface PortableOptionalFacts {
  readonly rememberedProjectFilesOffered: boolean
  readonly rememberedMediaImportOffered: boolean
  readonly pluginIsolationClaimed: boolean
}

export interface PortableResourceFacts {
  readonly samplesOpened: number
  readonly samplesClosed: number
}

export interface PortableCoreFacts {
  readonly contract: typeof PORTABLE_CORE_CONTRACT
  readonly schemaVersion: typeof PORTABLE_CORE_SCHEMA_VERSION
  readonly publicSupportClaim: boolean
  readonly importStatus: PortableImportStatus
  readonly editUndoEntries: number
  readonly clipCountAfterEdit: number
  readonly previewFrame: number
  readonly previewNonEmpty: boolean
  readonly playback: PortablePlaybackFacts
  readonly save: PortableSaveFacts
  readonly recoveryRestoredClipCount: number
  readonly relinked: boolean
  readonly exportResult: PortableExportFacts
  readonly optional: PortableOptionalFacts
  readonly resources: PortableResourceFacts
}

export interface PortableCoreDecision {
  readonly core: PortableCoreDecisionKind
  readonly reasons: readonly PortableCoreReason[]
  readonly publicSupportClaim: false
  readonly autoPreset: PortableAutoPreset | null
}
