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
  | PluginPackageStatus
  | 'missing'
  | 'version-mismatch'
  | 'invalid'
  | 'unsupported'

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
  | 'new'
  | 'preserved'
  | 'widened'
  | 'changed'
  | 'unavailable'

export type PluginPackageVersionChange =
  | 'new-install'
  | 'reinstall'
  | 'update'
  | 'downgrade'
  | 'same-version-replacement'

export type PluginStartupModeView =
  | 'normal'
  | 'review-required'
  | 'safe-mode'

export interface PluginPermissionView {
  readonly id: string
  readonly name: string
  readonly selectedVersion: string | null
  readonly detail: string
  readonly required: boolean
  readonly available: boolean
  readonly grantable: boolean
  readonly grantState: PluginPermissionGrantState
  readonly unavailableReason?: string | null
}

export interface PluginPackageReviewView {
  /** Opaque app-minted identity; replace it whenever any consent-relevant projection changes. */
  readonly reviewToken: string
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
  /** Exact token from the reviewed projection; the app must revalidate it before committing. */
  readonly reviewToken: string
  readonly trustSigner: boolean
  readonly grantedPermissionIds: readonly string[]
  readonly confirmDowngrade: boolean
  readonly confirmSameVersionReplacement: boolean
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
  readonly pluginVersion: string | null
  readonly packageDigest: string | null
  readonly status: PluginEffectStatus
  readonly reason: string
  readonly blocksExport: boolean
}

export interface PluginPreviewIssueView extends PluginEffectIssueView {
  readonly actions: PluginPreviewActionsView
}

export interface PluginContributionView {
  readonly effectType: string
  readonly pluginId: string
  readonly pluginName: string
  readonly pluginVersion: string
  readonly contributionName: string
  readonly status: PluginPackageStatus
  readonly detail: string
  readonly selectAction: PluginActionView
}

export type PluginParameterFieldState =
  | 'editable'
  | 'disabled'
  | 'locked'

interface PluginParameterFieldBaseView {
  readonly key: string
  readonly name: string
  readonly state: PluginParameterFieldState
  readonly stateReason?: string | null
}

export interface PluginNumberParameterFieldView extends PluginParameterFieldBaseView {
  readonly kind: 'number'
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly animatable: boolean
}

export interface PluginBooleanParameterFieldView extends PluginParameterFieldBaseView {
  readonly kind: 'boolean'
  readonly value: boolean
}

export interface PluginEnumOptionView {
  readonly value: string
  readonly name: string
}

export interface PluginEnumParameterFieldView extends PluginParameterFieldBaseView {
  readonly kind: 'enum'
  readonly value: string
  readonly options: readonly PluginEnumOptionView[]
}

export type PluginParameterFieldView =
  | PluginNumberParameterFieldView
  | PluginBooleanParameterFieldView
  | PluginEnumParameterFieldView

export type PluginParameterValue = number | boolean | string
