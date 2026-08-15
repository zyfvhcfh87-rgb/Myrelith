import {
  type PluginCompatibilityResult,
  type PluginDescriptorMigration,
  type PluginParameter,
  type PluginPermissionRequest,
  type PluginVideoEffectContribution,
} from '../domain/pluginManifest'
import {
  verifyPluginPackageArchive,
  type VerifiedPluginPackage,
} from './pluginPackage'
import type { PluginSessionSafety } from './pluginSafetyController'
import type {
  LocalPluginStorage,
  PluginRecordSnapshot,
  PluginStorageRevision,
} from './localPluginStorage'
import {
  appendPluginDiagnostic,
  classifyPluginInstall,
  evaluatePluginRevocation,
  isBuiltInTrusted,
  PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
  planPluginPermissions,
  type InstalledPluginRecord,
  type PluginActivationState,
  type PluginDiagnosticCode,
  type PluginInstallChange,
  type PluginPackageIdentity,
  type PluginPermissionGrant,
  type PluginTrustDecision,
  type PluginTrustPolicy,
  type Sha256Identity,
} from './pluginTrustRegistry'

const MAX_PENDING_INSPECTIONS = 4
const MAX_PENDING_ARCHIVE_BYTES = 64 * 1024 * 1024

export type PluginInstallControllerErrorCode =
  | 'aborted'
  | 'inspection-not-found'
  | 'install-conflict'
  | 'trust-required'
  | 'downgrade-confirmation-required'
  | 'replacement-confirmation-required'
  | 'permission-decision-required'
  | 'permission-denied'
  | 'incompatible'
  | 'revoked'
  | 'disabled'
  | 'quarantined'
  | 'safe-mode'
  | 'package-invalid'
  | 'storage-failed'

export class PluginInstallControllerError extends Error {
  readonly code: PluginInstallControllerErrorCode

  constructor(code: PluginInstallControllerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginInstallControllerError'
    this.code = code
  }
}

export interface PluginPermissionInspection {
  readonly id: string
  readonly minVersion: number
  readonly maxVersion: number
  readonly required: boolean
  readonly negotiatedVersion: number | null
  readonly status: 'available' | 'unavailable'
  readonly decisionRequired: boolean
}

export interface PluginPackageInspection {
  readonly inspectionId: string
  readonly pluginId: string
  readonly name: string
  readonly version: string
  readonly packageDigest: Sha256Identity
  readonly signerFingerprint: Sha256Identity
  readonly moduleSha256: string
  readonly memoryMaximumPages: number
  readonly change: PluginInstallChange
  readonly signerContinuity: boolean
  readonly trustDecisionRequired: boolean
  readonly compatibility: PluginCompatibilityResult
  readonly permissions: readonly PluginPermissionInspection[]
}

export interface PluginPermissionDecision {
  readonly id: string
  readonly granted: boolean
}

export interface CommitPluginInstallationOptions {
  readonly trustSigner: boolean
  readonly confirmDowngrade: boolean
  readonly confirmSameVersionReplacement: boolean
  readonly enableAfterInstall: boolean
  readonly permissionDecisions: readonly PluginPermissionDecision[]
}

export interface VerifiedPluginCapabilityPermission {
  readonly id: string
  readonly version: number
}

export interface VerifiedPluginCapabilityProfile {
  readonly apiVersion: number
  readonly memoryMaximumPages: number
  readonly permissions: readonly VerifiedPluginCapabilityPermission[]
}

export interface VerifiedPluginContribution {
  readonly kind: PluginVideoEffectContribution['kind']
  readonly id: string
  readonly name: string
  readonly contributionVersion: number
  readonly descriptorVersion: number
  readonly entrypoint: string
  readonly migrations: readonly PluginDescriptorMigration[]
  readonly parameters: readonly PluginParameter[]
}

export interface VerifiedPluginActivationBundle {
  readonly catalogGeneration: number
  readonly pluginId: string
  readonly name: string
  readonly version: string
  readonly packageDigest: Sha256Identity
  readonly signerFingerprint: Sha256Identity
  readonly modulePath: string
  readonly moduleSha256: string
  readonly moduleByteLength: number
  readonly profile: VerifiedPluginCapabilityProfile
  readonly contributions: readonly VerifiedPluginContribution[]
  copyModuleBytes(): Uint8Array
}

export interface PluginActivationBundleResolver {
  resolve(pluginId: string, signal: AbortSignal): Promise<VerifiedPluginActivationBundle>
}

type PluginDeclarationStatusReason =
  | 'available'
  | 'untrusted'
  | 'disabled'
  | 'quarantined'
  | 'revoked'
  | 'incompatible-api'
  | 'capability-unavailable'
  | 'permission-denied'
  | 'disabled-safe-mode'
  | 'package-invalid'

export type PluginDeclarationAvailability =
  | 'ready'
  | 'disabled'
  | 'incompatible'
  | 'failed'
  | 'revoked'
  | 'untrusted'
  | 'safe-mode'
  | 'quarantined'

export interface PluginDeclarationCatalogEntry {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly packageDigest: Sha256Identity
  readonly signerFingerprint: Sha256Identity
  readonly kind: PluginVideoEffectContribution['kind']
  readonly contributionId: string
  readonly contributionName: string
  readonly contributionVersion: number
  readonly descriptorVersion: number
  readonly entrypoint: string
  readonly parameters: readonly PluginParameter[]
  readonly availability: PluginDeclarationAvailability
  readonly detail: string
}

export interface PluginDeclarationCatalogSnapshot {
  readonly generation: number
  readonly declarations: readonly PluginDeclarationCatalogEntry[]
}

export interface PluginInstallController {
  readonly activationBundles: PluginActivationBundleResolver
  inspectPackage(archiveBytes: Uint8Array, signal?: AbortSignal): Promise<PluginPackageInspection>
  commitInstallation(
    inspectionId: string,
    options: CommitPluginInstallationOptions,
  ): Promise<InstalledPluginRecord>
  /** True only when cancellation won before the transactional write commit point. */
  cancelInspection(inspectionId: string): boolean
  disable(pluginId: string): Promise<InstalledPluginRecord>
  enable(pluginId: string, signal: AbortSignal): Promise<InstalledPluginRecord>
  setPermissionGrant(
    pluginId: string,
    permissionId: string,
    granted: boolean,
    signal: AbortSignal,
  ): Promise<InstalledPluginRecord>
  quarantine(pluginId: string): Promise<InstalledPluginRecord>
  revoke(pluginId: string): Promise<InstalledPluginRecord>
  uninstall(pluginId: string): Promise<boolean>
  recordDiagnostic(pluginId: string, code: PluginDiagnosticCode): Promise<void>
  declarationCatalog(signal?: AbortSignal): Promise<PluginDeclarationCatalogSnapshot>
}

export interface PluginInstallControllerDependencies {
  readonly storage: LocalPluginStorage
  readonly sessionSafety: PluginSessionSafety
  readonly trustPolicy: () => PluginTrustPolicy | Promise<PluginTrustPolicy>
  readonly revokeBinding: (binding: {
    readonly pluginId: string
    readonly signerFingerprint: Sha256Identity
  }) => Promise<void>
  readonly verifyPackage?: (archiveBytes: Uint8Array) => Promise<VerifiedPluginPackage>
  readonly now?: () => number
  readonly createInspectionId?: () => string
}

interface PendingInspection {
  readonly verified: VerifiedPluginPackage
  readonly archiveByteLength: number
  readonly previous: InstalledPluginRecord | null
  readonly inspection: PluginPackageInspection
}

interface VerifiedInstalledPlugin {
  readonly catalogGeneration: number
  readonly record: InstalledPluginRecord
  readonly verified: VerifiedPluginPackage
}

function abortError(signal: AbortSignal): PluginInstallControllerError {
  return new PluginInstallControllerError(
    'aborted',
    'Plugin operation was cancelled before verified bytes crossed the boundary',
    signal.reason === undefined ? undefined : { cause: signal.reason },
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function storageRevision(record: InstalledPluginRecord): PluginStorageRevision {
  return Object.freeze({
    packageDigest: record.packageDigest,
    revision: record.revision,
  })
}

function nextStorageRevision(record: InstalledPluginRecord | null): number {
  if (record?.revision === Number.MAX_SAFE_INTEGER) {
    throw new PluginInstallControllerError(
      'storage-failed',
      'Plugin registry revision is exhausted',
    )
  }
  return (record?.revision ?? 0) + 1
}

function identityFor(verified: VerifiedPluginPackage): PluginPackageIdentity {
  return Object.freeze({
    pluginId: verified.manifest.id,
    version: verified.manifest.version,
    packageDigest: verified.packageDigest,
    signerFingerprint: verified.signerFingerprint,
  })
}

function freezeParameter(parameter: PluginParameter): PluginParameter {
  if (parameter.kind === 'enum') {
    return Object.freeze({
      ...parameter,
      options: Object.freeze(parameter.options.map((option) => Object.freeze({ ...option }))),
    })
  }
  return Object.freeze({ ...parameter })
}

function freezeContribution(
  contribution: PluginVideoEffectContribution,
): VerifiedPluginContribution {
  return Object.freeze({
    kind: contribution.kind,
    id: contribution.id,
    name: contribution.name,
    contributionVersion: contribution.contributionVersion,
    descriptorVersion: contribution.descriptorVersion,
    entrypoint: contribution.entrypoint,
    migrations: Object.freeze(
      contribution.migrations.map((migration) => Object.freeze({ ...migration })),
    ),
    parameters: Object.freeze(contribution.parameters.map(freezeParameter)),
  })
}

function freezeCompatibility(
  compatibility: PluginCompatibilityResult,
): PluginCompatibilityResult {
  return Object.freeze({
    status: compatibility.status,
    apiVersion: compatibility.apiVersion,
    permissions: Object.freeze(
      compatibility.permissions.map((permission) => Object.freeze({ ...permission })),
    ),
    contributions: Object.freeze(
      compatibility.contributions.map((contribution) => Object.freeze({ ...contribution })),
    ),
    reasons: Object.freeze([...compatibility.reasons]),
  })
}

function trustForInstall(
  previous: InstalledPluginRecord | null,
  identity: PluginPackageIdentity,
  policy: PluginTrustPolicy,
  trustSigner: boolean,
  trustedAt: number,
): PluginTrustDecision {
  if (isBuiltInTrusted(identity, policy)) {
    return Object.freeze({ kind: 'built-in', trustedAt })
  }
  if (previous?.pluginId === identity.pluginId
    && previous.signerFingerprint === identity.signerFingerprint
    && previous.trust.kind === 'user') {
    return previous.trust
  }
  if (!trustSigner) {
    throw new PluginInstallControllerError(
      'trust-required',
      'This signing key has not been explicitly trusted for the plugin id',
    )
  }
  return Object.freeze({ kind: 'user', trustedAt })
}

function explicitPermissionDecisions(
  requests: readonly PluginPermissionRequest[],
  decisions: readonly PluginPermissionDecision[],
): ReadonlyMap<string, boolean> {
  const expected = new Set(requests.map((request) => request.id))
  const result = new Map<string, boolean>()
  for (const decision of decisions) {
    if (!expected.has(decision.id) || result.has(decision.id)) {
      throw new PluginInstallControllerError(
        'permission-decision-required',
        'Permission decisions must exactly match the permissions requiring review',
      )
    }
    result.set(decision.id, decision.granted)
  }
  if (result.size !== expected.size) {
    throw new PluginInstallControllerError(
      'permission-decision-required',
      'Every new or changed permission requires an explicit decision',
    )
  }
  return result
}

function recordIdentityMatches(
  record: InstalledPluginRecord,
  verified: VerifiedPluginPackage,
): boolean {
  return record.pluginId === verified.manifest.id
    && record.name === verified.manifest.name
    && record.catalogContributionCount === verified.manifest.contributions.length
    && record.version === verified.manifest.version
    && record.packageDigest === verified.packageDigest
    && record.signerFingerprint === verified.signerFingerprint
    && record.modulePath === verified.modulePath
    && record.moduleSha256 === verified.moduleSha256
    && record.moduleByteLength === verified.moduleByteLength
}

function requiredGrantsAvailable(
  record: InstalledPluginRecord,
  verified: VerifiedPluginPackage,
): boolean {
  return verified.manifest.permissions.every((request) => {
    if (!request.required) return true
    const compatibility = verified.compatibility.permissions.find((item) => item.id === request.id)
    const grant = record.grants.find((item) => item.id === request.id)
    return compatibility?.status === 'available'
      && compatibility.version !== null
      && grant?.pluginId === record.pluginId
      && grant.signerFingerprint === record.signerFingerprint
      && grant.packageDigest === record.packageDigest
      && grant.minVersion === request.minVersion
      && grant.maxVersion === request.maxVersion
      && grant.required === request.required
      && grant.negotiatedVersion === compatibility.version
  })
}

function statusForRecord(
  record: InstalledPluginRecord,
  verified: VerifiedPluginPackage | null,
  safeMode: boolean,
  policy: PluginTrustPolicy,
): PluginDeclarationStatusReason {
  if (safeMode) return 'disabled-safe-mode'
  if (evaluatePluginRevocation(record, policy).revoked || record.activationState === 'revoked') {
    return 'revoked'
  }
  if (record.activationState === 'quarantined') return 'quarantined'
  if (record.activationState === 'disabled') return 'disabled'
  if (record.trust.kind === 'built-in' && !isBuiltInTrusted(record, policy)) return 'untrusted'
  if (!verified || !recordIdentityMatches(record, verified)) return 'package-invalid'
  if (verified.compatibility.status !== 'compatible') {
    return verified.compatibility.apiVersion === null
      ? 'incompatible-api'
      : 'capability-unavailable'
  }
  if (!requiredGrantsAvailable(record, verified)) return 'permission-denied'
  return 'available'
}

function availabilityForStatus(
  status: PluginDeclarationStatusReason,
): PluginDeclarationAvailability {
  switch (status) {
    case 'available': return 'ready'
    case 'disabled': return 'disabled'
    case 'quarantined': return 'quarantined'
    case 'revoked': return 'revoked'
    case 'untrusted': return 'untrusted'
    case 'disabled-safe-mode': return 'safe-mode'
    case 'incompatible-api':
    case 'capability-unavailable':
    case 'permission-denied': return 'incompatible'
    case 'package-invalid': return 'failed'
  }
}

function detailForStatus(status: PluginDeclarationStatusReason): string {
  switch (status) {
    case 'available': return 'Ready to render.'
    case 'disabled': return 'The plugin is disabled locally.'
    case 'quarantined': return 'The plugin is quarantined after a runtime safety failure.'
    case 'revoked': return 'The package or signer is locally revoked.'
    case 'untrusted': return 'The package signer is not trusted for this plugin.'
    case 'disabled-safe-mode': return 'Plugins are disabled for this safe-mode session.'
    case 'incompatible-api': return 'The plugin API range is incompatible with this host.'
    case 'capability-unavailable': return 'A capability required by the plugin is unavailable.'
    case 'permission-denied': return 'A required plugin permission is not granted.'
    case 'package-invalid': return 'The stored plugin package failed verification.'
  }
}

export function createPluginInstallController(
  dependencies: PluginInstallControllerDependencies,
): PluginInstallController {
  const verifyPackage = dependencies.verifyPackage ?? verifyPluginPackageArchive
  const now = dependencies.now ?? Date.now
  let nextInspectionSequence = 1
  const pending = new Map<string, PendingInspection>()

  function createInspectionId(): string {
    const proposed = dependencies.createInspectionId?.() ?? `plugin-inspection-${nextInspectionSequence++}`
    if (proposed.length === 0 || proposed.length > 128 || pending.has(proposed)) {
      throw new PluginInstallControllerError('package-invalid', 'Inspection id is invalid or reused')
    }
    return proposed
  }

  async function replaceState(
    previous: InstalledPluginRecord,
    activationState: PluginActivationState,
  ): Promise<InstalledPluginRecord> {
    const next = Object.freeze({
      ...previous,
      revision: nextStorageRevision(previous),
      activationState,
      updatedAt: now(),
      archiveBytes: previous.archiveBytes.slice(),
    })
    let replaced: boolean
    try {
      replaced = await dependencies.storage.replace(
        previous.pluginId,
        storageRevision(previous),
        next,
      )
    } catch (cause) {
      throw new PluginInstallControllerError('storage-failed', 'Plugin state was not changed', { cause })
    }
    if (!replaced) {
      throw new PluginInstallControllerError('install-conflict', 'Plugin changed in another tab')
    }
    return next
  }

  async function updateState(
    pluginId: string,
    activationState: PluginActivationState,
  ): Promise<InstalledPluginRecord> {
    const previous = await dependencies.storage.load(pluginId)
    if (!previous) {
      throw new PluginInstallControllerError('package-invalid', 'Plugin is not installed')
    }
    return replaceState(previous, activationState)
  }

  async function verifiedRecord(
    snapshot: PluginRecordSnapshot,
    signal: AbortSignal,
    allowDisabled: boolean,
    requireRequiredGrants = true,
  ): Promise<VerifiedInstalledPlugin> {
    const { generation: startingGeneration, record } = snapshot
    throwIfAborted(signal)
    if (!record) {
      throw new PluginInstallControllerError('package-invalid', 'Plugin is not installed')
    }
    if (dependencies.sessionSafety.isSafeMode()) {
      throw new PluginInstallControllerError('safe-mode', 'Plugins are disabled for this session')
    }
    const policy = await dependencies.trustPolicy()
    if (evaluatePluginRevocation(record, policy).revoked || record.activationState === 'revoked') {
      throw new PluginInstallControllerError('revoked', 'Plugin identity is locally revoked')
    }
    if (record.activationState === 'quarantined') {
      throw new PluginInstallControllerError('quarantined', 'Plugin is quarantined')
    }
    if (!allowDisabled && record.activationState !== 'enabled') {
      throw new PluginInstallControllerError('disabled', 'Plugin is disabled')
    }
    if (record.trust.kind === 'built-in' && !isBuiltInTrusted(record, policy)) {
      throw new PluginInstallControllerError('revoked', 'Built-in trust binding is no longer valid')
    }
    if (await dependencies.storage.generation() !== startingGeneration) {
      throw new PluginInstallControllerError('install-conflict', 'Plugin catalog changed before verification')
    }
    throwIfAborted(signal)
    let verified: VerifiedPluginPackage
    try {
      verified = await verifyPackage(record.archiveBytes)
    } catch (cause) {
      throw new PluginInstallControllerError('package-invalid', 'Stored package failed re-verification', {
        cause,
      })
    }
    throwIfAborted(signal)
    const currentSnapshot = await dependencies.storage.loadSnapshot(record.pluginId)
    throwIfAborted(signal)
    const current = currentSnapshot.record
    if (currentSnapshot.generation !== startingGeneration
      || !current
      || current.revision !== record.revision
      || current.packageDigest !== record.packageDigest) {
      throw new PluginInstallControllerError(
        'install-conflict',
        'Plugin changed while its package was being verified',
      )
    }
    const currentPolicy = await dependencies.trustPolicy()
    throwIfAborted(signal)
    if (dependencies.sessionSafety.isSafeMode()) {
      throw new PluginInstallControllerError('safe-mode', 'Plugins are disabled for this session')
    }
    if (await dependencies.storage.generation() !== startingGeneration) {
      throw new PluginInstallControllerError(
        'install-conflict',
        'Plugin catalog changed while its package was being verified',
      )
    }
    throwIfAborted(signal)
    if (evaluatePluginRevocation(current, currentPolicy).revoked
      || current.activationState === 'revoked') {
      throw new PluginInstallControllerError('revoked', 'Plugin identity is locally revoked')
    }
    if (current.activationState === 'quarantined') {
      throw new PluginInstallControllerError('quarantined', 'Plugin is quarantined')
    }
    if (!allowDisabled && current.activationState !== 'enabled') {
      throw new PluginInstallControllerError('disabled', 'Plugin is disabled')
    }
    if (current.trust.kind === 'built-in' && !isBuiltInTrusted(current, currentPolicy)) {
      throw new PluginInstallControllerError('revoked', 'Built-in trust binding is no longer valid')
    }
    if (!recordIdentityMatches(current, verified)) {
      throw new PluginInstallControllerError('package-invalid', 'Stored package identity changed')
    }
    if (verified.compatibility.status !== 'compatible') {
      throw new PluginInstallControllerError('incompatible', 'Plugin is incompatible with this host')
    }
    if (requireRequiredGrants && !requiredGrantsAvailable(current, verified)) {
      throw new PluginInstallControllerError('permission-denied', 'Required plugin permission is not granted')
    }
    return Object.freeze({
      catalogGeneration: startingGeneration,
      record: current,
      verified,
    })
  }

  const activationBundles: PluginActivationBundleResolver = Object.freeze({
    async resolve(pluginId: string, signal: AbortSignal) {
      throwIfAborted(signal)
      const snapshot = await dependencies.storage.loadSnapshot(pluginId)
      throwIfAborted(signal)
      const resolved = await verifiedRecord(snapshot, signal, false)
      throwIfAborted(signal)
      const { record: current, verified } = resolved
      const retainedModuleBytes = verified.moduleBytes
      if (retainedModuleBytes.byteLength !== verified.moduleByteLength) {
        throw new PluginInstallControllerError(
          'package-invalid',
          'Verified module length does not match its signed entry declaration',
        )
      }
      const profile: VerifiedPluginCapabilityProfile = Object.freeze({
        apiVersion: verified.compatibility.apiVersion as number,
        memoryMaximumPages: verified.manifest.runtime.memoryMaximumPages,
        permissions: Object.freeze(current.grants.map((grant) => Object.freeze({
          id: grant.id,
          version: grant.negotiatedVersion,
        }))),
      })
      const bundle: VerifiedPluginActivationBundle = {
        catalogGeneration: resolved.catalogGeneration,
        pluginId: current.pluginId,
        name: current.name,
        version: current.version,
        packageDigest: current.packageDigest,
        signerFingerprint: current.signerFingerprint,
        modulePath: current.modulePath,
        moduleSha256: current.moduleSha256,
        moduleByteLength: current.moduleByteLength,
        profile,
        contributions: Object.freeze(verified.manifest.contributions.map(freezeContribution)),
        copyModuleBytes: () => retainedModuleBytes.slice(),
      }
      return Object.freeze(bundle)
    },
  })

  const controller: PluginInstallController = {
    activationBundles,
    async inspectPackage(archiveBytes: Uint8Array, signal?: AbortSignal) {
      throwIfAborted(signal)
      let verified: VerifiedPluginPackage
      try {
        verified = await verifyPackage(archiveBytes)
      } catch (cause) {
        throw new PluginInstallControllerError('package-invalid', 'Package inspection failed', { cause })
      }
      throwIfAborted(signal)
      const identity = identityFor(verified)
      const policy = await dependencies.trustPolicy()
      const revocation = evaluatePluginRevocation(identity, policy)
      if (revocation.revoked) {
        throw new PluginInstallControllerError('revoked', 'Package identity is locally revoked')
      }
      const previous = await dependencies.storage.load(identity.pluginId)
      throwIfAborted(signal)
      const permissionPlan = planPluginPermissions(
        previous,
        identity,
        verified.manifest,
        verified.compatibility,
      )
      const decisionIds = new Set(permissionPlan.decisionsRequired.map((request) => request.id))
      const inspectionId = createInspectionId()
      const inspection: PluginPackageInspection = Object.freeze({
        inspectionId,
        pluginId: identity.pluginId,
        name: verified.manifest.name,
        version: identity.version,
        packageDigest: identity.packageDigest,
        signerFingerprint: identity.signerFingerprint,
        moduleSha256: verified.moduleSha256,
        memoryMaximumPages: verified.manifest.runtime.memoryMaximumPages,
        change: classifyPluginInstall(previous, identity),
        signerContinuity: previous?.signerFingerprint === identity.signerFingerprint,
        trustDecisionRequired: !isBuiltInTrusted(identity, policy)
          && !(previous?.signerFingerprint === identity.signerFingerprint
            && previous.trust.kind === 'user'),
        compatibility: freezeCompatibility(verified.compatibility),
        permissions: Object.freeze(verified.manifest.permissions.map((request) => {
          const compatibility = verified.compatibility.permissions.find((item) => item.id === request.id)
          return Object.freeze({
            ...request,
            negotiatedVersion: compatibility?.version ?? null,
            status: compatibility?.status ?? 'unavailable',
            decisionRequired: decisionIds.has(request.id),
          })
        })),
      })
      const archiveByteLength = verified.archiveBytes.byteLength
      const retainedBytes = [...pending.values()].reduce(
        (sum, item) => sum + item.archiveByteLength,
        archiveByteLength,
      )
      if (pending.size >= MAX_PENDING_INSPECTIONS || retainedBytes > MAX_PENDING_ARCHIVE_BYTES) {
        throw new PluginInstallControllerError('package-invalid', 'Too many packages are pending review')
      }
      pending.set(inspectionId, Object.freeze({
        verified,
        archiveByteLength,
        previous,
        inspection,
      }))
      return inspection
    },
    async commitInstallation(
      inspectionId: string,
      options: CommitPluginInstallationOptions,
    ) {
      const candidate = pending.get(inspectionId)
      if (!candidate) {
        throw new PluginInstallControllerError('inspection-not-found', 'Package inspection expired')
      }
      const { verified, previous, inspection } = candidate
      const identity = identityFor(verified)
      const policy = await dependencies.trustPolicy()
      if (pending.get(inspectionId) !== candidate) {
        throw new PluginInstallControllerError('inspection-not-found', 'Package inspection expired')
      }
      if (evaluatePluginRevocation(identity, policy).revoked) {
        throw new PluginInstallControllerError('revoked', 'Package identity is locally revoked')
      }
      if (inspection.change === 'downgrade' && !options.confirmDowngrade) {
        throw new PluginInstallControllerError(
          'downgrade-confirmation-required',
          'Plugin downgrade requires explicit confirmation',
        )
      }
      if (inspection.change === 'same-version-replacement'
        && !options.confirmSameVersionReplacement) {
        throw new PluginInstallControllerError(
          'replacement-confirmation-required',
          'Same-version package replacement requires explicit confirmation',
        )
      }
      const timestamp = now()
      const trust = trustForInstall(previous, identity, policy, options.trustSigner, timestamp)
      const permissionPlan = planPluginPermissions(
        previous,
        identity,
        verified.manifest,
        verified.compatibility,
      )
      const decisions = explicitPermissionDecisions(
        permissionPlan.decisionsRequired,
        options.permissionDecisions,
      )
      const grants: PluginPermissionGrant[] = [...permissionPlan.preserved]
      for (const request of permissionPlan.decisionsRequired) {
        if (!decisions.get(request.id)) continue
        const compatibility = verified.compatibility.permissions.find((item) => item.id === request.id)
        if (compatibility?.status !== 'available' || compatibility.version === null) {
          throw new PluginInstallControllerError(
            'incompatible',
            'An unavailable capability cannot be granted',
          )
        }
        grants.push(Object.freeze({
          ...request,
          negotiatedVersion: compatibility.version,
          grantedAt: timestamp,
          pluginId: identity.pluginId,
          signerFingerprint: identity.signerFingerprint,
          packageDigest: identity.packageDigest,
        }))
      }
      if (options.enableAfterInstall) {
        if (verified.compatibility.status !== 'compatible') {
          throw new PluginInstallControllerError('incompatible', 'Incompatible package cannot be enabled')
        }
        const deniedRequired = verified.manifest.permissions.some(
          (request) => request.required && !grants.some((grant) => grant.id === request.id),
        )
        if (deniedRequired) {
          throw new PluginInstallControllerError(
            'permission-denied',
            'Required permission was denied; install disabled instead',
          )
        }
      }
      const archiveBytes = verified.archiveBytes
      const next: InstalledPluginRecord = Object.freeze({
        schemaVersion: PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
        revision: nextStorageRevision(previous),
        pluginId: identity.pluginId,
        name: verified.manifest.name,
        catalogContributionCount: verified.manifest.contributions.length,
        version: identity.version,
        packageDigest: identity.packageDigest,
        signerFingerprint: identity.signerFingerprint,
        modulePath: verified.modulePath,
        moduleSha256: verified.moduleSha256,
        moduleByteLength: verified.moduleByteLength,
        installedAt: previous?.installedAt ?? timestamp,
        updatedAt: timestamp,
        activationState: options.enableAfterInstall ? 'enabled' : 'disabled',
        trust,
        grants: Object.freeze(grants),
        diagnostics: previous?.diagnostics ?? Object.freeze([]),
        archiveBytes,
      })
      let replaced: boolean
      if (pending.get(inspectionId) !== candidate || !pending.delete(inspectionId)) {
        throw new PluginInstallControllerError('inspection-not-found', 'Package inspection expired')
      }
      try {
        replaced = await dependencies.storage.replace(
          identity.pluginId,
          previous ? storageRevision(previous) : null,
          next,
        )
      } catch (cause) {
        if (!pending.has(inspectionId)) pending.set(inspectionId, candidate)
        throw new PluginInstallControllerError(
          'storage-failed',
          'Installation failed; the previous package and grants were preserved',
          { cause },
        )
      }
      if (!replaced) {
        throw new PluginInstallControllerError(
          'install-conflict',
          'Installed package changed after inspection; inspect it again',
        )
      }
      return next
    },
    cancelInspection(inspectionId: string) {
      return pending.delete(inspectionId)
    },
    disable: (pluginId) => updateState(pluginId, 'disabled'),
    async enable(pluginId: string, signal: AbortSignal) {
      const snapshot = await dependencies.storage.loadSnapshot(pluginId)
      const resolved = await verifiedRecord(snapshot, signal, true)
      return replaceState(resolved.record, 'enabled')
    },
    async setPermissionGrant(pluginId, permissionId, granted, signal) {
      const snapshot = await dependencies.storage.loadSnapshot(pluginId)
      const resolved = await verifiedRecord(snapshot, signal, true, false)
      const { record, verified } = resolved
      const request = verified.manifest.permissions.find((item) => item.id === permissionId)
      const compatibility = verified.compatibility.permissions.find(
        (item) => item.id === permissionId,
      )
      if (!request) {
        throw new PluginInstallControllerError(
          'package-invalid',
          'The package does not request this permission',
        )
      }
      if (granted
        && (compatibility?.status !== 'available' || compatibility.version === null)) {
        throw new PluginInstallControllerError(
          'incompatible',
          'An unavailable capability cannot be granted',
        )
      }
      const existing = record.grants.find((item) => item.id === permissionId)
      if ((!granted && !existing)
        || (granted
          && existing?.minVersion === request.minVersion
          && existing.maxVersion === request.maxVersion
          && existing.required === request.required
          && existing.negotiatedVersion === compatibility?.version)) return record
      const grants = record.grants.filter((item) => item.id !== permissionId)
      if (granted && compatibility?.version !== null && compatibility?.version !== undefined) {
        grants.push(Object.freeze({
          ...request,
          negotiatedVersion: compatibility.version,
          grantedAt: now(),
          pluginId: record.pluginId,
          signerFingerprint: record.signerFingerprint,
          packageDigest: record.packageDigest,
        }))
      }
      const next: InstalledPluginRecord = Object.freeze({
        ...record,
        revision: nextStorageRevision(record),
        updatedAt: now(),
        activationState: !granted && request.required ? 'disabled' : record.activationState,
        grants: Object.freeze(grants),
        archiveBytes: record.archiveBytes.slice(),
      })
      let replaced: boolean
      try {
        replaced = await dependencies.storage.replace(
          pluginId,
          storageRevision(record),
          next,
        )
      } catch (cause) {
        throw new PluginInstallControllerError(
          'storage-failed',
          'Plugin permission was not changed',
          { cause },
        )
      }
      if (!replaced) {
        throw new PluginInstallControllerError('install-conflict', 'Plugin changed in another tab')
      }
      return next
    },
    quarantine: (pluginId) => updateState(pluginId, 'quarantined'),
    async revoke(pluginId: string) {
      const previous = await dependencies.storage.load(pluginId)
      if (!previous) {
        throw new PluginInstallControllerError('package-invalid', 'Plugin is not installed')
      }
      try {
        await dependencies.revokeBinding({
          pluginId: previous.pluginId,
          signerFingerprint: previous.signerFingerprint,
        })
      } catch (cause) {
        throw new PluginInstallControllerError(
          'storage-failed',
          'Plugin revocation was not persisted',
          { cause },
        )
      }
      return replaceState(previous, 'revoked')
    },
    async uninstall(pluginId: string) {
      const previous = await dependencies.storage.load(pluginId)
      if (!previous) return false
      let removed: boolean
      try {
        removed = await dependencies.storage.remove(pluginId, storageRevision(previous))
      } catch (cause) {
        throw new PluginInstallControllerError('storage-failed', 'Plugin was not uninstalled', { cause })
      }
      if (!removed) {
        throw new PluginInstallControllerError('install-conflict', 'Plugin changed in another tab')
      }
      return true
    },
    async recordDiagnostic(pluginId: string, code: PluginDiagnosticCode) {
      const previous = await dependencies.storage.load(pluginId)
      if (!previous) return
      const next = Object.freeze({
        ...previous,
        revision: nextStorageRevision(previous),
        updatedAt: now(),
        diagnostics: appendPluginDiagnostic(previous.diagnostics, { code, occurredAt: now() }),
        archiveBytes: previous.archiveBytes.slice(),
      })
      try {
        await dependencies.storage.replace(pluginId, storageRevision(previous), next, false)
      } catch {
        // Diagnostics are deliberately best effort and never expose exception text.
      }
    },
    async declarationCatalog(signal?: AbortSignal) {
      throwIfAborted(signal)
      const snapshot = await dependencies.storage.catalogSnapshot()
      const { generation, records } = snapshot
      throwIfAborted(signal)
      const safeMode = dependencies.sessionSafety.isSafeMode()
      const policy = await dependencies.trustPolicy()
      const declarations: PluginDeclarationCatalogEntry[] = []
      for (const record of records) {
        throwIfAborted(signal)
        let verified: VerifiedPluginPackage | null = null
        try {
          verified = await verifyPackage(record.archiveBytes)
        } catch {
          // The catalog reports a host-authored reason without retaining attacker text.
        }
        throwIfAborted(signal)
        const statusReason = statusForRecord(record, verified, safeMode, policy)
        if (verified && recordIdentityMatches(record, verified)) {
          for (const contribution of verified.manifest.contributions) {
            declarations.push(Object.freeze({
              pluginId: record.pluginId,
              pluginVersion: record.version,
              packageDigest: record.packageDigest,
              signerFingerprint: record.signerFingerprint,
              kind: contribution.kind,
              contributionId: contribution.id,
              contributionName: contribution.name,
              contributionVersion: contribution.contributionVersion,
              descriptorVersion: contribution.descriptorVersion,
              entrypoint: contribution.entrypoint,
              parameters: Object.freeze(contribution.parameters.map(freezeParameter)),
              availability: availabilityForStatus(statusReason),
              detail: detailForStatus(statusReason),
            }))
          }
        }
      }
      declarations.sort((left, right) => {
        const leftKey = `${left.pluginId}\0${left.contributionId}`
        const rightKey = `${right.pluginId}\0${right.contributionId}`
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      })
      if (await dependencies.storage.generation() !== generation) {
        throw new PluginInstallControllerError(
          'install-conflict',
          'Plugin catalog changed while its declarations were being verified',
        )
      }
      throwIfAborted(signal)
      if (dependencies.sessionSafety.isSafeMode() !== safeMode) {
        throw new PluginInstallControllerError(
          'safe-mode',
          'Plugin safe mode changed while declarations were being verified',
        )
      }
      return Object.freeze({
        generation,
        declarations: Object.freeze(declarations),
      })
    },
  }
  return Object.freeze(controller)
}
