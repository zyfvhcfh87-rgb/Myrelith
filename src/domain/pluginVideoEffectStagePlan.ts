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
  PLUGIN_MANIFEST_LIMITS,
  pluginEffectType,
  type PluginParameter,
} from './pluginManifest'
import { utf8ByteLength } from './documentMemory'
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
  readonly contributionVersion: number
  readonly contributionId: string
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

const LOCAL_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u
const PLUGIN_ID = /^(?:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u
const ENTRYPOINT = /^[A-Za-z_][A-Za-z0-9_]*$/u
const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/u
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

function failSnapshot(message: string): never {
  throw new TypeError(`Invalid plugin contribution snapshot: ${message}`)
}

function boundedText(value: string, name: string, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim().length === 0
    || value.length > maximum
    || Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) failSnapshot(`${name} is missing or exceeds ${maximum} characters`)
  return value
}

function cloneParameter(parameter: PluginParameter, index: number): PluginParameter {
  const path = `parameters[${index}]`
  const key = boundedText(
    parameter.key,
    `${path}.key`,
    PLUGIN_MANIFEST_LIMITS.maxIdentifierCharacters,
  )
  if (!LOCAL_IDENTIFIER.test(key) || isUnsafeEffectParamKey(key)) {
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
      parameter.min >= parameter.max
      || parameter.default < parameter.min
      || parameter.default > parameter.max
      || parameter.step <= 0
      || parameter.step > parameter.max - parameter.min
      || !(parameter.min + parameter.step > parameter.min)
      || !(parameter.max - parameter.step < parameter.max)
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
    if (!LOCAL_IDENTIFIER.test(value) || values.has(value)) {
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
    if (!PLUGIN_ID.test(pluginId)) failSnapshot(`declarations[${index}].pluginId is invalid`)
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
    if (!LOCAL_IDENTIFIER.test(contributionId)) {
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
    if (!ENTRYPOINT.test(entrypoint)) {
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
    if (!SEMANTIC_VERSION.test(declaration.pluginVersion)) {
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
    if (!LOCAL_IDENTIFIER.test(key) || isUnsafeEffectParamKey(key)) {
      throw new TypeError('Plugin parameter record contains an invalid key')
    }
    if (
      typeof value !== 'boolean'
      && typeof value !== 'string'
      && (typeof value !== 'number' || !Number.isFinite(value))
    ) throw new TypeError(`Plugin parameter record ${key} is not a finite primitive`)
    if (typeof value === 'string' && !LOCAL_IDENTIFIER.test(value)) {
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
  if (effect.kind === 'color-adjust') {
    return Object.freeze({
      kind: effect.kind,
      params: Object.freeze({ ...effect.params }),
    })
  }
  if (effect.kind === 'mask') {
    return Object.freeze({
      kind: effect.kind,
      params: Object.freeze({ ...effect.params }),
    })
  }
  return Object.freeze({
    kind: effect.kind,
    params: Object.freeze({ ...effect.params }),
  })
}

function builtInStage(effect: EffectDescriptor): BuiltInVideoEffectStage {
  const cloned = cloneEffectDescriptor(effect)
  const capabilities = new Set<EffectCapability>([
    CANVAS_FILTER_EFFECT_CAPABILITY,
    CANVAS_PIXEL_EFFECT_CAPABILITY,
  ])
  const resolution = resolveEffectStack([cloned], capabilities)[0]
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
  return PLUGIN_ID.test(pluginId) && LOCAL_IDENTIFIER.test(contributionId)
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

function pluginStage(
  effect: EffectDescriptor,
  clip: Clip,
  timelineFrame: number,
  declaration: PluginVideoEffectContributionDeclaration | undefined,
): PluginVideoEffectStage {
  if (!pluginTypeIsWellFormed(effect.type)) {
    return unavailablePluginStage(
      effect,
      effect.type || 'Unknown plugin effect',
      'invalid',
      'The plugin effect type is malformed; its data is preserved.',
    )
  }
  if (!declaration) {
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
  const declarationsByKey = new Map(declaration.parameters.map((parameter) => [
    parameter.key,
    parameter,
  ]))
  const unknownKey = Object.keys(effect.params).find((key) => !declarationsByKey.has(key))
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
  const animation = clipAnimation(clip)
  if (!clipAnimationValidationError(animation)) {
    const localFrame = timelineFrame - clip.timelineRange.startFrame
    if (Number.isSafeInteger(localFrame)) {
      for (const parameter of declaration.parameters) {
        if (parameter.kind !== 'number' || !parameter.animatable) continue
        const track = effectAnimationTracks(animation).find((candidate) => (
          candidate.effectId === effect.id && candidate.parameter === parameter.key
        ))
        if (!track || track.keyframes.some((keyframe) => (
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
    contributionVersion: declaration.contributionVersion,
    contributionId: declaration.contributionId,
    entrypoint: declaration.entrypoint,
    parameterRecord,
    canonicalParameterJson: canonicalPluginVideoEffectParameterJson(parameterRecord),
  })
  return Object.freeze({
    kind: 'plugin',
    effect: frozenEffect(effect),
    label: declaration.contributionName,
    status: 'ready',
    detail: declaration.detail,
    execution,
  })
}

function hasPluginPrefix(effect: EffectDescriptor): boolean {
  return effect.type.startsWith('plugin:')
}

function resolveWithCatalog(
  clip: Clip,
  timelineFrame: number,
  declarations: ReadonlyMap<string, PluginVideoEffectContributionDeclaration>,
): VideoEffectStagePlan | null {
  if (!clip.effects.some(hasPluginPrefix)) return null
  const stages = clip.effects.map<VideoEffectStage>((effect) => (
    hasPluginPrefix(effect)
      ? pluginStage(effect, clip, timelineFrame, declarations.get(effect.type))
      : builtInStage(effect)
  ))
  return Object.freeze({
    stages: Object.freeze(stages),
    requiresOrderedPixelPath: stages.some((stage) => (
      stage.kind === 'plugin' && stage.status === 'ready'
    )),
  })
}

/** Retained planner indexes one immutable snapshot without retaining app state. */
export function createVideoEffectStagePlanner(
  snapshot?: PluginVideoEffectContributionSnapshot,
): VideoEffectStagePlanner {
  const declarations = new Map(
    snapshot?.declarations.map((declaration) => [declaration.effectType, declaration]) ?? [],
  )
  return Object.freeze({
    planClip: (clip: Clip, timelineFrame: number) => (
      resolveWithCatalog(clip, timelineFrame, declarations)
    ),
  })
}

/** One-shot adapter for callers that do not retain a composition planner. */
export function resolveVideoEffectStagePlan(
  clip: Clip,
  timelineFrame: number,
  snapshot?: PluginVideoEffectContributionSnapshot,
): VideoEffectStagePlan | null {
  return createVideoEffectStagePlanner(snapshot).planClip(clip, timelineFrame)
}
