/** App-owned, explicit, atomic migration of portable plugin effect descriptors. */

import {
  cloneClipAnimation,
  clipAnimation,
  effectAnimationTracks,
} from '../domain/clipAnimation'
import {
  EFFECT_STACK_LIMITS,
  documentEffectBudgetUsage,
  effectDescriptorBoundsError,
} from '../domain/effectBounds'
import {
  canonicalPluginVideoEffectParameterJson,
  type PluginVideoEffectContributionDeclaration,
  type PluginVideoEffectContributionSnapshot,
} from '../domain/pluginVideoEffectStagePlan'
import type {
  Clip,
  ClipAnimation,
  EffectDescriptor,
  EffectId,
  EffectParamValue,
  TimelineDoc,
} from '../domain/schema'
import type {
  PluginDescriptorMigrationChainRequest,
  PluginDescriptorMigrationResult as PluginDescriptorMigrationRuntimeResult,
} from './pluginRuntimeController'
import { PluginRuntimeError } from './pluginRuntimeController'

export type PluginDescriptorMigrationErrorCode =
  | 'aborted'
  | 'busy'
  | 'invalid-target'
  | 'animated-target'
  | 'unavailable'
  | 'migration-not-required'
  | 'stale'
  | 'runtime-failed'
  | 'invalid-result'
  | 'cleanup-failed'

export class PluginDescriptorMigrationError extends Error {
  readonly code: PluginDescriptorMigrationErrorCode

  constructor(
    code: PluginDescriptorMigrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PluginDescriptorMigrationError'
    this.code = code
  }
}

export interface PluginDescriptorMigrationRequest {
  /** Duplicate-free effect instance ids. Execution order always comes from the document. */
  readonly effectIds: readonly EffectId[]
  readonly signal?: AbortSignal
}

export interface PluginDescriptorMigrationResult {
  readonly status: 'migrated'
  readonly effectIds: readonly EffectId[]
}

export interface PluginDescriptorMigrationController {
  migrate(
    request: PluginDescriptorMigrationRequest,
  ): Promise<PluginDescriptorMigrationResult>
}

export interface PluginMigrationDocumentSnapshot {
  readonly generation: number
  readonly document: TimelineDoc
}

export interface PluginDescriptorMigrationActionSession {
  applyTarget(
    request: {
      readonly targetIndex: number
      readonly requestId: number
    },
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationRuntimeResult>
  close(reason: string): Promise<void>
}

export interface PluginDescriptorMigrationRuntime {
  preflightDescriptorMigrationAction(
    request: {
      readonly targets: readonly (PluginDescriptorMigrationChainRequest & {
        readonly descriptorId: string
      })[]
    },
    signal?: AbortSignal,
  ): Promise<PluginDescriptorMigrationActionSession>
}

export interface PluginDescriptorMigrationControllerDependencies {
  getDocumentSnapshot(): PluginMigrationDocumentSnapshot
  getContributionSnapshot(): PluginVideoEffectContributionSnapshot
  readonly runtime: PluginDescriptorMigrationRuntime
  commitDocument(
    expectedGeneration: number,
    expectedDocument: TimelineDoc,
    doc: TimelineDoc,
  ): boolean
}

interface FrozenTarget {
  readonly trackIndex: number
  readonly clipIndex: number
  readonly effectIndex: number
  readonly clipId: string
  readonly effect: EffectDescriptor
  readonly animation: ClipAnimation
  readonly declaration: PluginVideoEffectContributionDeclaration
}

function fail(
  code: PluginDescriptorMigrationErrorCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new PluginDescriptorMigrationError(code, message, options)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail('aborted', 'Plugin descriptor migration was cancelled')
}

function hasEffectAnimation(clip: Clip, effectId: EffectId): boolean {
  return effectAnimationTracks(clipAnimation(clip)).some(
    (track) => track.effectId === effectId,
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function serializableEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (
    typeof left !== 'object'
    || left === null
    || typeof right !== 'object'
    || right === null
    || Array.isArray(left) !== Array.isArray(right)
  ) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => serializableEqual(value, right[index]))
  }
  const leftRecord = left as Readonly<Record<string, unknown>>
  const rightRecord = right as Readonly<Record<string, unknown>>
  const leftKeys = Object.keys(leftRecord).toSorted()
  const rightKeys = Object.keys(rightRecord).toSorted()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && serializableEqual(leftRecord[key], rightRecord[key])
    ))
}

function cloneEffect(effect: EffectDescriptor): EffectDescriptor {
  return deepFreeze({ ...effect, params: { ...effect.params } })
}

function freezeTargets(
  doc: TimelineDoc,
  snapshot: PluginVideoEffectContributionSnapshot,
  effectIds: readonly EffectId[],
): readonly FrozenTarget[] {
  if (
    !Array.isArray(effectIds)
    || effectIds.length === 0
    || effectIds.length > EFFECT_STACK_LIMITS.maxTotalEffects
  ) fail('invalid-target', 'Choose one or more bounded plugin effect instances')

  const requested = new Set<EffectId>()
  for (const effectId of effectIds) {
    if (typeof effectId !== 'string' || effectId.length === 0 || requested.has(effectId)) {
      fail('invalid-target', 'Plugin migration targets must be non-empty and duplicate-free')
    }
    requested.add(effectId)
  }

  const declarations = new Map(
    snapshot.declarations.map((declaration) => [declaration.effectType, declaration]),
  )
  const found = new Map<EffectId, FrozenTarget>()
  const targets: FrozenTarget[] = []

  for (const [trackIndex, track] of doc.tracks.entries()) {
    for (const [clipIndex, clip] of track.clips.entries()) {
      for (const [effectIndex, effect] of clip.effects.entries()) {
        if (!requested.has(effect.id)) continue
        if (found.has(effect.id)) {
          fail('invalid-target', 'A migration target is not unique in the document')
        }
        const declaration = declarations.get(effect.type)
        if (!declaration) {
          fail('unavailable', 'A selected plugin contribution is not installed')
        }
        if (declaration.availability !== 'ready') {
          fail('unavailable', 'A selected plugin contribution is not ready for migration')
        }
        if (effect.version >= declaration.descriptorVersion) {
          fail(
            'migration-not-required',
            effect.version === declaration.descriptorVersion
              ? 'A selected plugin descriptor is already current'
              : 'A selected plugin descriptor is newer than the installed contribution',
          )
        }
        if (hasEffectAnimation(clip, effect.id)) {
          fail(
            'animated-target',
            'Animated plugin descriptors cannot be migrated by the version 1 contract',
          )
        }
        const target: FrozenTarget = Object.freeze({
          trackIndex,
          clipIndex,
          effectIndex,
          clipId: clip.id,
          effect: cloneEffect(effect),
          animation: deepFreeze(cloneClipAnimation(clipAnimation(clip))),
          declaration,
        })
        found.set(effect.id, target)
        targets.push(target)
      }
    }
  }

  if (found.size !== requested.size) {
    fail('invalid-target', 'A selected plugin effect is no longer present')
  }
  return Object.freeze(targets)
}

function targetMatches(doc: TimelineDoc, target: FrozenTarget): boolean {
  const clip = doc.tracks[target.trackIndex]?.clips[target.clipIndex]
  const effect = clip?.effects[target.effectIndex]
  return clip?.id === target.clipId
    && effect !== undefined
    && serializableEqual(effect, target.effect)
    && serializableEqual(clipAnimation(clip), target.animation)
}

function assertStartingState(
  dependencies: PluginDescriptorMigrationControllerDependencies,
  starting: PluginMigrationDocumentSnapshot,
  targets: readonly FrozenTarget[],
): void {
  const current = dependencies.getDocumentSnapshot()
  if (
    current.generation !== starting.generation
    || targets.some((target) => !targetMatches(current.document, target))
  ) fail('stale', 'The project changed while plugin migration was running')
}

function parametersMatchDeclaration(
  value: Readonly<Record<string, EffectParamValue>>,
  declaration: PluginVideoEffectContributionDeclaration,
): boolean {
  const keys = Object.keys(value).toSorted()
  const expectedKeys = declaration.parameters.map((parameter) => parameter.key).toSorted()
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) return false
  return declaration.parameters.every((parameter) => {
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

function migratedDescriptor(
  target: FrozenTarget,
  result: PluginDescriptorMigrationRuntimeResult,
): EffectDescriptor {
  if (result.status !== 'migrated') {
    fail('runtime-failed', 'The plugin rejected its descriptor migration')
  }
  if (
    result.descriptorVersion !== target.declaration.descriptorVersion
    || !parametersMatchDeclaration(result.parameters, target.declaration)
  ) fail('invalid-result', 'The plugin returned an invalid migrated descriptor')

  let canonical: string
  try {
    canonical = canonicalPluginVideoEffectParameterJson(result.parameters)
  } catch (cause) {
    fail('invalid-result', 'The plugin returned invalid migration parameters', { cause })
  }
  if (canonical !== result.canonicalParameterJson) {
    fail('invalid-result', 'The plugin returned non-canonical migration parameters')
  }

  const descriptor: EffectDescriptor = {
    id: target.effect.id,
    type: target.effect.type,
    version: target.declaration.descriptorVersion,
    enabled: target.effect.enabled,
    params: { ...result.parameters },
  }
  const boundsError = effectDescriptorBoundsError(descriptor)
  if (boundsError) {
    fail('invalid-result', 'The migrated descriptor exceeds project bounds')
  }
  return descriptor
}

function replaceTarget(
  doc: TimelineDoc,
  target: FrozenTarget,
  effect: EffectDescriptor,
): TimelineDoc {
  const currentTrack = doc.tracks[target.trackIndex]
  const currentClip = currentTrack?.clips[target.clipIndex]
  const currentEffect = currentClip?.effects[target.effectIndex]
  if (
    !currentTrack
    || !currentClip
    || !currentEffect
    || currentEffect.id !== target.effect.id
    || currentEffect.type !== target.effect.type
    || currentEffect.version !== target.effect.version
  ) fail('stale', 'The project changed while plugin migration was running')

  const effects = currentClip.effects.slice()
  effects[target.effectIndex] = effect
  const clips = currentTrack.clips.slice()
  clips[target.clipIndex] = { ...currentClip, effects }
  const tracks = doc.tracks.slice()
  tracks[target.trackIndex] = { ...currentTrack, clips }
  return { ...doc, tracks }
}

function finalDocumentBudgetError(doc: TimelineDoc): string | null {
  const usage = documentEffectBudgetUsage(doc)
  if (usage.effects > EFFECT_STACK_LIMITS.maxTotalEffects) {
    return 'The migrated project exceeds the total effect limit'
  }
  if (usage.params > EFFECT_STACK_LIMITS.maxTotalEffectParams) {
    return 'The migrated project exceeds the total effect-parameter limit'
  }
  if (usage.stringCharacters > EFFECT_STACK_LIMITS.maxTotalEffectStringCharacters) {
    return 'The migrated project exceeds the total effect-string limit'
  }
  return null
}

async function closeMigrationAction(
  action: PluginDescriptorMigrationActionSession,
  reason: string,
  primaryFailure: unknown,
): Promise<void> {
  try {
    await action.close(reason)
  } catch (cause) {
    if (primaryFailure === undefined) {
      fail('cleanup-failed', 'Plugin migration action cleanup did not finish', { cause })
    }
  }
}

function migrationChainRequest(
  target: FrozenTarget,
  snapshot: PluginVideoEffectContributionSnapshot,
): PluginDescriptorMigrationChainRequest & { readonly descriptorId: string } {
  let canonicalParameterJson: string
  try {
    canonicalParameterJson = canonicalPluginVideoEffectParameterJson(target.effect.params)
  } catch (cause) {
    fail('invalid-target', 'The original plugin descriptor parameters are invalid', { cause })
  }
  const declaration = target.declaration
  return Object.freeze({
    descriptorId: target.effect.id,
    catalogGeneration: snapshot.catalogGeneration,
    pluginId: declaration.pluginId,
    pluginVersion: declaration.pluginVersion,
    packageDigest: declaration.packageDigest,
    signerFingerprint: declaration.signerFingerprint,
    kind: declaration.kind,
    contributionId: declaration.contributionId,
    contributionVersion: declaration.contributionVersion,
    descriptorVersion: declaration.descriptorVersion,
    entrypoint: declaration.entrypoint,
    fromDescriptorVersion: target.effect.version,
    canonicalParameterJson,
    hasAnimatedParameters: false,
  })
}

async function migrateTarget(
  target: FrozenTarget,
  index: number,
  action: PluginDescriptorMigrationActionSession,
  signal: AbortSignal | undefined,
): Promise<EffectDescriptor> {
  throwIfAborted(signal)
  try {
    const result = await action.applyTarget({ targetIndex: index, requestId: 1 }, signal)
    throwIfAborted(signal)
    return migratedDescriptor(target, result)
  } catch (cause) {
    if (cause instanceof PluginDescriptorMigrationError) throw cause
    if (signal?.aborted) fail('aborted', 'Plugin descriptor migration was cancelled')
    fail('runtime-failed', 'The plugin descriptor migration failed', { cause })
  }
}

export function createPluginDescriptorMigrationController(
  dependencies: PluginDescriptorMigrationControllerDependencies,
): PluginDescriptorMigrationController {
  let active = false
  const controller: PluginDescriptorMigrationController = {
    async migrate(request: PluginDescriptorMigrationRequest) {
      if (active) fail('busy', 'Another plugin descriptor migration is already running')
      active = true
      try {
        throwIfAborted(request.signal)
        const starting = dependencies.getDocumentSnapshot()
        if (!Number.isSafeInteger(starting.generation) || starting.generation < 0) {
          fail('stale', 'The project generation is invalid')
        }
        const snapshot = dependencies.getContributionSnapshot()
        const targets = freezeTargets(starting.document, snapshot, request.effectIds)
        const runtimeTargets = Object.freeze(targets.map((target) => (
          migrationChainRequest(target, snapshot)
        )))
        assertStartingState(dependencies, starting, targets)

        let action: PluginDescriptorMigrationActionSession
        try {
          action = await dependencies.runtime.preflightDescriptorMigrationAction(
            { targets: runtimeTargets },
            request.signal,
          )
        } catch (cause) {
          if (request.signal?.aborted) {
            fail('aborted', 'Plugin descriptor migration was cancelled')
          }
          if (cause instanceof PluginRuntimeError && cause.failure.code === 'busy') {
            fail('busy', 'The plugin migration runtime has no available action slot', { cause })
          }
          fail('runtime-failed', 'Plugin migration preflight failed', { cause })
        }

        let actionClosed = false
        let primaryFailure: unknown
        let stagedDocument = starting.document
        try {
          assertStartingState(dependencies, starting, targets)

          for (const [index, target] of targets.entries()) {
            throwIfAborted(request.signal)
            assertStartingState(dependencies, starting, targets)
            const migrated = await migrateTarget(
              target,
              index,
              action,
              request.signal,
            )
            assertStartingState(dependencies, starting, targets)
            stagedDocument = replaceTarget(stagedDocument, target, migrated)
          }

          throwIfAborted(request.signal)
          const budgetError = finalDocumentBudgetError(stagedDocument)
          if (budgetError) fail('invalid-result', budgetError)
          const currentSnapshot = dependencies.getContributionSnapshot()
          if (currentSnapshot.catalogGeneration !== snapshot.catalogGeneration) {
            fail('stale', 'The plugin catalog changed before migration commit')
          }
          assertStartingState(dependencies, starting, targets)

          actionClosed = true
          await closeMigrationAction(action, 'migration-complete', undefined)
          if (!dependencies.commitDocument(
            starting.generation,
            starting.document,
            stagedDocument,
          )) fail('stale', 'The project changed before the migration commit')
          return Object.freeze({
            status: 'migrated' as const,
            effectIds: Object.freeze(targets.map((target) => target.effect.id)),
          })
        } catch (cause) {
          primaryFailure = cause
          throw cause
        } finally {
          if (!actionClosed) {
            actionClosed = true
            await closeMigrationAction(action, 'migration-failed', primaryFailure)
          }
        }
      } finally {
        active = false
      }
    },
  }
  return Object.freeze(controller)
}
