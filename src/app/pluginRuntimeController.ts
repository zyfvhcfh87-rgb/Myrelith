import type {
  PluginActivationBundleResolver,
  VerifiedPluginActivationBundle,
  VerifiedPluginContribution,
} from './pluginInstallController'
import {
  PLUGIN_EXPORT_DEADLINE_MS,
  PLUGIN_PREVIEW_DEADLINE_MS,
  PluginSandboxError,
  createPluginSandboxController,
  type PluginSandboxController,
  type PluginSandboxSession,
} from './pluginSandboxController'
import {
  createPluginRawModuleCache,
  type PluginRawModuleCache,
  type PluginRawModuleCacheKey,
  type PluginRawModuleCacheSnapshot,
} from './pluginRawModuleCache'
import type {
  PluginRuntimeFailure,
  PluginRuntimeFailureCode,
} from '../workers/plugin-runtime-protocol'
import {
  PLUGIN_IO_PAGE_BYTES,
  PLUGIN_PIXEL_POINTER,
} from '../workers/plugin-runtime-protocol'
import { PLUGIN_WASM_OPCODE_TABLE_DIGESTS } from '../workers/plugin-wasm/policyTables'
import type { PluginWasmProfileSelection } from '../domain/pluginWasmPolicy'
import type { PluginRuntimeLifecycleObserver } from './pluginRuntimeLifecycleObserver'

const MAX_RESIDENT_RUNTIMES = 8
const MAX_ACTIVE_CALLS = 2
const MAX_QUEUED_CALLS = 32
const FAILURE_DISABLE_THRESHOLD = 3
const MAX_DIAGNOSTIC_PLUGINS = 64
const MAX_DIAGNOSTICS_PER_PLUGIN = 100
const MAX_MESSAGE_LENGTH = 512

export interface PluginExecutionIdentity {
  readonly catalogGeneration: number
  readonly pluginId: string
  readonly pluginVersion: string
  readonly packageDigest: string
  readonly signerFingerprint: string
  readonly kind: 'video-effect'
  readonly contributionId: string
  readonly contributionVersion: number
  readonly descriptorVersion: number
  readonly entrypoint: string
}

export interface PluginEffectApplyRequest extends PluginExecutionIdentity {
  readonly requestId: number
  readonly descriptorId: string
  readonly canonicalParameterJson: string
  readonly timelineFrame: number
  readonly frameRateNumerator: number
  readonly frameRateDenominator: number
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly rgbaBytes: Uint8Array
}

export type PluginEffectApplyResult =
  | {
    readonly status: 'applied'
    readonly effectResult: 'mutated' | 'identity'
    readonly rgbaBytes: Uint8Array
  }
  | {
    readonly status: 'failed'
    readonly failure: PluginRuntimeFailure
  }

export interface PluginEditorSession {
  apply(request: PluginEffectApplyRequest, signal?: AbortSignal): Promise<PluginEffectApplyResult>
  close(reason: string): Promise<void>
}

export interface PluginExportEffectRequirement extends PluginExecutionIdentity {
  /** Exact largest straight-RGBA8 surface this effect can receive in this export. */
  readonly maximumSurfaceWidth: number
  readonly maximumSurfaceHeight: number
  readonly maximumSurfaceStride: number
  readonly maximumSurfaceByteLength: number
}

export interface PluginExportPreflightRequest {
  readonly requiredEffects: readonly PluginExportEffectRequirement[]
}

export interface PluginExportPreflightFailure {
  readonly pluginId: string
  readonly failure: PluginRuntimeFailure
}

export interface PluginExportSession {
  apply(request: PluginEffectApplyRequest, signal?: AbortSignal): Promise<PluginEffectApplyResult>
  close(reason: string): Promise<void>
}

export interface PluginDescriptorMigrationChainRequest extends PluginExecutionIdentity {
  readonly fromDescriptorVersion: number
  readonly canonicalParameterJson: string
  readonly hasAnimatedParameters: boolean
}

export interface PluginDescriptorMigrationTargetRequest
  extends PluginDescriptorMigrationChainRequest {
  /** Stable app-owned locator, unique inside one ordered migration action. */
  readonly descriptorId: string
}

export interface PluginDescriptorMigrationActionPreflightRequest {
  /** Frozen stable document order: track, clip, then effect-stack order. */
  readonly targets: readonly PluginDescriptorMigrationTargetRequest[]
}

export interface PluginDescriptorMigrationActionApplyRequest {
  readonly targetIndex: number
  readonly requestId: number
}

export interface PluginDescriptorMigrationApplyRequest {
  readonly requestId: number
}

export type PluginDescriptorMigrationResult =
  | {
    readonly status: 'migrated'
    readonly descriptorVersion: number
    readonly canonicalParameterJson: string
    readonly parameters: Readonly<Record<string, boolean | number | string>>
  }
  | {
    readonly status: 'failed'
    readonly failure: PluginRuntimeFailure
  }

export interface PluginDescriptorMigrationChainSession {
  apply(
    request: PluginDescriptorMigrationApplyRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationResult>
  close(reason: string): Promise<void>
}

export interface PluginDescriptorMigrationActionSession {
  applyTarget(
    request: PluginDescriptorMigrationActionApplyRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationResult>
  close(reason: string): Promise<void>
}

export interface PluginRuntimeDiagnostic {
  readonly sequence: number
  readonly pluginId: string
  readonly phase: 'activation' | 'editor' | 'export' | 'migration' | 'lifecycle'
  readonly code: PluginRuntimeFailureCode
  readonly message: string
  readonly requestId?: number
}

export interface PluginRuntimeSnapshot {
  readonly activeCallCount: number
  readonly queuedCallCount: number
  readonly liveOwnerCount: number
  readonly residentRuntimeCount: number
  readonly cache: PluginRawModuleCacheSnapshot
  readonly diagnostics: readonly PluginRuntimeDiagnostic[]
}

export interface PluginRuntimeController {
  openEditorSession(): PluginEditorSession
  preflightExport(
    request: PluginExportPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginExportSession>
  openDescriptorMigrationChain(
    request: PluginDescriptorMigrationChainRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationChainSession>
  preflightDescriptorMigrationAction(
    request: PluginDescriptorMigrationActionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationActionSession>
  getSnapshot(): PluginRuntimeSnapshot
  /** Drop only retained in-memory runtime diagnostics for one exact plugin. */
  clearDiagnostics(pluginId: string): void
  invalidate(pluginId: string, reason: string): Promise<void>
  teardown(reason: string): Promise<void>
}

export class PluginRuntimeError extends Error {
  readonly failure: PluginRuntimeFailure

  constructor(failure: PluginRuntimeFailure) {
    super(failure.message)
    this.name = 'PluginRuntimeError'
    this.failure = failure
  }
}

/** Complete host-authored export activation failures in first-plugin order. */
export class PluginExportPreflightError extends PluginRuntimeError {
  readonly failures: readonly PluginExportPreflightFailure[]

  constructor(failures: readonly PluginExportPreflightFailure[]) {
    if (failures.length === 0) {
      throw new TypeError('Plugin export preflight requires at least one failure')
    }
    super(failures[0].failure)
    this.name = 'PluginExportPreflightError'
    this.failures = Object.freeze(failures.map(({ pluginId, failure }) => Object.freeze({
      pluginId,
      failure,
    })))
  }
}

interface RuntimeEntry {
  readonly pluginId: string
  readonly identityKey: string
  readonly session: PluginSandboxSession
  lastUsed: number
  activeCalls: number
  pinned: boolean
  readonly reservation: RuntimeReservation | null
}

interface RuntimeReservation {
  occupied: boolean
  closed: boolean
}

interface RuntimeOwner {
  readonly entries: Map<string, RuntimeEntry>
  withEntry<T>(
    bundle: VerifiedPluginActivationBundle,
    signal: AbortSignal | undefined,
    task: (entry: RuntimeEntry) => Promise<T>,
  ): Promise<T>
  pinBundles(
    bundles: readonly VerifiedPluginActivationBundle[],
    signal: AbortSignal | undefined,
  ): Promise<readonly PluginExportPreflightFailure[]>
  invalidate(pluginId: string, reason: string): Promise<void>
  close(reason: string): Promise<void>
}

interface ScheduledCall {
  readonly pluginId: string
  readonly task: () => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: PluginRuntimeError) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

function hostFailure(
  code: PluginRuntimeFailureCode,
  message: string,
  terminal = true,
  pluginCode?: number,
): PluginRuntimeFailure {
  const bounded = message.slice(0, MAX_MESSAGE_LENGTH)
  return Object.freeze(pluginCode === undefined
    ? { code, message: bounded, terminal }
    : { code, message: bounded, terminal, pluginCode })
}

const FAILURE_MESSAGES: Readonly<Record<PluginRuntimeFailureCode, string>> = Object.freeze({
  aborted: 'The plugin operation was cancelled.',
  'activation-failed': 'The plugin could not be activated.',
  busy: 'The plugin runtime is busy.',
  closed: 'The plugin runtime is closed.',
  crashed: 'The plugin runtime stopped unexpectedly.',
  'invalid-envelope': 'The plugin runtime returned an invalid message.',
  'invalid-input': 'The plugin request did not satisfy the runtime contract.',
  'invalid-output': 'The plugin returned invalid output.',
  'plugin-failure': 'The plugin reported a runtime failure.',
  'queue-full': 'The plugin runtime queue is full.',
  'session-disabled': 'The plugin is disabled for this editor session after repeated failures.',
  'stale-plan': 'The plugin plan no longer matches the installed package.',
  'stale-request': 'A newer preview request replaced this plugin request.',
  'stale-generation': 'The plugin runtime generation is stale.',
  timeout: 'The plugin operation exceeded its watchdog deadline.',
})

function publicFailure(value: unknown): PluginRuntimeFailure {
  if (value instanceof PluginRuntimeError) return value.failure
  if (value instanceof PluginSandboxError) {
    return hostFailure(
      value.failure.code,
      FAILURE_MESSAGES[value.failure.code],
      value.failure.terminal,
      value.failure.pluginCode,
    )
  }
  return hostFailure('crashed', FAILURE_MESSAGES.crashed)
}

const STALE_RESOLUTION_CODES = new Set([
  'disabled',
  'incompatible',
  'install-conflict',
  'permission-denied',
  'quarantined',
  'revoked',
  'safe-mode',
])

function resolutionFailure(value: unknown): PluginRuntimeFailure {
  if (value instanceof PluginRuntimeError || value instanceof PluginSandboxError) {
    return publicFailure(value)
  }
  if (value instanceof DOMException && value.name === 'AbortError') {
    return hostFailure('aborted', FAILURE_MESSAGES.aborted)
  }
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { readonly code?: unknown }).code
    if (code === 'aborted') return hostFailure('aborted', FAILURE_MESSAGES.aborted)
    if (typeof code === 'string' && STALE_RESOLUTION_CODES.has(code)) {
      return hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan'])
    }
    return hostFailure('activation-failed', FAILURE_MESSAGES['activation-failed'])
  }
  return hostFailure('activation-failed', FAILURE_MESSAGES['activation-failed'])
}

function selectedPolicy(bundle: VerifiedPluginActivationBundle): PluginWasmProfileSelection {
  return Object.freeze({
    binaryPolicyVersion: 1,
    profileId: bundle.contributions.some((contribution) => contribution.migrations.length > 0)
      ? 'myrelith-wasm-migration-integer-v1'
      : 'myrelith-wasm-render-general-v1',
  })
}

function contributionIdentityKey(bundle: VerifiedPluginActivationBundle): string {
  return JSON.stringify(bundle.contributions.map((contribution) => [
    contribution.kind,
    contribution.id,
    contribution.contributionVersion,
    contribution.descriptorVersion,
    contribution.entrypoint,
    contribution.migrations.map((migration) => [
      migration.fromVersion,
      migration.toVersion,
      migration.entrypoint,
    ]),
  ]))
}

function cacheKey(bundle: VerifiedPluginActivationBundle): PluginRawModuleCacheKey {
  const policy = selectedPolicy(bundle)
  const permission = bundle.profile.permissions.find(
    (candidate) => candidate.id === 'myrelith.effect.video-frame.rgba8',
  )
  if (!permission) throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
  return {
    pluginId: bundle.pluginId,
    pluginVersion: bundle.version,
    packageDigest: bundle.packageDigest,
    signerFingerprint: bundle.signerFingerprint,
    modulePath: bundle.modulePath,
    moduleSha256: bundle.moduleSha256,
    moduleByteLength: bundle.moduleByteLength,
    hostApiVersion: bundle.profile.apiVersion,
    selectedCapabilities: [...bundle.profile.permissions]
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version)
      .map((selected) => Object.freeze({ id: selected.id, version: selected.version })),
    memoryMaximumPages: bundle.profile.memoryMaximumPages,
    policy,
    opcodeTableDigest: PLUGIN_WASM_OPCODE_TABLE_DIGESTS[policy.profileId],
    contributionIdentityKey: contributionIdentityKey(bundle),
  }
}

function matchBundle(
  identity: PluginExecutionIdentity,
  bundle: VerifiedPluginActivationBundle,
): VerifiedPluginContribution {
  const contribution = bundle.contributions.find((candidate) => candidate.id === identity.contributionId)
  if (bundle.catalogGeneration !== identity.catalogGeneration
    || bundle.pluginId !== identity.pluginId
    || bundle.version !== identity.pluginVersion
    || bundle.packageDigest !== identity.packageDigest
    || bundle.signerFingerprint !== identity.signerFingerprint
    || !contribution
    || contribution.kind !== identity.kind
    || contribution.contributionVersion !== identity.contributionVersion
    || contribution.descriptorVersion !== identity.descriptorVersion
    || contribution.entrypoint !== identity.entrypoint) {
    throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
  }
  return contribution
}

function executionIdentityKey(identity: PluginExecutionIdentity): string {
  return JSON.stringify([
    identity.catalogGeneration,
    identity.pluginId,
    identity.pluginVersion,
    identity.packageDigest,
    identity.signerFingerprint,
    identity.kind,
    identity.contributionId,
    identity.contributionVersion,
    identity.descriptorVersion,
    identity.entrypoint,
  ])
}

function assertExportSurfaceCapacity(
  requirement: PluginExportEffectRequirement,
  bundle: VerifiedPluginActivationBundle,
): void {
  const expectedStride = requirement.maximumSurfaceWidth * 4
  const expectedLength = expectedStride * requirement.maximumSurfaceHeight
  const pixelCapacity = bundle.profile.memoryMaximumPages * PLUGIN_IO_PAGE_BYTES
    - PLUGIN_PIXEL_POINTER
  if (!Number.isSafeInteger(requirement.maximumSurfaceWidth)
    || !Number.isSafeInteger(requirement.maximumSurfaceHeight)
    || !Number.isSafeInteger(requirement.maximumSurfaceStride)
    || !Number.isSafeInteger(requirement.maximumSurfaceByteLength)
    || requirement.maximumSurfaceWidth < 1
    || requirement.maximumSurfaceHeight < 1
    || requirement.maximumSurfaceStride !== expectedStride
    || requirement.maximumSurfaceByteLength !== expectedLength
    || !Number.isSafeInteger(expectedLength)
    || !Number.isSafeInteger(pixelCapacity)
    || pixelCapacity < 0
    || expectedLength > pixelCapacity) {
    throw new PluginRuntimeError(hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']))
  }
}

function canonicalBytes(canonicalParameterJson: string): Uint8Array {
  if (typeof canonicalParameterJson !== 'string') {
    throw new PluginRuntimeError(hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']))
  }
  const bytes = new TextEncoder().encode(canonicalParameterJson)
  if (bytes.byteLength < 2
    || bytes.byteLength > 65_536
    || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    throw new PluginRuntimeError(hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']))
  }
  return bytes
}

function linkedAbortSignal(
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  const onAbort = (): void => controller.abort()
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of active) signal.removeEventListener('abort', onAbort)
    },
  }
}

export function createPluginRuntimeController(options: {
  readonly activationBundleResolver: PluginActivationBundleResolver
  readonly sandboxController?: PluginSandboxController
  readonly rawModuleCache?: PluginRawModuleCache
  readonly lifecycleObserver?: PluginRuntimeLifecycleObserver
}): PluginRuntimeController {
  const resolver = options.activationBundleResolver
  const sandboxController = options.sandboxController ?? createPluginSandboxController({
    lifecycleObserver: options.lifecycleObserver,
  })
  const rawModuleCache = options.rawModuleCache ?? createPluginRawModuleCache()
  const owners = new Set<RuntimeOwner>()
  const migrationReservations = new Set<RuntimeReservation>()
  const diagnosticsByPlugin = new Map<string, PluginRuntimeDiagnostic[]>()
  const diagnosticPluginAccess = new Map<string, number>()
  const scheduledCalls: ScheduledCall[] = []
  const activePlugins = new Set<string>()
  const invalidationEpochByPlugin = new Map<string, number>()
  const activeCallSettlements = new Set<Promise<void>>()
  let lifecycleTail = Promise.resolve()
  let diagnosticSequence = 0
  let ownerUsageSequence = 0
  let activeCallCount = 0
  let tornDown = false
  let terminalSnapshotEmitted = false
  let teardownPromise: Promise<void> | null = null
  const controllerAbort = new AbortController()

  const emitLifecycle = (terminal = false): void => {
    if (!options.lifecycleObserver || (terminal && terminalSnapshotEmitted)) return
    const cache = rawModuleCache.getSnapshot()
    const snapshot = Object.freeze({
      queuedCallCount: scheduledCalls.length,
      activeCallCount,
      liveOwnerCount: owners.size,
      migrationReservationCount: migrationReservations.size,
      residentRuntimeCount: [...owners].reduce(
        (count, owner) => count + owner.entries.size,
        0,
      ),
      rawCacheEntryCount: cache.entryCount,
      rawCacheByteLength: cache.byteLength,
      terminal,
    })
    if (terminal && Object.entries(snapshot).some(([key, value]) => (
      key !== 'terminal' && value !== 0
    ))) {
      throw new Error('Plugin runtime terminal lifecycle snapshot requires zero ownership')
    }
    if (terminal) terminalSnapshotEmitted = true
    try {
      options.lifecycleObserver.onRuntimeSnapshot(snapshot)
    } catch {
      // The injection-only observer never participates in runtime outcomes.
    }
  }

  emitLifecycle()

  const recordDiagnostic = (
    pluginId: string,
    phase: PluginRuntimeDiagnostic['phase'],
    runtimeFailure: PluginRuntimeFailure,
    requestId?: number,
  ): void => {
    diagnosticSequence++
    diagnosticPluginAccess.set(pluginId, diagnosticSequence)
    let values = diagnosticsByPlugin.get(pluginId)
    if (!values) {
      if (diagnosticsByPlugin.size >= MAX_DIAGNOSTIC_PLUGINS) {
        let oldestPlugin: string | undefined
        let oldestSequence = Number.POSITIVE_INFINITY
        for (const [candidate, sequence] of diagnosticPluginAccess) {
          if (sequence < oldestSequence
            || (sequence === oldestSequence && candidate.localeCompare(oldestPlugin ?? '') < 0)) {
            oldestPlugin = candidate
            oldestSequence = sequence
          }
        }
        if (oldestPlugin !== undefined) {
          diagnosticsByPlugin.delete(oldestPlugin)
          diagnosticPluginAccess.delete(oldestPlugin)
        }
      }
      values = []
      diagnosticsByPlugin.set(pluginId, values)
    }
    values.push(Object.freeze({
      sequence: diagnosticSequence,
      pluginId,
      phase,
      code: runtimeFailure.code,
      message: FAILURE_MESSAGES[runtimeFailure.code].slice(0, MAX_MESSAGE_LENGTH),
      ...(requestId === undefined ? {} : { requestId }),
    }))
    if (values.length > MAX_DIAGNOSTICS_PER_PLUGIN) values.splice(0, values.length - MAX_DIAGNOSTICS_PER_PLUGIN)
  }

  function dispatchScheduledCalls(): void {
    while (activeCallCount < MAX_ACTIVE_CALLS) {
      const index = scheduledCalls.findIndex((call) => !activePlugins.has(call.pluginId))
      if (index < 0) return
      const [call] = scheduledCalls.splice(index, 1)
      emitLifecycle()
      if (call.signal?.aborted) {
        call.signal.removeEventListener('abort', call.onAbort!)
        call.reject(new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted)))
        continue
      }
      startScheduledCall(call)
    }
  }

  function startScheduledCall(call: ScheduledCall): void {
    call.signal?.removeEventListener('abort', call.onAbort!)
    activeCallCount++
    activePlugins.add(call.pluginId)
    emitLifecycle()
    const settlement = Promise.resolve()
      .then(call.task)
      .then(call.resolve, (cause) => call.reject(
        cause instanceof PluginRuntimeError
          ? cause
          : new PluginRuntimeError(publicFailure(cause)),
      ))
      .finally(() => {
        activeCallCount--
        activePlugins.delete(call.pluginId)
        activeCallSettlements.delete(settlement)
        emitLifecycle()
        dispatchScheduledCalls()
      })
    activeCallSettlements.add(settlement)
  }

  const runBounded = <T>(
    pluginId: string,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> => {
    if (tornDown) return Promise.reject(
      new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed)),
    )
    if (signal?.aborted) return Promise.reject(
      new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted)),
    )
    return new Promise<T>((resolve, reject) => {
      let call!: ScheduledCall
      const onAbort = signal ? (): void => {
        const index = scheduledCalls.indexOf(call)
        if (index < 0) return
        scheduledCalls.splice(index, 1)
        emitLifecycle()
        signal!.removeEventListener('abort', onAbort!)
        reject(new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted)))
        dispatchScheduledCalls()
      } : undefined
      call = {
        pluginId,
        signal,
        onAbort,
        task,
        resolve: (value) => resolve(value as T),
        reject,
      }
      if (activeCallCount < MAX_ACTIVE_CALLS && !activePlugins.has(pluginId)) {
        startScheduledCall(call)
        return
      }
      if (scheduledCalls.length >= MAX_QUEUED_CALLS) {
        reject(new PluginRuntimeError(hostFailure(
          'queue-full',
          FAILURE_MESSAGES['queue-full'],
          false,
        )))
        return
      }
      scheduledCalls.push(call)
      emitLifecycle()
      signal?.addEventListener('abort', onAbort!, { once: true })
    })
  }

  function waitForPromise(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    if (!signal) return promise.then(() => undefined)
    if (signal.aborted) {
      return Promise.reject(new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted)))
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted)))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      )
    })
  }

  const withLifecycle = async <T>(
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = lifecycleTail.catch(() => undefined)
    let releaseLifecycle!: () => void
    const lifecycleGate = new Promise<void>((resolve) => { releaseLifecycle = resolve })
    const chain = previous.then(() => lifecycleGate)
    lifecycleTail = chain
    try {
      await waitForPromise(previous, signal)
      return await task()
    } finally {
      releaseLifecycle()
      if (lifecycleTail === chain) lifecycleTail = Promise.resolve()
    }
  }

  const removeEntryUnlocked = async (
    owner: RuntimeOwner,
    pluginId: string,
    reason: string,
  ): Promise<void> => {
    const entry = owner.entries.get(pluginId)
    if (!entry) return
    try {
      await entry.session.close(reason)
    } finally {
      if (owner.entries.get(pluginId) === entry) owner.entries.delete(pluginId)
      if (entry.reservation) entry.reservation.occupied = false
      emitLifecycle()
    }
  }

  const residentEntries = (): Array<{
    readonly owner: RuntimeOwner
    readonly entry: RuntimeEntry
  }> => (
    [...owners].flatMap((candidateOwner) => (
      [...candidateOwner.entries.values()].map((candidate) => ({
        owner: candidateOwner,
        entry: candidate,
      }))
    ))
  )

  const reserveCapacityUnlocked = async (newEntryCount: number): Promise<void> => {
    const residents = residentEntries()
    const ordinaryResidents = residents.filter((candidate) => (
      candidate.entry.reservation === null
    ))
    const occupiedSlots = ordinaryResidents.length + migrationReservations.size
    const evictionCount = Math.max(0, occupiedSlots + newEntryCount - MAX_RESIDENT_RUNTIMES)
    if (evictionCount === 0) return
    const candidates = ordinaryResidents
      .filter((candidate) => candidate.entry.activeCalls === 0 && !candidate.entry.pinned)
      .sort((left, right) => (
        left.entry.lastUsed - right.entry.lastUsed
          || left.entry.pluginId.localeCompare(right.entry.pluginId)
      ))
    if (candidates.length < evictionCount) {
      throw new PluginRuntimeError(hostFailure('busy', FAILURE_MESSAGES.busy, false))
    }
    for (const eviction of candidates.slice(0, evictionCount)) {
      await removeEntryUnlocked(eviction.owner, eviction.entry.pluginId, 'runtime-lru-eviction')
    }
  }

  const exactBundleIdentityKey = (bundle: VerifiedPluginActivationBundle): string => (
    JSON.stringify([
      bundle.catalogGeneration,
      cacheKey(bundle),
    ])
  )

  const createOwner = (reservation: RuntimeReservation | null = null): RuntimeOwner => {
    const entries = new Map<string, RuntimeEntry>()
    const pinnedIdentities = new Map<string, string>()
    let closed = false
    let owner!: RuntimeOwner

    const activateUnlocked = async (
      bundle: VerifiedPluginActivationBundle,
      signal: AbortSignal | undefined,
      pin: boolean,
      capacityReserved: boolean,
    ): Promise<RuntimeEntry> => {
      if (closed || tornDown) {
        throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
      }
      if (reservation?.closed) {
        throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
      }
      if (signal?.aborted) {
        throw new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted))
      }
      const expectedIdentityKey = exactBundleIdentityKey(bundle)
      const expectedPinnedIdentity = pinnedIdentities.get(bundle.pluginId)
      const existing = entries.get(bundle.pluginId)
      if (expectedPinnedIdentity !== undefined
        && (expectedPinnedIdentity !== expectedIdentityKey
          || existing?.identityKey !== expectedIdentityKey)) {
        throw new PluginRuntimeError(hostFailure(
          'stale-generation',
          FAILURE_MESSAGES['stale-generation'],
        ))
      }
      if (existing?.identityKey === expectedIdentityKey) {
        existing.lastUsed = ++ownerUsageSequence
        if (pin) {
          existing.pinned = true
          pinnedIdentities.set(bundle.pluginId, expectedIdentityKey)
        }
        return existing
      }
      if (existing) {
        await removeEntryUnlocked(owner, bundle.pluginId, 'activation-identity-changed')
      }
      if (!capacityReserved) await reserveCapacityUnlocked(1)
      if (reservation?.occupied) {
        throw new PluginRuntimeError(hostFailure('busy', FAILURE_MESSAGES.busy, false))
      }

      const exactCacheKey = cacheKey(bundle)
      const cachedModuleBytes = rawModuleCache.get(exactCacheKey)
      let moduleBytes: Uint8Array
      if (cachedModuleBytes) {
        moduleBytes = cachedModuleBytes
      } else {
        // Every caller must match the immutable bundle before reaching this byte boundary.
        moduleBytes = bundle.copyModuleBytes()
        if (!(moduleBytes instanceof Uint8Array)
          || moduleBytes.byteOffset !== 0
          || moduleBytes.buffer.byteLength !== moduleBytes.byteLength
          || Object.prototype.toString.call(moduleBytes.buffer) !== '[object ArrayBuffer]'
          || moduleBytes.byteLength !== exactCacheKey.moduleByteLength) {
          throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
        }
        rawModuleCache.put(exactCacheKey, moduleBytes)
        emitLifecycle()
      }
      if (moduleBytes.byteLength !== exactCacheKey.moduleByteLength) {
        throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
      }
      let session: PluginSandboxSession
      try {
        session = await sandboxController.activate({
          moduleBytes,
          expectations: {
            policy: exactCacheKey.policy,
            opcodeTableDigest: exactCacheKey.opcodeTableDigest,
            memoryMaximumPages: exactCacheKey.memoryMaximumPages,
            renderEntrypoints: bundle.contributions.map((contribution) => contribution.entrypoint),
            migrationEntrypoints: bundle.contributions.flatMap(
              (contribution) => contribution.migrations.map((migration) => migration.entrypoint),
            ),
          },
        }, signal)
      } finally {
        moduleBytes.fill(0)
      }
      if (closed || tornDown) {
        await session.close('owner-closed-during-activation')
        throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
      }
      const activated: RuntimeEntry = {
        pluginId: bundle.pluginId,
        identityKey: expectedIdentityKey,
        session,
        lastUsed: ++ownerUsageSequence,
        activeCalls: 0,
        pinned: pin,
        reservation,
      }
      entries.set(bundle.pluginId, activated)
      if (reservation) reservation.occupied = true
      if (pin) pinnedIdentities.set(bundle.pluginId, expectedIdentityKey)
      emitLifecycle()
      return activated
    }

    const removeEntry = (pluginId: string, reason: string): Promise<void> => withLifecycle(
      undefined,
      () => removeEntryUnlocked(owner, pluginId, reason),
    )

    owner = {
      entries,
      async withEntry(bundle, signal, task) {
        const entry = await withLifecycle(signal, async () => {
          const activated = await activateUnlocked(
            bundle,
            signal,
            reservation !== null,
            reservation !== null,
          )
          activated.activeCalls++
          return activated
        })
        try {
          return await task(entry)
        } finally {
          entry.activeCalls--
          entry.lastUsed = ++ownerUsageSequence
        }
      },
      async pinBundles(bundles, signal) {
        return withLifecycle(signal, async () => {
          if (closed || tornDown) {
            throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
          }
          const unique = new Map<string, VerifiedPluginActivationBundle>()
          for (const bundle of bundles) unique.set(bundle.pluginId, bundle)
          if (unique.size > MAX_RESIDENT_RUNTIMES) {
            throw new PluginRuntimeError(hostFailure('busy', FAILURE_MESSAGES.busy, false))
          }
          const newEntryCount = [...unique.values()].filter((bundle) => (
            entries.get(bundle.pluginId)?.identityKey !== exactBundleIdentityKey(bundle)
          )).length
          // Check and make room for the entire export attempt before copying or
          // activating any of its modules. The lifecycle lock holds the reservation.
          await reserveCapacityUnlocked(newEntryCount)
          const failures: PluginExportPreflightFailure[] = []
          for (const bundle of unique.values()) {
            try {
              await activateUnlocked(bundle, signal, true, true)
            } catch (cause) {
              const failure = resolutionFailure(cause)
              failures.push(Object.freeze({ pluginId: bundle.pluginId, failure }))
              if (failure.code === 'aborted' || failure.code === 'closed') break
            }
          }
          if (failures.length > 0) {
            closed = true
            const closing = [...entries.values()].map((entry) => (
              entry.session.close('export-preflight-rollback')
            ))
            await Promise.allSettled(closing)
            entries.clear()
            pinnedIdentities.clear()
            owners.delete(owner)
            emitLifecycle()
          }
          return Object.freeze(failures)
        })
      },
      invalidate: removeEntry,
      async close(reason: string) {
        await withLifecycle(undefined, async () => {
          if (closed) return
          closed = true
          const closing = [...entries.values()].map((entry) => entry.session.close(reason))
          const settled = await Promise.allSettled(closing)
          entries.clear()
          pinnedIdentities.clear()
          owners.delete(owner)
          if (reservation) reservation.occupied = false
          emitLifecycle()
          const rejected = settled.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          )
          if (rejected) throw rejected.reason
        })
      },
    }
    owners.add(owner)
    emitLifecycle()
    return owner
  }

  const reserveMigrationSlot = (signal?: AbortSignal): Promise<RuntimeReservation> => (
    withLifecycle(signal, async () => {
      if (tornDown) {
        throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
      }
      if (signal?.aborted) {
        throw new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted))
      }
      await reserveCapacityUnlocked(1)
      const reservation: RuntimeReservation = { occupied: false, closed: false }
      migrationReservations.add(reservation)
      emitLifecycle()
      return reservation
    })
  )

  const releaseMigrationSlot = (
    reservation: RuntimeReservation,
  ): Promise<void> => withLifecycle(undefined, async () => {
    if (reservation.closed) return
    reservation.closed = true
    reservation.occupied = false
    migrationReservations.delete(reservation)
    emitLifecycle()
  })

  const applyWithBundle = async (
    owner: RuntimeOwner,
    bundle: VerifiedPluginActivationBundle,
    request: PluginEffectApplyRequest,
    phase: 'editor' | 'export',
    signal?: AbortSignal,
  ): Promise<PluginEffectApplyResult> => {
    try {
      matchBundle(request, bundle)
      const expectedLength = request.stride * request.height
      const pixelCapacity = bundle.profile.memoryMaximumPages * PLUGIN_IO_PAGE_BYTES
        - PLUGIN_PIXEL_POINTER
      if (!Number.isSafeInteger(expectedLength)
        || !Number.isSafeInteger(pixelCapacity)
        || pixelCapacity < 0
        || !Number.isSafeInteger(request.width)
        || !Number.isSafeInteger(request.height)
        || !Number.isSafeInteger(request.stride)
        || request.width < 1
        || request.height < 1
        || request.stride !== request.width * 4
        || !(request.rgbaBytes instanceof Uint8Array)
        || request.rgbaBytes.byteOffset !== 0
        || request.rgbaBytes.buffer.byteLength !== request.rgbaBytes.byteLength
        || Object.prototype.toString.call(request.rgbaBytes.buffer) !== '[object ArrayBuffer]'
        || request.rgbaBytes.byteLength !== expectedLength
        || request.rgbaBytes.byteLength > pixelCapacity
        || !Number.isSafeInteger(request.timelineFrame)
        || request.timelineFrame < 0
        || !Number.isSafeInteger(request.frameRateNumerator)
        || !Number.isSafeInteger(request.frameRateDenominator)
        || request.frameRateNumerator < 1
        || request.frameRateDenominator < 1
        || !Number.isSafeInteger(request.requestId)
        || request.requestId < 0) {
        throw new PluginRuntimeError(hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']))
      }
      // The planner owns canonicalization. Runtime performs this one exact UTF-8 encoding only.
      const parameterBytes = canonicalBytes(request.canonicalParameterJson)
      let result: { readonly identity: boolean; readonly rgbaBytes: Uint8Array }
      try {
        result = await owner.withEntry(bundle, signal, (entry) => entry.session.render({
          entrypoint: request.entrypoint,
          width: request.width,
          height: request.height,
          stride: request.stride,
          timelineFrame: request.timelineFrame,
          frameRateNumerator: request.frameRateNumerator,
          frameRateDenominator: request.frameRateDenominator,
          canonicalParameterBytes: parameterBytes,
          rgbaBytes: request.rgbaBytes,
        }, phase === 'editor' ? PLUGIN_PREVIEW_DEADLINE_MS : PLUGIN_EXPORT_DEADLINE_MS, signal))
      } finally {
        parameterBytes.fill(0)
      }
      if (result.rgbaBytes.byteLength !== request.rgbaBytes.byteLength) {
        throw new PluginRuntimeError(hostFailure('invalid-output', FAILURE_MESSAGES['invalid-output']))
      }
      return Object.freeze({
        status: 'applied',
        effectResult: result.identity ? 'identity' : 'mutated',
        rgbaBytes: result.rgbaBytes,
      })
    } catch (cause) {
      const runtimeFailure = publicFailure(cause)
      recordDiagnostic(request.pluginId, phase, runtimeFailure, request.requestId)
      if (runtimeFailure.terminal) await owner.invalidate(request.pluginId, runtimeFailure.code)
      return Object.freeze({ status: 'failed', failure: runtimeFailure })
    }
  }

  const openEditorSession = (): PluginEditorSession => {
    if (tornDown) throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
    const owner = createOwner()
    const latestByDescriptor = new Map<string, { requestId: number; abort: AbortController }>()
    const lastRequestIdByDescriptor = new Map<string, number>()
    const consecutiveFailures = new Map<string, number>()
    const disabledPlugins = new Set<string>()
    const resolvedBundles = new Map<string, {
      readonly bundle: VerifiedPluginActivationBundle
      readonly invalidationEpoch: number
    }>()
    let closed = false

    return {
      async apply(request, signal) {
        if (closed) return Object.freeze({
          status: 'failed',
          failure: hostFailure('closed', FAILURE_MESSAGES.closed),
        })
        if (disabledPlugins.has(request.pluginId)) return Object.freeze({
          status: 'failed',
          failure: hostFailure('session-disabled', FAILURE_MESSAGES['session-disabled'], false),
        })
        if (typeof request.descriptorId !== 'string'
          || request.descriptorId.length === 0
          || request.descriptorId.length > 128
          || !Number.isSafeInteger(request.requestId)
          || request.requestId < 0) {
          const runtimeFailure = hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input'])
          recordDiagnostic(request.pluginId, 'editor', runtimeFailure, request.requestId)
          return Object.freeze({ status: 'failed', failure: runtimeFailure })
        }
        const lastRequestId = lastRequestIdByDescriptor.get(request.descriptorId)
        if (lastRequestId !== undefined && request.requestId <= lastRequestId) return Object.freeze({
          status: 'failed',
          failure: hostFailure('stale-request', FAILURE_MESSAGES['stale-request'], false),
        })
        lastRequestIdByDescriptor.set(request.descriptorId, request.requestId)
        const previous = latestByDescriptor.get(request.descriptorId)
        previous?.abort.abort()
        const latest = { requestId: request.requestId, abort: new AbortController() }
        latestByDescriptor.set(request.descriptorId, latest)
        const linked = linkedAbortSignal([signal, latest.abort.signal, controllerAbort.signal])
        let result: PluginEffectApplyResult
        try {
          result = await runBounded(request.pluginId, linked.signal, async () => {
            let bundle: VerifiedPluginActivationBundle
            try {
              const invalidationEpoch = invalidationEpochByPlugin.get(request.pluginId) ?? 0
              const cached = resolvedBundles.get(request.pluginId)
              if (cached && cached.invalidationEpoch === invalidationEpoch) {
                try {
                  matchBundle(request, cached.bundle)
                  bundle = cached.bundle
                } catch {
                  resolvedBundles.delete(request.pluginId)
                  await owner.invalidate(request.pluginId, 'editor-plan-identity-changed')
                  bundle = await resolver.resolve(request.pluginId, linked.signal)
                  if ((invalidationEpochByPlugin.get(request.pluginId) ?? 0) !== invalidationEpoch) {
                    throw new PluginRuntimeError(hostFailure(
                      'stale-generation',
                      FAILURE_MESSAGES['stale-generation'],
                    ))
                  }
                  matchBundle(request, bundle)
                  resolvedBundles.set(request.pluginId, { bundle, invalidationEpoch })
                }
              } else {
                resolvedBundles.delete(request.pluginId)
                bundle = await resolver.resolve(request.pluginId, linked.signal)
                if ((invalidationEpochByPlugin.get(request.pluginId) ?? 0) !== invalidationEpoch) {
                  throw new PluginRuntimeError(hostFailure(
                    'stale-generation',
                    FAILURE_MESSAGES['stale-generation'],
                  ))
                }
                matchBundle(request, bundle)
                resolvedBundles.set(request.pluginId, { bundle, invalidationEpoch })
              }
            } catch (cause) {
              const runtimeFailure = resolutionFailure(cause)
              if (runtimeFailure.code === 'stale-plan'
                || runtimeFailure.code === 'stale-generation') {
                resolvedBundles.delete(request.pluginId)
                await owner.invalidate(request.pluginId, runtimeFailure.code)
              }
              recordDiagnostic(request.pluginId, 'editor', runtimeFailure, request.requestId)
              return Object.freeze({ status: 'failed', failure: runtimeFailure }) satisfies PluginEffectApplyResult
            }
            return applyWithBundle(owner, bundle, request, 'editor', linked.signal)
          })
        } catch (cause) {
          const runtimeFailure = publicFailure(cause)
          recordDiagnostic(request.pluginId, 'editor', runtimeFailure, request.requestId)
          result = Object.freeze({ status: 'failed', failure: runtimeFailure })
        } finally {
          linked.dispose()
        }
        if (latestByDescriptor.get(request.descriptorId) === latest) {
          latestByDescriptor.delete(request.descriptorId)
        }
        if (result.status === 'applied') consecutiveFailures.set(request.pluginId, 0)
        else if (result.failure.terminal) resolvedBundles.delete(request.pluginId)
        if (result.status === 'failed'
          && !['aborted', 'stale-generation', 'stale-plan', 'stale-request'].includes(result.failure.code)) {
          const count = (consecutiveFailures.get(request.pluginId) ?? 0) + 1
          consecutiveFailures.set(request.pluginId, count)
          if (count >= FAILURE_DISABLE_THRESHOLD) {
            disabledPlugins.add(request.pluginId)
            await owner.invalidate(request.pluginId, 'editor-failure-threshold')
          }
        }
        return result
      },
      async close(reason) {
        if (closed) return
        closed = true
        for (const latest of latestByDescriptor.values()) latest.abort.abort()
        latestByDescriptor.clear()
        lastRequestIdByDescriptor.clear()
        resolvedBundles.clear()
        await owner.close(reason)
      },
    }
  }

  const preflightExport = async (
    request: PluginExportPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginExportSession> => {
    if (tornDown) throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
    const frozenBundles = new Map<string, VerifiedPluginActivationBundle>()
    const frozenIdentities = new Set<string>()
    const frozenRequirements = new Map<string, PluginExportEffectRequirement>()
    const frozenIdentityKeysByPlugin = new Map<string, Set<string>>()
    const failedPlugins = new Set<string>()
    const failures: PluginExportPreflightFailure[] = []
    const owner = createOwner()
    const preflightSignal = linkedAbortSignal([signal, controllerAbort.signal])
    try {
      for (const identity of request.requiredEffects) {
        if (preflightSignal.signal.aborted) {
          throw new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted))
        }
        if (failedPlugins.has(identity.pluginId)) continue
        const existing = frozenBundles.get(identity.pluginId)
        if (existing) {
          try {
            matchBundle(identity, existing)
            assertExportSurfaceCapacity(identity, existing)
            const key = executionIdentityKey(identity)
            frozenIdentities.add(key)
            frozenRequirements.set(key, identity)
            const pluginKeys = frozenIdentityKeysByPlugin.get(identity.pluginId)
            if (pluginKeys) pluginKeys.add(key)
            else frozenIdentityKeysByPlugin.set(identity.pluginId, new Set([key]))
          } catch (cause) {
            const failure = resolutionFailure(cause)
            failures.push(Object.freeze({ pluginId: identity.pluginId, failure }))
            failedPlugins.add(identity.pluginId)
            frozenBundles.delete(identity.pluginId)
            for (const key of frozenIdentityKeysByPlugin.get(identity.pluginId) ?? []) {
              frozenIdentities.delete(key)
              frozenRequirements.delete(key)
            }
            frozenIdentityKeysByPlugin.delete(identity.pluginId)
          }
          continue
        }
        try {
          const bundle = await resolver.resolve(identity.pluginId, preflightSignal.signal)
          matchBundle(identity, bundle)
          assertExportSurfaceCapacity(identity, bundle)
          frozenBundles.set(identity.pluginId, bundle)
          const key = executionIdentityKey(identity)
          frozenIdentities.add(key)
          frozenRequirements.set(key, identity)
          frozenIdentityKeysByPlugin.set(identity.pluginId, new Set([key]))
        } catch (cause) {
          const failure = resolutionFailure(cause)
          failures.push(Object.freeze({ pluginId: identity.pluginId, failure }))
          failedPlugins.add(identity.pluginId)
          if (failure.code === 'aborted' || failure.code === 'closed') break
        }
      }
      if (failures.some(({ failure }) => (
        failure.code === 'aborted' || failure.code === 'closed'
      ))) throw new PluginExportPreflightError(failures)
      // Compile and instantiate before encoder initialization. Each later apply
      // uses only these attempt-frozen bundles and never re-enters the registry.
      try {
        failures.push(...await owner.pinBundles(
          [...frozenBundles.values()],
          preflightSignal.signal,
        ))
      } catch (cause) {
        failures.push(Object.freeze({
          pluginId: 'plugin-runtime',
          failure: resolutionFailure(cause),
        }))
      }
      if (failures.length > 0) throw new PluginExportPreflightError(failures)
    } catch (cause) {
      const aggregate = cause instanceof PluginExportPreflightError
        ? cause
        : new PluginExportPreflightError([Object.freeze({
            pluginId: request.requiredEffects.find((identity) => (
              !frozenBundles.has(identity.pluginId)
            ))?.pluginId ?? request.requiredEffects[0]?.pluginId ?? 'plugin-runtime',
            failure: resolutionFailure(cause),
          })])
      for (const failed of aggregate.failures) {
        recordDiagnostic(failed.pluginId, 'export', failed.failure)
      }
      try {
        await owner.close(aggregate.failure.code)
      } catch {
        // The complete preflight failure remains primary over ordinary cleanup.
      }
      throw aggregate
    } finally {
      preflightSignal.dispose()
    }
    let closed = false
    return {
      async apply(applyRequest, applySignal) {
        if (closed) return Object.freeze({
          status: 'failed',
          failure: hostFailure('closed', FAILURE_MESSAGES.closed),
        })
        const bundle = frozenBundles.get(applyRequest.pluginId)
        const identityKey = executionIdentityKey(applyRequest)
        const requirement = frozenRequirements.get(identityKey)
        if (!bundle || !frozenIdentities.has(identityKey) || !requirement) return Object.freeze({
          status: 'failed',
          failure: hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']),
        })
        if (applyRequest.width !== requirement.maximumSurfaceWidth
          || applyRequest.height !== requirement.maximumSurfaceHeight
          || applyRequest.stride !== requirement.maximumSurfaceStride
          || applyRequest.rgbaBytes.byteLength !== requirement.maximumSurfaceByteLength) {
          return Object.freeze({
            status: 'failed',
            failure: hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']),
          })
        }
        const linked = linkedAbortSignal([applySignal, controllerAbort.signal])
        try {
          return await runBounded(
            applyRequest.pluginId,
            linked.signal,
            () => applyWithBundle(owner, bundle, applyRequest, 'export', linked.signal),
          )
        } catch (cause) {
          const runtimeFailure = publicFailure(cause)
          recordDiagnostic(applyRequest.pluginId, 'export', runtimeFailure, applyRequest.requestId)
          return Object.freeze({ status: 'failed', failure: runtimeFailure })
        } finally {
          linked.dispose()
        }
      },
      async close(reason) {
        if (closed) return
        closed = true
        frozenBundles.clear()
        frozenIdentities.clear()
        frozenRequirements.clear()
        frozenIdentityKeysByPlugin.clear()
        await owner.close(reason)
      },
    }
  }

  const canonicalRecord = (
    bytes: Uint8Array,
  ): { readonly json: string; readonly value: Record<string, boolean | number | string> } => {
    if (bytes.byteLength < 2 || bytes.byteLength > 65_536
      || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
      throw new PluginRuntimeError(hostFailure('invalid-output', FAILURE_MESSAGES['invalid-output']))
    }
    let source: string
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new PluginRuntimeError(hostFailure('invalid-output', FAILURE_MESSAGES['invalid-output']))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      throw new PluginRuntimeError(hostFailure('invalid-output', FAILURE_MESSAGES['invalid-output']))
    }
    if (!isPrimitiveRecord(parsed)) {
      throw new PluginRuntimeError(hostFailure('invalid-output', FAILURE_MESSAGES['invalid-output']))
    }
    const keys = Object.keys(parsed).sort()
    const canonical = `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(parsed[key])}`).join(',')}}`
    if (canonical !== source) {
      throw new PluginRuntimeError(hostFailure('invalid-output', FAILURE_MESSAGES['invalid-output']))
    }
    return Object.freeze({ json: source, value: Object.freeze({ ...parsed }) })
  }

  const isPrimitiveRecord = (value: unknown): value is Record<string, boolean | number | string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const entries = Object.entries(value)
    if (entries.length > 64) return false
    for (const [key, entry] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
        || ['__proto__', 'prototype', 'constructor'].includes(key)) return false
      if (typeof entry === 'boolean') continue
      if (typeof entry === 'number' && Number.isFinite(entry)
        && entry >= -1_000_000_000 && entry <= 1_000_000_000) continue
      if (typeof entry === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entry)) continue
      return false
    }
    return true
  }

  const matchesCurrentSchema = (
    value: Readonly<Record<string, boolean | number | string>>,
    contribution: VerifiedPluginContribution,
  ): boolean => {
    const keys = Object.keys(value).sort()
    const expectedKeys = contribution.parameters.map((parameter) => parameter.key).sort()
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false
    return contribution.parameters.every((parameter) => {
      const candidate = value[parameter.key]
      if (parameter.kind === 'boolean') return typeof candidate === 'boolean'
      if (parameter.kind === 'number') {
        return typeof candidate === 'number'
          && Number.isFinite(candidate)
          && candidate >= parameter.min
          && candidate <= parameter.max
      }
      return typeof candidate === 'string'
        && parameter.options.some((option) => option.value === candidate)
    })
  }

  const completeMigrationChain = (
    request: PluginDescriptorMigrationChainRequest,
    contribution: VerifiedPluginContribution,
  ): readonly VerifiedPluginContribution['migrations'][number][] => {
    let version = request.fromDescriptorVersion
    const steps: VerifiedPluginContribution['migrations'][number][] = []
    for (const step of contribution.migrations) {
      if (step.fromVersion < version) continue
      if (step.fromVersion !== version || step.toVersion <= step.fromVersion) {
        throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
      }
      steps.push(step)
      version = step.toVersion
    }
    if (version !== contribution.descriptorVersion) {
      throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
    }
    return Object.freeze([...steps])
  }

  interface PreparedMigrationTarget {
    readonly request: PluginDescriptorMigrationTargetRequest
    readonly bundleIdentityKey: string
    readonly initial: ReturnType<typeof canonicalRecord>
  }

  const preflightDescriptorMigrationAction = async (
    request: PluginDescriptorMigrationActionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationActionSession> => {
    if (tornDown) throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
    if (!Array.isArray(request.targets)
      || request.targets.length === 0
      || request.targets.length > 1_024) {
      throw new PluginRuntimeError(hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']))
    }
    const descriptorIds = new Set<string>()
    const locallyValidated: Array<{
      readonly request: PluginDescriptorMigrationTargetRequest
      readonly initial: ReturnType<typeof canonicalRecord>
    }> = []
    for (const target of request.targets) {
      if (typeof target.descriptorId !== 'string'
        || target.descriptorId.length === 0
        || target.descriptorId.length > 128
        || descriptorIds.has(target.descriptorId)
        || target.hasAnimatedParameters
        || !Number.isSafeInteger(target.fromDescriptorVersion)
        || target.fromDescriptorVersion < 1) {
        throw new PluginRuntimeError(hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']))
      }
      descriptorIds.add(target.descriptorId)
      const inputBytes = canonicalBytes(target.canonicalParameterJson)
      let initial: ReturnType<typeof canonicalRecord>
      try {
        initial = canonicalRecord(inputBytes)
      } finally {
        inputBytes.fill(0)
      }
      locallyValidated.push({
        request: Object.freeze({ ...target }),
        initial,
      })
    }

    const linked = linkedAbortSignal([signal, controllerAbort.signal])
    const prepared: PreparedMigrationTarget[] = []
    let reservation: RuntimeReservation | null = null
    try {
      for (const target of locallyValidated) {
        let bundle: VerifiedPluginActivationBundle
        try {
          bundle = await resolver.resolve(target.request.pluginId, linked.signal)
        } catch (cause) {
          throw new PluginRuntimeError(resolutionFailure(cause))
        }
        const contribution = matchBundle(target.request, bundle)
        completeMigrationChain(target.request, contribution)
        prepared.push(Object.freeze({
          request: target.request,
          bundleIdentityKey: exactBundleIdentityKey(bundle),
          initial: target.initial,
        }))
      }
      reservation = await reserveMigrationSlot(linked.signal)
    } catch (cause) {
      const runtimeFailure = cause instanceof PluginRuntimeError
        ? cause.failure
        : resolutionFailure(cause)
      const pluginId = prepared.length < locallyValidated.length
        ? locallyValidated[prepared.length]!.request.pluginId
        : locallyValidated[0]!.request.pluginId
      recordDiagnostic(pluginId, 'migration', runtimeFailure)
      if (reservation) await releaseMigrationSlot(reservation)
      throw new PluginRuntimeError(runtimeFailure)
    } finally {
      linked.dispose()
    }

    if (!reservation) {
      throw new PluginRuntimeError(hostFailure('busy', FAILURE_MESSAGES.busy, false))
    }
    const actionReservation = reservation
    let closed = false
    let running = false
    let nextTargetIndex = 0
    let currentAbort: AbortController | null = null
    let currentOwner: RuntimeOwner | null = null
    let currentSettlement: Promise<PluginDescriptorMigrationResult> | null = null
    let closingPromise: Promise<void> | null = null

    const closeAction = (reason: string): Promise<void> => {
      if (closingPromise) return closingPromise
      closed = true
      currentAbort?.abort()
      closingPromise = (async () => {
        const owner = currentOwner
        let cleanupError: unknown
        try {
          if (owner) await owner.close(reason)
        } catch (cause) {
          cleanupError = cause
        }
        try {
          await releaseMigrationSlot(actionReservation)
        } catch (cause) {
          cleanupError ??= cause
        }
        if (cleanupError !== undefined) throw cleanupError
      })()
      return closingPromise
    }

    const applyPreparedTarget = async (
      preparedTarget: PreparedMigrationTarget,
      requestId: number,
      applySignal?: AbortSignal,
    ): Promise<PluginDescriptorMigrationResult> => {
      const target = preparedTarget.request
      currentAbort = new AbortController()
      const targetSignal = linkedAbortSignal([
        applySignal,
        currentAbort.signal,
        controllerAbort.signal,
      ])
      const owner = createOwner(actionReservation)
      currentOwner = owner
      let result: PluginDescriptorMigrationResult
      try {
        result = await runBounded(target.pluginId, targetSignal.signal, async () => {
          let bundle: VerifiedPluginActivationBundle
          try {
            bundle = await resolver.resolve(target.pluginId, targetSignal.signal)
          } catch (cause) {
            throw new PluginRuntimeError(resolutionFailure(cause))
          }
          const contribution = matchBundle(target, bundle)
          if (exactBundleIdentityKey(bundle) !== preparedTarget.bundleIdentityKey) {
            throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
          }
          const steps = completeMigrationChain(target, contribution)
          let currentBytes = canonicalBytes(preparedTarget.initial.json)
          let currentVersion = target.fromDescriptorVersion
          let finalRecord = preparedTarget.initial
          try {
            if (steps.length > 0) {
              await owner.withEntry(bundle, targetSignal.signal, async (entry) => {
                for (const step of steps) {
                  const outputBytes = await entry.session.migrate({
                    entrypoint: step.entrypoint,
                    fromVersion: step.fromVersion,
                    toVersion: step.toVersion,
                    canonicalInputBytes: currentBytes,
                  }, targetSignal.signal)
                  try {
                    finalRecord = canonicalRecord(outputBytes)
                  } finally {
                    outputBytes.fill(0)
                  }
                  currentBytes.fill(0)
                  currentBytes = canonicalBytes(finalRecord.json)
                  currentVersion = step.toVersion
                }
              })
            }
            if (currentVersion !== contribution.descriptorVersion
              || !matchesCurrentSchema(finalRecord.value, contribution)) {
              throw new PluginRuntimeError(hostFailure('invalid-output', FAILURE_MESSAGES['invalid-output']))
            }
            return Object.freeze({
              status: 'migrated' as const,
              descriptorVersion: currentVersion,
              canonicalParameterJson: finalRecord.json,
              parameters: finalRecord.value,
            })
          } finally {
            currentBytes.fill(0)
          }
        })
      } catch (cause) {
        const runtimeFailure = publicFailure(cause)
        recordDiagnostic(target.pluginId, 'migration', runtimeFailure, requestId)
        result = Object.freeze({ status: 'failed', failure: runtimeFailure })
      } finally {
        targetSignal.dispose()
        let cleanupFailure: PluginRuntimeFailure | null = null
        try {
          await owner.close('migration-target-terminal')
        } catch (cause) {
          cleanupFailure = publicFailure(cause)
        }
        if (currentOwner === owner) currentOwner = null
        currentAbort = null
        if (cleanupFailure && result!.status === 'migrated') {
          recordDiagnostic(target.pluginId, 'migration', cleanupFailure, requestId)
          result = Object.freeze({ status: 'failed', failure: cleanupFailure })
        }
      }
      return result!
    }

    return {
      applyTarget(applyRequest, applySignal) {
        if (closed || running) return Promise.resolve(Object.freeze({
          status: 'failed',
          failure: hostFailure('closed', FAILURE_MESSAGES.closed),
        }))
        if (!Number.isSafeInteger(applyRequest.targetIndex)
          || applyRequest.targetIndex !== nextTargetIndex
          || !Number.isSafeInteger(applyRequest.requestId)
          || applyRequest.requestId < 0
          || applyRequest.targetIndex >= prepared.length) {
          const runtimeFailure = hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input'])
          const pluginId = prepared[nextTargetIndex]?.request.pluginId ?? prepared[0]!.request.pluginId
          recordDiagnostic(pluginId, 'migration', runtimeFailure, applyRequest.requestId)
          return closeAction(runtimeFailure.code).catch(() => undefined).then(() => Object.freeze({
            status: 'failed' as const,
            failure: runtimeFailure,
          }))
        }
        running = true
        const settlement = applyPreparedTarget(
          prepared[applyRequest.targetIndex]!,
          applyRequest.requestId,
          applySignal,
        ).then(async (result) => {
          if (result.status === 'failed') {
            await closeAction(result.failure.code).catch(() => undefined)
          } else {
            nextTargetIndex++
          }
          return result
        }).finally(() => {
          running = false
          if (currentSettlement === settlement) currentSettlement = null
        })
        currentSettlement = settlement
        return settlement
      },
      async close(reason) {
        const settlement = currentSettlement
        let cleanupError: unknown
        try {
          await closeAction(reason)
        } catch (cause) {
          cleanupError = cause
        }
        await settlement?.catch(() => undefined)
        if (cleanupError !== undefined) throw cleanupError
      },
    }
  }

  const openDescriptorMigrationChain = async (
    request: PluginDescriptorMigrationChainRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationChainSession> => {
    const action = await preflightDescriptorMigrationAction({
      targets: [{ ...request, descriptorId: `${request.pluginId}:${request.contributionId}` }],
    }, signal)
    return {
      apply(applyRequest, applySignal) {
        return action.applyTarget({ targetIndex: 0, requestId: applyRequest.requestId }, applySignal)
      },
      close(reason) {
        return action.close(reason)
      },
    }
  }

  return {
    openEditorSession,
    preflightExport,
    openDescriptorMigrationChain,
    preflightDescriptorMigrationAction,
    getSnapshot() {
      const diagnostics = [...diagnosticsByPlugin.values()]
        .flat()
        .sort((left, right) => left.sequence - right.sequence)
      const residentRuntimeCount = [...owners].reduce(
        (count, owner) => count + owner.entries.size,
        0,
      )
      return Object.freeze({
        activeCallCount,
        queuedCallCount: scheduledCalls.length,
        liveOwnerCount: owners.size,
        residentRuntimeCount,
        cache: rawModuleCache.getSnapshot(),
        diagnostics: Object.freeze(diagnostics),
      })
    },
    clearDiagnostics(pluginId) {
      diagnosticsByPlugin.delete(pluginId)
      diagnosticPluginAccess.delete(pluginId)
    },
    async invalidate(pluginId, reason) {
      invalidationEpochByPlugin.set(
        pluginId,
        (invalidationEpochByPlugin.get(pluginId) ?? 0) + 1,
      )
      rawModuleCache.invalidatePlugin(pluginId)
      emitLifecycle()
      await Promise.allSettled([...owners].map((owner) => owner.invalidate(pluginId, reason)))
      recordDiagnostic(
        pluginId,
        'lifecycle',
        hostFailure('stale-generation', FAILURE_MESSAGES['stale-generation']),
      )
    },
    teardown(reason) {
      if (teardownPromise) return teardownPromise
      tornDown = true
      teardownPromise = (async () => {
        controllerAbort.abort()
        const sandboxTeardown = Promise.resolve().then(() => sandboxController.teardown(reason))
        for (const call of scheduledCalls.splice(0)) {
          call.signal?.removeEventListener('abort', call.onAbort!)
          call.reject(new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed)))
        }
        emitLifecycle()
        await Promise.allSettled([...owners].map((owner) => owner.close(reason)))
        await Promise.allSettled([...activeCallSettlements])
        for (const reservation of migrationReservations) {
          reservation.closed = true
          reservation.occupied = false
        }
        migrationReservations.clear()
        rawModuleCache.clear()
        invalidationEpochByPlugin.clear()
        activePlugins.clear()
        const [sandboxResult] = await Promise.allSettled([sandboxTeardown])
        emitLifecycle(true)
        if (sandboxResult.status === 'rejected') throw sandboxResult.reason
      })()
      return teardownPromise
    },
  }
}
