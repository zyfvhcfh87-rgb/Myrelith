/** Pure, non-executing validation and compatibility negotiation for plugin manifests. */

import {
  EFFECT_STACK_LIMITS,
  isUnsafeEffectParamKey,
} from './effectBounds'
import {
  MAX_RENDER_SURFACE_PIXELS,
  RENDER_SURFACE_BYTES_PER_PIXEL,
} from './renderSurfaceBudget'

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const
export const PLUGIN_HOST_API_VERSION = 1 as const
export const VIDEO_EFFECT_FRAME_CAPABILITY = 'myrelith.effect.video-frame.rgba8' as const

const WEBASSEMBLY_PAGE_BYTES = 65_536
const MAX_PLUGIN_FRAME_BYTES = MAX_RENDER_SURFACE_PIXELS * RENDER_SURFACE_BYTES_PER_PIXEL
const MAX_CANONICAL_PARAMETER_BYTES = WEBASSEMBLY_PAGE_BYTES
const MAX_PLUGIN_MEMORY_PAGES = Math.ceil(
  (MAX_PLUGIN_FRAME_BYTES + MAX_CANONICAL_PARAMETER_BYTES) / WEBASSEMBLY_PAGE_BYTES,
)

export const PLUGIN_MANIFEST_LIMITS = Object.freeze({
  maxManifestBytes: 65_536,
  maxPluginIdCharacters: 128,
  maxNameCharacters: 128,
  maxVersionCharacters: 64,
  maxEntryPathCharacters: 240,
  maxPermissions: 32,
  maxContributions: 64,
  maxParametersPerContribution: 64,
  maxMigrationsPerContribution: 64,
  maxEnumOptions: 32,
  maxIdentifierCharacters: 64,
  maxEntrypointCharacters: 128,
  maxCanonicalParameterBytes: MAX_CANONICAL_PARAMETER_BYTES,
  maxWasmMemoryPages: MAX_PLUGIN_MEMORY_PAGES,
  maxApiVersion: 65_535,
  maxDescriptorVersion: 65_535,
})

export interface PluginVersionRange {
  readonly minVersion: number
  readonly maxVersion: number
}

export interface PluginPermissionRequest extends PluginVersionRange {
  readonly id: string
  readonly required: boolean
}

export interface PluginWasmRuntime {
  readonly kind: 'wasm'
  readonly entry: string
  /** One WebAssembly page is 64 KiB. The host supplies the bounded memory. */
  readonly memoryMaximumPages: number
}

export interface PluginNumberParameter {
  readonly key: string
  readonly name: string
  readonly kind: 'number'
  readonly default: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly animatable: boolean
}

export interface PluginBooleanParameter {
  readonly key: string
  readonly name: string
  readonly kind: 'boolean'
  readonly default: boolean
}

export interface PluginEnumOption {
  readonly value: string
  readonly name: string
}

export interface PluginEnumParameter {
  readonly key: string
  readonly name: string
  readonly kind: 'enum'
  readonly default: string
  readonly options: readonly PluginEnumOption[]
}

export type PluginParameter =
  | PluginNumberParameter
  | PluginBooleanParameter
  | PluginEnumParameter

export interface PluginDescriptorMigration {
  /**
   * Declares one data-only step for a static effect instance. The v1 host
   * rejects matching `ClipAnimation.effectTracks` before invoking the chain;
   * non-final outputs are bounded records and only the final matches `parameters`.
   */
  readonly fromVersion: number
  readonly toVersion: number
  readonly entrypoint: string
}

export interface PluginVideoEffectContribution {
  readonly kind: 'video-effect'
  readonly contributionVersion: number
  readonly id: string
  readonly name: string
  readonly descriptorVersion: number
  readonly entrypoint: string
  readonly migrations: readonly PluginDescriptorMigration[]
  readonly parameters: readonly PluginParameter[]
}

export interface PluginManifestV1 {
  readonly schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION
  readonly id: string
  readonly name: string
  readonly version: string
  readonly api: PluginVersionRange
  readonly runtime: PluginWasmRuntime
  readonly permissions: readonly PluginPermissionRequest[]
  readonly contributions: readonly PluginVideoEffectContribution[]
}

export interface PluginManifestProblem {
  readonly path: string
  readonly message: string
}

export type PluginManifestValidationResult =
  | { readonly ok: true; readonly manifest: PluginManifestV1 }
  | { readonly ok: false; readonly problem: PluginManifestProblem }

export interface PluginHostPermission {
  readonly id: string
  readonly version: number
}

export interface PluginHostProfile {
  readonly apiVersion: number
  readonly permissions: readonly PluginHostPermission[]
  readonly contributions: readonly PluginHostContribution[]
}

export interface PluginHostContribution {
  readonly kind: PluginVideoEffectContribution['kind']
  readonly version: number
}

export interface PluginPermissionCompatibility {
  readonly id: string
  readonly required: boolean
  readonly version: number | null
  readonly status: 'available' | 'unavailable'
}

export interface PluginCompatibilityResult {
  readonly status: 'compatible' | 'incompatible'
  readonly apiVersion: number | null
  readonly permissions: readonly PluginPermissionCompatibility[]
  readonly contributions: readonly PluginContributionCompatibility[]
  readonly reasons: readonly string[]
}

export interface PluginContributionCompatibility {
  readonly id: string
  readonly kind: PluginVideoEffectContribution['kind']
  readonly version: number
  readonly status: 'available' | 'unavailable'
}

export const PLUGIN_HOST_PROFILE_V1: PluginHostProfile = Object.freeze({
  apiVersion: PLUGIN_HOST_API_VERSION,
  permissions: Object.freeze([Object.freeze({
    id: VIDEO_EFFECT_FRAME_CAPABILITY,
    version: 1,
  })]),
  contributions: Object.freeze([Object.freeze({
    kind: 'video-effect' as const,
    version: 1,
  })]),
})

const PLUGIN_MANIFEST_KEYS = new Set([
  'schemaVersion',
  'id',
  'name',
  'version',
  'api',
  'runtime',
  'permissions',
  'contributions',
])
const VERSION_RANGE_KEYS = new Set(['minVersion', 'maxVersion'])
const RUNTIME_KEYS = new Set(['kind', 'entry', 'memoryMaximumPages'])
const PERMISSION_KEYS = new Set(['id', 'minVersion', 'maxVersion', 'required'])
const CONTRIBUTION_KEYS = new Set([
  'kind',
  'contributionVersion',
  'id',
  'name',
  'descriptorVersion',
  'entrypoint',
  'migrations',
  'parameters',
])
const MIGRATION_KEYS = new Set(['fromVersion', 'toVersion', 'entrypoint'])
const NUMBER_PARAMETER_KEYS = new Set([
  'key',
  'name',
  'kind',
  'default',
  'min',
  'max',
  'step',
  'animatable',
])
const BOOLEAN_PARAMETER_KEYS = new Set(['key', 'name', 'kind', 'default'])
const ENUM_PARAMETER_KEYS = new Set(['key', 'name', 'kind', 'default', 'options'])
const ENUM_OPTION_KEYS = new Set(['value', 'name'])
const PLUGIN_ID = /^(?:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u
const DOTTED_CAPABILITY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/u
const LOCAL_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u
const ENTRYPOINT = /^[A-Za-z_][A-Za-z0-9_]*$/u
const PACKAGE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

class ManifestValidationFailure extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(message)
    this.name = 'ManifestValidationFailure'
    this.path = path
  }
}

function fail(path: string, message: string): never {
  throw new ManifestValidationFailure(path, message)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, path: string): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, 'is required')
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`${path}.${key}`, 'is an unknown field')
  }
}

function arrayValue(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > maximum) fail(path, `must contain at most ${maximum} entries`)
  return value
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function boundedText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.length === 0 || value.trim().length === 0) fail(path, 'must not be empty')
  if (value.length > maximum) fail(path, `must contain at most ${maximum} characters`)
  if (hasControlCharacter(value)) fail(path, 'must not contain control characters')
  return value
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `must be a safe integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number')
  return value
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function versionRange(value: unknown, path: string): PluginVersionRange {
  const range = record(value, path)
  exactKeys(range, VERSION_RANGE_KEYS, path)
  const minVersion = safeInteger(range.minVersion, `${path}.minVersion`, 1, PLUGIN_MANIFEST_LIMITS.maxApiVersion)
  const maxVersion = safeInteger(range.maxVersion, `${path}.maxVersion`, 1, PLUGIN_MANIFEST_LIMITS.maxApiVersion)
  if (minVersion > maxVersion) fail(path, 'minVersion must not exceed maxVersion')
  return { minVersion, maxVersion }
}

function pluginId(value: unknown, path: string): string {
  const id = boundedText(value, path, PLUGIN_MANIFEST_LIMITS.maxPluginIdCharacters)
  if (!PLUGIN_ID.test(id)) fail(path, 'must be a lowercase reverse-DNS identifier')
  return id
}

function localIdentifier(value: unknown, path: string): string {
  const id = boundedText(value, path, PLUGIN_MANIFEST_LIMITS.maxIdentifierCharacters)
  if (!LOCAL_IDENTIFIER.test(id)) fail(path, 'must be a lowercase local identifier')
  return id
}

function parameterKey(value: unknown, path: string): string {
  const key = localIdentifier(value, path)
  if (isUnsafeEffectParamKey(key)) fail(path, 'must not be a reserved object key')
  return key
}

function capabilityId(value: unknown, path: string): string {
  const id = boundedText(value, path, PLUGIN_MANIFEST_LIMITS.maxPluginIdCharacters)
  if (!DOTTED_CAPABILITY_ID.test(id)) fail(path, 'must be a lowercase dotted capability identifier')
  return id
}

function packageEntryPath(value: unknown, path: string): string {
  const entry = boundedText(value, path, PLUGIN_MANIFEST_LIMITS.maxEntryPathCharacters)
  if (entry.includes('\\') || entry.startsWith('/') || !entry.endsWith('.wasm')) {
    fail(path, 'must be a relative POSIX path ending in .wasm')
  }
  const segments = entry.split('/')
  if (segments.some((segment) => !PACKAGE_PATH_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    fail(path, 'must contain only safe package path segments')
  }
  return entry
}

function semanticVersion(value: unknown, path: string): string {
  const version = boundedText(value, path, PLUGIN_MANIFEST_LIMITS.maxVersionCharacters)
  if (!SEMANTIC_VERSION.test(version)) fail(path, 'must be a valid semantic version')
  return version
}

function wasmEntrypoint(value: unknown, path: string): string {
  const entrypoint = boundedText(
    value,
    path,
    PLUGIN_MANIFEST_LIMITS.maxEntrypointCharacters,
  )
  if (!ENTRYPOINT.test(entrypoint)) fail(path, 'must be a WebAssembly export name')
  return entrypoint
}

function boundedEffectNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path)
  if (Math.abs(number) > EFFECT_STACK_LIMITS.maxFiniteMagnitude) {
    fail(
      path,
      `must be between -${EFFECT_STACK_LIMITS.maxFiniteMagnitude} and ${EFFECT_STACK_LIMITS.maxFiniteMagnitude}`,
    )
  }
  return number
}

function permission(value: unknown, path: string): PluginPermissionRequest {
  const item = record(value, path)
  exactKeys(item, PERMISSION_KEYS, path)
  const range = versionRange(
    { minVersion: item.minVersion, maxVersion: item.maxVersion },
    path,
  )
  return {
    id: capabilityId(item.id, `${path}.id`),
    ...range,
    required: booleanValue(item.required, `${path}.required`),
  }
}

function enumOption(value: unknown, path: string): PluginEnumOption {
  const option = record(value, path)
  exactKeys(option, ENUM_OPTION_KEYS, path)
  return {
    value: localIdentifier(option.value, `${path}.value`),
    name: boundedText(option.name, `${path}.name`, PLUGIN_MANIFEST_LIMITS.maxNameCharacters),
  }
}

function migration(value: unknown, path: string): PluginDescriptorMigration {
  const item = record(value, path)
  exactKeys(item, MIGRATION_KEYS, path)
  return {
    fromVersion: safeInteger(
      item.fromVersion,
      `${path}.fromVersion`,
      1,
      PLUGIN_MANIFEST_LIMITS.maxDescriptorVersion,
    ),
    toVersion: safeInteger(
      item.toVersion,
      `${path}.toVersion`,
      1,
      PLUGIN_MANIFEST_LIMITS.maxDescriptorVersion,
    ),
    entrypoint: wasmEntrypoint(item.entrypoint, `${path}.entrypoint`),
  }
}

function parameter(value: unknown, path: string): PluginParameter {
  const item = record(value, path)
  if (item.kind === 'number') {
    exactKeys(item, NUMBER_PARAMETER_KEYS, path)
    const key = parameterKey(item.key, `${path}.key`)
    const minimum = boundedEffectNumber(item.min, `${path}.min`)
    const maximum = boundedEffectNumber(item.max, `${path}.max`)
    const defaultValue = boundedEffectNumber(item.default, `${path}.default`)
    const step = finiteNumber(item.step, `${path}.step`)
    if (minimum >= maximum) fail(path, 'number parameter min must be less than max')
    if (defaultValue < minimum || defaultValue > maximum) fail(`${path}.default`, 'must be inside the declared range')
    if (step <= 0 || step > maximum - minimum) fail(`${path}.step`, 'must be positive and no larger than the declared range')
    if (!(minimum + step > minimum) || !(maximum - step < maximum)) {
      fail(`${path}.step`, 'must make representable progress from both declared endpoints')
    }
    return {
      key,
      name: boundedText(item.name, `${path}.name`, PLUGIN_MANIFEST_LIMITS.maxNameCharacters),
      kind: 'number',
      default: defaultValue,
      min: minimum,
      max: maximum,
      step,
      animatable: booleanValue(item.animatable, `${path}.animatable`),
    }
  }
  if (item.kind === 'boolean') {
    exactKeys(item, BOOLEAN_PARAMETER_KEYS, path)
    return {
      key: parameterKey(item.key, `${path}.key`),
      name: boundedText(item.name, `${path}.name`, PLUGIN_MANIFEST_LIMITS.maxNameCharacters),
      kind: 'boolean',
      default: booleanValue(item.default, `${path}.default`),
    }
  }
  if (item.kind === 'enum') {
    exactKeys(item, ENUM_PARAMETER_KEYS, path)
    const key = parameterKey(item.key, `${path}.key`)
    const options = arrayValue(item.options, `${path}.options`, PLUGIN_MANIFEST_LIMITS.maxEnumOptions)
      .map((option, index) => enumOption(option, `${path}.options[${index}]`))
    if (options.length === 0) fail(`${path}.options`, 'must contain at least one option')
    const values = new Set<string>()
    for (const [index, option] of options.entries()) {
      if (values.has(option.value)) fail(`${path}.options[${index}].value`, 'must be unique')
      values.add(option.value)
    }
    const defaultValue = localIdentifier(item.default, `${path}.default`)
    if (!values.has(defaultValue)) fail(`${path}.default`, 'must match a declared option')
    return {
      key,
      name: boundedText(item.name, `${path}.name`, PLUGIN_MANIFEST_LIMITS.maxNameCharacters),
      kind: 'enum',
      default: defaultValue,
      options,
    }
  }
  fail(`${path}.kind`, 'must be number, boolean, or enum')
}

function contribution(value: unknown, path: string): PluginVideoEffectContribution {
  const item = record(value, path)
  exactKeys(item, CONTRIBUTION_KEYS, path)
  if (item.kind !== 'video-effect') fail(`${path}.kind`, 'must be video-effect')
  const parameters = arrayValue(
    item.parameters,
    `${path}.parameters`,
    PLUGIN_MANIFEST_LIMITS.maxParametersPerContribution,
  ).map((entry, index) => parameter(entry, `${path}.parameters[${index}]`))
  const parameterKeys = new Set<string>()
  for (const [index, definition] of parameters.entries()) {
    if (parameterKeys.has(definition.key)) fail(`${path}.parameters[${index}].key`, 'must be unique')
    parameterKeys.add(definition.key)
  }
  const descriptorVersion = safeInteger(
    item.descriptorVersion,
    `${path}.descriptorVersion`,
    1,
    PLUGIN_MANIFEST_LIMITS.maxDescriptorVersion,
  )
  const migrations = arrayValue(
    item.migrations,
    `${path}.migrations`,
    PLUGIN_MANIFEST_LIMITS.maxMigrationsPerContribution,
  ).map((entry, index) => migration(entry, `${path}.migrations[${index}]`))
  if (descriptorVersion > 1 && migrations.length === 0) {
    fail(`${path}.migrations`, 'must declare a chain to the current descriptor version')
  }
  const migrationsByFromVersion = new Map<number, PluginDescriptorMigration>()
  for (const [index, step] of migrations.entries()) {
    if (index > 0 && migrations[index - 1].fromVersion >= step.fromVersion) {
      fail(`${path}.migrations[${index}].fromVersion`, 'must be strictly increasing')
    }
    if (step.fromVersion >= step.toVersion) {
      fail(`${path}.migrations[${index}]`, 'fromVersion must be less than toVersion')
    }
    if (step.toVersion > descriptorVersion) {
      fail(`${path}.migrations[${index}].toVersion`, 'must not exceed descriptorVersion')
    }
    migrationsByFromVersion.set(step.fromVersion, step)
  }
  for (const [index, firstStep] of migrations.entries()) {
    let step = firstStep
    while (step.toVersion !== descriptorVersion) {
      const nextStep = migrationsByFromVersion.get(step.toVersion)
      if (!nextStep) {
        fail(
          `${path}.migrations[${index}].toVersion`,
          'must lead through a declared chain to descriptorVersion',
        )
      }
      step = nextStep
    }
  }
  const entrypoint = wasmEntrypoint(item.entrypoint, `${path}.entrypoint`)
  return {
    kind: 'video-effect',
    contributionVersion: safeInteger(
      item.contributionVersion,
      `${path}.contributionVersion`,
      1,
      PLUGIN_MANIFEST_LIMITS.maxApiVersion,
    ),
    id: localIdentifier(item.id, `${path}.id`),
    name: boundedText(item.name, `${path}.name`, PLUGIN_MANIFEST_LIMITS.maxNameCharacters),
    descriptorVersion,
    entrypoint,
    migrations,
    parameters,
  }
}

/** Validate an already-parsed manifest without loading, installing, or executing it. */
export function validatePluginManifest(value: unknown): PluginManifestValidationResult {
  try {
    const manifest = record(value, '$')
    exactKeys(manifest, PLUGIN_MANIFEST_KEYS, '$')
    if (manifest.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
      fail('$.schemaVersion', `must equal ${PLUGIN_MANIFEST_SCHEMA_VERSION}`)
    }
    const api = versionRange(manifest.api, '$.api')
    const runtimeValue = record(manifest.runtime, '$.runtime')
    exactKeys(runtimeValue, RUNTIME_KEYS, '$.runtime')
    if (runtimeValue.kind !== 'wasm') fail('$.runtime.kind', 'must be wasm')
    const runtime: PluginWasmRuntime = {
      kind: 'wasm',
      entry: packageEntryPath(runtimeValue.entry, '$.runtime.entry'),
      memoryMaximumPages: safeInteger(
        runtimeValue.memoryMaximumPages,
        '$.runtime.memoryMaximumPages',
        1,
        PLUGIN_MANIFEST_LIMITS.maxWasmMemoryPages,
      ),
    }
    const permissions = arrayValue(
      manifest.permissions,
      '$.permissions',
      PLUGIN_MANIFEST_LIMITS.maxPermissions,
    ).map((item, index) => permission(item, `$.permissions[${index}]`))
    const permissionIds = new Set<string>()
    for (const [index, request] of permissions.entries()) {
      if (permissionIds.has(request.id)) fail(`$.permissions[${index}].id`, 'must be unique')
      permissionIds.add(request.id)
    }
    const contributions = arrayValue(
      manifest.contributions,
      '$.contributions',
      PLUGIN_MANIFEST_LIMITS.maxContributions,
    ).map((item, index) => contribution(item, `$.contributions[${index}]`))
    if (contributions.length === 0) fail('$.contributions', 'must contain at least one contribution')
    if (
      runtime.memoryMaximumPages < 2
      && contributions.some((item) => item.migrations.length > 0)
    ) {
      fail(
        '$.runtime.memoryMaximumPages',
        'must provide at least two pages for non-overlapping migration buffers',
      )
    }
    const contributionIds = new Set<string>()
    const renderEntrypoints = new Set<string>()
    for (const [index, item] of contributions.entries()) {
      if (contributionIds.has(item.id)) fail(`$.contributions[${index}].id`, 'must be unique')
      contributionIds.add(item.id)
      if (renderEntrypoints.has(item.entrypoint)) {
        fail(
          `$.contributions[${index}].entrypoint`,
          'must be unique across contributions',
        )
      }
      renderEntrypoints.add(item.entrypoint)
    }
    for (const [contributionIndex, item] of contributions.entries()) {
      for (const [migrationIndex, migration] of item.migrations.entries()) {
        if (renderEntrypoints.has(migration.entrypoint)) {
          fail(
            `$.contributions[${contributionIndex}].migrations[${migrationIndex}].entrypoint`,
            'must differ from every render entrypoint',
          )
        }
      }
    }
    const framePermission = permissions.find((request) => request.id === VIDEO_EFFECT_FRAME_CAPABILITY)
    if (!framePermission?.required) {
      fail(
        '$.permissions',
        `video-effect contributions require ${VIDEO_EFFECT_FRAME_CAPABILITY}`,
      )
    }
    return {
      ok: true,
      manifest: {
        schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
        id: pluginId(manifest.id, '$.id'),
        name: boundedText(manifest.name, '$.name', PLUGIN_MANIFEST_LIMITS.maxNameCharacters),
        version: semanticVersion(manifest.version, '$.version'),
        api,
        runtime,
        permissions,
        contributions,
      },
    }
  } catch (error) {
    if (error instanceof ManifestValidationFailure) {
      return { ok: false, problem: { path: error.path, message: error.message } }
    }
    throw error
  }
}

/** Select only declared host versions. User permission grants are a later, separate gate. */
export function negotiatePluginCompatibility(
  manifest: PluginManifestV1,
  host: PluginHostProfile = PLUGIN_HOST_PROFILE_V1,
): PluginCompatibilityResult {
  const reasons: string[] = []
  const apiVersion = host.apiVersion >= manifest.api.minVersion
    && host.apiVersion <= manifest.api.maxVersion
    ? host.apiVersion
    : null
  if (apiVersion === null) {
    reasons.push(
      `Host API ${host.apiVersion} is outside plugin range ${manifest.api.minVersion}-${manifest.api.maxVersion}.`,
    )
  }
  const permissions = manifest.permissions.map<PluginPermissionCompatibility>((request) => {
    const available = host.permissions.find((candidate) => (
      candidate.id === request.id
      && candidate.version >= request.minVersion
      && candidate.version <= request.maxVersion
    ))
    if (!available && request.required) {
      reasons.push(
        `Required permission ${request.id} ${request.minVersion}-${request.maxVersion} is unavailable.`,
      )
    }
    return {
      id: request.id,
      required: request.required,
      version: available?.version ?? null,
      status: available ? 'available' : 'unavailable',
    }
  })
  const contributions = manifest.contributions.map<PluginContributionCompatibility>((contribution) => {
    const available = host.contributions.some((candidate) => (
      candidate.kind === contribution.kind
      && candidate.version === contribution.contributionVersion
    ))
    if (!available) {
      reasons.push(
        `Contribution ${contribution.id} requires ${contribution.kind} version ${contribution.contributionVersion}.`,
      )
    }
    return {
      id: contribution.id,
      kind: contribution.kind,
      version: contribution.contributionVersion,
      status: available ? 'available' : 'unavailable',
    }
  })
  return {
    status: reasons.length === 0 ? 'compatible' : 'incompatible',
    apiVersion,
    permissions,
    contributions,
    reasons,
  }
}

/** Stable durable type for project descriptors; it never contains a package URL. */
export function pluginEffectType(pluginIdValue: string, contributionId: string): string {
  return `plugin:${pluginIdValue}/${contributionId}`
}
