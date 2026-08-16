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

export interface PluginExportPreflightRequest {
  readonly requiredEffects: readonly PluginExecutionIdentity[]
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
  getSnapshot(): PluginRuntimeSnapshot
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

interface RuntimeEntry {
  readonly pluginId: string
  readonly identityKey: string
  readonly session: PluginSandboxSession
  lastUsed: number
  activeCalls: number
  pinned: boolean
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
  ): Promise<void>
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
}): PluginRuntimeController {
  const resolver = options.activationBundleResolver
  const sandboxController = options.sandboxController ?? createPluginSandboxController()
  const rawModuleCache = options.rawModuleCache ?? createPluginRawModuleCache()
  const owners = new Set<RuntimeOwner>()
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
  const controllerAbort = new AbortController()

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
    owner.entries.delete(pluginId)
    await entry.session.close(reason)
  }

  const createOwner = (): RuntimeOwner => {
    const entries = new Map<string, RuntimeEntry>()
    const pinnedIdentities = new Map<string, string>()
    let closed = false
    let owner!: RuntimeOwner

    const bundleIdentityKey = (bundle: VerifiedPluginActivationBundle): string => JSON.stringify([
      bundle.catalogGeneration,
      bundle.pluginId,
      bundle.version,
      bundle.packageDigest,
      bundle.signerFingerprint,
      bundle.moduleSha256,
      contributionIdentityKey(bundle),
    ])

    const residentEntries = (): Array<{ readonly owner: RuntimeOwner; readonly entry: RuntimeEntry }> => (
      [...owners].flatMap((candidateOwner) => (
        [...candidateOwner.entries.values()].map((candidate) => ({
          owner: candidateOwner,
          entry: candidate,
        }))
      ))
    )

    const reserveCapacityUnlocked = async (newEntryCount: number): Promise<void> => {
      const residents = residentEntries()
      const evictionCount = Math.max(0, residents.length + newEntryCount - MAX_RESIDENT_RUNTIMES)
      if (evictionCount === 0) return
      const candidates = residents
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

    const activateUnlocked = async (
      bundle: VerifiedPluginActivationBundle,
      signal: AbortSignal | undefined,
      pin: boolean,
      capacityReserved: boolean,
    ): Promise<RuntimeEntry> => {
      if (closed || tornDown) {
        throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
      }
      if (signal?.aborted) {
        throw new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted))
      }
      const expectedIdentityKey = bundleIdentityKey(bundle)
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
      }
      entries.set(bundle.pluginId, activated)
      if (pin) pinnedIdentities.set(bundle.pluginId, expectedIdentityKey)
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
          const activated = await activateUnlocked(bundle, signal, false, false)
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
        await withLifecycle(signal, async () => {
          if (closed || tornDown) {
            throw new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed))
          }
          const unique = new Map<string, VerifiedPluginActivationBundle>()
          for (const bundle of bundles) unique.set(bundle.pluginId, bundle)
          if (unique.size > MAX_RESIDENT_RUNTIMES) {
            throw new PluginRuntimeError(hostFailure('busy', FAILURE_MESSAGES.busy, false))
          }
          const newEntryCount = [...unique.values()].filter((bundle) => (
            entries.get(bundle.pluginId)?.identityKey !== bundleIdentityKey(bundle)
          )).length
          // Check and make room for the entire export attempt before copying or
          // activating any of its modules. The lifecycle lock holds the reservation.
          await reserveCapacityUnlocked(newEntryCount)
          try {
            for (const bundle of unique.values()) {
              await activateUnlocked(bundle, signal, true, true)
            }
          } catch (cause) {
            closed = true
            const closing = [...entries.values()].map((entry) => (
              entry.session.close('export-preflight-rollback')
            ))
            entries.clear()
            pinnedIdentities.clear()
            owners.delete(owner)
            await Promise.allSettled(closing)
            throw cause
          }
        })
      },
      invalidate: removeEntry,
      async close(reason: string) {
        await withLifecycle(undefined, async () => {
          if (closed) return
          closed = true
          const closing = [...entries.values()].map((entry) => entry.session.close(reason))
          entries.clear()
          pinnedIdentities.clear()
          owners.delete(owner)
          await Promise.allSettled(closing)
        })
      },
    }
    owners.add(owner)
    return owner
  }

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
    const owner = createOwner()
    const preflightSignal = linkedAbortSignal([signal, controllerAbort.signal])
    try {
      for (const identity of request.requiredEffects) {
        if (preflightSignal.signal.aborted) {
          throw new PluginRuntimeError(hostFailure('aborted', FAILURE_MESSAGES.aborted))
        }
        const existing = frozenBundles.get(identity.pluginId)
        if (existing) {
          matchBundle(identity, existing)
          frozenIdentities.add(executionIdentityKey(identity))
          continue
        }
        const bundle = await resolver.resolve(identity.pluginId, preflightSignal.signal)
        matchBundle(identity, bundle)
        frozenBundles.set(identity.pluginId, bundle)
        frozenIdentities.add(executionIdentityKey(identity))
      }
      // Compile and instantiate before encoder initialization. Each later apply
      // uses only these attempt-frozen bundles and never re-enters the registry.
      await owner.pinBundles([...frozenBundles.values()], preflightSignal.signal)
    } catch (cause) {
      const runtimeFailure = resolutionFailure(cause)
      const pluginId = request.requiredEffects.find((identity) => (
        !frozenBundles.has(identity.pluginId)
      ))?.pluginId ?? request.requiredEffects[0]?.pluginId ?? 'plugin-runtime'
      recordDiagnostic(pluginId, 'export', runtimeFailure)
      await owner.close(runtimeFailure.code)
      throw new PluginRuntimeError(runtimeFailure)
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
        if (!bundle || !frozenIdentities.has(executionIdentityKey(applyRequest))) return Object.freeze({
          status: 'failed',
          failure: hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']),
        })
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

  const openDescriptorMigrationChain = async (
    request: PluginDescriptorMigrationChainRequest,
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationChainSession> => {
    if (request.hasAnimatedParameters) {
      throw new PluginRuntimeError(hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input']))
    }
    const activationSignal = linkedAbortSignal([signal, controllerAbort.signal])
    let bundle: VerifiedPluginActivationBundle
    let contribution: VerifiedPluginContribution
    try {
      bundle = await resolver.resolve(request.pluginId, activationSignal.signal)
      contribution = matchBundle(request, bundle)
    } catch (cause) {
      const runtimeFailure = resolutionFailure(cause)
      recordDiagnostic(request.pluginId, 'migration', runtimeFailure)
      throw new PluginRuntimeError(runtimeFailure)
    } finally {
      activationSignal.dispose()
    }
    const steps = contribution.migrations
    let version = request.fromDescriptorVersion
    for (const step of steps) {
      if (step.fromVersion < version) continue
      if (step.fromVersion !== version || step.toVersion <= step.fromVersion) {
        throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
      }
      version = step.toVersion
    }
    if (version !== contribution.descriptorVersion) {
      throw new PluginRuntimeError(hostFailure('stale-plan', FAILURE_MESSAGES['stale-plan']))
    }
    // Validate the initial bytes generically without changing their byte representation.
    const initialBytes = canonicalBytes(request.canonicalParameterJson)
    let initial: ReturnType<typeof canonicalRecord>
    try {
      initial = canonicalRecord(initialBytes)
    } finally {
      initialBytes.fill(0)
    }
    const owner = createOwner()
    let closed = false
    let applied = false

    return {
      async apply(applyRequest, applySignal) {
        if (closed || applied) return Object.freeze({
          status: 'failed',
          failure: hostFailure('closed', FAILURE_MESSAGES.closed),
        })
        if (!Number.isSafeInteger(applyRequest.requestId) || applyRequest.requestId < 0) {
          const runtimeFailure = hostFailure('invalid-input', FAILURE_MESSAGES['invalid-input'])
          recordDiagnostic(request.pluginId, 'migration', runtimeFailure, applyRequest.requestId)
          return Object.freeze({ status: 'failed', failure: runtimeFailure })
        }
        applied = true
        const linked = linkedAbortSignal([applySignal, controllerAbort.signal])
        try {
          return await runBounded(request.pluginId, linked.signal, async (): Promise<PluginDescriptorMigrationResult> => {
            let currentBytes = canonicalBytes(initial.json)
            try {
              let currentVersion = request.fromDescriptorVersion
              let finalRecord = initial
              if (steps.some((step) => step.fromVersion >= currentVersion)) {
                await owner.withEntry(bundle, linked.signal, async (entry) => {
                  for (const step of steps) {
                    if (step.fromVersion < currentVersion) continue
                    const outputBytes = await entry.session.migrate({
                      entrypoint: step.entrypoint,
                      fromVersion: step.fromVersion,
                      toVersion: step.toVersion,
                      canonicalInputBytes: currentBytes,
                    }, linked.signal)
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
                status: 'migrated',
                descriptorVersion: currentVersion,
                canonicalParameterJson: finalRecord.json,
                parameters: finalRecord.value,
              })
            } catch (cause) {
              const runtimeFailure = publicFailure(cause)
              recordDiagnostic(request.pluginId, 'migration', runtimeFailure, applyRequest.requestId)
              await owner.invalidate(request.pluginId, runtimeFailure.code)
              return Object.freeze({ status: 'failed', failure: runtimeFailure })
            } finally {
              currentBytes.fill(0)
            }
          })
        } catch (cause) {
          const runtimeFailure = publicFailure(cause)
          recordDiagnostic(request.pluginId, 'migration', runtimeFailure, applyRequest.requestId)
          return Object.freeze({ status: 'failed', failure: runtimeFailure })
        } finally {
          linked.dispose()
        }
      },
      async close(reason) {
        if (closed) return
        closed = true
        await owner.close(reason)
      },
    }
  }

  return {
    openEditorSession,
    preflightExport,
    openDescriptorMigrationChain,
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
    async invalidate(pluginId, reason) {
      invalidationEpochByPlugin.set(
        pluginId,
        (invalidationEpochByPlugin.get(pluginId) ?? 0) + 1,
      )
      rawModuleCache.invalidatePlugin(pluginId)
      await Promise.allSettled([...owners].map((owner) => owner.invalidate(pluginId, reason)))
      recordDiagnostic(
        pluginId,
        'lifecycle',
        hostFailure('stale-generation', FAILURE_MESSAGES['stale-generation']),
      )
    },
    async teardown(reason) {
      if (tornDown) return
      tornDown = true
      controllerAbort.abort()
      sandboxController.teardown(reason)
      for (const call of scheduledCalls.splice(0)) {
        call.signal?.removeEventListener('abort', call.onAbort!)
        call.reject(new PluginRuntimeError(hostFailure('closed', FAILURE_MESSAGES.closed)))
      }
      await Promise.allSettled([...owners].map((owner) => owner.close(reason)))
      await Promise.allSettled([...activeCallSettlements])
      rawModuleCache.clear()
      invalidationEpochByPlugin.clear()
      activePlugins.clear()
    },
  }
}
