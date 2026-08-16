/** Inert app-owned composition facade for local plugin management and execution. */

import {
  PLUGIN_MANIFEST_LIMITS,
} from '../domain/pluginManifest'
import {
  createPluginVideoEffectContributionSnapshot,
  type PluginVideoEffectContributionSnapshot,
} from '../domain/pluginVideoEffectStagePlan'
import type {
  PluginEffectBridgeHandler,
  PluginEffectBridgeHandlerRequest,
  PluginEffectBridgeHandlerResult,
} from '../workers/plugin-effect-bridge-protocol'
import {
  PluginInstallControllerError,
  type CommitPluginInstallationOptions,
  type PluginDeclarationCatalogEntry,
  type PluginDeclarationCatalogSnapshot,
  type PluginInstallController,
  type PluginInstalledPackageProjection,
  type PluginPackageInspection,
} from './pluginInstallController'
import {
  captureLoadedPluginLifecycleToken,
  disposeLoadedPlugins,
  registerLoadedPluginDisposer,
  type LoadedPluginDisposer,
  type LoadedPluginLifecycleToken,
} from './pluginLifecycle'
import type {
  PluginDescriptorMigrationActionPreflightRequest,
  PluginDescriptorMigrationActionSession,
  PluginEffectApplyRequest,
  PluginExportPreflightRequest,
  PluginExportSession,
  PluginRuntimeController,
} from './pluginRuntimeController'
import type {
  PluginSafetyStorage,
  PluginSessionSafety,
} from './pluginSafetyController'
import type { PluginRuntimeLifecycleObserver } from './pluginRuntimeLifecycleObserver'
import {
  createPluginStartupController,
  type PluginStartupSnapshot,
} from './pluginStartupController'

const MAX_ACTION_DETAIL_CHARACTERS = 512
const COHERENT_REFRESH_ATTEMPTS = 3
const PLUGIN_ID = /^(?:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u

export type PluginCompositionManagementPhase = 'idle' | 'loading' | 'ready' | 'error'

export type PluginCompositionActionKind =
  | 'refresh'
  | 'inspect'
  | 'cancel-inspection'
  | 'install'
  | 'retry'
  | 'enable'
  | 'disable'
  | 'permission'
  | 'quarantine'
  | 'revoke'
  | 'uninstall'
  | 'clear-diagnostics'
  | 'safe-mode'

export type PluginCompositionActionPhase = 'idle' | 'pending' | 'succeeded' | 'failed'

export interface PluginCompositionActionSnapshot {
  readonly epoch: number
  readonly kind: PluginCompositionActionKind | null
  readonly pluginId: string | null
  readonly phase: PluginCompositionActionPhase
  readonly detail: string
}

export interface PluginCompositionInstalledPackage {
  readonly pluginId: string
  readonly name: string
  readonly installedVersion: string
  readonly packageDigest: string
  readonly signerFingerprint: string
  readonly contributionNames: readonly string[]
  readonly selectedCapabilities: readonly {
    readonly id: string
    readonly version: number
    readonly required: boolean
  }[]
  readonly status: PluginInstalledPackageProjection['status']
  readonly detail: string
  readonly diagnostics: readonly {
    readonly code: string
    readonly occurredAt: number
  }[]
}

export interface PluginCompositionInspection {
  readonly inspectionId: string
  readonly pluginId: string
  readonly name: string
  readonly version: string
  readonly packageDigest: string
  readonly signerFingerprint: string
  readonly installedVersion: string | null
  readonly versionChanged: boolean
  readonly sameVersionReplacement: boolean
  readonly samePackage: boolean
  readonly moduleSha256: string
  readonly memoryMaximumPages: number
  readonly change: PluginPackageInspection['change']
  readonly contributionNames: readonly string[]
  readonly selectedCapabilities: PluginCompositionInstalledPackage['selectedCapabilities']
  readonly signerContinuity: boolean
  readonly trustState: PluginPackageInspection['trustState']
  readonly trustDecisionRequired: boolean
  readonly compatibility: {
    readonly status: PluginPackageInspection['compatibility']['status']
    readonly apiVersion: number | null
    readonly permissions: readonly {
      readonly id: string
      readonly required: boolean
      readonly version: number | null
      readonly status: 'available' | 'unavailable'
    }[]
    readonly contributions: readonly {
      readonly id: string
      readonly kind: 'video-effect'
      readonly version: number
      readonly status: 'available' | 'unavailable'
    }[]
    readonly reasons: readonly string[]
  }
  readonly permissions: readonly {
    readonly id: string
    readonly minVersion: number
    readonly maxVersion: number
    readonly required: boolean
    readonly negotiatedVersion: number | null
    readonly selectedVersion: number | null
    readonly status: 'available' | 'unavailable'
    readonly decisionRequired: boolean
    readonly priorGrant: {
      readonly minVersion: number
      readonly maxVersion: number
      readonly required: boolean
      readonly selectedVersion: number
    } | null
    readonly grantChange: PluginPackageInspection['permissions'][number]['grantChange']
  }[]
  readonly diagnostics: readonly {
    readonly code: string
    readonly occurredAt: number
  }[]
}

export interface PluginCompositionSnapshot {
  readonly startup: PluginStartupSnapshot
  readonly managementPhase: PluginCompositionManagementPhase
  readonly managementDetail: string
  readonly catalogGeneration: number | null
  readonly installedPackages: readonly PluginCompositionInstalledPackage[]
  readonly contributionSnapshot: PluginVideoEffectContributionSnapshot | null
  readonly inspection: PluginCompositionInspection | null
  readonly action: PluginCompositionActionSnapshot
}

export interface PluginCompositionController {
  getSnapshot(): PluginCompositionSnapshot
  subscribe(listener: (snapshot: PluginCompositionSnapshot) => void): () => void
  getContributionSnapshot(): PluginVideoEffectContributionSnapshot | undefined
  getEffectBridgeHandler(): PluginEffectBridgeHandler
  getDeclarationCatalog(signal?: AbortSignal): Promise<PluginDeclarationCatalogSnapshot>
  refreshManagement(signal?: AbortSignal): Promise<void>
  inspectPackage(
    archiveBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<PluginCompositionInspection>
  cancelInspection(inspectionId: string): Promise<boolean>
  commitInstallation(
    inspectionId: string,
    options: CommitPluginInstallationOptions,
  ): Promise<void>
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
  continueWithReviewedNormalStartup(): boolean
  enterSafeMode(): Promise<boolean>
  applyEditorEffect(
    request: PluginEffectBridgeHandlerRequest,
    signal: AbortSignal,
  ): Promise<PluginEffectBridgeHandlerResult>
  preflightExport(
    request: PluginExportPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginExportSession>
  preflightDescriptorMigrationAction(
    request: PluginDescriptorMigrationActionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationActionSession>
  close(reason: string): Promise<void>
}

export interface PluginCompositionControllerDependencies {
  readonly safetyStorage: PluginSafetyStorage
  readonly createManagementController: (
    sessionSafety: PluginSessionSafety,
  ) => PluginInstallController | Promise<PluginInstallController>
  readonly createRuntimeController: (
    activationBundleResolver: PluginInstallController['activationBundles'],
    lifecycleObserver?: PluginRuntimeLifecycleObserver,
  ) => PluginRuntimeController | Promise<PluginRuntimeController>
  readonly lifecycleObserver?: PluginRuntimeLifecycleObserver
  readonly lifecycle?: {
    captureToken(): LoadedPluginLifecycleToken
    registerDisposer(
      token: LoadedPluginLifecycleToken,
      disposer: LoadedPluginDisposer,
    ): Promise<boolean>
    dispose(): Promise<void>
  }
}

interface CoherentManagementProjection {
  readonly generation: number
  readonly installedPackages: readonly PluginCompositionInstalledPackage[]
  readonly declarationCatalog: PluginDeclarationCatalogSnapshot
  readonly contributionSnapshot: PluginVideoEffectContributionSnapshot
}

function boundedDetail(value: string): string {
  return value.length <= MAX_ACTION_DETAIL_CHARACTERS
    ? value
    : `${value.slice(0, MAX_ACTION_DETAIL_CHARACTERS - 1)}\u2026`
}

function validatedPluginId(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > PLUGIN_MANIFEST_LIMITS.maxPluginIdCharacters
    || !PLUGIN_ID.test(value)
  ) throw new TypeError('Plugin id is invalid')
  return value
}

function actionFailureDetail(cause: unknown): string {
  if (cause instanceof PluginInstallControllerError) return boundedDetail(cause.message)
  return 'The plugin action failed without exposing internal details.'
}

function freezeStartup(snapshot: PluginStartupSnapshot): PluginStartupSnapshot {
  return Object.freeze({
    mode: snapshot.mode,
    sentinelStatus: snapshot.sentinelStatus,
    safeModeRecommended: snapshot.safeModeRecommended,
    recommendationReason: snapshot.recommendationReason,
    staleBatchId: snapshot.staleBatchId,
  })
}

function freezeInstalledPackage(
  source: PluginInstalledPackageProjection,
): PluginCompositionInstalledPackage {
  return Object.freeze({
    pluginId: source.pluginId,
    name: source.name,
    installedVersion: source.installedVersion,
    packageDigest: source.packageDigest,
    signerFingerprint: source.signerFingerprint,
    contributionNames: Object.freeze([...source.contributionNames]),
    selectedCapabilities: Object.freeze(source.selectedCapabilities.map((capability) => Object.freeze({
      id: capability.id,
      version: capability.version,
      required: capability.required,
    }))),
    status: source.status,
    detail: boundedDetail(source.detail),
    diagnostics: Object.freeze(source.diagnostics.map((diagnostic) => Object.freeze({
      code: diagnostic.code,
      occurredAt: diagnostic.occurredAt,
    }))),
  })
}

function freezeInspection(source: PluginPackageInspection): PluginCompositionInspection {
  return Object.freeze({
    inspectionId: source.inspectionId,
    pluginId: source.pluginId,
    name: source.name,
    version: source.version,
    packageDigest: source.packageDigest,
    signerFingerprint: source.signerFingerprint,
    installedVersion: source.installedVersion,
    versionChanged: source.versionChanged,
    sameVersionReplacement: source.sameVersionReplacement,
    samePackage: source.samePackage,
    moduleSha256: source.moduleSha256,
    memoryMaximumPages: source.memoryMaximumPages,
    change: source.change,
    contributionNames: Object.freeze([...source.contributionNames]),
    selectedCapabilities: Object.freeze(source.selectedCapabilities.map((capability) => Object.freeze({
      id: capability.id,
      version: capability.version,
      required: capability.required,
    }))),
    signerContinuity: source.signerContinuity,
    trustState: source.trustState,
    trustDecisionRequired: source.trustDecisionRequired,
    compatibility: Object.freeze({
      status: source.compatibility.status,
      apiVersion: source.compatibility.apiVersion,
      permissions: Object.freeze(source.compatibility.permissions.map((permission) => Object.freeze({
        id: permission.id,
        required: permission.required,
        version: permission.version,
        status: permission.status,
      }))),
      contributions: Object.freeze(source.compatibility.contributions.map((contribution) => Object.freeze({
        id: contribution.id,
        kind: contribution.kind,
        version: contribution.version,
        status: contribution.status,
      }))),
      reasons: Object.freeze([...source.compatibility.reasons]),
    }),
    permissions: Object.freeze(source.permissions.map((permission) => Object.freeze({
      id: permission.id,
      minVersion: permission.minVersion,
      maxVersion: permission.maxVersion,
      required: permission.required,
      negotiatedVersion: permission.negotiatedVersion,
      selectedVersion: permission.selectedVersion,
      status: permission.status,
      decisionRequired: permission.decisionRequired,
      priorGrant: permission.priorGrant === null
        ? null
        : Object.freeze({
            minVersion: permission.priorGrant.minVersion,
            maxVersion: permission.priorGrant.maxVersion,
            required: permission.priorGrant.required,
            selectedVersion: permission.priorGrant.selectedVersion,
          }),
      grantChange: permission.grantChange,
    }))),
    diagnostics: Object.freeze(source.diagnostics.map((diagnostic) => Object.freeze({
      code: diagnostic.code,
      occurredAt: diagnostic.occurredAt,
    }))),
  })
}

function freezeDeclarationEntry(
  source: PluginDeclarationCatalogEntry,
): PluginDeclarationCatalogEntry {
  return Object.freeze({
    pluginId: source.pluginId,
    pluginVersion: source.pluginVersion,
    packageDigest: source.packageDigest,
    signerFingerprint: source.signerFingerprint,
    kind: source.kind,
    contributionId: source.contributionId,
    contributionName: source.contributionName,
    contributionVersion: source.contributionVersion,
    descriptorVersion: source.descriptorVersion,
    entrypoint: source.entrypoint,
    parameters: Object.freeze(source.parameters.map(freezeParameter)),
    availability: source.availability,
    detail: boundedDetail(source.detail),
  })
}

function freezeParameter(
  parameter: PluginDeclarationCatalogEntry['parameters'][number],
): PluginDeclarationCatalogEntry['parameters'][number] {
  if (parameter.kind === 'enum') {
    return Object.freeze({
      ...parameter,
      options: Object.freeze(parameter.options.map((option) => Object.freeze({ ...option }))),
    })
  }
  return Object.freeze({ ...parameter })
}

function freezeDeclarationCatalog(
  source: PluginDeclarationCatalogSnapshot,
): PluginDeclarationCatalogSnapshot {
  return Object.freeze({
    generation: source.generation,
    declarations: Object.freeze(source.declarations.map(freezeDeclarationEntry)),
  })
}

function contributionSnapshot(
  generation: number,
  declarations: readonly PluginDeclarationCatalogEntry[],
): PluginVideoEffectContributionSnapshot {
  return createPluginVideoEffectContributionSnapshot(generation, declarations.map((entry) => ({
    signerFingerprint: entry.signerFingerprint,
    packageDigest: entry.packageDigest,
    pluginId: entry.pluginId,
    pluginVersion: entry.pluginVersion,
    kind: entry.kind,
    contributionVersion: entry.contributionVersion,
    contributionId: entry.contributionId,
    contributionName: entry.contributionName,
    descriptorVersion: entry.descriptorVersion,
    entrypoint: entry.entrypoint,
    parameters: entry.parameters,
    availability: entry.availability,
    detail: entry.detail,
  })))
}

function closedError(): Error {
  return new Error('Plugin composition is closed')
}

function runtimeBlockedError(): PluginInstallControllerError {
  return new PluginInstallControllerError(
    'safe-mode',
    'Plugin execution is unavailable until reviewed normal startup is active',
  )
}

function staleRuntimeError(): PluginInstallControllerError {
  return new PluginInstallControllerError(
    'install-conflict',
    'Plugin execution was superseded by a local management change',
  )
}

function isExpectedRuntimeCloseRejection(cause: unknown): boolean {
  return cause instanceof PluginInstallControllerError
    ? cause.code === 'safe-mode' || cause.code === 'install-conflict'
    : cause instanceof Error && cause.message === 'Plugin composition is closed'
}

function zeroBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > 0) bytes.fill(0)
}

export function createPluginCompositionController(
  dependencies: PluginCompositionControllerDependencies,
): PluginCompositionController {
  const startup = createPluginStartupController(dependencies.safetyStorage)
  const lifecycle = dependencies.lifecycle ?? Object.freeze({
    captureToken: captureLoadedPluginLifecycleToken,
    registerDisposer: registerLoadedPluginDisposer,
    dispose: disposeLoadedPlugins,
  })
  const listeners = new Set<(snapshot: PluginCompositionSnapshot) => void>()
  let managementPromise: Promise<PluginInstallController> | null = null
  let managementController: PluginInstallController | null = null
  let runtimePromise: Promise<PluginRuntimeController> | null = null
  let runtimeController: PluginRuntimeController | null = null
  let editorSession: ReturnType<PluginRuntimeController['openEditorSession']> | null = null
  let runtimeDisposalPromise: Promise<void> | null = null
  let terminalClosePromise: Promise<void> | null = null
  const runtimeCandidateDisposals = new WeakMap<PluginRuntimeController, Promise<void>>()
  const pendingInspectionIds = new Set<string>()
  let managementTail = Promise.resolve()
  let operationEpoch = 0
  let runtimeEpoch = 0
  let activeRuntimeMutations = 0
  let lifecycleEpoch = 0
  let closed = false
  let runtimeBlocked = startup.getSnapshot().mode !== 'normal'
  let runtimeCloseReason = 'plugin-composition-disposed'
  let managementPhase: PluginCompositionManagementPhase = 'idle'
  let managementDetail = ''
  let catalogGeneration: number | null = null
  let installedPackages: readonly PluginCompositionInstalledPackage[] = Object.freeze([])
  let currentContributionSnapshot: PluginVideoEffectContributionSnapshot | null = null
  let inspection: PluginCompositionInspection | null = null
  let action: PluginCompositionActionSnapshot = Object.freeze({
    epoch: 0,
    kind: null,
    pluginId: null,
    phase: 'idle',
    detail: '',
  })
  let snapshot: PluginCompositionSnapshot

  const buildSnapshot = (): PluginCompositionSnapshot => Object.freeze({
    startup: freezeStartup(startup.getSnapshot()),
    managementPhase,
    managementDetail,
    catalogGeneration,
    installedPackages,
    contributionSnapshot: currentContributionSnapshot,
    inspection,
    action,
  })

  const publish = (): void => {
    snapshot = buildSnapshot()
    for (const listener of listeners) listener(snapshot)
  }

  snapshot = buildSnapshot()
  const unsubscribeStartup = startup.subscribe(() => { publish() })

  const assertOpen = (): void => {
    if (closed) throw closedError()
  }

  const assertRuntimeAllowed = (): void => {
    assertOpen()
    if (runtimeBlocked || startup.getSnapshot().mode !== 'normal') throw runtimeBlockedError()
    if (activeRuntimeMutations > 0) {
      throw new PluginInstallControllerError(
        'install-conflict',
        'Plugin execution is paused while local plugin management changes',
      )
    }
  }

  const disposeRuntimeCandidate = (
    candidate: PluginRuntimeController,
    reason: string,
  ): Promise<void> => {
    const existing = runtimeCandidateDisposals.get(candidate)
    if (existing) return existing
    const ownedEditor = runtimeController === candidate ? editorSession : null
    if (runtimeController === candidate) {
      runtimeController = null
      runtimePromise = null
      editorSession = null
    }
    runtimeEpoch++
    lifecycleEpoch++
    const disposal = (async () => {
      let editorFailure: unknown
      try {
        await ownedEditor?.close(reason)
      } catch (cause) {
        editorFailure = cause
      }
      let runtimeFailure: unknown
      try {
        await candidate.teardown(reason)
      } catch (cause) {
        runtimeFailure = cause
      }
      if (editorFailure !== undefined && runtimeFailure !== undefined) {
        throw new AggregateError(
          [editorFailure, runtimeFailure],
          'Editor and plugin runtime cleanup both failed',
        )
      }
      if (editorFailure !== undefined) throw editorFailure
      if (runtimeFailure !== undefined) throw runtimeFailure
    })().catch((cause) => {
      if (!closed) {
        runtimeBlocked = true
        startup.enterSafeMode()
      }
      throw cause
    })
    runtimeCandidateDisposals.set(candidate, disposal)
    return disposal
  }

  const ensureManagement = (): Promise<PluginInstallController> => {
    assertOpen()
    if (managementController) return Promise.resolve(managementController)
    if (managementPromise) return managementPromise
    const expectedLifecycle = lifecycleEpoch
    const candidate = Promise.resolve().then(() => (
      dependencies.createManagementController(startup.getSessionSafety())
    )).then((controller) => {
      if (closed || expectedLifecycle !== lifecycleEpoch) throw closedError()
      managementController = controller
      return controller
    })
    const tracked = candidate.catch((cause) => {
      if (managementPromise === tracked) managementPromise = null
      throw cause
    })
    managementPromise = tracked
    return managementPromise
  }

  const ensureRuntime = (): Promise<PluginRuntimeController> => {
    assertRuntimeAllowed()
    if (runtimeController) return Promise.resolve(runtimeController)
    if (runtimePromise) return runtimePromise
    // Capture at the beginning of every ownership attempt. A project disposal
    // with no registered owner still advances the global lifecycle generation.
    const creationLifecycleToken = lifecycle.captureToken()
    const expectedLifecycle = lifecycleEpoch
    const expectedRuntime = runtimeEpoch
    const candidatePromise = (async () => {
      const management = await ensureManagement()
      assertRuntimeAllowed()
      if (expectedLifecycle !== lifecycleEpoch) throw closedError()
      if (expectedRuntime !== runtimeEpoch) throw staleRuntimeError()
      const candidate = await dependencies.createRuntimeController(
        management.activationBundles,
        dependencies.lifecycleObserver,
      )
      if (closed
        || runtimeBlocked
        || startup.getSnapshot().mode !== 'normal'
        || expectedLifecycle !== lifecycleEpoch
        || expectedRuntime !== runtimeEpoch) {
        await disposeRuntimeCandidate(candidate, 'stale-plugin-composition')
        if (runtimeBlocked) throw runtimeBlockedError()
        if (closed || expectedLifecycle !== lifecycleEpoch) throw closedError()
        throw staleRuntimeError()
      }
      let registered: boolean
      try {
        registered = await lifecycle.registerDisposer(
          creationLifecycleToken,
          () => disposeRuntimeCandidate(candidate, runtimeCloseReason),
        )
      } catch (cause) {
        if (!runtimeCandidateDisposals.has(candidate)) {
          await disposeRuntimeCandidate(candidate, 'plugin-lifecycle-registration-failed')
        }
        throw cause
      }
      if (!registered) {
        if (closed) throw closedError()
        if (runtimeBlocked) throw runtimeBlockedError()
        throw staleRuntimeError()
      }
      if (closed
        || runtimeBlocked
        || startup.getSnapshot().mode !== 'normal'
        || expectedLifecycle !== lifecycleEpoch
        || expectedRuntime !== runtimeEpoch) {
        await disposeRuntimeCandidate(candidate, 'stale-plugin-composition')
        if (runtimeBlocked) throw runtimeBlockedError()
        if (closed || expectedLifecycle !== lifecycleEpoch) throw closedError()
        throw staleRuntimeError()
      }
      runtimeController = candidate
      return candidate
    })()
    const tracked = candidatePromise.catch((cause) => {
      if (runtimePromise === tracked) runtimePromise = null
      throw cause
    })
    runtimePromise = tracked
    return runtimePromise
  }

  const readCoherentManagement = async (
    management: PluginInstallController,
    signal?: AbortSignal,
  ): Promise<CoherentManagementProjection> => {
    for (let attempt = 0; attempt < COHERENT_REFRESH_ATTEMPTS; attempt++) {
      const [installed, catalog] = await Promise.all([
        management.installedPackages(signal),
        management.declarationCatalog(signal),
      ])
      if (installed.generation !== catalog.generation) continue
      const frozenCatalog = freezeDeclarationCatalog(catalog)
      return Object.freeze({
        generation: frozenCatalog.generation,
        installedPackages: Object.freeze(installed.packages.map(freezeInstalledPackage)),
        declarationCatalog: frozenCatalog,
        contributionSnapshot: contributionSnapshot(
          frozenCatalog.generation,
          frozenCatalog.declarations,
        ),
      })
    }
    throw new PluginInstallControllerError(
      'install-conflict',
      'Plugin management changed too quickly to produce one coherent view',
    )
  }

  const installProjection = (projection: CoherentManagementProjection): void => {
    catalogGeneration = projection.generation
    installedPackages = projection.installedPackages
    currentContributionSnapshot = projection.contributionSnapshot
    managementPhase = 'ready'
    managementDetail = ''
  }

  const beginAction = (
    kind: PluginCompositionActionKind,
    pluginId: string | null,
  ): number => {
    const epoch = ++operationEpoch
    action = Object.freeze({
      epoch,
      kind,
      pluginId,
      phase: 'pending',
      detail: '',
    })
    managementPhase = 'loading'
    managementDetail = ''
    publish()
    return epoch
  }

  const finishAction = (
    epoch: number,
    kind: PluginCompositionActionKind,
    pluginId: string | null,
    phase: 'succeeded' | 'failed',
    detail: string,
  ): void => {
    if (closed || epoch !== operationEpoch) return
    action = Object.freeze({ epoch, kind, pluginId, phase, detail: boundedDetail(detail) })
    if (phase === 'failed') {
      managementPhase = 'error'
      managementDetail = boundedDetail(detail)
    }
    publish()
  }

  const enqueueManagement = <T>(
    kind: PluginCompositionActionKind,
    pluginId: string | null,
    task: (
      management: PluginInstallController,
      epoch: number,
    ) => Promise<T>,
  ): Promise<T> => {
    assertOpen()
    const epoch = beginAction(kind, pluginId)
    const run = managementTail.then(async () => {
      try {
        const management = await ensureManagement()
        const result = await task(management, epoch)
        finishAction(epoch, kind, pluginId, 'succeeded', '')
        return result
      } catch (cause) {
        finishAction(epoch, kind, pluginId, 'failed', actionFailureDetail(cause))
        throw cause
      }
    })
    managementTail = run.then(() => {}, () => {})
    return run
  }

  const enqueueRuntimeMutation = <T>(
    kind: PluginCompositionActionKind,
    pluginId: string | null,
    task: (
      management: PluginInstallController,
      epoch: number,
    ) => Promise<T>,
  ): Promise<T> => {
    runtimeEpoch++
    activeRuntimeMutations++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      activeRuntimeMutations--
    }
    try {
      return enqueueManagement(kind, pluginId, async (management, epoch) => {
        try {
          return await task(management, epoch)
        } finally {
          release()
        }
      })
    } catch (cause) {
      release()
      throw cause
    }
  }

  const refreshAfterAction = async (
    management: PluginInstallController,
    epoch: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    const projection = await readCoherentManagement(management, signal)
    if (!closed && epoch === operationEpoch) installProjection(projection)
  }

  const closeLoadedRuntime = (reason: string): Promise<void> => {
    if (runtimeDisposalPromise) return runtimeDisposalPromise
    runtimeCloseReason = boundedDetail(reason)
    runtimeEpoch++
    lifecycleEpoch++
    const pendingRuntime = runtimePromise
    void pendingRuntime?.catch(() => {})
    const disposal = (async () => {
      let lifecycleFailure: unknown
      try {
        await lifecycle.dispose()
      } catch (cause) {
        lifecycleFailure = cause
      }
      let pendingRuntimeFailure: unknown
      if (pendingRuntime) {
        try {
          await pendingRuntime
        } catch (cause) {
          if (!isExpectedRuntimeCloseRejection(cause)) pendingRuntimeFailure = cause
        }
      }
      runtimeController = null
      runtimePromise = null
      editorSession = null
      const cleanupFailures = [lifecycleFailure, pendingRuntimeFailure].filter(
        (failure): failure is unknown => failure !== undefined,
      )
      if (cleanupFailures.length > 0) {
        if (!closed) {
          runtimeBlocked = true
          startup.enterSafeMode()
        }
        if (cleanupFailures.length === 1) throw cleanupFailures[0]
        throw new AggregateError(cleanupFailures, 'Plugin runtime cleanup failed')
      }
    })().finally(() => {
      if (runtimeDisposalPromise === disposal) runtimeDisposalPromise = null
    })
    runtimeDisposalPromise = disposal
    return disposal
  }

  const closePendingInspections = async (): Promise<void> => {
    await managementTail
    const management = managementController
    if (!management) return
    const cleanupFailures: unknown[] = []
    for (const inspectionId of pendingInspectionIds) {
      try {
        management.cancelInspection(inspectionId)
        pendingInspectionIds.delete(inspectionId)
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }
    inspection = null
    if (cleanupFailures.length === 1) throw cleanupFailures[0]
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, 'Plugin inspection cleanup failed')
    }
  }

  const invalidateLoadedRuntime = async (pluginId: string, reason: string): Promise<void> => {
    try {
      await runtimeController?.invalidate(pluginId, reason)
    } catch (cause) {
      runtimeBlocked = true
      runtimeEpoch++
      lifecycleEpoch++
      startup.enterSafeMode()
      try {
        await closeLoadedRuntime('runtime-invalidation-failed')
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          'Plugin runtime invalidation and cleanup both failed',
        )
      }
      throw cause
    }
  }

  const invalidateLoadedRuntimeAndRefresh = async (
    management: PluginInstallController,
    epoch: number,
    pluginId: string,
    reason: string,
  ): Promise<void> => {
    let invalidationFailure: unknown
    try {
      await invalidateLoadedRuntime(pluginId, reason)
    } catch (cause) {
      invalidationFailure = cause
    }
    try {
      await refreshAfterAction(management, epoch)
    } catch (refreshFailure) {
      if (invalidationFailure !== undefined) {
        throw new AggregateError(
          [invalidationFailure, refreshFailure],
          'Plugin runtime invalidation and management refresh both failed',
        )
      }
      throw refreshFailure
    }
    if (invalidationFailure !== undefined) throw invalidationFailure
  }

  const applyEditorEffect = async (
    request: PluginEffectBridgeHandlerRequest,
    signal: AbortSignal,
  ): Promise<PluginEffectBridgeHandlerResult> => {
    const expectedRuntimeEpoch = runtimeEpoch
    try {
      assertRuntimeAllowed()
      const runtime = await ensureRuntime()
      assertRuntimeAllowed()
      if (expectedRuntimeEpoch !== runtimeEpoch) return Object.freeze({ status: 'bypassed' })
      const editor = editorSession ??= runtime.openEditorSession()
      const runtimeRequest: PluginEffectApplyRequest = Object.freeze({
        catalogGeneration: request.execution.catalogGeneration,
        pluginId: request.execution.pluginId,
        pluginVersion: request.execution.pluginVersion,
        packageDigest: request.execution.packageDigest,
        signerFingerprint: request.execution.signerFingerprint,
        kind: request.execution.kind,
        contributionId: request.execution.contributionId,
        contributionVersion: request.execution.contributionVersion,
        descriptorVersion: request.execution.descriptorVersion,
        entrypoint: request.execution.entrypoint,
        requestId: request.requestId,
        descriptorId: request.descriptorId,
        canonicalParameterJson: request.execution.canonicalParameterJson,
        timelineFrame: request.timelineFrame,
        frameRateNumerator: request.frameRateNumerator,
        frameRateDenominator: request.frameRateDenominator,
        width: request.width,
        height: request.height,
        stride: request.stride,
        rgbaBytes: request.rgbaBytes,
      })
      const result = await editor.apply(runtimeRequest, signal)
      if (result.status !== 'applied') return Object.freeze({ status: 'bypassed' })
      if (closed
        || runtimeBlocked
        || startup.getSnapshot().mode !== 'normal'
        || expectedRuntimeEpoch !== runtimeEpoch
        || signal.aborted) {
        zeroBytes(result.rgbaBytes)
        return Object.freeze({ status: 'bypassed' })
      }
      if (!(result.rgbaBytes.buffer instanceof ArrayBuffer)
        || result.rgbaBytes.byteOffset !== 0
        || result.rgbaBytes.byteLength !== result.rgbaBytes.buffer.byteLength
        || result.rgbaBytes.byteLength !== request.rgbaBytes.byteLength) {
        zeroBytes(result.rgbaBytes)
        return Object.freeze({ status: 'bypassed' })
      }
      return Object.freeze({
        status: 'applied',
        rgbaBytes: result.rgbaBytes as Uint8Array<ArrayBuffer>,
      })
    } catch {
      return Object.freeze({ status: 'bypassed' })
    }
  }

  const effectBridgeHandler: PluginEffectBridgeHandler = Object.freeze({
    apply: applyEditorEffect,
  })

  const controller: PluginCompositionController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      assertOpen()
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getContributionSnapshot() {
      if (
        closed
        || runtimeBlocked
        || activeRuntimeMutations > 0
        || startup.getSnapshot().mode !== 'normal'
      ) return undefined
      return currentContributionSnapshot ?? undefined
    },
    getEffectBridgeHandler: () => effectBridgeHandler,
    async getDeclarationCatalog(signal) {
      assertRuntimeAllowed()
      const expectedOperationEpoch = operationEpoch
      const expectedRuntimeEpoch = runtimeEpoch
      const management = await ensureManagement()
      assertRuntimeAllowed()
      const catalog = freezeDeclarationCatalog(await management.declarationCatalog(signal))
      assertRuntimeAllowed()
      if (
        expectedOperationEpoch !== operationEpoch
        || expectedRuntimeEpoch !== runtimeEpoch
      ) throw staleRuntimeError()
      return catalog
    },
    refreshManagement(signal) {
      return enqueueManagement('refresh', null, async (management, epoch) => {
        await refreshAfterAction(management, epoch, signal)
      })
    },
    inspectPackage(archiveBytes, signal) {
      return enqueueManagement('inspect', null, async (management, epoch) => {
        const result = await management.inspectPackage(archiveBytes, signal)
        pendingInspectionIds.add(result.inspectionId)
        const projected = freezeInspection(result)
        if (closed || epoch !== operationEpoch) {
          try {
            management.cancelInspection(result.inspectionId)
            pendingInspectionIds.delete(result.inspectionId)
          } catch (cleanupCause) {
            throw new AggregateError(
              [new PluginInstallControllerError(
                'inspection-not-found',
                'Package inspection was superseded by a newer plugin action',
              ), cleanupCause],
              'Plugin package inspection and cleanup both failed',
            )
          }
          throw new PluginInstallControllerError(
            'inspection-not-found',
            'Package inspection was superseded by a newer plugin action',
          )
        }
        inspection = projected
        managementPhase = 'ready'
        managementDetail = ''
        return projected
      })
    },
    cancelInspection(inspectionId) {
      return enqueueManagement('cancel-inspection', null, async (management, epoch) => {
        const cancelled = management.cancelInspection(inspectionId)
        pendingInspectionIds.delete(inspectionId)
        if (epoch === operationEpoch && inspection?.inspectionId === inspectionId) inspection = null
        managementPhase = 'ready'
        managementDetail = ''
        return cancelled
      })
    },
    commitInstallation(inspectionId, options) {
      return enqueueRuntimeMutation(
        'install',
        inspection?.pluginId ?? null,
        async (management, epoch) => {
          const installed = await management.commitInstallation(inspectionId, options)
          pendingInspectionIds.delete(inspectionId)
          await invalidateLoadedRuntimeAndRefresh(
            management,
            epoch,
            installed.pluginId,
            'management-install',
          )
          if (epoch === operationEpoch) inspection = null
        },
      )
    },
    retryPlugin(pluginId) {
      pluginId = validatedPluginId(pluginId)
      return enqueueRuntimeMutation('retry', pluginId, async (management, epoch) => {
        await invalidateLoadedRuntimeAndRefresh(management, epoch, pluginId, 'management-retry')
      })
    },
    enablePlugin(pluginId, signal) {
      pluginId = validatedPluginId(pluginId)
      return enqueueRuntimeMutation('enable', pluginId, async (management, epoch) => {
        await management.enable(pluginId, signal)
        await invalidateLoadedRuntimeAndRefresh(management, epoch, pluginId, 'management-enable')
      })
    },
    disablePlugin(pluginId) {
      pluginId = validatedPluginId(pluginId)
      return enqueueRuntimeMutation('disable', pluginId, async (management, epoch) => {
        await management.disable(pluginId)
        await invalidateLoadedRuntimeAndRefresh(management, epoch, pluginId, 'management-disable')
      })
    },
    setPermissionGrant(pluginId, permissionId, granted, signal) {
      pluginId = validatedPluginId(pluginId)
      return enqueueRuntimeMutation('permission', pluginId, async (management, epoch) => {
        await management.setPermissionGrant(pluginId, permissionId, granted, signal)
        await invalidateLoadedRuntimeAndRefresh(management, epoch, pluginId, 'management-permission')
      })
    },
    quarantinePlugin(pluginId) {
      pluginId = validatedPluginId(pluginId)
      return enqueueRuntimeMutation('quarantine', pluginId, async (management, epoch) => {
        await management.quarantine(pluginId)
        await invalidateLoadedRuntimeAndRefresh(management, epoch, pluginId, 'management-quarantine')
      })
    },
    revokePlugin(pluginId) {
      pluginId = validatedPluginId(pluginId)
      return enqueueRuntimeMutation('revoke', pluginId, async (management, epoch) => {
        await management.revoke(pluginId)
        await invalidateLoadedRuntimeAndRefresh(management, epoch, pluginId, 'management-revoke')
      })
    },
    uninstallPlugin(pluginId) {
      pluginId = validatedPluginId(pluginId)
      return enqueueRuntimeMutation('uninstall', pluginId, async (management, epoch) => {
        const removed = await management.uninstall(pluginId)
        await invalidateLoadedRuntimeAndRefresh(management, epoch, pluginId, 'management-uninstall')
        return removed
      })
    },
    clearDiagnostics(pluginId) {
      pluginId = validatedPluginId(pluginId)
      return enqueueManagement('clear-diagnostics', pluginId, async (management, epoch) => {
        const cleared = await management.clearDiagnostics(pluginId)
        try {
          runtimeController?.clearDiagnostics(pluginId)
        } finally {
          await refreshAfterAction(management, epoch)
        }
        return cleared
      })
    },
    continueWithReviewedNormalStartup() {
      assertOpen()
      const changed = startup.continueWithReviewedNormalStartup()
      if (changed) runtimeBlocked = false
      return changed
    },
    enterSafeMode() {
      assertOpen()
      runtimeBlocked = true
      runtimeEpoch++
      lifecycleEpoch++
      const epoch = ++operationEpoch
      action = Object.freeze({
        epoch,
        kind: 'safe-mode',
        pluginId: null,
        phase: 'pending',
        detail: '',
      })
      const changed = startup.enterSafeMode()
      if (!changed) publish()
      return closeLoadedRuntime('safe-mode').then(() => {
        finishAction(epoch, 'safe-mode', null, 'succeeded', '')
        return changed
      }, (cause: unknown) => {
        finishAction(epoch, 'safe-mode', null, 'failed', actionFailureDetail(cause))
        throw cause
      })
    },
    applyEditorEffect,
    async preflightExport(request, signal) {
      const expectedRuntimeEpoch = runtimeEpoch
      const runtime = await ensureRuntime()
      assertRuntimeAllowed()
      if (expectedRuntimeEpoch !== runtimeEpoch) throw staleRuntimeError()
      const session = await runtime.preflightExport(request, signal)
      try {
        assertRuntimeAllowed()
        if (expectedRuntimeEpoch !== runtimeEpoch) throw staleRuntimeError()
        return session
      } catch (cause) {
        try {
          await session.close('stale-plugin-composition')
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Plugin export preflight and cleanup both failed',
          )
        }
        throw cause
      }
    },
    async preflightDescriptorMigrationAction(request, signal) {
      const expectedRuntimeEpoch = runtimeEpoch
      const runtime = await ensureRuntime()
      assertRuntimeAllowed()
      if (expectedRuntimeEpoch !== runtimeEpoch) throw staleRuntimeError()
      const actionSession = await runtime.preflightDescriptorMigrationAction(request, signal)
      try {
        assertRuntimeAllowed()
        if (expectedRuntimeEpoch !== runtimeEpoch) throw staleRuntimeError()
        return actionSession
      } catch (cause) {
        try {
          await actionSession.close('stale-plugin-composition')
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Plugin migration preflight and cleanup both failed',
          )
        }
        throw cause
      }
    },
    close(reason) {
      if (closed) return terminalClosePromise ?? runtimeDisposalPromise ?? Promise.resolve()
      closed = true
      runtimeBlocked = true
      runtimeEpoch++
      lifecycleEpoch++
      operationEpoch++
      unsubscribeStartup()
      listeners.clear()
      terminalClosePromise = (async () => {
        const [runtimeResult, inspectionResult] = await Promise.allSettled([
          closeLoadedRuntime(reason),
          closePendingInspections(),
        ])
        const cleanupFailures: unknown[] = []
        if (runtimeResult.status === 'rejected') cleanupFailures.push(runtimeResult.reason)
        if (inspectionResult.status === 'rejected') cleanupFailures.push(inspectionResult.reason)
        if (cleanupFailures.length === 1) throw cleanupFailures[0]
        if (cleanupFailures.length > 1) {
          throw new AggregateError(cleanupFailures, 'Plugin composition cleanup failed')
        }
      })()
      return terminalClosePromise
    },
  }
  return Object.freeze(controller)
}
