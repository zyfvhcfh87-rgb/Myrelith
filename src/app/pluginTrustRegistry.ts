import type {
  PluginCompatibilityResult,
  PluginManifestV1,
  PluginPermissionRequest,
} from '../domain/pluginManifest'

export type Sha256Identity = `sha256:${string}`

export const PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION = 1 as const
export const PLUGIN_TRUST_POLICY_SCHEMA_VERSION = 1 as const

export const PLUGIN_REGISTRY_LIMITS = Object.freeze({
  maxInstalledPlugins: 64,
  maxAggregateContributions: 1_024,
  maxAggregateArchiveBytes: 512 * 1024 * 1024,
  maxDiagnosticsPerPlugin: 100,
  maxRevocationsPerKind: 256,
})

export type PluginActivationState =
  | 'enabled'
  | 'disabled'
  | 'quarantined'
  | 'revoked'

export type PluginDiagnosticCode =
  | 'manifest-invalid'
  | 'signature-invalid'
  | 'untrusted'
  | 'permission-denied'
  | 'incompatible-api'
  | 'capability-unavailable'
  | 'revoked'
  | 'wasm-policy-rejected'
  | 'timeout'
  | 'crash'
  | 'bad-response'
  | 'disabled-safe-mode'
  | 'package-invalid'
  | 'storage-failed'

export const PLUGIN_DIAGNOSTIC_CODES = Object.freeze([
  'manifest-invalid',
  'signature-invalid',
  'untrusted',
  'permission-denied',
  'incompatible-api',
  'capability-unavailable',
  'revoked',
  'wasm-policy-rejected',
  'timeout',
  'crash',
  'bad-response',
  'disabled-safe-mode',
  'package-invalid',
  'storage-failed',
] as const satisfies readonly PluginDiagnosticCode[])

export interface PluginDiagnosticEvent {
  readonly code: PluginDiagnosticCode
  readonly occurredAt: number
}

export interface PluginPackageIdentity {
  readonly pluginId: string
  readonly version: string
  readonly packageDigest: Sha256Identity
  readonly signerFingerprint: Sha256Identity
}

export interface PluginTrustBinding {
  readonly pluginId: string
  readonly signerFingerprint: Sha256Identity
}

export interface PluginPackageBinding extends PluginTrustBinding {
  readonly packageDigest: Sha256Identity
}

export interface PluginTrustPolicy {
  readonly builtInTrustedBindings: readonly PluginTrustBinding[]
  readonly revokedPackageDigests: readonly Sha256Identity[]
  readonly revokedSignerFingerprints: readonly Sha256Identity[]
  readonly revokedBindings: readonly PluginTrustBinding[]
}

export interface PersistedPluginTrustPolicy {
  readonly schemaVersion: typeof PLUGIN_TRUST_POLICY_SCHEMA_VERSION
  readonly revision: number
  readonly revokedPackageDigests: readonly Sha256Identity[]
  readonly revokedSignerFingerprints: readonly Sha256Identity[]
  readonly revokedBindings: readonly PluginTrustBinding[]
}

export interface PluginTrustPolicyStore {
  load(): Promise<unknown>
  compareAndSwap(
    expectedRevision: number | null,
    next: PersistedPluginTrustPolicy,
  ): Promise<boolean>
}

export interface PluginTrustRegistry {
  policy(): Promise<PluginTrustPolicy>
  revokePackage(packageDigest: Sha256Identity): Promise<void>
  revokeSigner(signerFingerprint: Sha256Identity): Promise<void>
  revokeBinding(binding: PluginTrustBinding): Promise<void>
}

export interface PluginTrustDecision {
  readonly kind: 'built-in' | 'user'
  readonly trustedAt: number
}

export interface PluginPermissionGrant {
  readonly id: string
  readonly minVersion: number
  readonly maxVersion: number
  readonly required: boolean
  readonly negotiatedVersion: number
  readonly grantedAt: number
  readonly pluginId: string
  readonly signerFingerprint: Sha256Identity
  readonly packageDigest: Sha256Identity
}

export interface InstalledPluginRecord extends PluginPackageIdentity {
  readonly schemaVersion: typeof PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION
  readonly revision: number
  readonly name: string
  readonly catalogContributionCount: number
  readonly modulePath: string
  readonly moduleSha256: string
  readonly moduleByteLength: number
  readonly installedAt: number
  readonly updatedAt: number
  readonly activationState: PluginActivationState
  readonly trust: PluginTrustDecision
  readonly grants: readonly PluginPermissionGrant[]
  readonly diagnostics: readonly PluginDiagnosticEvent[]
  readonly archiveBytes: Uint8Array
}

export type PluginInstallChange =
  | 'new-install'
  | 'upgrade'
  | 'downgrade'
  | 'same-version-replacement'
  | 'same-package'

export interface PluginPermissionPlan {
  readonly preserved: readonly PluginPermissionGrant[]
  readonly decisionsRequired: readonly PluginPermissionRequest[]
}

export interface PluginRevocationResult {
  readonly revoked: boolean
  readonly reason: 'package' | 'signer' | 'binding' | null
}

interface ParsedSemver {
  readonly core: readonly [string, string, string]
  readonly prerelease: readonly string[]
}

const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const NUMERIC_IDENTIFIER = /^(0|[1-9]\d*)$/
const PLUGIN_ID = /^(?:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u
const PERSISTED_POLICY_KEYS = [
  'schemaVersion',
  'revision',
  'revokedPackageDigests',
  'revokedSignerFingerprints',
  'revokedBindings',
] as const
const BINDING_KEYS = ['pluginId', 'signerFingerprint'] as const

export function isSha256Identity(value: unknown): value is Sha256Identity {
  return typeof value === 'string' && SHA256_IDENTITY.test(value)
}

function parseSemver(version: string): ParsedSemver {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`Invalid semantic version: ${version}`)
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split('.') ?? [],
  }
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

/** Compare valid SemVer strings without coercing attacker-controlled integers to Number. */
export function comparePluginVersions(leftVersion: string, rightVersion: string): number {
  const left = parseSemver(leftVersion)
  const right = parseSemver(rightVersion)
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifier(left.core[index], right.core[index])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < count; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1
    }
    if (leftPart === rightPart) continue
    const leftNumeric = NUMERIC_IDENTIFIER.test(leftPart)
    const rightNumeric = NUMERIC_IDENTIFIER.test(rightPart)
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export function classifyPluginInstall(
  previous: InstalledPluginRecord | null,
  next: PluginPackageIdentity,
): PluginInstallChange {
  if (!previous) return 'new-install'
  if (previous.packageDigest === next.packageDigest) return 'same-package'
  const versionComparison = comparePluginVersions(next.version, previous.version)
  if (versionComparison > 0) return 'upgrade'
  if (versionComparison < 0) return 'downgrade'
  return 'same-version-replacement'
}

function bindingMatches(binding: PluginTrustBinding, identity: PluginPackageIdentity): boolean {
  return binding.pluginId === identity.pluginId
    && binding.signerFingerprint === identity.signerFingerprint
}

export function isBuiltInTrusted(
  identity: PluginPackageIdentity,
  policy: PluginTrustPolicy,
): boolean {
  return policy.builtInTrustedBindings.some((binding) => bindingMatches(binding, identity))
}

export function evaluatePluginRevocation(
  identity: PluginPackageIdentity,
  policy: PluginTrustPolicy,
): PluginRevocationResult {
  if (policy.revokedPackageDigests.includes(identity.packageDigest)) {
    return { revoked: true, reason: 'package' }
  }
  if (policy.revokedSignerFingerprints.includes(identity.signerFingerprint)) {
    return { revoked: true, reason: 'signer' }
  }
  if (policy.revokedBindings.some((binding) => bindingMatches(binding, identity))) {
    return { revoked: true, reason: 'binding' }
  }
  return { revoked: false, reason: null }
}

function grantMatchesRequest(
  grant: PluginPermissionGrant,
  request: PluginPermissionRequest,
  negotiatedVersion: number,
): boolean {
  return grant.id === request.id
    && grant.minVersion === request.minVersion
    && grant.maxVersion === request.maxVersion
    && grant.required === request.required
    && grant.negotiatedVersion === negotiatedVersion
}

export function planPluginPermissions(
  previous: InstalledPluginRecord | null,
  nextIdentity: PluginPackageIdentity,
  manifest: PluginManifestV1,
  compatibility: PluginCompatibilityResult,
): PluginPermissionPlan {
  const sameSigner = previous?.signerFingerprint === nextIdentity.signerFingerprint
  const preserved: PluginPermissionGrant[] = []
  const decisionsRequired: PluginPermissionRequest[] = []
  for (const request of manifest.permissions) {
    const negotiated = compatibility.permissions.find((item) => item.id === request.id)
    if (!negotiated || negotiated.status !== 'available' || negotiated.version === null) {
      decisionsRequired.push(request)
      continue
    }
    const negotiatedVersion = negotiated.version
    const existing = sameSigner
      ? previous?.grants.find((grant) => grantMatchesRequest(grant, request, negotiatedVersion))
      : undefined
    if (existing) {
      preserved.push(Object.freeze({
        ...existing,
        packageDigest: nextIdentity.packageDigest,
      }))
    } else {
      decisionsRequired.push(request)
    }
  }
  return Object.freeze({
    preserved: Object.freeze(preserved),
    decisionsRequired: Object.freeze(decisionsRequired),
  })
}

export function appendPluginDiagnostic(
  diagnostics: readonly PluginDiagnosticEvent[],
  event: PluginDiagnosticEvent,
): readonly PluginDiagnosticEvent[] {
  const retained = diagnostics.slice(-(PLUGIN_REGISTRY_LIMITS.maxDiagnosticsPerPlugin - 1))
  return Object.freeze([...retained, Object.freeze({ ...event })])
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function parseBinding(value: unknown): PluginTrustBinding | null {
  const record = unknownRecord(value)
  if (!record || !exactKeys(record, BINDING_KEYS)
    || typeof record.pluginId !== 'string'
    || !PLUGIN_ID.test(record.pluginId)
    || !isSha256Identity(record.signerFingerprint)) return null
  return Object.freeze({
    pluginId: record.pluginId,
    signerFingerprint: record.signerFingerprint,
  })
}

export function parsePersistedPluginTrustPolicy(value: unknown): PersistedPluginTrustPolicy {
  if (value === undefined || value === null) {
    return Object.freeze({
      schemaVersion: PLUGIN_TRUST_POLICY_SCHEMA_VERSION,
      revision: 0,
      revokedPackageDigests: Object.freeze([]),
      revokedSignerFingerprints: Object.freeze([]),
      revokedBindings: Object.freeze([]),
    })
  }
  const record = unknownRecord(value)
  if (!record || !exactKeys(record, PERSISTED_POLICY_KEYS)
    || record.schemaVersion !== PLUGIN_TRUST_POLICY_SCHEMA_VERSION
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || !Array.isArray(record.revokedPackageDigests)
    || !Array.isArray(record.revokedSignerFingerprints)
    || !Array.isArray(record.revokedBindings)
    || record.revokedPackageDigests.length > PLUGIN_REGISTRY_LIMITS.maxRevocationsPerKind
    || record.revokedSignerFingerprints.length > PLUGIN_REGISTRY_LIMITS.maxRevocationsPerKind
    || record.revokedBindings.length > PLUGIN_REGISTRY_LIMITS.maxRevocationsPerKind) {
    throw new Error('Stored plugin trust policy failed bounded validation')
  }
  const packages = record.revokedPackageDigests
  const signers = record.revokedSignerFingerprints
  const bindings = record.revokedBindings.map(parseBinding)
  if (!packages.every(isSha256Identity)
    || !signers.every(isSha256Identity)
    || bindings.some((binding) => binding === null)
    || new Set(packages).size !== packages.length
    || new Set(signers).size !== signers.length
    || new Set(bindings.map((binding) => `${binding?.pluginId}\0${binding?.signerFingerprint}`)).size
      !== bindings.length) {
    throw new Error('Stored plugin trust policy contains an invalid or duplicate revocation')
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: record.revision as number,
    revokedPackageDigests: Object.freeze([...packages] as Sha256Identity[]),
    revokedSignerFingerprints: Object.freeze([...signers] as Sha256Identity[]),
    revokedBindings: Object.freeze(bindings as PluginTrustBinding[]),
  })
}

function bindingKey(binding: PluginTrustBinding): string {
  return `${binding.pluginId}\0${binding.signerFingerprint}`
}

export function createPluginTrustRegistry(
  store: PluginTrustPolicyStore,
  builtInTrustedBindings: readonly PluginTrustBinding[] = [],
): PluginTrustRegistry {
  const retainedBuiltIns = Object.freeze(builtInTrustedBindings.map((binding) => {
    const parsed = parseBinding(binding)
    if (!parsed) throw new TypeError('Built-in plugin trust binding is invalid')
    return parsed
  }))

  async function mutate(
    change: (current: PersistedPluginTrustPolicy) => PersistedPluginTrustPolicy,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = parsePersistedPluginTrustPolicy(await store.load())
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Plugin trust policy revision is exhausted')
      }
      const next = change(current)
      if (next === current) return
      if (await store.compareAndSwap(current.revision, next)) return
    }
    throw new Error('Plugin trust policy changed concurrently; retry the action')
  }

  function nextPolicy(
    current: PersistedPluginTrustPolicy,
    updates: Partial<PersistedPluginTrustPolicy>,
  ): PersistedPluginTrustPolicy {
    return parsePersistedPluginTrustPolicy({
      ...current,
      ...updates,
      revision: current.revision + 1,
    })
  }

  return Object.freeze({
    async policy() {
      const persisted = parsePersistedPluginTrustPolicy(await store.load())
      return Object.freeze({
        builtInTrustedBindings: retainedBuiltIns,
        revokedPackageDigests: persisted.revokedPackageDigests,
        revokedSignerFingerprints: persisted.revokedSignerFingerprints,
        revokedBindings: persisted.revokedBindings,
      })
    },
    revokePackage(packageDigest: Sha256Identity) {
      if (!isSha256Identity(packageDigest)) throw new TypeError('Package digest is invalid')
      return mutate((current) => current.revokedPackageDigests.includes(packageDigest)
        ? current
        : nextPolicy(current, {
          revokedPackageDigests: [...current.revokedPackageDigests, packageDigest],
        }))
    },
    revokeSigner(signerFingerprint: Sha256Identity) {
      if (!isSha256Identity(signerFingerprint)) throw new TypeError('Signer fingerprint is invalid')
      return mutate((current) => current.revokedSignerFingerprints.includes(signerFingerprint)
        ? current
        : nextPolicy(current, {
          revokedSignerFingerprints: [...current.revokedSignerFingerprints, signerFingerprint],
        }))
    },
    revokeBinding(binding: PluginTrustBinding) {
      const retained = parseBinding(binding)
      if (!retained) throw new TypeError('Plugin trust binding is invalid')
      return mutate((current) => current.revokedBindings.some(
        (item) => bindingKey(item) === bindingKey(retained),
      )
        ? current
        : nextPolicy(current, {
          revokedBindings: [...current.revokedBindings, retained],
        }))
    },
  })
}
