import { describe, expect, test } from 'vitest'
import {
  LocalPluginStorageError,
  createLocalPluginStorage,
  type LocalPluginStorageBackend,
} from './localPluginStorage'
import {
  PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
  PLUGIN_REGISTRY_LIMITS,
  type InstalledPluginRecord,
  type Sha256Identity,
} from './pluginTrustRegistry'

const DIGEST_A = `sha256:${'a'.repeat(64)}` as Sha256Identity
const DIGEST_B = `sha256:${'b'.repeat(64)}` as Sha256Identity
const SIGNER = `sha256:${'1'.repeat(64)}` as Sha256Identity

function record(overrides: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    schemaVersion: PLUGIN_REGISTRY_RECORD_SCHEMA_VERSION,
    revision: 1,
    pluginId: 'com.example.fixture',
    name: 'Fixture',
    catalogContributionCount: 1,
    version: '1.0.0',
    packageDigest: DIGEST_A,
    signerFingerprint: SIGNER,
    modulePath: 'runtime/plugin.wasm',
    moduleSha256: '2'.repeat(64),
    moduleByteLength: 8,
    installedAt: 1,
    updatedAt: 1,
    activationState: 'enabled',
    trust: { kind: 'user', trustedAt: 1 },
    grants: [],
    diagnostics: [],
    archiveBytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  }
}

function memoryBackend(initial: readonly InstalledPluginRecord[] = []): LocalPluginStorageBackend & {
  readonly values: Map<string, unknown>
  generation: number
} {
  const values = new Map<string, unknown>(initial.map((item) => [item.pluginId, item]))
  const backend: LocalPluginStorageBackend & {
    readonly values: Map<string, unknown>
    generation: number
  } = {
    values,
    generation: 0,
    getWithGeneration: async (pluginId) => ({
      generation: backend.generation,
      value: values.get(pluginId),
    }),
    listWithGeneration: async () => ({
      generation: backend.generation,
      values: [...values.values()],
    }),
    getGeneration: async () => backend.generation,
    compareAndSwap: async (pluginId, expected, next, catalogAffecting) => {
      const current = values.get(pluginId) as InstalledPluginRecord | undefined
      if ((current?.packageDigest ?? null) !== (expected?.packageDigest ?? null)
        || (current?.revision ?? null) !== (expected?.revision ?? null)) return false
      const retained = [...values.entries()]
        .filter(([key]) => key !== pluginId)
        .map(([, value]) => value as InstalledPluginRecord)
      const aggregateContributions = retained.reduce(
        (sum, item) => sum + item.catalogContributionCount,
        next.catalogContributionCount,
      )
      if (aggregateContributions > PLUGIN_REGISTRY_LIMITS.maxAggregateContributions) {
        throw new LocalPluginStorageError('The plugin declaration catalog limit was reached')
      }
      values.set(pluginId, next)
      if (catalogAffecting) backend.generation += 1
      return true
    },
    removeIf: async (pluginId, expected, catalogAffecting) => {
      const current = values.get(pluginId) as InstalledPluginRecord | undefined
      if (current?.packageDigest !== expected.packageDigest
        || current.revision !== expected.revision) return false
      values.delete(pluginId)
      if (catalogAffecting) backend.generation += 1
      return true
    },
  }
  return backend
}

describe('local plugin storage boundary', () => {
  test('copies package bytes on commit and every load', async () => {
    const backend = memoryBackend()
    const storage = createLocalPluginStorage(backend)
    const candidate = record()

    await expect(storage.replace(candidate.pluginId, null, candidate)).resolves.toBe(true)
    candidate.archiveBytes[0] = 0xff
    const first = await storage.load(candidate.pluginId)
    expect(first?.archiveBytes).toEqual(new Uint8Array([1, 2, 3]))
    if (!first) throw new Error('expected stored record')
    first.archiveBytes[1] = 0xff
    expect((await storage.load(candidate.pluginId))?.archiveBytes).toEqual(
      new Uint8Array([1, 2, 3]),
    )
  })

  test('fails closed on unknown fields, unsafe ids, and oversized diagnostics', async () => {
    const backend = memoryBackend()
    backend.values.set('com.example.fixture', {
      ...record(),
      unexpected: 'field',
    })
    const storage = createLocalPluginStorage(backend)
    await expect(storage.load('com.example.fixture')).rejects.toBeInstanceOf(
      LocalPluginStorageError,
    )

    backend.values.set('com.example.fixture', record({ pluginId: '__proto__' }))
    await expect(storage.load('com.example.fixture')).rejects.toThrow('bounded validation')

    backend.values.set('com.example.fixture', record({
      diagnostics: Array.from({ length: 101 }, (_, occurredAt) => ({
        code: 'timeout' as const,
        occurredAt,
      })),
    }))
    await expect(storage.load('com.example.fixture')).rejects.toThrow('bounded validation')
  })

  test('fails closed when an IndexedDB key and stored plugin identity diverge', async () => {
    const backend = memoryBackend()
    backend.values.set('com.example.expected', record({
      pluginId: 'com.example.different',
    }))
    const storage = createLocalPluginStorage(backend)

    await expect(storage.load('com.example.expected')).rejects.toThrow(
      'key does not match the record id',
    )
  })

  test('uses package-digest and monotonic-revision compare-and-swap for replacement and uninstall', async () => {
    const backend = memoryBackend([record()])
    const storage = createLocalPluginStorage(backend)
    const replacement = record({ revision: 2, packageDigest: DIGEST_B, version: '2.0.0' })

    await expect(storage.replace(replacement.pluginId, {
      packageDigest: DIGEST_B,
      revision: 1,
    }, replacement)).resolves.toBe(false)
    expect((await storage.load(replacement.pluginId))?.packageDigest).toBe(DIGEST_A)
    await expect(storage.replace(replacement.pluginId, {
      packageDigest: DIGEST_A,
      revision: 2,
    }, replacement)).resolves.toBe(false)
    await expect(storage.replace(replacement.pluginId, {
      packageDigest: DIGEST_A,
      revision: 1,
    }, replacement)).resolves.toBe(true)
    await expect(storage.remove(replacement.pluginId, {
      packageDigest: DIGEST_B,
      revision: 1,
    })).resolves.toBe(false)
    await expect(storage.remove(replacement.pluginId, {
      packageDigest: DIGEST_B,
      revision: 2,
    })).resolves.toBe(true)
  })

  test('rejects a registry exceeding the aggregate entry limit', async () => {
    const backend = memoryBackend()
    for (let index = 0; index < 65; index += 1) {
      const pluginId = `com.example.fixture${index}`
      backend.values.set(pluginId, record({ pluginId }))
    }
    const storage = createLocalPluginStorage(backend)

    await expect(storage.list()).rejects.toThrow('exceeds its entry limit')
  })

  test('accepts exactly 1,024 declarations and rolls back cap-plus-one installs', async () => {
    const initial = Array.from({ length: 15 }, (_, index) => record({
      pluginId: `com.example.fixture${index}`,
      catalogContributionCount: 64,
    }))
    const backend = memoryBackend(initial)
    const storage = createLocalPluginStorage(backend)
    const exact = record({
      pluginId: 'com.example.exact',
      catalogContributionCount: 64,
    })
    const overflow = record({ pluginId: 'com.example.overflow' })

    await expect(storage.replace(exact.pluginId, null, exact)).resolves.toBe(true)
    await expect(storage.catalogSnapshot()).resolves.toMatchObject({ generation: 1 })
    await expect(storage.replace(overflow.pluginId, null, overflow)).rejects.toThrow(
      'declaration catalog limit',
    )
    expect(await storage.load(overflow.pluginId)).toBeNull()
    expect(backend.generation).toBe(1)
  })

  test('cap-plus-one update preserves the old record and management generation', async () => {
    const initial = [
      ...Array.from({ length: 15 }, (_, index) => record({
        pluginId: `com.example.fixture${index}`,
        catalogContributionCount: 64,
      })),
      record({ pluginId: 'com.example.target', catalogContributionCount: 63 }),
      record({ pluginId: 'com.example.filler', catalogContributionCount: 1 }),
    ]
    const backend = memoryBackend(initial)
    const storage = createLocalPluginStorage(backend)
    const replacement = record({
      pluginId: 'com.example.target',
      revision: 2,
      version: '2.0.0',
      packageDigest: DIGEST_B,
      catalogContributionCount: 64,
    })

    await expect(storage.replace(replacement.pluginId, {
      packageDigest: DIGEST_A,
      revision: 1,
    }, replacement)).rejects.toThrow('declaration catalog limit')
    expect(await storage.load(replacement.pluginId)).toMatchObject({
      version: '1.0.0',
      packageDigest: DIGEST_A,
      catalogContributionCount: 63,
      revision: 1,
    })
    expect(backend.generation).toBe(0)
  })
})
