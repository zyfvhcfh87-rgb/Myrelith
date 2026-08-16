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

export type PluginDiagnosticLevel = 'info' | 'warning' | 'error'

export interface PluginActionView {
  readonly available: boolean
  readonly disabledReason?: string | null
  readonly pending: boolean
  readonly error?: string | null
}

export interface PluginManagerActionsView {
  readonly retry: PluginActionView
  readonly enable: PluginActionView
  readonly disable: PluginActionView
  readonly uninstall: PluginActionView
  readonly clearDiagnostics: PluginActionView
}

export interface PluginRecoveryActionsView {
  readonly retry: PluginActionView
  readonly disable: PluginActionView
  readonly manage: PluginActionView
}

export interface PluginPreviewActionsView {
  readonly retry: PluginActionView
  readonly disable: PluginActionView
}

export type PluginPermissionGrantState =
  | 'previously-granted'
  | 'new'
  | 'widened'

export type PluginPackageVersionChange =
  | 'new-install'
  | 'reinstall'
  | 'update'
  | 'downgrade'

export interface PluginPermissionView {
  readonly id: string
  readonly name: string
  readonly selectedVersion: string
  readonly detail: string
  readonly required: boolean
  readonly available: boolean
  readonly grantable: boolean
  readonly grantState: PluginPermissionGrantState
  readonly unavailableReason?: string | null
}

export interface PluginPackageReviewView {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly installedVersion: string | null
  readonly versionChange: PluginPackageVersionChange
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
  readonly confirmDowngrade: boolean
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
  readonly actions: PluginManagerActionsView
}

export interface PluginEffectIssueView {
  readonly effectInstanceId: string
  readonly effectLabel: string
  readonly pluginId: string
  readonly pluginName: string
  readonly pluginVersion: string
  readonly packageDigest: string
  readonly status: PluginEffectStatus
  readonly reason: string
  readonly blocksExport: boolean
}

export interface PluginPreviewIssueView extends PluginEffectIssueView {
  readonly actions: PluginPreviewActionsView
}
