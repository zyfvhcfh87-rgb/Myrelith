import { PluginSandboxError, type PluginSandboxSession } from '../pluginSandboxController';
import type {
  VerifiedPluginActivationBundle,
  VerifiedPluginContribution,
} from '../pluginInstallController'
import { type PluginRawModuleCacheKey } from '../pluginRawModuleCache';
import type { PluginRuntimeFailure, PluginRuntimeFailureCode } from '../../workers/plugin-runtime-protocol';
import { PLUGIN_IO_PAGE_BYTES, PLUGIN_PIXEL_POINTER } from '../../workers/plugin-runtime-protocol';
import { PLUGIN_WASM_OPCODE_TABLE_DIGESTS } from '../../workers/plugin-wasm/policyTables';
import type { PluginWasmProfileSelection } from '../../domain/pluginWasmPolicy';
import { PluginRuntimeError, type PluginExecutionIdentity, type PluginExportEffectRequirement, type PluginExportPreflightFailure } from './contracts';

export const MAX_RESIDENT_RUNTIMES = 8
export const MAX_ACTIVE_CALLS = 2
export const MAX_QUEUED_CALLS = 32
export const FAILURE_DISABLE_THRESHOLD = 3
export const MAX_DIAGNOSTIC_PLUGINS = 64
export const MAX_DIAGNOSTICS_PER_PLUGIN = 100
export const MAX_MESSAGE_LENGTH = 512

export interface RuntimeEntry {
  readonly pluginId: string
  readonly identityKey: string
  readonly session: PluginSandboxSession
  lastUsed: number
  activeCalls: number
  pinned: boolean
  readonly reservation: RuntimeReservation | null
}

export interface RuntimeReservation {
  occupied: boolean
  closed: boolean
}

export interface RuntimeOwner {
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

export interface ScheduledCall {
  readonly pluginId: string
  readonly task: () => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: PluginRuntimeError) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

export function hostFailure(
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

export const FAILURE_MESSAGES: Readonly<Record<PluginRuntimeFailureCode, string>> = Object.freeze({
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

export function publicFailure(value: unknown): PluginRuntimeFailure {
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

export const STALE_RESOLUTION_CODES = new Set([
  'disabled',
  'incompatible',
  'install-conflict',
  'permission-denied',
  'quarantined',
  'revoked',
  'safe-mode',
])

export function resolutionFailure(value: unknown): PluginRuntimeFailure {
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

export function selectedPolicy(bundle: VerifiedPluginActivationBundle): PluginWasmProfileSelection {
  return Object.freeze({
    binaryPolicyVersion: 1,
    profileId: bundle.contributions.some((contribution) => contribution.migrations.length > 0)
      ? 'myrelith-wasm-migration-integer-v1'
      : 'myrelith-wasm-render-general-v1',
  })
}

export function contributionIdentityKey(bundle: VerifiedPluginActivationBundle): string {
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

export function cacheKey(bundle: VerifiedPluginActivationBundle): PluginRawModuleCacheKey {
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

export function matchBundle(
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

export function executionIdentityKey(identity: PluginExecutionIdentity): string {
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

export function assertExportSurfaceCapacity(
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

export function canonicalBytes(canonicalParameterJson: string): Uint8Array {
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

export function linkedAbortSignal(
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
