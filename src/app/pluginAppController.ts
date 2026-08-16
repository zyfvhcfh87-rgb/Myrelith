/** Persistent app-owned plugin root. React receives data; capabilities stay private. */

import type { PluginVideoEffectContributionSnapshot } from '../domain/pluginVideoEffectStagePlan'
import type {
  PluginEffectBridgeHandler,
  PluginEffectBridgeHandlerRequest,
  PluginEffectBridgeHandlerResult,
} from '../workers/plugin-effect-bridge-protocol'
import {
  createPluginCompositionController,
  type PluginCompositionActionKind,
  type PluginCompositionActionSnapshot,
  type PluginCompositionControllerDependencies,
  type PluginCompositionInspection,
  type PluginCompositionInstalledPackage,
  type PluginCompositionSnapshot,
} from './pluginCompositionController'
import {
  createPluginInstallController,
  PluginInstallControllerError,
  type CommitPluginInstallationOptions,
  type PluginDeclarationCatalogSnapshot,
  type PluginInspectionTrustState,
} from './pluginInstallController'
import {
  localPluginStorage,
  localPluginTrustPolicyStore,
} from './localPluginStorage'
import { PLUGIN_PACKAGE_LIMITS } from './pluginPackage'
import { createPluginRuntimeController } from './pluginRuntimeController'
import type {
  PluginDescriptorMigrationActionPreflightRequest,
  PluginDescriptorMigrationActionSession,
  PluginEffectApplyRequest,
  PluginEffectApplyResult,
  PluginExportPreflightRequest,
  PluginExportSession,
} from './pluginRuntimeController'
import type { PluginRuntimeLifecycleObserver } from './pluginRuntimeLifecycleObserver'
import {
  runPluginActivationBatch,
  type PluginSafetyStorage,
} from './pluginSafetyController'
import { createPluginTrustRegistry, type PluginDiagnosticCode } from './pluginTrustRegistry'
import {
  createPluginEditorController,
  type PluginAppAddEffectRequest,
  type PluginAppEditorMutationResult,
  type PluginAppEditorSnapshot,
  type PluginAppSetParameterRequest,
  type PluginEditorController,
  type PluginEditorControllerFactory,
  type PluginEditorPluginProjection,
} from './pluginEditorController'
import {
  createPluginDescriptorMigrationController,
  PluginDescriptorMigrationError,
  type PluginDescriptorMigrationController,
  type PluginDescriptorMigrationResult,
} from './pluginDescriptorMigrationController'
import {
  createPluginDocumentGenerationController,
  type PluginDocumentGenerationController,
} from './pluginDocumentGeneration'

const MAX_PUBLIC_DETAIL_CHARACTERS = 512
const FAILURE_POLICY = 'Preview bypasses a failed effect with a warning. Export stops unless you review a one-time bypass.'

export type PluginAppControllerErrorCode =
  | 'aborted'
  | 'closed'
  | 'file-invalid'
  | 'file-too-large'
  | 'review-expired'
  | 'review-invalid'
  | 'stale-operation'

export class PluginAppControllerError extends Error {
  readonly code: PluginAppControllerErrorCode

  constructor(code: PluginAppControllerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginAppControllerError'
    this.code = code
  }
}

export interface PluginAppFile {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface PluginAppActionView {
  readonly available: boolean
  readonly disabledReason: string | null
  readonly pending: boolean
  readonly error: string | null
}

export interface PluginAppManagerActionsView {
  readonly retry: PluginAppActionView
  readonly enable: PluginAppActionView
  readonly disable: PluginAppActionView
  readonly uninstall: PluginAppActionView
  readonly clearDiagnostics: PluginAppActionView
}

export interface PluginAppDiagnosticView {
  readonly id: string
  readonly level: 'info' | 'warning' | 'error'
  readonly code: PluginDiagnosticCode
  readonly message: string
  readonly occurredAtLabel: string
}

export interface PluginAppInstalledPackageView {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly signerFingerprint: string
  readonly packageDigest: string
  readonly status: PluginCompositionInstalledPackage['status']
  readonly statusDetail: string
  readonly permissionNames: readonly string[]
  readonly contributionNames: readonly string[]
  readonly diagnostics: readonly PluginAppDiagnosticView[]
  readonly actions: PluginAppManagerActionsView
}

export interface PluginAppPermissionView {
  readonly id: string
  readonly name: string
  readonly selectedVersion: string | null
  readonly detail: string
  readonly required: boolean
  readonly available: boolean
  readonly grantable: boolean
  readonly grantState: PluginCompositionInspection['permissions'][number]['grantChange']
  readonly unavailableReason: string | null
}

export interface PluginAppPackageReviewView {
  readonly reviewToken: string
  readonly id: string
  readonly name: string
  readonly version: string
  readonly installedVersion: string | null
  readonly versionChange:
    | 'new-install'
    | 'reinstall'
    | 'update'
    | 'downgrade'
    | 'same-version-replacement'
  readonly signerFingerprint: string
  readonly packageDigest: string
  readonly signatureState: 'valid'
  readonly trustState: PluginInspectionTrustState
  readonly compatibilityState: 'compatible' | 'incompatible'
  readonly compatibilityReasons: readonly string[]
  readonly permissions: readonly PluginAppPermissionView[]
  readonly contributionNames: readonly string[]
  readonly memoryLimitMiB: number
  readonly failurePolicy: string
}

export interface PluginAppInstallDecision {
  readonly reviewToken: string
  readonly trustSigner: boolean
  readonly grantedPermissionIds: readonly string[]
  readonly confirmDowngrade: boolean
  readonly confirmSameVersionReplacement: boolean
}

export interface PluginAppContributionView {
  readonly effectType: string
  readonly pluginId: string
  readonly pluginName: string
  readonly pluginVersion: string
  readonly contributionName: string
  readonly status: PluginCompositionInstalledPackage['status']
  readonly detail: string
  readonly parameters: readonly PluginAppParameterDeclarationView[]
  readonly selectAction: PluginAppActionView
}

export type PluginAppParameterDeclarationView =
  | {
    readonly key: string
    readonly name: string
    readonly kind: 'number'
    readonly default: number
    readonly min: number
    readonly max: number
    readonly step: number
    readonly animatable: boolean
  }
  | {
    readonly key: string
    readonly name: string
    readonly kind: 'boolean'
    readonly default: boolean
  }
  | {
    readonly key: string
    readonly name: string
    readonly kind: 'enum'
    readonly default: string
    readonly options: readonly {
      readonly value: string
      readonly name: string
    }[]
  }

export type PluginAppInspectionPhase =
  | 'idle'
  | 'reading'
  | 'inspecting'
  | 'review'
  | 'installing'
  | 'error'

export interface PluginAppSnapshot {
  readonly startup: PluginCompositionSnapshot['startup']
  readonly startupActions: {
    readonly enterSafeMode: PluginAppActionView
    readonly continueReviewedNormal: PluginAppActionView
  }
  readonly managementPhase: PluginCompositionSnapshot['managementPhase']
  readonly managementDetail: string
  readonly catalogGeneration: number | null
  readonly installedPackages: readonly PluginAppInstalledPackageView[]
  readonly contributions: readonly PluginAppContributionView[]
  readonly review: PluginAppPackageReviewView | null
  readonly inspectionPhase: PluginAppInspectionPhase
  readonly inspectionDetail: string
  readonly action: PluginCompositionActionSnapshot
}

export interface PluginExportCompositionPort {
  getDeclarationCatalog(signal?: AbortSignal): Promise<PluginDeclarationCatalogSnapshot>
  preflightExport(
    request: PluginExportPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginExportSession>
}

export interface PluginAppController {
  getSnapshot(): PluginAppSnapshot
  subscribe(listener: (snapshot: PluginAppSnapshot) => void): () => void
  getEditorSnapshot(): PluginAppEditorSnapshot
  subscribeEditor(listener: (snapshot: PluginAppEditorSnapshot) => void): () => void
  addPluginEffect(request: PluginAppAddEffectRequest): PluginAppEditorMutationResult
  setPluginEffectParameter(request: PluginAppSetParameterRequest): PluginAppEditorMutationResult
  migratePluginEffects(
    effectIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationResult>
  getContributionSnapshot(): PluginVideoEffectContributionSnapshot | undefined
  getEffectBridgeHandler(): PluginEffectBridgeHandler
  refreshManagement(signal?: AbortSignal): Promise<void>
  inspectFile(file: PluginAppFile, signal?: AbortSignal): Promise<PluginAppPackageReviewView>
  cancelInspection(reviewToken?: string): Promise<boolean>
  installPlugin(decision: PluginAppInstallDecision): Promise<void>
  retryPlugin(pluginId: string): Promise<void>
  enablePlugin(pluginId: string, signal: AbortSignal): Promise<void>
  disablePlugin(pluginId: string): Promise<void>
  setPermissionGrant(
    pluginId: string,
    permissionId: string,
    granted: boolean,
    signal: AbortSignal,
  ): Promise<void>
  quarantinePlugin(pluginId: string): Promise<void>
  revokePlugin(pluginId: string): Promise<void>
  uninstallPlugin(pluginId: string): Promise<boolean>
  clearDiagnostics(pluginId: string): Promise<boolean>
  continueWithReviewedNormalStartup(): Promise<boolean>
  enterSafeMode(): Promise<boolean>
}

/** App-private owner surface. React receives only `controller`. */
export interface PluginAppControllerOwner {
  readonly controller: PluginAppController
  readonly exportCompositionPort: PluginExportCompositionPort
  preflightDescriptorMigrationAction(
    request: PluginDescriptorMigrationActionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationActionSession>
  close(reason: string): Promise<void>
}

/** Data-only export operations exposed to the disposable Issue #77 gate. */
export interface PluginAppAcceptanceExportFacade {
  getDeclarationCatalog(signal?: AbortSignal): Promise<PluginDeclarationCatalogSnapshot>
  preflightAndCloseExport(
    request: PluginExportPreflightRequest,
    signal?: AbortSignal,
  ): Promise<void>
  applyAndCloseExport(
    preflight: PluginExportPreflightRequest,
    effect: PluginEffectApplyRequest,
    signal?: AbortSignal,
  ): Promise<PluginEffectApplyResult>
}

/** Exclusive dev-gate lease. It never exposes the app-private owner or sessions. */
export interface PluginAppAcceptanceSession {
  readonly controller: PluginAppController
  readonly exportFacade: PluginAppAcceptanceExportFacade
  close(reason: string): Promise<void>
}

export interface PluginAppControllerDependencies
  extends PluginCompositionControllerDependencies {
  readonly createReviewToken?: () => string
  readonly lifecycleObserver?: PluginRuntimeLifecycleObserver
  readonly createEditorController?: PluginEditorControllerFactory
}

interface RetainedReview {
  readonly token: string
  readonly inspectionId: string
  readonly consentFingerprint: string
  readonly actionEpoch: number
  readonly inspection: PluginCompositionInspection
  readonly view: PluginAppPackageReviewView
}

interface AppOwnedOperation {
  readonly epoch: number
  readonly controller: AbortController
  readonly promise: Promise<unknown>
}

function boundedDetail(value: string): string {
  return value.length <= MAX_PUBLIC_DETAIL_CHARACTERS
    ? value
    : `${value.slice(0, MAX_PUBLIC_DETAIL_CHARACTERS - 1)}\u2026`
}

function isExpectedAppCloseRejection(cause: unknown): boolean {
  return cause instanceof PluginAppControllerError
    ? cause.code === 'aborted' || cause.code === 'closed' || cause.code === 'stale-operation'
    : cause instanceof PluginDescriptorMigrationError
      ? cause.code === 'aborted' || cause.code === 'stale'
    : cause instanceof Error && cause.message === 'Plugin composition is closed'
}

function permissionCopy(id: string): { readonly name: string; readonly detail: string } {
  if (id === 'myrelith.effect.video-frame.rgba8') {
    return Object.freeze({
      name: 'Video frame pixels',
      detail: 'Allows this effect to read and replace only its enabled RGBA8 video layer.',
    })
  }
  return Object.freeze({
    name: 'Unsupported capability',
    detail: 'This capability is not supported by this version of Myrelith.',
  })
}

const DIAGNOSTIC_COPY: Readonly<Record<PluginDiagnosticCode, {
  readonly level: PluginAppDiagnosticView['level']
  readonly message: string
}>> = Object.freeze({
  'manifest-invalid': Object.freeze({ level: 'error', message: 'The installed manifest is invalid.' }),
  'signature-invalid': Object.freeze({ level: 'error', message: 'The package signature is invalid.' }),
  untrusted: Object.freeze({ level: 'warning', message: 'This signer is not trusted for the plugin ID.' }),
  'permission-denied': Object.freeze({ level: 'warning', message: 'A required capability was not granted.' }),
  'incompatible-api': Object.freeze({ level: 'warning', message: 'The plugin API is incompatible with this Myrelith version.' }),
  'capability-unavailable': Object.freeze({ level: 'warning', message: 'A requested capability is unavailable.' }),
  revoked: Object.freeze({ level: 'error', message: 'The signer, package, or plugin binding is revoked.' }),
  'wasm-policy-rejected': Object.freeze({ level: 'error', message: 'The WebAssembly module failed the host byte policy.' }),
  timeout: Object.freeze({ level: 'warning', message: 'Plugin work exceeded its host deadline.' }),
  crash: Object.freeze({ level: 'error', message: 'The isolated plugin runtime stopped unexpectedly.' }),
  'bad-response': Object.freeze({ level: 'error', message: 'The isolated plugin runtime returned an invalid response.' }),
  'disabled-safe-mode': Object.freeze({ level: 'info', message: 'Plugin execution is disabled in safe mode.' }),
  'package-invalid': Object.freeze({ level: 'error', message: 'The installed package could not be verified.' }),
  'storage-failed': Object.freeze({ level: 'error', message: 'The local plugin registry operation failed.' }),
})

function occurredAtLabel(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'Unknown local time'
  try {
    return new Date(value).toISOString()
  } catch {
    return 'Unknown local time'
  }
}

function versionChange(
  inspection: PluginCompositionInspection,
): PluginAppPackageReviewView['versionChange'] {
  switch (inspection.change) {
    case 'new-install': return 'new-install'
    case 'upgrade': return 'update'
    case 'downgrade': return 'downgrade'
    case 'same-version-replacement': return 'same-version-replacement'
    case 'same-package': return 'reinstall'
  }
}

function actionView(options: {
  readonly available: boolean
  readonly unavailableReason: string | null
  readonly kind: PluginCompositionActionKind
  readonly pluginId: string
  readonly action: PluginCompositionActionSnapshot
}): PluginAppActionView {
  const matches = options.action.pluginId === options.pluginId && options.action.kind === options.kind
  return Object.freeze({
    available: options.available,
    disabledReason: options.available ? null : options.unavailableReason,
    pending: matches && options.action.phase === 'pending',
    error: matches && options.action.phase === 'failed' ? boundedDetail(options.action.detail) : null,
  })
}

function packageView(
  source: PluginCompositionInstalledPackage,
  startupMode: PluginCompositionSnapshot['startup']['mode'],
  action: PluginCompositionActionSnapshot,
): PluginAppInstalledPackageView {
  const status = startupMode === 'safe-mode' ? 'safe-mode' : source.status
  const ready = status === 'ready'
  const disabled = status === 'disabled'
  const actionReason = action.phase === 'pending'
    ? 'Another plugin action is still finishing.'
    : 'This action is unavailable for the current package status.'
  return Object.freeze({
    id: source.pluginId,
    name: source.name,
    version: source.installedVersion,
    signerFingerprint: source.signerFingerprint,
    packageDigest: source.packageDigest,
    status,
    statusDetail: startupMode === 'safe-mode'
      ? 'Plugin execution is disabled for this editor session.'
      : boundedDetail(source.detail),
    permissionNames: Object.freeze(source.selectedCapabilities.map((capability) => (
      `${permissionCopy(capability.id).name} v${capability.version}`
    ))),
    contributionNames: Object.freeze([...source.contributionNames]),
    diagnostics: Object.freeze(source.diagnostics.map((diagnostic, index) => {
      const copy = DIAGNOSTIC_COPY[diagnostic.code as PluginDiagnosticCode]
        ?? Object.freeze({ level: 'error' as const, message: 'A local plugin failure was recorded.' })
      return Object.freeze({
        id: `${source.pluginId}:${diagnostic.occurredAt}:${index}`,
        level: copy.level,
        code: diagnostic.code as PluginDiagnosticCode,
        message: copy.message,
        occurredAtLabel: occurredAtLabel(diagnostic.occurredAt),
      })
    })),
    actions: Object.freeze({
      retry: actionView({
        available: status !== 'revoked' && status !== 'safe-mode',
        unavailableReason: actionReason,
        kind: 'retry',
        pluginId: source.pluginId,
        action,
      }),
      enable: actionView({
        available: disabled,
        unavailableReason: actionReason,
        kind: 'enable',
        pluginId: source.pluginId,
        action,
      }),
      disable: actionView({
        available: ready,
        unavailableReason: actionReason,
        kind: 'disable',
        pluginId: source.pluginId,
        action,
      }),
      uninstall: actionView({
        available: true,
        unavailableReason: null,
        kind: 'uninstall',
        pluginId: source.pluginId,
        action,
      }),
      clearDiagnostics: actionView({
        available: source.diagnostics.length > 0,
        unavailableReason: source.diagnostics.length > 0 ? null : 'No diagnostics are stored.',
        kind: 'clear-diagnostics',
        pluginId: source.pluginId,
        action,
      }),
    }),
  })
}

function reviewView(
  token: string,
  inspection: PluginCompositionInspection,
): PluginAppPackageReviewView {
  return Object.freeze({
    reviewToken: token,
    id: inspection.pluginId,
    name: inspection.name,
    version: inspection.version,
    installedVersion: inspection.installedVersion,
    versionChange: versionChange(inspection),
    signerFingerprint: inspection.signerFingerprint,
    packageDigest: inspection.packageDigest,
    signatureState: 'valid',
    trustState: inspection.trustState,
    compatibilityState: inspection.compatibility.status === 'compatible'
      ? 'compatible'
      : 'incompatible',
    compatibilityReasons: Object.freeze(inspection.compatibility.reasons.map(boundedDetail)),
    permissions: Object.freeze(inspection.permissions.map((permission) => {
      const copy = permissionCopy(permission.id)
      const available = permission.status === 'available' && permission.selectedVersion !== null
      return Object.freeze({
        id: permission.id,
        name: copy.name,
        selectedVersion: permission.selectedVersion === null
          ? null
          : String(permission.selectedVersion),
        detail: copy.detail,
        required: permission.required,
        available,
        grantable: available && permission.decisionRequired,
        grantState: permission.grantChange,
        unavailableReason: available
          ? null
          : 'This capability is unavailable in the current host.',
      })
    })),
    contributionNames: Object.freeze([...inspection.contributionNames]),
    memoryLimitMiB: inspection.memoryMaximumPages / 16,
    failurePolicy: FAILURE_POLICY,
  })
}

function consentFingerprint(view: PluginAppPackageReviewView): string {
  return JSON.stringify({
    id: view.id,
    name: view.name,
    version: view.version,
    installedVersion: view.installedVersion,
    versionChange: view.versionChange,
    signerFingerprint: view.signerFingerprint,
    packageDigest: view.packageDigest,
    signatureState: view.signatureState,
    trustState: view.trustState,
    compatibilityState: view.compatibilityState,
    compatibilityReasons: view.compatibilityReasons,
    permissions: view.permissions,
    contributionNames: view.contributionNames,
    memoryLimitMiB: view.memoryLimitMiB,
    failurePolicy: view.failurePolicy,
  })
}

function inspectionFailureDetail(cause: unknown): string {
  if (cause instanceof PluginAppControllerError) return cause.message
  if (cause instanceof PluginInstallControllerError) {
    switch (cause.code) {
      case 'aborted': return 'Package inspection was cancelled.'
      case 'revoked': return 'The package signer, digest, or plugin binding is revoked.'
      case 'package-invalid': return 'The selected file is not a valid supported plugin package.'
      default: return 'Package inspection could not finish safely.'
    }
  }
  return 'Package inspection failed without exposing internal details.'
}

function defaultReviewToken(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  if (!globalThis.crypto?.getRandomValues) {
    throw new PluginAppControllerError('review-invalid', 'Secure review tokens are unavailable')
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return `plugin-review-${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function browserSafetyStorage(): PluginSafetyStorage {
  return Object.freeze({
    getItem: (key: string) => globalThis.localStorage.getItem(key),
    setItem: (key: string, value: string) => { globalThis.localStorage.setItem(key, value) },
    removeItem: (key: string) => { globalThis.localStorage.removeItem(key) },
  })
}

export function createPluginAppControllerOwner(
  dependencies: PluginAppControllerDependencies,
): PluginAppControllerOwner {
  const composition = createPluginCompositionController(dependencies)
  const createReviewToken = dependencies.createReviewToken ?? defaultReviewToken
  const listeners = new Set<(snapshot: PluginAppSnapshot) => void>()
  let closed = false
  let actionEpoch = 0
  let reviewEpoch = 0
  let mutationEpoch = 0
  let retainedReview: RetainedReview | null = null
  let inspectionPhase: PluginAppInspectionPhase = 'idle'
  let inspectionDetail = ''
  let terminalClosePromise: Promise<void> | null = null
  let operationTransition = Promise.resolve()
  const ownedOperations = new Set<AppOwnedOperation>()
  const ownedInspectionIds = new Set<string>()
  let snapshot: PluginAppSnapshot
  let editorController: PluginEditorController | null = null
  let migrationController: PluginDescriptorMigrationController | null = null
  let migrationDocumentController: PluginDocumentGenerationController | null = null
  let editorPluginRevision = 0
  const createEditorController = dependencies.createEditorController
    ?? ((readPlugins) => createPluginEditorController({ readPlugins }))

  const assertOpen = (): void => {
    if (closed) throw new PluginAppControllerError('closed', 'Plugin app controller is closed')
  }

  const stableActionView = Object.freeze({
    available: true,
    disabledReason: null,
    pending: false,
    error: null,
  })

  const buildSnapshot = (): PluginAppSnapshot => {
    const source = composition.getSnapshot()
    const startupMode = source.startup.mode
    const contributions = source.contributionSnapshot?.declarations.map((declaration) => {
      const status = startupMode === 'safe-mode' ? 'safe-mode' : declaration.availability
      return Object.freeze({
        effectType: declaration.effectType,
        pluginId: declaration.pluginId,
        pluginName: source.installedPackages.find(
          (item) => item.pluginId === declaration.pluginId,
        )?.name ?? declaration.pluginId,
        pluginVersion: declaration.pluginVersion,
        contributionName: declaration.contributionName,
        status,
        detail: startupMode === 'safe-mode'
          ? 'Plugin execution is disabled for this editor session.'
          : boundedDetail(declaration.detail),
        parameters: Object.freeze(declaration.parameters.map((parameter) => (
          parameter.kind === 'enum'
            ? Object.freeze({
                ...parameter,
                options: Object.freeze(parameter.options.map((option) => Object.freeze({
                  value: option.value,
                  name: option.name,
                }))),
              })
            : Object.freeze({ ...parameter })
        ))),
        selectAction: status === 'ready'
          ? stableActionView
          : Object.freeze({
              available: false,
              disabledReason: boundedDetail(declaration.detail),
              pending: false,
              error: null,
            }),
      })
    }) ?? []
    return Object.freeze({
      startup: Object.freeze({ ...source.startup }),
      startupActions: Object.freeze({
        enterSafeMode: Object.freeze({
          available: startupMode !== 'safe-mode',
          disabledReason: startupMode === 'safe-mode' ? 'Safe mode is already active.' : null,
          pending: source.action.kind === 'safe-mode' && source.action.phase === 'pending',
          error: source.action.kind === 'safe-mode' && source.action.phase === 'failed'
            ? boundedDetail(source.action.detail)
            : null,
        }),
        continueReviewedNormal: Object.freeze({
          available: startupMode === 'review-required',
          disabledReason: startupMode === 'review-required'
            ? null
            : 'Reviewed normal startup is available only after an interrupted activation.',
          pending: false,
          error: null,
        }),
      }),
      managementPhase: source.managementPhase,
      managementDetail: boundedDetail(source.managementDetail),
      catalogGeneration: source.catalogGeneration,
      installedPackages: Object.freeze(source.installedPackages.map((item) => (
        packageView(item, startupMode, source.action)
      ))),
      contributions: Object.freeze(contributions),
      review: retainedReview?.view ?? null,
      inspectionPhase,
      inspectionDetail,
      action: Object.freeze({ ...source.action }),
    })
  }

  const publish = (): void => {
    if (closed) return
    snapshot = buildSnapshot()
    editorPluginRevision++
    editorController?.refresh()
    for (const listener of listeners) listener(snapshot)
  }

  snapshot = buildSnapshot()
  const unsubscribeComposition = composition.subscribe(() => { publish() })

  const readEditorPlugins = (): PluginEditorPluginProjection => Object.freeze({
    revision: editorPluginRevision,
    catalogGeneration: snapshot.catalogGeneration,
    startupMode: snapshot.startup.mode,
    contributionSnapshot: composition.getSnapshot().contributionSnapshot ?? undefined,
    installedPackages: snapshot.installedPackages,
  })

  const ensureEditorController = (): PluginEditorController => {
    assertOpen()
    editorController ??= createEditorController(readEditorPlugins)
    return editorController
  }

  const clearReview = (): RetainedReview | null => {
    const previous = retainedReview
    retainedReview = null
    return previous
  }

  const mintReviewToken = (): string => {
    if (reviewEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new PluginAppControllerError('review-invalid', 'Package review token capacity is exhausted')
    }
    const entropy = createReviewToken()
    if (
      typeof entropy !== 'string'
      || entropy.length < 1
      || entropy.length > 192
      || !/^[A-Za-z0-9._~-]+$/u.test(entropy)
    ) throw new PluginAppControllerError('review-invalid', 'A package review token could not be created')
    const nextEpoch = reviewEpoch + 1
    const token = `plugin-review-${nextEpoch.toString(36)}-${entropy}`
    if (token.length > 256) {
      throw new PluginAppControllerError('review-invalid', 'A package review token could not be created')
    }
    reviewEpoch = nextEpoch
    return token
  }

  const withOperationTransition = async <T>(task: () => Promise<T>): Promise<T> => {
    const prior = operationTransition
    let release!: () => void
    operationTransition = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
      return await task()
    } finally {
      release()
    }
  }

  const trackOperation = <T>(
    externalSignal: AbortSignal | undefined,
    task: (signal: AbortSignal, epoch: number) => Promise<T>,
  ): Promise<T> => {
    const operationController = new AbortController()
    const epoch = actionEpoch
    const abortFromExternal = (): void => { operationController.abort(externalSignal?.reason) }
    if (externalSignal?.aborted) abortFromExternal()
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
    let operation!: AppOwnedOperation
    const promise = Promise.resolve()
      .then(() => task(operationController.signal, epoch))
      .finally(() => {
        externalSignal?.removeEventListener('abort', abortFromExternal)
        ownedOperations.delete(operation)
      })
    operation = Object.freeze({ epoch, controller: operationController, promise })
    ownedOperations.add(operation)
    return promise
  }

  const abortAndDrainOwnedOperations = async (
    inspectionIds: readonly string[],
  ): Promise<void> => {
    const pending = [...ownedOperations]
    for (const operation of pending) operation.controller.abort('plugin-app-operation-superseded')
    await Promise.allSettled(pending.map((operation) => operation.promise))
    const cleanupFailures: unknown[] = []
    for (const inspectionId of inspectionIds) {
      try {
        await composition.cancelInspection(inspectionId)
        ownedInspectionIds.delete(inspectionId)
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0]
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, 'Plugin inspection cleanup failed')
    }
  }

  const startExclusiveOperation = async <T>(options: {
    readonly signal?: AbortSignal
    readonly cancelReview: boolean
    readonly task: (signal: AbortSignal, epoch: number) => Promise<T>
  }): Promise<T> => {
    const holder = await withOperationTransition(async () => {
      assertOpen()
      const review = options.cancelReview ? clearReview() : null
      const inspectionIds = new Set<string>()
      if (review) inspectionIds.add(review.inspectionId)
      if (options.cancelReview) {
        const projectedInspectionId = composition.getSnapshot().inspection?.inspectionId
        if (projectedInspectionId) inspectionIds.add(projectedInspectionId)
        for (const inspectionId of ownedInspectionIds) inspectionIds.add(inspectionId)
      }
      if (options.cancelReview) {
        actionEpoch++
        inspectionPhase = 'idle'
        inspectionDetail = ''
        publish()
      }
      await abortAndDrainOwnedOperations([...inspectionIds])
      assertOpen()
      return Object.freeze({ promise: trackOperation(options.signal, options.task) })
    })
    return holder.promise
  }

  const beginMutation = (): void => {
    assertOpen()
    mutationEpoch++
    actionEpoch++
    clearReview()
    inspectionPhase = 'idle'
    inspectionDetail = ''
    publish()
  }

  const runMutation = async <T>(task: () => Promise<T>): Promise<T> => {
    return startExclusiveOperation({
      cancelReview: true,
      task: async () => {
        beginMutation()
        return task()
      },
    })
  }

  const appEffectBridgeHandler: PluginEffectBridgeHandler = Object.freeze({
    async apply(
      request: PluginEffectBridgeHandlerRequest,
      signal: AbortSignal,
    ): Promise<PluginEffectBridgeHandlerResult> {
      if (closed) return Object.freeze({ status: 'bypassed' })
      const expectedMutationEpoch = mutationEpoch
      return trackOperation(signal, async (ownedSignal) => {
        const result = await composition.getEffectBridgeHandler().apply(request, ownedSignal)
        if (result.status !== 'applied') return result
        if (closed || expectedMutationEpoch !== mutationEpoch || ownedSignal.aborted) {
          if (result.rgbaBytes.byteLength > 0) result.rgbaBytes.fill(0)
          return Object.freeze({ status: 'bypassed' })
        }
        return result
      })
    },
  })

  const exportPort: PluginExportCompositionPort = Object.freeze({
    async getDeclarationCatalog(signal?: AbortSignal) {
      return trackOperation(signal, async (ownedSignal) => {
        assertOpen()
        const expectedMutationEpoch = mutationEpoch
        const catalog = await composition.getDeclarationCatalog(ownedSignal)
        assertOpen()
        if (expectedMutationEpoch !== mutationEpoch || ownedSignal.aborted) {
          throw new PluginAppControllerError(
            'stale-operation',
            'Plugin management changed while the export catalog was loading',
          )
        }
        return catalog
      })
    },
    async preflightExport(request: PluginExportPreflightRequest, signal?: AbortSignal) {
      return trackOperation(signal, async (ownedSignal) => {
        assertOpen()
        const expectedMutationEpoch = mutationEpoch
        const session = await composition.preflightExport(request, ownedSignal)
        try {
          assertOpen()
          if (expectedMutationEpoch !== mutationEpoch || ownedSignal.aborted) {
            throw new PluginAppControllerError(
              'stale-operation',
              'Plugin management changed during export preflight',
            )
          }
          return session
        } catch (cause) {
          try {
            await session.close('stale-plugin-app')
          } catch (cleanupCause) {
            throw new AggregateError(
              [cause, cleanupCause],
              'Plugin export preflight and app cleanup both failed',
            )
          }
          throw cause
        }
      })
    },
  })

  const preflightDescriptorMigrationAction = async (
    request: PluginDescriptorMigrationActionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationActionSession> => trackOperation(
    signal,
    async (ownedSignal) => {
      assertOpen()
      const expectedMutationEpoch = mutationEpoch
      const session = await composition.preflightDescriptorMigrationAction(request, ownedSignal)
      try {
        assertOpen()
        if (expectedMutationEpoch !== mutationEpoch || ownedSignal.aborted) {
          throw new PluginAppControllerError(
            'stale-operation',
            'Plugin management changed during descriptor migration preflight',
          )
        }
        return session
      } catch (cause) {
        try {
          await session.close('stale-plugin-app')
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Plugin migration preflight and app cleanup both failed',
          )
        }
        throw cause
      }
    },
  )

  const ensureMigrationController = (): PluginDescriptorMigrationController => {
    assertOpen()
    if (migrationController) return migrationController
    const documentController = createPluginDocumentGenerationController()
    migrationDocumentController = documentController
    migrationController = createPluginDescriptorMigrationController({
      getDocumentSnapshot: documentController.getDocumentSnapshot,
      commitDocument: documentController.commitDocument,
      getContributionSnapshot() {
        const contributionSnapshot = composition.getSnapshot().contributionSnapshot
        if (!contributionSnapshot) {
          throw new PluginAppControllerError(
            'stale-operation',
            'Plugin declarations are unavailable for descriptor migration',
          )
        }
        return contributionSnapshot
      },
      runtime: { preflightDescriptorMigrationAction },
    })
    return migrationController
  }

  const close = (reason: string): Promise<void> => {
    if (closed) return terminalClosePromise ?? Promise.resolve()
    closed = true
    mutationEpoch++
    actionEpoch++
    const review = clearReview()
    const inspectionIds = new Set<string>()
    if (review) inspectionIds.add(review.inspectionId)
    const projectedInspectionId = composition.getSnapshot().inspection?.inspectionId
    if (projectedInspectionId) inspectionIds.add(projectedInspectionId)
    for (const inspectionId of ownedInspectionIds) inspectionIds.add(inspectionId)
    inspectionPhase = 'idle'
    inspectionDetail = ''
    for (const operation of ownedOperations) operation.controller.abort(reason)
    unsubscribeComposition()
    const ownedEditorController = editorController
    editorController = null
    listeners.clear()
    terminalClosePromise = Promise.resolve().then(async () => {
      const cleanupFailures: unknown[] = []
      try {
        ownedEditorController?.dispose()
      } catch (cause) {
        cleanupFailures.push(cause)
      }
      try {
        migrationDocumentController?.dispose()
        migrationDocumentController = null
        migrationController = null
      } catch (cause) {
        cleanupFailures.push(cause)
      }
      await operationTransition
      const pending = [...ownedOperations]
      for (const operation of pending) operation.controller.abort(reason)
      const settledOperations = await Promise.allSettled(
        pending.map((operation) => operation.promise),
      )
      for (const result of settledOperations) {
        if (result.status === 'rejected' && !isExpectedAppCloseRejection(result.reason)) {
          cleanupFailures.push(result.reason)
        }
      }
      const lateReview = retainedReview
      if (lateReview) inspectionIds.add(lateReview.inspectionId)
      const lateProjectedInspectionId = composition.getSnapshot().inspection?.inspectionId
      if (lateProjectedInspectionId) inspectionIds.add(lateProjectedInspectionId)
      for (const inspectionId of ownedInspectionIds) inspectionIds.add(inspectionId)
      for (const inspectionId of inspectionIds) {
        try {
          await composition.cancelInspection(inspectionId)
          ownedInspectionIds.delete(inspectionId)
        } catch (cause) {
          cleanupFailures.push(cause)
        }
      }
      try {
        await composition.close(reason)
      } catch (cause) {
        cleanupFailures.push(cause)
      }
      if (cleanupFailures.length === 1) throw cleanupFailures[0]
      if (cleanupFailures.length > 1) {
        throw new AggregateError(cleanupFailures, 'Plugin app cleanup failed')
      }
    })
    return terminalClosePromise
  }

  const controller: PluginAppController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      assertOpen()
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getEditorSnapshot: () => ensureEditorController().getSnapshot(),
    subscribeEditor(listener) {
      return ensureEditorController().subscribe(listener)
    },
    addPluginEffect(request) {
      return ensureEditorController().addPluginEffect(request)
    },
    setPluginEffectParameter(request) {
      return ensureEditorController().setPluginEffectParameter(request)
    },
    migratePluginEffects(effectIds, signal) {
      return trackOperation(signal, async (ownedSignal) => {
        assertOpen()
        return ensureMigrationController().migrate({ effectIds, signal: ownedSignal })
      })
    },
    getContributionSnapshot() {
      if (closed) return undefined
      return composition.getContributionSnapshot()
    },
    getEffectBridgeHandler: () => appEffectBridgeHandler,
    async refreshManagement(signal) {
      return startExclusiveOperation({
        signal,
        cancelReview: true,
        task: async (ownedSignal, epoch) => {
          await composition.refreshManagement(ownedSignal)
          if (!closed && epoch === actionEpoch && !ownedSignal.aborted) publish()
        },
      })
    },
    async inspectFile(file, signal) {
      return startExclusiveOperation({
        signal,
        cancelReview: true,
        task: async (ownedSignal, epoch) => {
          let bytes: Uint8Array | null = null
          let inspectedId: string | null = null
          let inspectionRetained = false
          inspectionPhase = 'reading'
          publish()
          try {
            if (!Number.isSafeInteger(file.size) || file.size < 0) {
              throw new PluginAppControllerError(
                'file-invalid',
                'The selected file has an invalid byte length.',
              )
            }
            if (file.size > PLUGIN_PACKAGE_LIMITS.maxArchiveBytes) {
              throw new PluginAppControllerError(
                'file-too-large',
                `Plugin packages must not exceed ${PLUGIN_PACKAGE_LIMITS.maxArchiveBytes} bytes.`,
              )
            }
            if (ownedSignal.aborted) {
              throw new PluginAppControllerError('aborted', 'Package inspection was cancelled')
            }
            const buffer = await file.arrayBuffer()
            if (!(buffer instanceof ArrayBuffer)) {
              throw new PluginAppControllerError('file-invalid', 'The selected file could not be read safely.')
            }
            bytes = new Uint8Array(buffer)
            if (buffer.byteLength !== file.size
              || buffer.byteLength > PLUGIN_PACKAGE_LIMITS.maxArchiveBytes) {
              throw new PluginAppControllerError(
                'file-invalid',
                'The selected file changed while it was being read.',
              )
            }
            if (closed || epoch !== actionEpoch || ownedSignal.aborted) {
              throw new PluginAppControllerError('stale-operation', 'Package inspection was superseded')
            }
            inspectionPhase = 'inspecting'
            publish()
            const inspected = await composition.inspectPackage(bytes, ownedSignal)
            inspectedId = inspected.inspectionId
            ownedInspectionIds.add(inspectedId)
            if (closed || epoch !== actionEpoch || ownedSignal.aborted) {
              throw new PluginAppControllerError('stale-operation', 'Package inspection was superseded')
            }
            const token = mintReviewToken()
            const view = reviewView(token, inspected)
            retainedReview = Object.freeze({
              token,
              inspectionId: inspected.inspectionId,
              consentFingerprint: consentFingerprint(view),
              actionEpoch: epoch,
              inspection: inspected,
              view,
            })
            inspectionRetained = true
            inspectionPhase = 'review'
            inspectionDetail = ''
            publish()
            return view
          } catch (cause) {
            if (!closed && epoch === actionEpoch && inspectionPhase !== 'review') {
              inspectionPhase = cause instanceof PluginAppControllerError
                && (cause.code === 'aborted' || cause.code === 'stale-operation')
                ? 'idle'
                : 'error'
              inspectionDetail = inspectionPhase === 'error'
                ? boundedDetail(inspectionFailureDetail(cause))
                : ''
              publish()
            }
            throw cause
          } finally {
            if (bytes?.byteLength) bytes.fill(0)
            if (inspectedId !== null && !inspectionRetained) {
              await composition.cancelInspection(inspectedId)
              ownedInspectionIds.delete(inspectedId)
            }
          }
        },
      })
    },
    async cancelInspection(reviewToken) {
      assertOpen()
      const current = retainedReview
      if (reviewToken !== undefined && current?.token !== reviewToken) return false
      const hadInspection = current !== null || composition.getSnapshot().inspection !== null
      await startExclusiveOperation({
        cancelReview: true,
        task: async () => {},
      })
      return hadInspection
    },
    async installPlugin(decision) {
      assertOpen()
      const current = retainedReview
      if (!current || decision.reviewToken !== current.token) {
        throw new PluginAppControllerError('review-expired', 'Package review expired; inspect it again')
      }
      if (current.actionEpoch !== actionEpoch
        || consentFingerprint(current.view) !== current.consentFingerprint) {
        throw new PluginAppControllerError('review-expired', 'Package review changed; inspect it again')
      }
      const latestInspection = composition.getSnapshot().inspection
      if (!latestInspection || latestInspection.inspectionId !== current.inspectionId
        || consentFingerprint(reviewView(current.token, latestInspection)) !== current.consentFingerprint) {
        throw new PluginAppControllerError('review-expired', 'Package review changed; inspect it again')
      }
      mutationEpoch++
      actionEpoch++
      clearReview()
      inspectionPhase = 'installing'
      inspectionDetail = ''
      publish()
      let permissionDecisions: CommitPluginInstallationOptions['permissionDecisions']
      try {
        const grantedIds = decision.grantedPermissionIds
        const uniqueIds = new Set(grantedIds)
        if (uniqueIds.size !== grantedIds.length) {
          throw new PluginAppControllerError('review-invalid', 'Granted capability ids must be unique')
        }
        const decisionIds = new Set(current.inspection.permissions.filter((permission) => (
          permission.decisionRequired
          && permission.status === 'available'
          && permission.selectedVersion !== null
        )).map((permission) => permission.id))
        if (grantedIds.some((id) => !decisionIds.has(id))) {
          throw new PluginAppControllerError(
            'review-invalid',
            'Only capabilities requiring a current decision can be granted',
          )
        }
        if (decision.trustSigner !== current.inspection.trustDecisionRequired
          || decision.confirmDowngrade !== (current.inspection.change === 'downgrade')
          || decision.confirmSameVersionReplacement
            !== (current.inspection.change === 'same-version-replacement')) {
          throw new PluginAppControllerError(
            'review-invalid',
            'The installation decisions do not match the current package review',
          )
        }
        permissionDecisions = Object.freeze(current.inspection.permissions
          .filter((permission) => permission.decisionRequired)
          .map((permission) => Object.freeze({
            id: permission.id,
            granted: uniqueIds.has(permission.id),
          })))
      } catch (cause) {
        inspectionPhase = 'error'
        inspectionDetail = 'The package review is no longer usable; inspect the package again.'
        publish()
        try {
          await composition.cancelInspection(current.inspectionId)
          ownedInspectionIds.delete(current.inspectionId)
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Package review validation and cleanup both failed',
          )
        }
        throw cause
      }
      try {
        await startExclusiveOperation({
          cancelReview: false,
          task: async () => composition.commitInstallation(current.inspectionId, Object.freeze({
            trustSigner: decision.trustSigner,
            confirmDowngrade: decision.confirmDowngrade,
            confirmSameVersionReplacement: decision.confirmSameVersionReplacement,
            enableAfterInstall: true,
            permissionDecisions: Object.freeze(permissionDecisions),
          })),
        })
        ownedInspectionIds.delete(current.inspectionId)
        inspectionPhase = 'idle'
        publish()
      } catch (cause) {
        inspectionPhase = 'error'
        inspectionDetail = 'Plugin installation did not complete; inspect the package again.'
        publish()
        try {
          await composition.cancelInspection(current.inspectionId)
          ownedInspectionIds.delete(current.inspectionId)
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Plugin installation and inspection cleanup both failed',
          )
        }
        throw cause
      }
    },
    retryPlugin(pluginId) {
      return runMutation(() => composition.retryPlugin(pluginId))
    },
    enablePlugin(pluginId, signal) {
      return runMutation(() => composition.enablePlugin(pluginId, signal))
    },
    disablePlugin(pluginId) {
      return runMutation(() => composition.disablePlugin(pluginId))
    },
    setPermissionGrant(pluginId, permissionId, granted, signal) {
      return runMutation(() => composition.setPermissionGrant(
        pluginId,
        permissionId,
        granted,
        signal,
      ))
    },
    quarantinePlugin(pluginId) {
      return runMutation(() => composition.quarantinePlugin(pluginId))
    },
    revokePlugin(pluginId) {
      return runMutation(() => composition.revokePlugin(pluginId))
    },
    uninstallPlugin(pluginId) {
      return runMutation(() => composition.uninstallPlugin(pluginId))
    },
    clearDiagnostics(pluginId) {
      return startExclusiveOperation({
        cancelReview: true,
        task: async () => composition.clearDiagnostics(pluginId),
      })
    },
    continueWithReviewedNormalStartup() {
      return startExclusiveOperation({
        cancelReview: true,
        task: async () => {
          mutationEpoch++
          return composition.continueWithReviewedNormalStartup()
        },
      })
    },
    enterSafeMode() {
      assertOpen()
      mutationEpoch++
      actionEpoch++
      const review = clearReview()
      inspectionPhase = 'idle'
      inspectionDetail = ''
      publish()
      for (const operation of ownedOperations) operation.controller.abort('safe-mode')
      // This call flips the execution gate synchronously before any await.
      const safeMode = composition.enterSafeMode()
      return withOperationTransition(async () => {
        const pending = [...ownedOperations]
        for (const operation of pending) operation.controller.abort('safe-mode')
        await Promise.allSettled(pending.map((operation) => operation.promise))
        const cleanupFailures: unknown[] = []
        const inspectionIds = new Set<string>()
        if (review) inspectionIds.add(review.inspectionId)
        const projectedInspectionId = composition.getSnapshot().inspection?.inspectionId
        if (projectedInspectionId) inspectionIds.add(projectedInspectionId)
        for (const inspectionId of inspectionIds) {
          try {
            await composition.cancelInspection(inspectionId)
          } catch (cause) {
            cleanupFailures.push(cause)
          }
        }
        try {
          const changed = await safeMode
          if (cleanupFailures.length === 1) throw cleanupFailures[0]
          if (cleanupFailures.length > 1) {
            throw new AggregateError(cleanupFailures, 'Safe mode cleanup failed')
          }
          return changed
        } catch (cause) {
          if (cleanupFailures.length > 0 && !cleanupFailures.includes(cause)) {
            throw new AggregateError(
              [cause, ...cleanupFailures],
              'Safe mode transition and cleanup failed',
            )
          }
          throw cause
        }
      })
    },
  }
  const owner: PluginAppControllerOwner = Object.freeze({
    controller: Object.freeze(controller),
    exportCompositionPort: exportPort,
    preflightDescriptorMigrationAction,
    close,
  })
  return owner
}

function createProductionPluginAppControllerOwner(
  lifecycleObserver?: PluginRuntimeLifecycleObserver,
): PluginAppControllerOwner {
  const safetyStorage = browserSafetyStorage()
  let activationBatchSequence = 0
  return createPluginAppControllerOwner({
    safetyStorage,
    lifecycleObserver,
    createManagementController(sessionSafety) {
      const trustRegistry = createPluginTrustRegistry(localPluginTrustPolicyStore)
      return createPluginInstallController({
        storage: localPluginStorage,
        sessionSafety,
        trustPolicy: trustRegistry.policy,
        revokeBinding: trustRegistry.revokeBinding,
      })
    },
    createRuntimeController(activationBundleResolver, observer) {
      return createPluginRuntimeController({
        activationBundleResolver,
        lifecycleObserver: observer,
        runActivationBatch(pluginId, activate) {
          activationBatchSequence++
          return runPluginActivationBatch({
            storage: safetyStorage,
            batchId: `plugin-activation-${activationBatchSequence.toString(36)}-${pluginId.length.toString(36)}`,
            activate,
          })
        },
      })
    },
  })
}

interface PluginAppAcceptanceLease {
  readonly owner: PluginAppControllerOwner
}

let productionOwner: PluginAppControllerOwner | null = null
let productionClosePromise: Promise<void> | null = null
let acceptanceLease: PluginAppAcceptanceLease | null = null

function ownershipConflict(message: string): PluginAppControllerError {
  return new PluginAppControllerError('stale-operation', message)
}

/**
 * Creates one isolated, production-composed owner for the disposable browser gate.
 * The lease is deliberately separate from `productionOwner` and remains exclusive
 * until terminal cleanup settles, including a rejected cleanup.
 */
export function createPluginAppAcceptanceSession(
  lifecycleObserver: PluginRuntimeLifecycleObserver,
): PluginAppAcceptanceSession {
  if (productionOwner || productionClosePromise) {
    throw ownershipConflict('Plugin acceptance cannot run while production ownership exists')
  }
  if (acceptanceLease) {
    throw ownershipConflict('Plugin acceptance ownership already exists or is closing')
  }

  const owner = createProductionPluginAppControllerOwner(lifecycleObserver)
  const lease = Object.freeze({ owner })
  acceptanceLease = lease
  let terminalClosePromise: Promise<void> | null = null

  const exportFacade: PluginAppAcceptanceExportFacade = Object.freeze({
    getDeclarationCatalog(signal?: AbortSignal) {
      return owner.exportCompositionPort.getDeclarationCatalog(signal)
    },
    async preflightAndCloseExport(
      request: PluginExportPreflightRequest,
      signal?: AbortSignal,
    ) {
      const session = await owner.exportCompositionPort.preflightExport(request, signal)
      await session.close('issue77-acceptance-export-preflight-complete')
    },
    async applyAndCloseExport(
      preflight: PluginExportPreflightRequest,
      effect: PluginEffectApplyRequest,
      signal?: AbortSignal,
    ) {
      const session = await owner.exportCompositionPort.preflightExport(preflight, signal)
      try {
        return await session.apply(effect, signal)
      } finally {
        await session.close('issue77-acceptance-export-apply-complete')
      }
    },
  })

  const close = (reason: string): Promise<void> => {
    if (terminalClosePromise) return terminalClosePromise
    const completion = owner.close(reason).then(
      () => {
        if (acceptanceLease === lease) acceptanceLease = null
      },
      (cause: unknown) => {
        if (acceptanceLease === lease) acceptanceLease = null
        throw cause
      },
    )
    terminalClosePromise = completion
    return completion
  }

  return Object.freeze({
    controller: owner.controller,
    exportFacade,
    close,
  })
}

/** App-private production accessor for export, migration, and terminal ownership. */
export function getPluginAppControllerOwner(): PluginAppControllerOwner {
  if (acceptanceLease) {
    throw ownershipConflict('Production plugin ownership cannot open during acceptance validation')
  }
  if (productionOwner) return productionOwner
  if (productionClosePromise) {
    throw ownershipConflict('Production plugin ownership is still closing')
  }
  productionOwner = createProductionPluginAppControllerOwner()
  return productionOwner
}

/** StrictMode-safe production accessor. Construction performs only the sentinel read. */
export function getPluginAppController(): PluginAppController {
  return getPluginAppControllerOwner().controller
}

/** Test/HMR-only terminal release; the next accessor creates a fresh root. */
export function disposePluginAppController(reason: string): Promise<void> {
  if (productionClosePromise) return productionClosePromise
  const retiring = productionOwner
  productionOwner = null
  if (!retiring) return Promise.resolve()
  const completion = retiring.close(reason).then(
    () => {
      if (productionClosePromise === completion) productionClosePromise = null
    },
    (cause: unknown) => {
      if (productionClosePromise === completion) productionClosePromise = null
      throw cause
    },
  )
  productionClosePromise = completion
  return completion
}
