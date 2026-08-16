import { describe, expect, test, vi } from 'vitest'
import {
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  negotiatePluginCompatibility,
  type PluginManifestV1,
} from '../domain/pluginManifest'
import {
  createPluginInstallController,
  type CommitPluginInstallationOptions,
} from './pluginInstallController'
import { createLocalPluginStorage, type LocalPluginStorageBackend } from './localPluginStorage'
import type { VerifiedPluginPackage } from './pluginPackage'
import type {
  PluginSessionSafety,
  PluginSessionStartupMode,
} from './pluginSafetyController'
import type {
  InstalledPluginRecord,
  PluginTrustPolicy,
  Sha256Identity,
} from './pluginTrustRegistry'

const DIGEST_A = `sha256:${'a'.repeat(64)}` as Sha256Identity
const DIGEST_B = `sha256:${'b'.repeat(64)}` as Sha256Identity
const DIGEST_C = `sha256:${'c'.repeat(64)}` as Sha256Identity
const SIGNER_A = `sha256:${'1'.repeat(64)}` as Sha256Identity
const SIGNER_B = `sha256:${'2'.repeat(64)}` as Sha256Identity

interface MemoryBackend extends LocalPluginStorageBackend {
  readonly values: Map<string, InstalledPluginRecord>
  failNextSwap: boolean
  swapCalls: number
  beforeSwap: (() => Promise<void>) | null
  generation: number
}

function memoryBackend(): MemoryBackend {
  const backend: MemoryBackend = {
    values: new Map(),
    failNextSwap: false,
    swapCalls: 0,
    beforeSwap: null,
    generation: 0,
    getWithGeneration: async (pluginId) => ({
      generation: backend.generation,
      value: backend.values.get(pluginId),
    }),
    listWithGeneration: async () => ({
      generation: backend.generation,
      values: [...backend.values.values()],
    }),
    getGeneration: async () => backend.generation,
    compareAndSwap: async (pluginId, expected, next, catalogAffecting) => {
      backend.swapCalls += 1
      await backend.beforeSwap?.()
      if (backend.failNextSwap) {
        backend.failNextSwap = false
        throw new DOMException('quota', 'QuotaExceededError')
      }
      const current = backend.values.get(pluginId)
      if ((current?.packageDigest ?? null) !== (expected?.packageDigest ?? null)
        || (current?.revision ?? null) !== (expected?.revision ?? null)) return false
      backend.values.set(pluginId, next)
      if (catalogAffecting) backend.generation += 1
      return true
    },
    removeIf: async (pluginId, expected, catalogAffecting) => {
      const current = backend.values.get(pluginId)
      if (current?.packageDigest !== expected.packageDigest
        || current.revision !== expected.revision) return false
      backend.values.delete(pluginId)
      if (catalogAffecting) backend.generation += 1
      return true
    },
  }
  return backend
}

function verified(options: {
  readonly key: number
  readonly version: string
  readonly digest: Sha256Identity
  readonly signer?: Sha256Identity
  readonly permissionMax?: number
  readonly permissionRequired?: boolean
  readonly pluginId?: string
  readonly moduleByteLength?: number
}): VerifiedPluginPackage {
  const manifest: PluginManifestV1 = Object.freeze({
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: options.pluginId ?? 'com.example.fixture',
    name: 'Fixture',
    version: options.version,
    api: Object.freeze({ minVersion: 1, maxVersion: 1 }),
    runtime: Object.freeze({
      kind: 'wasm',
      entry: 'runtime/plugin.wasm',
      memoryMaximumPages: 258,
    }),
    permissions: Object.freeze([Object.freeze({
      id: 'myrelith.effect.video-frame.rgba8',
      minVersion: 1,
      maxVersion: options.permissionMax ?? 1,
      required: options.permissionRequired ?? true,
    })]),
    contributions: Object.freeze([Object.freeze({
      kind: 'video-effect',
      contributionVersion: 1,
      id: 'fixture',
      name: 'Fixture',
      descriptorVersion: 1,
      entrypoint: 'myrelith_effect_fixture',
      migrations: Object.freeze([]),
      parameters: Object.freeze([]),
    })]),
  })
  const archive = new Uint8Array([options.key])
  const module = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  return Object.freeze({
    packageDigest: options.digest,
    signerFingerprint: options.signer ?? SIGNER_A,
    modulePath: manifest.runtime.entry,
    moduleSha256: '3'.repeat(64),
    moduleByteLength: options.moduleByteLength ?? module.byteLength,
    manifest,
    compatibility: negotiatePluginCompatibility(manifest),
    get archiveBytes() { return archive.slice() },
    get manifestBytes() { return new Uint8Array([123, 125]) },
    get moduleBytes() { return module.slice() },
    get signatureBytes() { return new Uint8Array([123, 125]) },
  })
}

const INSTALL_ENABLED: CommitPluginInstallationOptions = Object.freeze({
  trustSigner: true,
  confirmDowngrade: false,
  confirmSameVersionReplacement: false,
  enableAfterInstall: true,
  permissionDecisions: Object.freeze([Object.freeze({
    id: 'myrelith.effect.video-frame.rgba8',
    granted: true,
  })]),
})

function harness(packages: readonly VerifiedPluginPackage[]) {
  const backend = memoryBackend()
  const storage = createLocalPluginStorage(backend)
  const byKey = new Map(packages.map((item) => [item.archiveBytes[0], item]))
  const verifyPackage = vi.fn(async (bytes: Uint8Array) => {
    const value = byKey.get(bytes[0])
    if (!value) throw new Error('unknown fixture package')
    return value
  })
  let policy: PluginTrustPolicy = {
    builtInTrustedBindings: [],
    revokedPackageDigests: [],
    revokedSignerFingerprints: [],
    revokedBindings: [],
  }
  let readPolicy: () => PluginTrustPolicy | Promise<PluginTrustPolicy> = () => policy
  let startupMode: PluginSessionStartupMode = 'normal'
  const sessionSafety: PluginSessionSafety = {
    enterSafeMode: () => { startupMode = 'safe-mode' },
    continueWithReviewedNormalStartup: () => {
      if (startupMode !== 'review-required') return false
      startupMode = 'normal'
      return true
    },
    startupMode: () => startupMode,
    isSafeMode: () => startupMode === 'safe-mode',
    thirdPartyInitializationAllowed: () => startupMode === 'normal',
  }
  const createController = () => createPluginInstallController({
    storage,
    sessionSafety,
    trustPolicy: () => readPolicy(),
    revokeBinding: async (binding) => {
      policy = {
        ...policy,
        revokedBindings: [...policy.revokedBindings, binding],
      }
      backend.generation += 1
    },
    verifyPackage,
    now: (() => {
      let timestamp = 10
      return () => timestamp++
    })(),
  })
  const controller = createController()
  return {
    backend,
    controller,
    createController,
    storage,
    verifyPackage,
    setPolicy: (next: PluginTrustPolicy) => { policy = next },
    setPolicyReader: (next: () => PluginTrustPolicy | Promise<PluginTrustPolicy>) => {
      readPolicy = next
    },
    enterSafeMode: () => { startupMode = 'safe-mode' },
    requireStartupReview: () => { startupMode = 'review-required' },
    continueWithReviewedNormalStartup: () => sessionSafety.continueWithReviewedNormalStartup(),
  }
}

describe('plugin installation and activation boundary', () => {
  test('inspection is non-mutating and activation exposes only fresh-copy verified bytes', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { backend, controller, storage } = harness([fixture])

    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    expect(backend.swapCalls).toBe(0)
    expect(inspection).toMatchObject({
      pluginId: 'com.example.fixture',
      installedVersion: null,
      versionChanged: false,
      sameVersionReplacement: false,
      samePackage: false,
      trustState: 'untrusted',
      trustDecisionRequired: true,
      change: 'new-install',
      contributionNames: ['Fixture'],
      selectedCapabilities: [{
        id: 'myrelith.effect.video-frame.rgba8',
        version: 1,
        required: true,
      }],
      diagnostics: [],
    })
    expect(inspection.permissions[0].decisionRequired).toBe(true)
    expect(inspection.permissions[0]).toMatchObject({
      selectedVersion: 1,
      priorGrant: null,
      grantChange: 'new',
    })

    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    const record = await storage.load('com.example.fixture')
    expect(record).toMatchObject({ activationState: 'enabled', packageDigest: DIGEST_A })

    const bundle = await controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )
    const first = bundle.copyModuleBytes()
    first[0] = 0xff
    expect(bundle.copyModuleBytes()).toEqual(fixture.moduleBytes)
    expect(bundle.copyModuleBytes()).not.toBe(first)
    expect(bundle.moduleByteLength).toBe(fixture.moduleByteLength)
    expect(Object.keys(bundle)).not.toContain('trust')
    expect(Object.keys(bundle)).not.toContain('archiveBytes')

    const trustedInspection = await controller.inspectPackage(new Uint8Array([1]))
    expect(trustedInspection).toMatchObject({
      signerContinuity: true,
      trustState: 'user-trusted',
      trustDecisionRequired: false,
    })
    expect(controller.cancelInspection(trustedInspection.inspectionId)).toBe(true)

    const catalog = await controller.declarationCatalog()
    expect(bundle.catalogGeneration).toBe(catalog.generation)
    expect(catalog.declarations[0]).toMatchObject({
      pluginVersion: '1.0.0',
      packageDigest: DIGEST_A,
      signerFingerprint: SIGNER_A,
      contributionName: 'Fixture',
      availability: 'ready',
      detail: 'Ready to render.',
    })
    expect(Object.isFrozen(catalog.declarations[0].parameters)).toBe(true)
  })

  test('projects built-in trust from the host policy without inferring publisher identity', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller, setPolicy } = harness([fixture])
    setPolicy({
      builtInTrustedBindings: [Object.freeze({
        pluginId: 'com.example.fixture',
        signerFingerprint: SIGNER_A,
      })],
      revokedPackageDigests: [],
      revokedSignerFingerprints: [],
      revokedBindings: [],
    })

    await expect(controller.inspectPackage(new Uint8Array([1]))).resolves.toMatchObject({
      trustState: 'built-in-trusted',
      trustDecisionRequired: false,
    })
  })

  test('rejects an off-by-one signed module length before bytes cross to runtime', async () => {
    const fixture = verified({
      key: 1,
      version: '1.0.0',
      digest: DIGEST_A,
      moduleByteLength: 9,
    })
    const { controller } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)

    await expect(controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'package-invalid' })
  })

  test('blocks activation until a stale-startup review explicitly chooses normal startup', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const {
      controller,
      requireStartupReview,
      continueWithReviewedNormalStartup,
      verifyPackage,
    } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    verifyPackage.mockClear()
    requireStartupReview()

    await expect(controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'startup-review-required' })
    expect(verifyPackage).not.toHaveBeenCalled()

    const catalog = await controller.declarationCatalog()
    expect(catalog.declarations[0]).toMatchObject({
      availability: 'safe-mode',
      detail: 'Review the interrupted activation before initializing plugins.',
    })
    const installed = await controller.installedPackages()
    expect(installed.packages[0]).toMatchObject({
      status: 'safe-mode',
      detail: 'Review the interrupted activation before initializing plugins.',
    })

    expect(continueWithReviewedNormalStartup()).toBe(true)
    await expect(controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )).resolves.toMatchObject({ pluginId: 'com.example.fixture' })
  })

  test('projects bounded installed-package facts and clears diagnostics without catalog churn', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller, storage } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    await controller.recordDiagnostic('com.example.fixture', 'timeout')
    await controller.recordDiagnostic('com.example.fixture', 'bad-response')
    const generationBeforeClear = await storage.generation()

    const snapshot = await controller.installedPackages()
    const projected = snapshot.packages[0]
    expect(projected).toEqual({
      pluginId: 'com.example.fixture',
      name: 'Fixture',
      installedVersion: '1.0.0',
      packageDigest: DIGEST_A,
      signerFingerprint: SIGNER_A,
      contributionNames: ['Fixture'],
      selectedCapabilities: [{
        id: 'myrelith.effect.video-frame.rgba8',
        version: 1,
        required: true,
      }],
      status: 'ready',
      detail: 'Ready to render.',
      diagnostics: [
        { code: 'timeout', occurredAt: 12 },
        { code: 'bad-response', occurredAt: 14 },
      ],
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.packages)).toBe(true)
    expect(Object.isFrozen(projected)).toBe(true)
    expect(Object.isFrozen(projected.diagnostics)).toBe(true)
    expect(Object.keys(projected)).not.toContain('archiveBytes')
    expect(Object.keys(projected)).not.toContain('trust')
    expect(Object.keys(projected)).not.toContain('grants')
    expect(Object.keys(projected)).not.toContain('storage')

    await expect(controller.clearDiagnostics('com.example.fixture')).resolves.toBe(true)
    expect(await storage.generation()).toBe(generationBeforeClear)
    expect((await storage.load('com.example.fixture'))?.diagnostics).toEqual([])
    expect((await controller.installedPackages()).packages[0].diagnostics).toEqual([])
    await expect(controller.clearDiagnostics('com.example.missing')).resolves.toBe(false)
  })

  test('same-signer update preserves only an unchanged grant and rebases its digest', async () => {
    const first = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const update = verified({ key: 2, version: '2.0.0', digest: DIGEST_B })
    const widened = verified({
      key: 3,
      version: '3.0.0',
      digest: DIGEST_C,
      permissionMax: 2,
    })
    const { controller, storage } = harness([first, update, widened])
    const initial = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(initial.inspectionId, INSTALL_ENABLED)

    const next = await controller.inspectPackage(new Uint8Array([2]))
    expect(next.permissions[0].decisionRequired).toBe(false)
    expect(next).toMatchObject({
      installedVersion: '1.0.0',
      versionChanged: true,
      sameVersionReplacement: false,
    })
    expect(next.permissions[0]).toMatchObject({
      grantChange: 'preserved',
      priorGrant: {
        minVersion: 1,
        maxVersion: 1,
        required: true,
        selectedVersion: 1,
      },
    })
    const committed = await controller.commitInstallation(next.inspectionId, {
      ...INSTALL_ENABLED,
      trustSigner: false,
      permissionDecisions: [],
    })
    expect(committed.grants[0].packageDigest).toBe(DIGEST_B)
    expect(committed.grants[0].grantedAt).toBe(10)

    const changedPermission = await controller.inspectPackage(new Uint8Array([3]))
    expect(changedPermission.permissions[0].decisionRequired).toBe(true)
    expect(changedPermission.permissions[0]).toMatchObject({
      grantChange: 'widened',
      priorGrant: {
        maxVersion: 1,
        selectedVersion: 1,
      },
      maxVersion: 2,
    })
    expect((await storage.load('com.example.fixture'))?.packageDigest).toBe(DIGEST_B)
  })

  test('distinguishes an exact same-version replacement from a version change', async () => {
    const first = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const replacement = verified({ key: 2, version: '1.0.0', digest: DIGEST_B })
    const { controller } = harness([first, replacement])
    const initial = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(initial.inspectionId, INSTALL_ENABLED)

    const inspection = await controller.inspectPackage(new Uint8Array([2]))

    expect(inspection).toMatchObject({
      installedVersion: '1.0.0',
      versionChanged: false,
      sameVersionReplacement: true,
      samePackage: false,
      change: 'same-version-replacement',
    })
    expect(inspection.permissions[0].grantChange).toBe('preserved')
  })

  test('signer changes require new trust and cannot inherit permission grants', async () => {
    const first = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const replacement = verified({
      key: 2,
      version: '2.0.0',
      digest: DIGEST_B,
      signer: SIGNER_B,
    })
    const { controller } = harness([first, replacement])
    const initial = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(initial.inspectionId, INSTALL_ENABLED)
    const inspection = await controller.inspectPackage(new Uint8Array([2]))

    expect(inspection).toMatchObject({
      signerContinuity: false,
      trustState: 'untrusted',
      trustDecisionRequired: true,
    })
    expect(inspection.permissions[0]).toMatchObject({
      decisionRequired: true,
      grantChange: 'new',
      priorGrant: {
        minVersion: 1,
        maxVersion: 1,
        required: true,
        selectedVersion: 1,
      },
    })
    await expect(controller.commitInstallation(inspection.inspectionId, {
      ...INSTALL_ENABLED,
      trustSigner: false,
    })).rejects.toMatchObject({
      code: 'trust-required',
    })
  })

  test('storage failure preserves the previous package and the inspection remains retryable', async () => {
    const first = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const update = verified({ key: 2, version: '2.0.0', digest: DIGEST_B })
    const { backend, controller, storage } = harness([first, update])
    const initial = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(initial.inspectionId, INSTALL_ENABLED)
    const inspection = await controller.inspectPackage(new Uint8Array([2]))
    const updateOptions = {
      ...INSTALL_ENABLED,
      trustSigner: false,
      permissionDecisions: [],
    }

    backend.failNextSwap = true
    await expect(controller.commitInstallation(inspection.inspectionId, updateOptions))
      .rejects.toMatchObject({ code: 'storage-failed' })
    expect((await storage.load('com.example.fixture'))?.packageDigest).toBe(DIGEST_A)

    await expect(controller.commitInstallation(inspection.inspectionId, updateOptions))
      .resolves.toMatchObject({ packageDigest: DIGEST_B })
  })

  test('checks current revocation and cancellation before re-verifying or exposing bytes', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller, setPolicy, verifyPackage } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    verifyPackage.mockClear()
    setPolicy({
      builtInTrustedBindings: [],
      revokedPackageDigests: [],
      revokedSignerFingerprints: [SIGNER_A],
      revokedBindings: [],
    })

    await expect(controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'revoked' })
    expect(verifyPackage).not.toHaveBeenCalled()

    const aborted = new AbortController()
    aborted.abort('cancelled')
    await expect(controller.activationBundles.resolve('com.example.fixture', aborted.signal))
      .rejects.toMatchObject({ code: 'aborted' })
    expect(verifyPackage).not.toHaveBeenCalled()
  })

  test('rechecks revocation after asynchronous package verification before exposing bytes', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller, setPolicy, verifyPackage } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    verifyPackage.mockClear()

    let releaseVerification!: () => void
    verifyPackage.mockImplementationOnce(() => new Promise<VerifiedPluginPackage>((resolve) => {
      releaseVerification = () => resolve(fixture)
    }))
    const resolution = controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(verifyPackage).toHaveBeenCalledTimes(1))
    setPolicy({
      builtInTrustedBindings: [],
      revokedPackageDigests: [],
      revokedSignerFingerprints: [SIGNER_A],
      revokedBindings: [],
    })
    releaseVerification()

    await expect(resolution).rejects.toMatchObject({ code: 'revoked' })
  })

  test('rejects activation when safe mode begins during the final generation check', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { backend, controller, enterSafeMode } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)

    const getGeneration = backend.getGeneration
    let generationReads = 0
    backend.getGeneration = async () => {
      generationReads += 1
      if (generationReads === 2) enterSafeMode()
      return getGeneration()
    }

    await expect(controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'safe-mode' })
  })

  test('same-digest install cannot overwrite a newer disabled revision', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller, storage } = harness([fixture])
    const initial = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(initial.inspectionId, INSTALL_ENABLED)
    const staleInspection = await controller.inspectPackage(new Uint8Array([1]))

    const disabled = await controller.disable('com.example.fixture')
    expect(disabled).toMatchObject({ activationState: 'disabled', revision: 2 })
    await expect(controller.commitInstallation(staleInspection.inspectionId, {
      ...INSTALL_ENABLED,
      trustSigner: false,
      permissionDecisions: [],
    })).rejects.toMatchObject({ code: 'install-conflict' })
    expect(await storage.load('com.example.fixture')).toMatchObject({
      activationState: 'disabled',
      revision: 2,
    })
  })

  test('cancelling an inspection while commit awaits policy prevents any write', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { backend, controller, setPolicyReader } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    const policy: PluginTrustPolicy = {
      builtInTrustedBindings: [],
      revokedPackageDigests: [],
      revokedSignerFingerprints: [],
      revokedBindings: [],
    }
    let releasePolicy!: () => void
    setPolicyReader(() => new Promise<PluginTrustPolicy>((resolve) => {
      releasePolicy = () => resolve(policy)
    }))

    const commit = controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    await vi.waitFor(() => expect(releasePolicy).toBeTypeOf('function'))
    expect(controller.cancelInspection(inspection.inspectionId)).toBe(true)
    releasePolicy()

    await expect(commit).rejects.toMatchObject({ code: 'inspection-not-found' })
    expect(backend.swapCalls).toBe(0)
  })

  test('cancellation is rejected after the transactional write owns the inspection', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { backend, controller } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    let releaseSwap!: () => void
    backend.beforeSwap = () => new Promise<void>((resolve) => {
      releaseSwap = resolve
    })

    const commit = controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    await vi.waitFor(() => expect(backend.swapCalls).toBe(1))
    expect(controller.cancelInspection(inspection.inspectionId)).toBe(false)
    releaseSwap()

    await expect(commit).resolves.toMatchObject({
      activationState: 'enabled',
      revision: 1,
    })
  })

  test('two controllers invalidate an old generation across disable and re-enable', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller, createController } = harness([fixture])
    const otherController = createController()
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    const oldCatalog = await controller.declarationCatalog()

    await otherController.disable('com.example.fixture')
    await otherController.enable('com.example.fixture', new AbortController().signal)
    const bundle = await controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )

    expect(bundle.catalogGeneration).toBe(oldCatalog.generation + 2)
  })

  test('two controllers invalidate an old generation on same-package reinstall', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller, createController } = harness([fixture])
    const otherController = createController()
    const initial = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(initial.inspectionId, INSTALL_ENABLED)
    const oldCatalog = await controller.declarationCatalog()
    const reinstall = await otherController.inspectPackage(new Uint8Array([1]))

    await otherController.commitInstallation(reinstall.inspectionId, {
      ...INSTALL_ENABLED,
      trustSigner: false,
      permissionDecisions: [],
    })
    const bundle = await controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )
    expect(bundle.catalogGeneration).toBe(oldCatalog.generation + 1)
  })

  test('two controllers invalidate generation and bundle capabilities on optional grant change', async () => {
    const fixture = verified({
      key: 1,
      version: '1.0.0',
      digest: DIGEST_A,
      permissionRequired: false,
    })
    const { controller, createController } = harness([fixture])
    const otherController = createController()
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)
    const oldCatalog = await controller.declarationCatalog()

    await otherController.setPermissionGrant(
      'com.example.fixture',
      'myrelith.effect.video-frame.rgba8',
      false,
      new AbortController().signal,
    )
    const bundle = await controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )
    expect(bundle.catalogGeneration).toBe(oldCatalog.generation + 1)
    expect(bundle.profile.permissions).toEqual([])
  })

  test('an unrelated plugin mutation invalidates the shared catalog generation', async () => {
    const first = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const unrelated = verified({
      key: 2,
      version: '1.0.0',
      digest: DIGEST_B,
      pluginId: 'com.example.unrelated',
    })
    const { controller, createController } = harness([first, unrelated])
    const otherController = createController()
    const initial = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(initial.inspectionId, INSTALL_ENABLED)
    const oldCatalog = await controller.declarationCatalog()

    const otherInspection = await otherController.inspectPackage(new Uint8Array([2]))
    await otherController.commitInstallation(otherInspection.inspectionId, INSTALL_ENABLED)
    const bundle = await controller.activationBundles.resolve(
      'com.example.fixture',
      new AbortController().signal,
    )
    expect(bundle.catalogGeneration).toBe(oldCatalog.generation + 1)
  })

  test('binding revocation survives uninstall and blocks reinstall', async () => {
    const fixture = verified({ key: 1, version: '1.0.0', digest: DIGEST_A })
    const { controller } = harness([fixture])
    const inspection = await controller.inspectPackage(new Uint8Array([1]))
    await controller.commitInstallation(inspection.inspectionId, INSTALL_ENABLED)

    await controller.revoke('com.example.fixture')
    await controller.uninstall('com.example.fixture')

    await expect(controller.inspectPackage(new Uint8Array([1])))
      .rejects.toMatchObject({ code: 'revoked' })
  })
})
