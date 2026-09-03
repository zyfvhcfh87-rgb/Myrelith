/** App-owned preparation and one-shot ownership for plugin-aware exports. */

import { validateExportProfile, type ExportProfile } from '../domain/exportProfile'
import { EFFECT_STACK_LIMITS } from '../domain/effectBounds'
import type { TimelineDoc } from '../domain/schema'
import { sequenceById, type SequenceProject } from '../domain/projectSequences'
import {
  createPluginVideoEffectContributionSnapshot,
  createVideoEffectStagePlanner,
  type PluginVideoEffectContributionSnapshot,
  type PluginVideoEffectExecutionPlan,
  type PluginVideoEffectStageStatus,
} from '../domain/pluginVideoEffectStagePlan'
import type {
  PluginVideoEffectApplyRequest,
  PluginVideoEffectApplyResult,
  VideoEffectStageExecutor,
} from '../pipeline/videoEffectStageExecution'
import type {
  PluginDeclarationCatalogSnapshot,
} from './pluginInstallController'
import {
  PluginExportPreflightError,
  type PluginEffectApplyRequest,
  type PluginExecutionIdentity,
  type PluginExportEffectRequirement,
  type PluginExportSession,
  type PluginRuntimeController,
} from './pluginRuntimeController'
import type {
  PluginRuntimeFailure,
  PluginRuntimeFailureCode,
} from '../workers/plugin-runtime-protocol'

const MAX_PLUGIN_EXPORT_EFFECTS = EFFECT_STACK_LIMITS.maxTotalEffects
const MAX_REASON_CHARACTERS = 512

export type PluginExportAttemptErrorCode =
  | 'aborted'
  | 'already-used'
  | 'closed'
  | 'invalid-review'
  | 'stale-attempt'

export class PluginExportAttemptError extends Error {
  readonly code: PluginExportAttemptErrorCode

  constructor(code: PluginExportAttemptErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginExportAttemptError'
    this.code = code
  }
}

export type PluginExportBlockerStatus =
  | Exclude<PluginVideoEffectStageStatus, 'ready'>
  | `runtime-${PluginRuntimeFailureCode}`

/** Data-only exact instance fact shown during reviewed export bypass. */
export interface PluginExportBlocker {
  readonly key: string
  readonly descriptorId: string
  readonly pluginId: string | null
  readonly contributionId: string | null
  readonly status: PluginExportBlockerStatus
  readonly reason: string
}

export interface PluginExportEffectFact {
  readonly key: string
  readonly descriptorId: string
  readonly effectType: string
  readonly enabled: boolean
  readonly pluginId: string | null
  readonly pluginVersion: string | null
  readonly packageDigest: string | null
  readonly signerFingerprint: string | null
  readonly contributionId: string | null
  readonly contributionVersion: number | null
  readonly descriptorVersion: number
  readonly status: PluginVideoEffectStageStatus | `runtime-${PluginRuntimeFailureCode}`
  readonly reason: string
}

export interface PluginExportAttemptSnapshot {
  readonly documentGeneration: number
  readonly settings: Readonly<ExportProfile>
  readonly catalogGeneration: number
  readonly effects: readonly PluginExportEffectFact[]
  readonly blockers: readonly PluginExportBlocker[]
}

export interface PluginExportAttemptToken {
  readonly kind: 'plugin-export-attempt-token'
}

export interface PluginExportReviewToken {
  readonly kind: 'plugin-export-review-token'
}

export type PluginExportAttemptPrepareResult =
  | {
      readonly status: 'ready'
      readonly token: PluginExportAttemptToken
      readonly snapshot: PluginExportAttemptSnapshot
    }
  | {
      readonly status: 'blocked'
      readonly reviewToken: PluginExportReviewToken
      readonly snapshot: PluginExportAttemptSnapshot
    }

export interface PluginPreparedExportExecution {
  readonly document: TimelineDoc
  readonly documentGeneration: number
  readonly settings: Readonly<ExportProfile>
  readonly pluginSnapshot: PluginVideoEffectContributionSnapshot
  readonly videoEffectStageExecutor: VideoEffectStageExecutor
  readonly projectTarget?: Readonly<{
    project: SequenceProject
    sequenceId: string
  }>
  close(reason: string): Promise<void>
}

export interface PluginExportDocumentSnapshot {
  readonly generation: number
  readonly document: TimelineDoc
  readonly project?: SequenceProject
  readonly sequenceId?: string
}

export interface PluginExportAttemptControllerDependencies {
  getDocumentSnapshot(): PluginExportDocumentSnapshot
  getDeclarationCatalog(signal?: AbortSignal): Promise<PluginDeclarationCatalogSnapshot>
  readonly runtime: Pick<PluginRuntimeController, 'preflightExport'>
}

export interface PluginExportAttemptController {
  prepare(
    settings: ExportProfile,
    signal?: AbortSignal,
  ): Promise<PluginExportAttemptPrepareResult>
  approveReviewedBlockers(
    token: PluginExportReviewToken,
    blockerKeys: readonly string[],
    signal?: AbortSignal,
  ): Promise<PluginExportAttemptPrepareResult>
  consume(
    token: PluginExportAttemptToken,
    signal?: AbortSignal,
  ): Promise<PluginPreparedExportExecution>
  close(
    token: PluginExportAttemptToken | PluginExportReviewToken,
    reason: string,
  ): Promise<void>
  teardown(reason: string): Promise<void>
}

interface FrozenEffect {
  readonly fact: PluginExportEffectFact
  readonly execution: PluginVideoEffectExecutionPlan | null
}

interface FrozenPlan {
  readonly document: TimelineDoc
  readonly documentGeneration: number
  readonly projectTarget?: Readonly<{
    project: SequenceProject
    sequenceId: string
  }>
  readonly settings: Readonly<ExportProfile>
  readonly catalog: PluginDeclarationCatalogSnapshot
  readonly catalogFingerprint: string
  readonly pluginSnapshot: PluginVideoEffectContributionSnapshot
  readonly effects: readonly FrozenEffect[]
  readonly maximumSurface: Readonly<{
    readonly width: number
    readonly height: number
    readonly stride: number
    readonly byteLength: number
  }>
}

interface AttemptState {
  readonly token: PluginExportAttemptToken | PluginExportReviewToken
  readonly plan: FrozenPlan
  readonly approvedBlockerKeys: ReadonlySet<string>
  readonly runtimeFailures: ReadonlyMap<string, PluginRuntimeFailure>
  readonly binding: string
  readonly abort: AbortController
  session: PluginExportSession | null
  phase: 'review' | 'ready' | 'consumed' | 'closed'
  closePromise: Promise<void> | null
}

interface PendingPreparation {
  readonly abort: AbortController
  readonly done: Promise<void>
  finish(): void
}

function boundedReason(value: string): string {
  return value.slice(0, MAX_REASON_CHARACTERS)
}

function fail(
  code: PluginExportAttemptErrorCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new PluginExportAttemptError(code, message, options)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail('aborted', 'Plugin export preparation was cancelled')
}

function rethrowAsyncFailure(
  cause: unknown,
  options: {
    readonly callerSignal?: AbortSignal
    readonly internalSignal: AbortSignal
    readonly tornDown: boolean
    readonly stale: boolean
  },
): never {
  if (!options.internalSignal.aborted) throw cause
  if (options.callerSignal?.aborted) {
    fail('aborted', 'Plugin export preparation was cancelled', { cause })
  }
  if (options.tornDown) fail('closed', 'Plugin export attempt controller is closed', { cause })
  if (options.stale) fail('stale-attempt', 'A newer plugin export attempt replaced this one', {
    cause,
  })
  throw cause
}

function linkedAbortSignal(
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const active = signals.filter((value): value is AbortSignal => value !== undefined)
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

function declarationSnapshot(
  catalog: PluginDeclarationCatalogSnapshot,
  runtimeFailures: ReadonlyMap<string, PluginRuntimeFailure> = new Map(),
): PluginVideoEffectContributionSnapshot {
  const globalFailure = runtimeFailures.get('plugin-runtime')
  return createPluginVideoEffectContributionSnapshot(
    catalog.generation,
    catalog.declarations.map((declaration) => {
      const runtimeFailure = runtimeFailures.get(declaration.pluginId) ?? globalFailure
      return {
        ...declaration,
        availability: runtimeFailure ? 'failed' as const : declaration.availability,
        detail: runtimeFailure
          ? boundedReason(runtimeFailure.message)
          : declaration.detail,
      }
    }),
  )
}

function catalogFingerprint(catalog: PluginDeclarationCatalogSnapshot): string {
  return JSON.stringify([
    catalog.generation,
    catalog.declarations.map((declaration) => [
      declaration.pluginId,
      declaration.pluginVersion,
      declaration.packageDigest,
      declaration.signerFingerprint,
      declaration.kind,
      declaration.contributionId,
      declaration.contributionName,
      declaration.contributionVersion,
      declaration.descriptorVersion,
      declaration.entrypoint,
      declaration.parameters.map((parameter) => {
        switch (parameter.kind) {
          case 'number':
            return [
              parameter.kind,
              parameter.key,
              parameter.name,
              parameter.default,
              parameter.min,
              parameter.max,
              parameter.step,
              parameter.animatable,
            ]
          case 'boolean':
            return [parameter.kind, parameter.key, parameter.name, parameter.default]
          case 'enum':
            return [
              parameter.kind,
              parameter.key,
              parameter.name,
              parameter.default,
              parameter.options.map((option) => [option.value, option.name]),
            ]
        }
      }),
      declaration.availability,
      declaration.detail,
    ]),
  ])
}

function maximumExportSurface(document: TimelineDoc): FrozenPlan['maximumSurface'] {
  const stride = document.width * 4
  const byteLength = stride * document.height
  if (!Number.isSafeInteger(document.width)
    || !Number.isSafeInteger(document.height)
    || document.width < 1
    || document.height < 1
    || !Number.isSafeInteger(stride)
    || !Number.isSafeInteger(byteLength)) {
    throw new RangeError('Plugin export surface dimensions are invalid')
  }
  return Object.freeze({
    width: document.width,
    height: document.height,
    stride,
    byteLength,
  })
}

function effectKey(
  sequenceIndex: number,
  trackIndex: number,
  clipIndex: number,
  effectIndex: number,
  descriptorId: string,
): string {
  const local = `${trackIndex}:${clipIndex}:${effectIndex}:${descriptorId}`
  return sequenceIndex === 0 ? local : `sequence-${sequenceIndex}:${local}`
}

function exportDocuments(snapshot: PluginExportDocumentSnapshot): readonly TimelineDoc[] {
  if (!snapshot.project || !snapshot.sequenceId) return [snapshot.document]
  const documents: TimelineDoc[] = []
  const visited = new Set<string>()
  const queue = [snapshot.sequenceId]
  while (queue.length > 0) {
    const sequenceId = queue.shift()!
    if (visited.has(sequenceId)) continue
    visited.add(sequenceId)
    const sequence = sequenceById(snapshot.project, sequenceId)
    if (!sequence) throw new RangeError(`Missing plugin export sequence "${sequenceId}"`)
    documents.push(sequence)
    for (const track of sequence.tracks) {
      for (const instance of track.sequenceInstances ?? []) queue.push(instance.sequenceId)
    }
  }
  return documents
}

function freezePlan(
  snapshot: PluginExportDocumentSnapshot,
  settings: ExportProfile,
  catalog: PluginDeclarationCatalogSnapshot,
): FrozenPlan {
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) {
    throw new TypeError('Plugin export document generation is invalid')
  }
  const validatedSettings = validateExportProfile(settings)
  const pluginSnapshot = declarationSnapshot(catalog)
  const planner = createVideoEffectStagePlanner(pluginSnapshot)
  const declarationsByType = new Map(
    pluginSnapshot.declarations.map((declaration) => [declaration.effectType, declaration]),
  )
  const effects: FrozenEffect[] = []
  for (const [sequenceIndex, document] of exportDocuments(snapshot).entries()) {
    for (const [trackIndex, track] of document.tracks.entries()) {
      if (track.kind !== 'video' || track.hidden) continue
      for (const [clipIndex, clip] of track.clips.entries()) {
        const plan = planner.planClip(clip, clip.timelineRange.startFrame)
        if (!plan) continue
        for (const [effectIndex, stage] of plan.stages.entries()) {
          if (stage.kind !== 'plugin') continue
          const execution = stage.execution
          const declaration = declarationsByType.get(stage.effect.type)
          const key = effectKey(
            sequenceIndex,
            trackIndex,
            clipIndex,
            effectIndex,
            stage.effect.id,
          )
          effects.push(Object.freeze({
            fact: Object.freeze({
              key,
              descriptorId: stage.effect.id,
              effectType: stage.effect.type,
              enabled: stage.effect.enabled,
              pluginId: execution?.pluginId ?? declaration?.pluginId ?? null,
              pluginVersion: execution?.pluginVersion ?? declaration?.pluginVersion ?? null,
              packageDigest: execution?.packageDigest ?? declaration?.packageDigest ?? null,
              signerFingerprint: execution?.signerFingerprint
                ?? declaration?.signerFingerprint
                ?? null,
              contributionId: execution?.contributionId ?? declaration?.contributionId ?? null,
              contributionVersion: execution?.contributionVersion
                ?? declaration?.contributionVersion
                ?? null,
              descriptorVersion: stage.effect.version,
              status: stage.status,
              reason: boundedReason(stage.detail),
            }),
            execution,
          }))
        }
      }
    }
  }
  if (effects.length > MAX_PLUGIN_EXPORT_EFFECTS) {
    throw new RangeError('Plugin export effect count exceeds its bound')
  }
  return Object.freeze({
    document: snapshot.document,
    documentGeneration: snapshot.generation,
    ...(snapshot.project && snapshot.sequenceId
      ? {
          projectTarget: Object.freeze({
            project: snapshot.project,
            sequenceId: snapshot.sequenceId,
          }),
        }
      : {}),
    settings: validatedSettings,
    catalog,
    catalogFingerprint: catalogFingerprint(catalog),
    pluginSnapshot,
    effects: Object.freeze(effects),
    maximumSurface: maximumExportSurface(snapshot.document),
  })
}

function runtimeBlocker(
  effect: FrozenEffect,
  failure: PluginRuntimeFailure,
): PluginExportBlocker {
  return Object.freeze({
    key: effect.fact.key,
    descriptorId: effect.fact.descriptorId,
    pluginId: effect.execution?.pluginId ?? effect.fact.pluginId,
    contributionId: effect.execution?.contributionId ?? effect.fact.contributionId,
    status: `runtime-${failure.code}`,
    reason: boundedReason(failure.message),
  })
}

function staticBlocker(effect: FrozenEffect): PluginExportBlocker | null {
  if (effect.fact.status === 'ready'
    || (effect.fact.status === 'disabled' && !effect.fact.enabled)) return null
  return Object.freeze({
    key: effect.fact.key,
    descriptorId: effect.fact.descriptorId,
    pluginId: effect.fact.pluginId,
    contributionId: effect.fact.contributionId,
    status: effect.fact.status,
    reason: effect.fact.reason,
  })
}

function blockersFor(
  plan: FrozenPlan,
  runtimeFailures: ReadonlyMap<string, PluginRuntimeFailure>,
): readonly PluginExportBlocker[] {
  const blockers: PluginExportBlocker[] = []
  const globalFailure = runtimeFailures.get('plugin-runtime')
  for (const effect of plan.effects) {
    const runtimeFailure = effect.execution
      ? runtimeFailures.get(effect.execution.pluginId) ?? globalFailure
      : undefined
    const blocker = runtimeFailure
      ? runtimeBlocker(effect, runtimeFailure)
      : staticBlocker(effect)
    if (blocker) blockers.push(blocker)
  }
  return Object.freeze(blockers)
}

function executionIdentity(
  execution: PluginVideoEffectExecutionPlan,
): PluginExecutionIdentity {
  return Object.freeze({
    catalogGeneration: execution.catalogGeneration,
    pluginId: execution.pluginId,
    pluginVersion: execution.pluginVersion,
    packageDigest: execution.packageDigest,
    signerFingerprint: execution.signerFingerprint,
    kind: execution.kind,
    contributionId: execution.contributionId,
    contributionVersion: execution.contributionVersion,
    descriptorVersion: execution.descriptorVersion,
    entrypoint: execution.entrypoint,
  })
}

function exportRequirement(
  execution: PluginVideoEffectExecutionPlan,
  surface: FrozenPlan['maximumSurface'],
): PluginExportEffectRequirement {
  return Object.freeze({
    ...executionIdentity(execution),
    maximumSurfaceWidth: surface.width,
    maximumSurfaceHeight: surface.height,
    maximumSurfaceStride: surface.stride,
    maximumSurfaceByteLength: surface.byteLength,
  })
}

function attemptBinding(
  plan: FrozenPlan,
  approved: ReadonlySet<string>,
  runtimeFailures: ReadonlyMap<string, PluginRuntimeFailure>,
): string {
  return JSON.stringify([
    plan.documentGeneration,
    plan.settings,
    plan.catalog.generation,
    plan.catalogFingerprint,
    [...plan.effects].map(({ fact, execution }) => [
      fact.key,
      fact.descriptorId,
      fact.effectType,
      fact.enabled,
      execution?.pluginId ?? fact.pluginId,
      execution?.pluginVersion ?? fact.pluginVersion,
      execution?.packageDigest ?? fact.packageDigest,
      execution?.signerFingerprint ?? fact.signerFingerprint,
      execution?.contributionId ?? fact.contributionId,
      execution?.contributionVersion ?? fact.contributionVersion,
      fact.descriptorVersion,
      (runtimeFailures.get(execution?.pluginId ?? '')
        ?? runtimeFailures.get('plugin-runtime'))?.code ?? fact.status,
      (runtimeFailures.get(execution?.pluginId ?? '')
        ?? runtimeFailures.get('plugin-runtime'))?.message ?? fact.reason,
    ]).toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
    [...approved].toSorted(),
  ])
}

function publicSnapshot(
  plan: FrozenPlan,
  blockers: readonly PluginExportBlocker[],
  runtimeFailures: ReadonlyMap<string, PluginRuntimeFailure>,
): PluginExportAttemptSnapshot {
  return Object.freeze({
    documentGeneration: plan.documentGeneration,
    settings: plan.settings,
    catalogGeneration: plan.catalog.generation,
    effects: Object.freeze(plan.effects.map(({ fact, execution }) => {
      const failure = execution
        ? runtimeFailures.get(execution.pluginId) ?? runtimeFailures.get('plugin-runtime')
        : undefined
      return failure
        ? Object.freeze({
            ...fact,
            status: `runtime-${failure.code}` as const,
            reason: boundedReason(failure.message),
          })
        : fact
    })),
    blockers,
  })
}

function requireExactReview(
  blockers: readonly PluginExportBlocker[],
  blockerKeys: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(blockerKeys) || blockerKeys.length !== blockers.length) {
    fail('invalid-review', 'Review every exact plugin blocker before bypassing export')
  }
  const received = new Set(blockerKeys)
  if (received.size !== blockerKeys.length
    || blockers.some((blocker) => !received.has(blocker.key))) {
    fail('invalid-review', 'Reviewed plugin blockers no longer match this attempt')
  }
  return received
}

function runtimeFailuresFrom(cause: unknown): ReadonlyMap<string, PluginRuntimeFailure> {
  if (cause instanceof PluginExportPreflightError) {
    return new Map(cause.failures.map(({ pluginId, failure }) => [pluginId, failure]))
  }
  if (typeof cause === 'object' && cause !== null && 'failure' in cause) {
    const failure = (cause as { readonly failure?: unknown }).failure
    if (typeof failure === 'object' && failure !== null
      && 'code' in failure && 'message' in failure && 'terminal' in failure) {
      return new Map([['plugin-runtime', failure as PluginRuntimeFailure]])
    }
  }
  throw cause
}

function createExecutor(
  session: PluginExportSession | null,
  signal: AbortSignal,
): VideoEffectStageExecutor {
  let requestId = 0
  return Object.freeze({
    bypassPolicy: 'fail' as const,
    async applyPluginEffect(
      request: PluginVideoEffectApplyRequest,
    ): Promise<PluginVideoEffectApplyResult> {
      try {
        throwIfAborted(signal)
        if (!session) throw new Error('No ready plugin runtime was reserved for this export')
        if (requestId >= Number.MAX_SAFE_INTEGER) {
          throw new Error('Plugin export request id capacity was exhausted')
        }
        requestId++
        const runtimeRequest: PluginEffectApplyRequest = {
          ...executionIdentity(request.execution),
          requestId,
          descriptorId: request.effect.id,
          canonicalParameterJson: request.execution.canonicalParameterJson,
          timelineFrame: request.timelineFrame,
          frameRateNumerator: request.frameRate.num,
          frameRateDenominator: request.frameRate.den,
          width: request.width,
          height: request.height,
          stride: request.stride,
          rgbaBytes: request.rgba,
        }
        const result = await session.apply(runtimeRequest, signal)
        if (result.status === 'failed') {
          if (signal.aborted
            && (result.failure.code === 'aborted' || result.failure.code === 'closed')) {
            fail('aborted', 'Plugin export execution was cancelled', {
              cause: result.failure,
            })
          }
          throw new Error(result.failure.message, { cause: result.failure })
        }
        if (result.rgbaBytes.byteLength !== request.stride * request.height) {
          result.rgbaBytes.fill(0)
          throw new Error('Plugin export returned an invalid RGBA byte length')
        }
        // The trusted runtime normally returns a distinct sandbox-owned buffer.
        // Preserve that invariant for any injected adapter before wiping input.
        const output = result.rgbaBytes.buffer === request.rgba.buffer
          ? result.rgbaBytes.slice()
          : result.rgbaBytes
        return Object.freeze({ status: 'applied', rgba: output })
      } finally {
        // The context-neutral pipeline gives the executor sole ownership of
        // this request copy. Runtime may copy rather than transfer it.
        if (request.rgba.byteLength > 0) request.rgba.fill(0)
      }
    },
  })
}

export function createPluginExportAttemptController(
  dependencies: PluginExportAttemptControllerDependencies,
): PluginExportAttemptController {
  const states = new WeakMap<object, AttemptState>()
  let active: AttemptState | null = null
  const pendingPreparations = new Set<PendingPreparation>()
  let epoch = 0
  let tornDown = false
  let teardownPromise: Promise<void> | null = null

  const beginPreparation = (): PendingPreparation => {
    const abort = new AbortController()
    let finished = false
    let resolveDone!: () => void
    const operation: PendingPreparation = {
      abort,
      done: new Promise<void>((resolve) => { resolveDone = resolve }),
      finish() {
        if (finished) return
        finished = true
        pendingPreparations.delete(operation)
        resolveDone()
      },
    }
    pendingPreparations.add(operation)
    return operation
  }

  const closeState = (state: AttemptState, reason: string): Promise<void> => {
    if (state.closePromise) return state.closePromise
    state.phase = 'closed'
    state.abort.abort()
    const session = state.session
    state.session = null
    state.closePromise = session ? session.close(reason) : Promise.resolve()
    if (active === state) active = null
    return state.closePromise
  }

  const replaceActive = async (reason: string): Promise<number> => {
    const ownEpoch = ++epoch
    const pending = [...pendingPreparations]
    for (const operation of pending) operation.abort.abort()
    await Promise.allSettled(pending.map((operation) => operation.done))
    if (tornDown) fail('closed', 'Plugin export attempt controller is closed')
    if (ownEpoch !== epoch) {
      fail('stale-attempt', 'A newer plugin export attempt replaced this one')
    }
    const previous = active
    active = null
    if (previous) await closeState(previous, reason)
    return ownEpoch
  }

  const assertCurrent = (
    ownEpoch: number,
    plan: FrozenPlan,
    signal?: AbortSignal,
  ): void => {
    throwIfAborted(signal)
    if (tornDown) fail('closed', 'Plugin export attempt controller is closed')
    if (ownEpoch !== epoch) fail('stale-attempt', 'A newer plugin export attempt replaced this one')
    const current = dependencies.getDocumentSnapshot()
    if (
      current.generation !== plan.documentGeneration
      || current.document !== plan.document
      || (plan.projectTarget !== undefined && (
        current.project !== plan.projectTarget.project
        || current.sequenceId !== plan.projectTarget.sequenceId
      ))
    ) {
      fail('stale-attempt', 'The document changed during plugin export preparation')
    }
  }

  const publish = (
    ownEpoch: number,
    plan: FrozenPlan,
    approved: ReadonlySet<string>,
    runtimeFailures: ReadonlyMap<string, PluginRuntimeFailure>,
    session: PluginExportSession | null,
  ): PluginExportAttemptPrepareResult => {
    assertCurrent(ownEpoch, plan)
    const blockers = blockersFor(plan, runtimeFailures)
    const pending = blockers.filter((blocker) => !approved.has(blocker.key))
    const token = Object.freeze({
      kind: pending.length === 0
        ? 'plugin-export-attempt-token' as const
        : 'plugin-export-review-token' as const,
    })
    const state: AttemptState = {
      token,
      plan,
      approvedBlockerKeys: new Set(approved),
      runtimeFailures: new Map(runtimeFailures),
      binding: attemptBinding(plan, approved, runtimeFailures),
      abort: new AbortController(),
      session: pending.length === 0 ? session : null,
      phase: pending.length === 0 ? 'ready' : 'review',
      closePromise: null,
    }
    states.set(token, state)
    active = state
    const snapshot = publicSnapshot(plan, blockers, runtimeFailures)
    return pending.length === 0
      ? Object.freeze({
          status: 'ready',
          token: token as PluginExportAttemptToken,
          snapshot,
        })
      : Object.freeze({
          status: 'blocked',
          reviewToken: token as PluginExportReviewToken,
          snapshot: Object.freeze({ ...snapshot, blockers: Object.freeze(pending) }),
        })
  }

  const runPreparedPreflight = async (
    ownEpoch: number,
    plan: FrozenPlan,
    approved: ReadonlySet<string>,
    knownRuntimeFailures: ReadonlyMap<string, PluginRuntimeFailure>,
    signal?: AbortSignal,
  ): Promise<PluginExportAttemptPrepareResult> => {
    const excludedPlugins = new Set<string>()
    for (const effect of plan.effects) {
      if (approved.has(effect.fact.key) && effect.execution
        && (knownRuntimeFailures.has(effect.execution.pluginId)
          || knownRuntimeFailures.has('plugin-runtime'))) {
        excludedPlugins.add(effect.execution.pluginId)
      }
    }
    const requiredEffects = plan.effects.flatMap(({ fact, execution }) => (
      execution && !approved.has(fact.key) && !excludedPlugins.has(execution.pluginId)
        ? [exportRequirement(execution, plan.maximumSurface)]
        : []
    ))
    let session: PluginExportSession | null = null
    let runtimeFailures = new Map(knownRuntimeFailures)
    if (requiredEffects.length > 0) {
      try {
        session = await dependencies.runtime.preflightExport(
          Object.freeze({ requiredEffects: Object.freeze(requiredEffects) }),
          signal,
        )
      } catch (cause) {
        runtimeFailures = new Map([...runtimeFailures, ...runtimeFailuresFrom(cause)])
      }
    }
    try {
      const terminal = [...runtimeFailures.values()].find((failure) => (
        failure.code === 'aborted' || failure.code === 'closed'
      ))
      if (terminal) fail(
        terminal.code === 'aborted' ? 'aborted' : 'closed',
        terminal.message,
      )
      assertCurrent(ownEpoch, plan, signal)
      const liveCatalog = await dependencies.getDeclarationCatalog(signal)
      assertCurrent(ownEpoch, plan, signal)
      if (liveCatalog.generation !== plan.catalog.generation
        || catalogFingerprint(liveCatalog) !== plan.catalogFingerprint) {
        fail('stale-attempt', 'The plugin catalog changed during export preparation')
      }
      const blockers = blockersFor(plan, runtimeFailures)
      if (blockers.some((blocker) => !approved.has(blocker.key)) && session) {
        await session.close('plugin-export-blocked')
        session = null
      }
      return publish(ownEpoch, plan, approved, runtimeFailures, session)
    } catch (cause) {
      if (session) {
        try {
          await session.close('plugin-export-preflight-failed')
        } catch {
          // The stale/cancelled preparation failure remains primary.
        }
      }
      throw cause
    }
  }

  return {
    async prepare(settings, signal) {
      const ownEpoch = await replaceActive('plugin-export-replaced')
      throwIfAborted(signal)
      const operation = beginPreparation()
      const linked = linkedAbortSignal([signal, operation.abort.signal])
      try {
        const document = dependencies.getDocumentSnapshot()
        const catalog = await dependencies.getDeclarationCatalog(linked.signal)
        const plan = freezePlan(document, settings, catalog)
        assertCurrent(ownEpoch, plan, linked.signal)
        return await runPreparedPreflight(
          ownEpoch,
          plan,
          new Set(),
          new Map(),
          linked.signal,
        )
      } catch (cause) {
        rethrowAsyncFailure(cause, {
          callerSignal: signal,
          internalSignal: linked.signal,
          tornDown,
          stale: ownEpoch !== epoch,
        })
      } finally {
        linked.dispose()
        operation.finish()
      }
    },

    async approveReviewedBlockers(token, blockerKeys, signal) {
      const state = typeof token === 'object' && token !== null ? states.get(token) : undefined
      if (!state || state.phase !== 'review' || active !== state) {
        fail('already-used', 'Plugin export review token is invalid or already used')
      }
      if (attemptBinding(state.plan, state.approvedBlockerKeys, state.runtimeFailures)
        !== state.binding) fail('stale-attempt', 'Plugin export review binding changed')
      const blockers = blockersFor(state.plan, state.runtimeFailures)
        .filter((blocker) => !state.approvedBlockerKeys.has(blocker.key))
      const reviewed = requireExactReview(blockers, blockerKeys)
      const approved = new Set([...state.approvedBlockerKeys, ...reviewed])
      const ownEpoch = await replaceActive('plugin-export-review-consumed')
      const operation = beginPreparation()
      const linked = linkedAbortSignal([signal, operation.abort.signal])
      try {
        return await runPreparedPreflight(
          ownEpoch,
          state.plan,
          approved,
          state.runtimeFailures,
          linked.signal,
        )
      } catch (cause) {
        rethrowAsyncFailure(cause, {
          callerSignal: signal,
          internalSignal: linked.signal,
          tornDown,
          stale: ownEpoch !== epoch,
        })
      } finally {
        linked.dispose()
        operation.finish()
      }
    },

    async consume(token, signal) {
      const state = typeof token === 'object' && token !== null ? states.get(token) : undefined
      if (!state || state.phase !== 'ready' || active !== state) {
        fail('already-used', 'Plugin export attempt token is invalid or already used')
      }
      const consumeEpoch = epoch
      state.phase = 'consumed'
      const linked = linkedAbortSignal([signal, state.abort.signal])
      try {
        throwIfAborted(linked.signal)
        if (attemptBinding(state.plan, state.approvedBlockerKeys, state.runtimeFailures)
          !== state.binding) fail('stale-attempt', 'Plugin export attempt binding changed')
        const current = dependencies.getDocumentSnapshot()
        if (current.generation !== state.plan.documentGeneration
          || current.document !== state.plan.document
          || (state.plan.projectTarget !== undefined && (
            current.project !== state.plan.projectTarget.project
            || current.sequenceId !== state.plan.projectTarget.sequenceId
          ))) {
          fail('stale-attempt', 'The document changed before export started')
        }
        const catalog = await dependencies.getDeclarationCatalog(linked.signal)
        throwIfAborted(linked.signal)
        if (consumeEpoch !== epoch || active !== state || state.phase !== 'consumed') {
          fail('stale-attempt', 'A newer plugin export attempt replaced this one')
        }
        if (catalog.generation !== state.plan.catalog.generation
          || catalogFingerprint(catalog) !== state.plan.catalogFingerprint) {
          fail('stale-attempt', 'The plugin catalog changed before export started')
        }
      } catch (cause) {
        try {
          await closeState(state, 'plugin-export-consume-failed')
        } catch {
          // The consume/cancellation/stale failure remains primary.
        }
        rethrowAsyncFailure(cause, {
          callerSignal: signal,
          internalSignal: linked.signal,
          tornDown,
          stale: consumeEpoch !== epoch || active !== state,
        })
      } finally {
        linked.dispose()
      }
      const session = state.session
      const pluginSnapshot = declarationSnapshot(state.plan.catalog, state.runtimeFailures)
      let closePromise: Promise<void> | null = null
      return Object.freeze({
        document: state.plan.document,
        documentGeneration: state.plan.documentGeneration,
        settings: state.plan.settings,
        pluginSnapshot,
        videoEffectStageExecutor: createExecutor(session, state.abort.signal),
        ...(state.plan.projectTarget
          ? { projectTarget: state.plan.projectTarget }
          : {}),
        close(reason: string) {
          if (closePromise) return closePromise
          closePromise = closeState(state, reason)
          return closePromise
        },
      })
    },

    async close(token, reason) {
      const state = typeof token === 'object' && token !== null ? states.get(token) : undefined
      if (!state) return
      await closeState(state, reason)
    },

    async teardown(reason) {
      if (teardownPromise) return teardownPromise
      tornDown = true
      epoch++
      teardownPromise = (async () => {
        const pending = [...pendingPreparations]
        for (const operation of pending) operation.abort.abort()
        await Promise.allSettled(pending.map((operation) => operation.done))
        const current = active
        active = null
        if (current) await closeState(current, reason)
      })()
      return teardownPromise
    },
  }
}
