
import { type PluginRawModuleCacheSnapshot } from '../pluginRawModuleCache';
import type { PluginRuntimeFailure, PluginRuntimeFailureCode } from '../../workers/plugin-runtime-protocol';

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
