export type PluginTrustState =
  | 'built-in-trusted'
  | 'user-trusted'
  | 'untrusted'
  | 'invalid'
  | 'revoked'

export type PluginSignatureState = 'valid' | 'invalid' | 'unsigned' | 'revoked'

export type PluginCompatibilityState = 'compatible' | 'incompatible'

export type PluginPackageStatus =
  | 'ready'
  | 'disabled'
  | 'incompatible'
  | 'failed'
  | 'revoked'
  | 'untrusted'
  | 'quarantined'
  | 'safe-mode'

export type PluginEffectStatus =
  | 'ready'
  | 'disabled'
  | 'missing'
  | 'incompatible'
  | 'failed'
  | 'revoked'
  | 'untrusted'
  | 'safe-mode'

export type PluginOperation =
  | 'retry'
  | 'enable'
  | 'disable'
  | 'uninstall'
  | null

export type PluginDiagnosticLevel = 'info' | 'warning' | 'error'

export interface PluginPermissionView {
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly required: boolean
}

export interface PluginPackageReviewView {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly signerFingerprint: string
  readonly packageDigest: string
  readonly signatureState: PluginSignatureState
  readonly trustState: PluginTrustState
  readonly compatibilityState: PluginCompatibilityState
  readonly compatibilityReasons: readonly string[]
  readonly permissions: readonly PluginPermissionView[]
  readonly contributionNames: readonly string[]
  readonly memoryLimitMiB: number
  readonly failurePolicy: string
}

export interface PluginInstallDecision {
  readonly trustSigner: boolean
  readonly grantedPermissionIds: readonly string[]
}

export interface PluginDiagnosticView {
  readonly id: string
  readonly level: PluginDiagnosticLevel
  readonly code: string
  readonly message: string
  readonly occurredAtLabel: string
}

export interface InstalledPluginView {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly signerFingerprint: string
  readonly packageDigest: string
  readonly status: PluginPackageStatus
  readonly statusDetail: string
  readonly permissionNames: readonly string[]
  readonly contributionNames: readonly string[]
  readonly diagnostics: readonly PluginDiagnosticView[]
  readonly operation: PluginOperation
  readonly operationError?: string | null
}

export interface PluginEffectIssueView {
  readonly effectInstanceId: string
  readonly effectLabel: string
  readonly pluginId: string
  readonly pluginName: string
  readonly status: PluginEffectStatus
  readonly reason: string
  readonly blocksExport: boolean
}
