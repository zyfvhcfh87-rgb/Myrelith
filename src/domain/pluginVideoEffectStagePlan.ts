/** Pure, serializable authored-order planning for built-in and plugin effects. */

import {
  clipAnimation,
  clipAnimationValidationError,
  effectAnimationTracks,
  evaluateAnimationTrack,
} from './clipAnimation'
import { EFFECT_STACK_LIMITS, isUnsafeEffectParamKey } from './effectBounds'
import {
  CANVAS_FILTER_EFFECT_CAPABILITY,
  CANVAS_PIXEL_EFFECT_CAPABILITY,
  cloneEffectDescriptor,
  effectRegistration,
  resolveEffectStack,
  type CanvasPixelEffect,
  type EffectCapability,
  type EffectResolutionStatus,
} from './effectStack'
import {
  PLUGIN_ENTRYPOINT_PATTERN,
  PLUGIN_ID_PATTERN,
  PLUGIN_LOCAL_IDENTIFIER_PATTERN,
  PLUGIN_MANIFEST_LIMITS,
  PLUGIN_SEMANTIC_VERSION_PATTERN,
  pluginBoundedTextProblem,
  pluginEffectType,
  pluginNumberParameterRangeProblem,
  type PluginParameter,
} from './pluginManifest'
import { utf8ByteLength } from './documentMemory'
import { animationParameterIdentityMatches } from './animationParameterIdentity'
import type { Clip, EffectDescriptor, EffectParamValue } from './schema'

export const PLUGIN_VIDEO_EFFECT_STAGE_LIMITS = Object.freeze({
  maxCatalogContributions: 1_024,
  maxStatusDetailCharacters: 512,
})

export type PluginVideoEffectContributionAvailability =
  | 'ready'
  | 'disabled'
  | 'incompatible'
  | 'failed'
  | 'revoked'
  | 'untrusted'
  | 'safe-mode'
  | 'quarantined'

/** App-owned package/trust facts projected into a bounded data-only declaration. */
export interface PluginVideoEffectContributionDeclarationInput {
  readonly signerFingerprint: string
  readonly packageDigest: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly kind: 'video-effect'
  readonly contributionVersion: number
  readonly contributionId: string
  readonly contributionName: string
  readonly descriptorVersion: number
  readonly entrypoint: string
  readonly parameters: readonly PluginParameter[]
  readonly availability: PluginVideoEffectContributionAvailability
  readonly detail: string
}

export interface PluginVideoEffectContributionDeclaration
  extends PluginVideoEffectContributionDeclarationInput {
  readonly catalogGeneration: number
  readonly effectType: string
}

/** Immutable catalog snapshot; it owns no package bytes, handles, or runtime objects. */
export interface PluginVideoEffectContributionSnapshot {
  readonly catalogGeneration: number
  readonly declarations: readonly PluginVideoEffectContributionDeclaration[]
}

export interface PluginVideoEffectExecutionPlan {
  readonly catalogGeneration: number
  readonly signerFingerprint: string
  readonly packageDigest: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly kind: 'video-effect'
  readonly contributionVersion: number
  readonly contributionId: string
  readonly descriptorVersion: number
  readonly entrypoint: string
  readonly parameterRecord: Readonly<Record<string, EffectParamValue>>
  /** RFC 8785 text; the runtime performs the sole UTF-8 encoding. */
  readonly canonicalParameterJson: string
}

export interface BuiltInVideoEffectStage {
  readonly kind: 'builtin'
  readonly effect: EffectDescriptor
  readonly label: string
  readonly status: EffectResolutionStatus
  readonly detail: string
  readonly pixelEffect: CanvasPixelEffect | null
}

export type PluginVideoEffectStageStatus =
  | 'ready'
  | 'missing'
  | 'disabled'
  | 'incompatible'
  | 'version-mismatch'
  | 'invalid'
  | 'unsupported'
  | 'failed'
  | 'revoked'
  | 'untrusted'
  | 'safe-mode'
  | 'quarantined'

export interface PluginVideoEffectStage {
  readonly kind: 'plugin'
  readonly effect: EffectDescriptor
  readonly label: string
  readonly status: PluginVideoEffectStageStatus
  readonly detail: string
  /** Null is the fail-closed guarantee for every non-ready stage. */
  readonly execution: PluginVideoEffectExecutionPlan | null
}

export type VideoEffectStage = BuiltInVideoEffectStage | PluginVideoEffectStage

export interface VideoEffectStagePlan {
  readonly stages: readonly VideoEffectStage[]
  /** True only when a ready plugin requires the unified authored-order pixel path. */
  readonly requiresOrderedPixelPath: boolean
}

export interface VideoEffectStagePlanner {
  readonly planClip: (clip: Clip, timelineFrame: number) => VideoEffectStagePlan | null
}

const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/u

function failSnapshot(message: string): never {
  throw new TypeError(`Invalid plugin contribution snapshot: ${message}`)
}

function boundedText(value: string, name: string, maximum: number): string {
  if (pluginBoundedTextProblem(value, maximum)) {
    failSnapshot(`${name} is missing or exceeds ${maximum} characters`)
  }
  return value
}

function cloneParameter(parameter: PluginParameter, index: number): PluginParameter {
  const path = `parameters[${index}]`
  const key = boundedText(
    parameter.key,
    `${path}.key`,
    PLUGIN_MANIFEST_LIMITS.maxIdentifierCharacters,
  )
  if (!PLUGIN_LOCAL_IDENTIFIER_PATTERN.test(key) || isUnsafeEffectParamKey(key)) {
    failSnapshot(`${path}.key is not a safe local identifier`)
  }
  const name = boundedText(
    parameter.name,
    `${path}.name`,
    PLUGIN_MANIFEST_LIMITS.maxNameCharacters,
  )
  if (parameter.kind === 'number') {
    const values = [parameter.default, parameter.min, parameter.max, parameter.step]
    if (values.some((value) => (
      !Number.isFinite(value)
      || Math.abs(value) > EFFECT_STACK_LIMITS.maxFiniteMagnitude
    ))) failSnapshot(`${path} contains an out-of-range number`)
    if (
      pluginNumberParameterRangeProblem(
        parameter.min,
        parameter.max,
        parameter.default,
        parameter.step,
      )
      || typeof parameter.animatable !== 'boolean'
    ) failSnapshot(`${path} is not a valid number declaration`)
    return Object.freeze({
      key,
      name,
      kind: 'number' as const,
      default: parameter.default,
      min: parameter.min,
      max: parameter.max,
      step: parameter.step,
      animatable: parameter.animatable,
    })
  }
  if (parameter.kind === 'boolean') {
    if (typeof parameter.default !== 'boolean') {
      failSnapshot(`${path}.default must be boolean`)
    }
    return Object.freeze({ key, name, kind: 'boolean' as const, default: parameter.default })
  }
  if (parameter.kind !== 'enum') failSnapshot(`${path}.kind is unsupported`)
  if (
    !Array.isArray(parameter.options)
    || parameter.options.length === 0
    || parameter.options.length > PLUGIN_MANIFEST_LIMITS.maxEnumOptions
  ) failSnapshot(`${path}.options is outside the enum bound`)
  const values = new Set<string>()
  const options = parameter.options.map((option, optionIndex) => {
    const value = boundedText(
      option.value,
      `${path}.options[${optionIndex}].value`,
      PLUGIN_MANIFEST_LIMITS.maxIdentifierCharacters,
    )
    if (!PLUGIN_LOCAL_IDENTIFIER_PATTERN.test(value) || values.has(value)) {
      failSnapshot(`${path}.options[${optionIndex}].value is invalid or duplicated`)
    }
    values.add(value)
    return Object.freeze({
      value,
      name: boundedText(
        option.name,
        `${path}.options[${optionIndex}].name`,
        PLUGIN_MANIFEST_LIMITS.maxNameCharacters,
      ),
    })
  })
  if (!values.has(parameter.default)) failSnapshot(`${path}.default is not a declared option`)
  return Object.freeze({
    key,
    name,
    kind: 'enum' as const,
    default: parameter.default,
    options: Object.freeze(options),
  })
}

/**
 * Clone and freeze trusted app-layer declarations before any frame planning.
 * Invalid or oversized data fails closed instead of entering the hot path.
 */
export function createPluginVideoEffectContributionSnapshot(
  catalogGeneration: number,
  inputs: readonly PluginVideoEffectContributionDeclarationInput[],
): PluginVideoEffectContributionSnapshot {
  if (!Number.isSafeInteger(catalogGeneration) || catalogGeneration < 0) {
    failSnapshot('catalogGeneration must be a non-negative safe integer')
  }
  if (
    !Array.isArray(inputs)
    || inputs.length > PLUGIN_VIDEO_EFFECT_STAGE_LIMITS.maxCatalogContributions
  ) failSnapshot('catalog contribution count exceeds its bound')
  const effectTypes = new Set<string>()
  const declarations = inputs.map((input, index) => {
    if (!SHA256_IDENTITY.test(input.signerFingerprint)) {
      failSnapshot(`declarations[${index}].signerFingerprint is invalid`)
    }
    if (!SHA256_IDENTITY.test(input.packageDigest)) {
      failSnapshot(`declarations[${index}].packageDigest is invalid`)
    }
    const pluginId = boundedText(
      input.pluginId,
      `declarations[${index}].pluginId`,
      PLUGIN_MANIFEST_LIMITS.maxPluginIdCharacters,
    )
    if (!PLUGIN_ID_PATTERN.test(pluginId)) failSnapshot(`declarations[${index}].pluginId is invalid`)
    if (input.kind !== 'video-effect') {
      failSnapshot(`declarations[${index}].kind is not a video effect`)
    }
    if (
      !Number.isSafeInteger(input.contributionVersion)
      || input.contributionVersion < 1
      || input.contributionVersion > PLUGIN_MANIFEST_LIMITS.maxApiVersion
    ) failSnapshot(`declarations[${index}].contributionVersion is invalid`)
    const contributionId = boundedText(
      input.contributionId,
      `declarations[${index}].contributionId`,
      PLUGIN_MANIFEST_LIMITS.maxIdentifierCharacters,
    )
    if (!PLUGIN_LOCAL_IDENTIFIER_PATTERN.test(contributionId)) {
      failSnapshot(`declarations[${index}].contributionId is invalid`)
    }
    const effectType = pluginEffectType(pluginId, contributionId)
    if (effectTypes.has(effectType)) failSnapshot(`duplicate declaration ${effectType}`)
    effectTypes.add(effectType)
    if (
      !Number.isSafeInteger(input.descriptorVersion)
      || input.descriptorVersion < 1
      || input.descriptorVersion > PLUGIN_MANIFEST_LIMITS.maxDescriptorVersion
    ) failSnapshot(`declarations[${index}].descriptorVersion is invalid`)
    const entrypoint = boundedText(
      input.entrypoint,
      `declarations[${index}].entrypoint`,
      PLUGIN_MANIFEST_LIMITS.maxEntrypointCharacters,
    )
    if (!PLUGIN_ENTRYPOINT_PATTERN.test(entrypoint)) {
      failSnapshot(`declarations[${index}].entrypoint is invalid`)
    }
    if (!([
      'ready',
      'disabled',
      'incompatible',
      'failed',
      'revoked',
      'untrusted',
      'safe-mode',
      'quarantined',
    ] as const).includes(input.availability)) {
      failSnapshot(`declarations[${index}].availability is invalid`)
    }
    if (
      !Array.isArray(input.parameters)
      || input.parameters.length > PLUGIN_MANIFEST_LIMITS.maxParametersPerContribution
    ) failSnapshot(`declarations[${index}].parameters exceeds its bound`)
    const parameterKeys = new Set<string>()
    const parameters = input.parameters.map((
      parameter: PluginParameter,
      parameterIndex: number,
    ) => {
      const cloned = cloneParameter(parameter, parameterIndex)
      if (parameterKeys.has(cloned.key)) failSnapshot(`duplicate parameter ${cloned.key}`)
      parameterKeys.add(cloned.key)
      return cloned
    })
    return Object.freeze({
      catalogGeneration,
      signerFingerprint: input.signerFingerprint,
      packageDigest: input.packageDigest,
      pluginId,
      pluginVersion: boundedText(
        input.pluginVersion,
        `declarations[${index}].pluginVersion`,
        PLUGIN_MANIFEST_LIMITS.maxVersionCharacters,
      ),
      kind: input.kind,
      contributionVersion: input.contributionVersion,
      contributionId,
      contributionName: boundedText(
        input.contributionName,
        `declarations[${index}].contributionName`,
        PLUGIN_MANIFEST_LIMITS.maxNameCharacters,
      ),
      descriptorVersion: input.descriptorVersion,
      entrypoint,
      parameters: Object.freeze(parameters),
      availability: input.availability,
      detail: boundedText(
        input.detail,
        `declarations[${index}].detail`,
        PLUGIN_VIDEO_EFFECT_STAGE_LIMITS.maxStatusDetailCharacters,
      ),
      effectType,
    })
  })
  for (const [index, declaration] of declarations.entries()) {
    if (!PLUGIN_SEMANTIC_VERSION_PATTERN.test(declaration.pluginVersion)) {
      failSnapshot(`declarations[${index}].pluginVersion is invalid`)
    }
  }
  return Object.freeze({ catalogGeneration, declarations: Object.freeze(declarations) })
}

/** RFC 8785 for the v1 record's restricted ASCII-keyed primitive vocabulary. */
export function canonicalPluginVideoEffectParameterJson(
  record: Readonly<Record<string, EffectParamValue>>,
): string {
  const fields = Object.keys(record).toSorted().map((key) => {
    const value = record[key]
    if (!PLUGIN_LOCAL_IDENTIFIER_PATTERN.test(key) || isUnsafeEffectParamKey(key)) {
      throw new TypeError('Plugin parameter record contains an invalid key')
    }
    if (
      typeof value !== 'boolean'
      && typeof value !== 'string'
      && (typeof value !== 'number' || !Number.isFinite(value))
    ) throw new TypeError(`Plugin parameter record ${key} is not a finite primitive`)
    if (typeof value === 'string' && !PLUGIN_LOCAL_IDENTIFIER_PATTERN.test(value)) {
      throw new TypeError(`Plugin parameter record ${key} is not a local identifier`)
    }
    const encodedValue = JSON.stringify(value)
    if (encodedValue === undefined) throw new TypeError(`Plugin parameter record ${key} is invalid`)
    return `${JSON.stringify(key)}:${encodedValue}`
  })
  const canonical = `{${fields.join(',')}}`
  if (utf8ByteLength(canonical) > PLUGIN_MANIFEST_LIMITS.maxCanonicalParameterBytes) {
    throw new RangeError('Plugin parameter record exceeds the canonical byte bound')
  }
  return canonical
}

function frozenEffect(effect: EffectDescriptor): EffectDescriptor {
  const clone = cloneEffectDescriptor(effect)
  Object.freeze(clone.params)
  return Object.freeze(clone)
}

function frozenPixelEffect(effect: CanvasPixelEffect | null): CanvasPixelEffect | null {
  if (effect === null) return null
  // Every variant is exactly { kind, params }; the cast restores the
  // kind/params pairing that one generic rebuild cannot express.
  return Object.freeze({
    kind: effect.kind,
    params: Object.freeze({ ...effect.params }),
  }) as CanvasPixelEffect
}

const BUILT_IN_STAGE_CAPABILITIES: ReadonlySet<EffectCapability> = new Set<EffectCapability>([
  CANVAS_FILTER_EFFECT_CAPABILITY,
  CANVAS_PIXEL_EFFECT_CAPABILITY,
])

function builtInStage(effect: EffectDescriptor): BuiltInVideoEffectStage {
  const cloned = cloneEffectDescriptor(effect)
  const resolution = resolveEffectStack([cloned], BUILT_IN_STAGE_CAPABILITIES)[0]
  if (!resolution) throw new Error('Built-in effect resolution returned no stage')
  const registration = effectRegistration(cloned.type)
  const pixelEffect = resolution.status === 'ready'
    ? registration?.pixelEffect(cloned) ?? null
    : null
  return Object.freeze({
    kind: 'builtin',
    effect: frozenEffect(cloned),
    label: resolution.label,
    status: resolution.status,
    detail: resolution.detail,
    pixelEffect: frozenPixelEffect(pixelEffect),
  })
}

function pluginTypeIsWellFormed(type: string): boolean {
  if (!type.startsWith('plugin:')) return false
  const separator = type.lastIndexOf('/')
  if (separator <= 'plugin:'.length || separator === type.length - 1) return false
  const pluginId = type.slice('plugin:'.length, separator)
  const contributionId = type.slice(separator + 1)
  return PLUGIN_ID_PATTERN.test(pluginId) && PLUGIN_LOCAL_IDENTIFIER_PATTERN.test(contributionId)
}

function unavailablePluginStage(
  effect: EffectDescriptor,
  label: string,
  status: Exclude<PluginVideoEffectStageStatus, 'ready'>,
  detail: string,
): PluginVideoEffectStage {
  return Object.freeze({
    kind: 'plugin',
    effect: frozenEffect(effect),
    label,
    status,
    detail,
    execution: null,
  })
}

/** One snapshot declaration with its parameter keys indexed once per planner. */
interface IndexedDeclaration {
  readonly declaration: PluginVideoEffectContributionDeclaration
  readonly parameterKeys: ReadonlySet<string>
}

function pluginStage(
  effect: EffectDescriptor,
  clip: Clip,
  timelineFrame: number,
  indexed: IndexedDeclaration | undefined,
  clipAnimationIsValid: () => boolean,
): PluginVideoEffectStage {
  const declaration = indexed?.declaration
  if (!pluginTypeIsWellFormed(effect.type)) {
    return unavailablePluginStage(
      effect,
      effect.type || 'Unknown plugin effect',
      'invalid',
      'The plugin effect type is malformed; its data is preserved.',
    )
  }
  if (!indexed || !declaration) {
    return unavailablePluginStage(
      effect,
      effect.type,
      'missing',
      'The plugin contribution is not installed; its data is preserved.',
    )
  }
  if (declaration.availability !== 'ready') {
    return unavailablePluginStage(
      effect,
      declaration.contributionName,
      declaration.availability,
      declaration.detail,
    )
  }
  if (effect.version !== declaration.descriptorVersion) {
    return unavailablePluginStage(
      effect,
      declaration.contributionName,
      'version-mismatch',
      `Descriptor version ${effect.version} does not match installed version ${declaration.descriptorVersion}; its data is preserved.`,
    )
  }
  const unknownKey = Object.keys(effect.params).find((key) => !indexed.parameterKeys.has(key))
  if (unknownKey) {
    return unavailablePluginStage(
      effect,
      declaration.contributionName,
      'unsupported',
      `Parameter ${unknownKey} is not declared by this installed contribution; its data is preserved.`,
    )
  }
  const record: Record<string, EffectParamValue> = {}
  for (const parameter of declaration.parameters) {
    const ownsValue = Object.prototype.hasOwnProperty.call(effect.params, parameter.key)
    const value = ownsValue ? effect.params[parameter.key] : parameter.default
    const valid = parameter.kind === 'number'
      ? typeof value === 'number'
        && Number.isFinite(value)
        && value >= parameter.min
        && value <= parameter.max
      : parameter.kind === 'boolean'
        ? typeof value === 'boolean'
        : typeof value === 'string'
          && parameter.options.some((option) => option.value === value)
    if (!valid) {
      return unavailablePluginStage(
        effect,
        declaration.contributionName,
        'invalid',
        `Parameter ${parameter.key} does not match its installed declaration; the effect is bypassed.`,
      )
    }
    record[parameter.key] = value
  }
  let animationDetail: string | null = null
  const animation = clipAnimation(clip)
  if (clip.title !== undefined && effectAnimationTracks(animation).some((track) => track.effectId === effect.id)) {
    animationDetail = 'Plugin animation is unavailable on titles; stored keys are preserved and static parameters are used.'
  } else if (clipAnimationIsValid()) {
    const localFrame = timelineFrame - clip.timelineRange.startFrame
    if (Number.isSafeInteger(localFrame)) {
      for (const parameter of declaration.parameters) {
        if (parameter.kind !== 'number' || !parameter.animatable) continue
        const track = effectAnimationTracks(animation).find((candidate) => (
          candidate.effectId === effect.id && candidate.parameter === parameter.key
        ))
        if (!track) continue
        if (!animationParameterIdentityMatches(track.parameterIdentity, declaration)) {
          animationDetail = track.parameterIdentity === undefined
            ? 'Plugin animation identity is unverified; keys are preserved and static parameters are used. Bind explicitly to the current declaration.'
            : 'Plugin animation identity does not match the installed package; keys are preserved and static parameters are used.'
          continue
        }
        if (track.keyframes.some((keyframe) => (
          keyframe.value < parameter.min || keyframe.value > parameter.max
        ))) continue
        const fallback = record[parameter.key]
        if (typeof fallback !== 'number') continue
        const value = evaluateAnimationTrack(track, localFrame, fallback)
        if (Number.isFinite(value) && value >= parameter.min && value <= parameter.max) {
          record[parameter.key] = value
        }
      }
    }
  }
  if (!effect.enabled) {
    return unavailablePluginStage(
      effect,
      declaration.contributionName,
      'disabled',
      'Bypassed by the effect toggle.',
    )
  }
  const parameterRecord = Object.freeze({ ...record })
  const execution = Object.freeze({
    catalogGeneration: declaration.catalogGeneration,
    signerFingerprint: declaration.signerFingerprint,
    packageDigest: declaration.packageDigest,
    pluginId: declaration.pluginId,
    pluginVersion: declaration.pluginVersion,
    kind: declaration.kind,
    contributionVersion: declaration.contributionVersion,
    contributionId: declaration.contributionId,
    descriptorVersion: declaration.descriptorVersion,
    entrypoint: declaration.entrypoint,
    parameterRecord,
    canonicalParameterJson: canonicalPluginVideoEffectParameterJson(parameterRecord),
  })
  return Object.freeze({
    kind: 'plugin',
    effect: frozenEffect(effect),
    label: declaration.contributionName,
    status: 'ready',
    detail: animationDetail ?? declaration.detail,
    execution,
  })
}

function hasPluginPrefix(effect: EffectDescriptor): boolean {
  return effect.type.startsWith('plugin:')
}

function resolveWithCatalog(
  clip: Clip,
  timelineFrame: number,
  declarations: ReadonlyMap<string, IndexedDeclaration>,
): VideoEffectStagePlan | null {
  if (!clip.effects.some(hasPluginPrefix)) return null
  // Validated at most once per call, however many plugin effects the clip has.
  let animationValid: boolean | undefined
  const clipAnimationIsValid = () => (
    animationValid ??= clipAnimationValidationError(clipAnimation(clip)) === null
  )
  const stages = clip.effects.map<VideoEffectStage>((effect) => (
    hasPluginPrefix(effect)
      ? pluginStage(
          effect,
          clip,
          timelineFrame,
          declarations.get(effect.type),
          clipAnimationIsValid,
        )
      : builtInStage(effect)
  ))
  return Object.freeze({
    stages: Object.freeze(stages),
    requiresOrderedPixelPath: stages.some((stage) => (
      stage.kind === 'plugin' && stage.status === 'ready'
    )),
  })
}

/**
 * Retained planner indexes one immutable snapshot without retaining app state.
 * Snapshot declarations are frozen at creation, so their parameter-key index
 * stays exact for the planner's lifetime.
 */
export function createVideoEffectStagePlanner(
  snapshot?: PluginVideoEffectContributionSnapshot,
): VideoEffectStagePlanner {
  const declarations = new Map<string, IndexedDeclaration>(
    snapshot?.declarations.map((declaration) => [declaration.effectType, {
      declaration,
      parameterKeys: new Set(declaration.parameters.map((parameter) => parameter.key)),
    }]) ?? [],
  )
  return Object.freeze({
    planClip: (clip: Clip, timelineFrame: number) => (
      resolveWithCatalog(clip, timelineFrame, declarations)
    ),
  })
}
