import { describe, expect, test } from 'vitest'
import {
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  type PluginCompatibilityResult,
  type PluginManifestV1,
} from '../domain/pluginManifest'
import {
  appendPluginDiagnostic,
  classifyPluginInstall,
  comparePluginVersions,
  createPluginTrustRegistry,
  evaluatePluginRevocation,
  parsePersistedPluginTrustPolicy,
  PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
  PLUGIN_TRUST_POLICY_SCHEMA_VERSION,
  planPluginPermissions,
  type InstalledPluginRecord,
  type PluginTrustPolicy,
  type Sha256Identity,
} from './pluginTrustRegistry'

const DIGEST_A = `sha256:${'a'.repeat(64)}` as Sha256Identity
const DIGEST_B = `sha256:${'b'.repeat(64)}` as Sha256Identity
const SIGNER_A = `sha256:${'1'.repeat(64)}` as Sha256Identity
const SIGNER_B = `sha256:${'2'.repeat(64)}` as Sha256Identity

function installed(overrides: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    schemaVersion: PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
    revision: 1,
    pluginId: 'com.example.fixture',
    name: 'Fixture',
    catalogContributionCount: 1,
    version: '1.0.0',
    packageDigest: DIGEST_A,
    signerFingerprint: SIGNER_A,
    modulePath: 'runtime/plugin.wasm',
    moduleSha256: '3'.repeat(64),
    moduleByteLength: 8,
    installedAt: 1,
    updatedAt: 1,
    activationState: 'enabled',
    trust: { kind: 'user', trustedAt: 1 },
    grants: [],
    diagnostics: [],
    archiveBytes: new Uint8Array([1]),
    ...overrides,
  }
}

function manifest(maxVersion = 1): PluginManifestV1 {
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: 'com.example.fixture',
    name: 'Fixture',
    version: '2.0.0',
    api: { minVersion: 1, maxVersion: 1 },
    runtime: { kind: 'wasm', entry: 'runtime/plugin.wasm', memoryMaximumPages: 258 },
    permissions: [{
      id: 'myrelith.effect.video-frame.rgba8',
      minVersion: 1,
      maxVersion,
      required: true,
    }],
    contributions: [],
  }
}

function compatibility(): PluginCompatibilityResult {
  return {
    status: 'compatible',
    apiVersion: 1,
    permissions: [{
      id: 'myrelith.effect.video-frame.rgba8',
      required: true,
      version: 1,
      status: 'available',
    }],
    contributions: [],
    reasons: [],
  }
}

describe('plugin trust and update policy', () => {
  test('orders complete SemVer precedence without unsafe integer coercion', () => {
    expect(comparePluginVersions('1.0.0-alpha.9', '1.0.0-alpha.10')).toBeLessThan(0)
    expect(comparePluginVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(comparePluginVersions('1.0.0+first', '1.0.0+second')).toBe(0)
    expect(comparePluginVersions(
      '999999999999999999999999999999.0.0',
      '1000000000000000000000000000000.0.0',
    )).toBeLessThan(0)
  })

  test('classifies downgrade and same-version digest replacement explicitly', () => {
    expect(classifyPluginInstall(installed(), {
      pluginId: 'com.example.fixture',
      version: '0.9.0',
      packageDigest: DIGEST_B,
      signerFingerprint: SIGNER_A,
    })).toBe('downgrade')
    expect(classifyPluginInstall(installed(), {
      pluginId: 'com.example.fixture',
      version: '1.0.0+rebuilt',
      packageDigest: DIGEST_B,
      signerFingerprint: SIGNER_A,
    })).toBe('same-version-replacement')
  })

  test('preserves only exact same-signer permission contracts for the new digest', () => {
    const previous = installed({
      grants: [{
        id: 'myrelith.effect.video-frame.rgba8',
        minVersion: 1,
        maxVersion: 1,
        required: true,
        negotiatedVersion: 1,
        grantedAt: 1,
        pluginId: 'com.example.fixture',
        signerFingerprint: SIGNER_A,
        packageDigest: DIGEST_A,
      }],
    })
    const identity = {
      pluginId: previous.pluginId,
      version: '2.0.0',
      packageDigest: DIGEST_B,
      signerFingerprint: SIGNER_A,
    }

    const exact = planPluginPermissions(previous, identity, manifest(), compatibility())
    expect(exact.decisionsRequired).toEqual([])
    expect(exact.preserved).toEqual([
      expect.objectContaining({ packageDigest: DIGEST_B }),
    ])

    const widened = planPluginPermissions(previous, identity, manifest(2), compatibility())
    expect(widened.preserved).toEqual([])
    expect(widened.decisionsRequired).toHaveLength(1)

    const newSigner = planPluginPermissions(previous, {
      ...identity,
      signerFingerprint: SIGNER_B,
    }, manifest(), compatibility())
    expect(newSigner.preserved).toEqual([])
    expect(newSigner.decisionsRequired).toHaveLength(1)
  })

  test('checks package, signer, and plugin binding revocations', () => {
    const policy: PluginTrustPolicy = {
      builtInTrustedBindings: [],
      revokedPackageDigests: [DIGEST_A],
      revokedSignerFingerprints: [],
      revokedBindings: [],
    }
    expect(evaluatePluginRevocation(installed(), policy)).toEqual({
      revoked: true,
      reason: 'package',
    })
    expect(evaluatePluginRevocation(installed({ packageDigest: DIGEST_B }), {
      ...policy,
      revokedPackageDigests: [],
      revokedBindings: [{
        pluginId: 'com.example.fixture',
        signerFingerprint: SIGNER_A,
      }],
    })).toEqual({ revoked: true, reason: 'binding' })
  })

  test('retains only the latest 100 host-owned diagnostic codes', () => {
    let diagnostics = Object.freeze([]) as ReturnType<typeof appendPluginDiagnostic>
    for (let index = 0; index < 105; index += 1) {
      diagnostics = appendPluginDiagnostic(diagnostics, {
        code: 'timeout',
        occurredAt: index,
      })
    }
    expect(diagnostics).toHaveLength(100)
    expect(diagnostics[0].occurredAt).toBe(5)
    expect(Object.isFrozen(diagnostics)).toBe(true)
  })

  test('persists bounded revocations with compare-and-swap and no duplicate growth', async () => {
    let stored: unknown
    let writes = 0
    const registry = createPluginTrustRegistry({
      load: async () => stored,
      compareAndSwap: async (expected, next) => {
        const current = parsePersistedPluginTrustPolicy(stored)
        if (current.revision !== expected) return false
        stored = next
        writes += 1
        return true
      },
    })

    await registry.revokeBinding({
      pluginId: 'com.example.fixture',
      signerFingerprint: SIGNER_A,
    })
    await registry.revokeBinding({
      pluginId: 'com.example.fixture',
      signerFingerprint: SIGNER_A,
    })

    expect(writes).toBe(1)
    expect(await registry.policy()).toMatchObject({
      revokedBindings: [{
        pluginId: 'com.example.fixture',
        signerFingerprint: SIGNER_A,
      }],
    })
  })

  test('fails closed on malformed or duplicate persisted revocations', () => {
    expect(() => parsePersistedPluginTrustPolicy({
      schemaVersion: PLUGIN_TRUST_POLICY_SCHEMA_VERSION,
      revision: 1,
      revokedPackageDigests: [DIGEST_A, DIGEST_A],
      revokedSignerFingerprints: [],
      revokedBindings: [],
    })).toThrow('invalid or duplicate revocation')
    expect(() => parsePersistedPluginTrustPolicy({
      schemaVersion: PLUGIN_TRUST_POLICY_SCHEMA_VERSION,
      revision: 1,
      revokedPackageDigests: [],
      revokedSignerFingerprints: [],
      revokedBindings: [],
      unknown: true,
    })).toThrow('bounded validation')
  })
})
