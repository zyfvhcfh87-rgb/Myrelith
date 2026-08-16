import { describe, expect, test, vi } from 'vitest'
import type { PluginEffectBridgeHandlerRequest } from '../workers/plugin-effect-bridge-protocol'
import {
  createPluginAppControllerOwner,
  PluginAppControllerError,
  type PluginAppController,
  type PluginAppControllerDependencies,
  type PluginAppFile,
} from './pluginAppController'
import type {
  PluginDeclarationCatalogEntry,
  PluginInstallController,
  PluginInstalledPackageProjection,
  PluginPackageInspection,
} from './pluginInstallController'
import type {
  LoadedPluginDisposer,
  LoadedPluginLifecycleToken,
} from './pluginLifecycle'
import { PLUGIN_PACKAGE_LIMITS } from './pluginPackage'
import type {
  PluginEditorSession,
  PluginRuntimeController,
} from './pluginRuntimeController'
import type { PluginRuntimeLifecycleObserver } from './pluginRuntimeLifecycleObserver'

const PLUGIN_ID = 'example.soft-sparkle'
const PACKAGE_DIGEST = `sha256:${'1'.repeat(64)}` as PluginDeclarationCatalogEntry['packageDigest']
const SIGNER_FINGERPRINT = `sha256:${'2'.repeat(64)}` as PluginDeclarationCatalogEntry['signerFingerprint']

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function safetyStorage(value: string | null = null) {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
}

function declaration(
  availability: PluginDeclarationCatalogEntry['availability'] = 'ready',
): PluginDeclarationCatalogEntry {
  return Object.freeze({
    pluginId: PLUGIN_ID,
    pluginVersion: '1.2.3',
    packageDigest: PACKAGE_DIGEST,
    signerFingerprint: SIGNER_FINGERPRINT,
    kind: 'video-effect',
    contributionId: 'sparkle',
    contributionName: 'Soft Sparkle',
    contributionVersion: 1,
    descriptorVersion: 1,
    entrypoint: 'render_sparkle',
    parameters: Object.freeze([Object.freeze({
      key: 'enabled',
      name: 'Enabled',
      kind: 'boolean' as const,
      default: true,
    })]),
    availability,
    detail: availability === 'ready' ? 'Ready to render.' : 'Unavailable locally.',
  })
}

function installedPackage(
  status: PluginInstalledPackageProjection['status'] = 'ready',
  diagnostics: PluginInstalledPackageProjection['diagnostics'] = Object.freeze([
    Object.freeze({ code: 'timeout' as const, occurredAt: 1_700_000_000_000 }),
  ]),
): PluginInstalledPackageProjection {
  return Object.freeze({
    pluginId: PLUGIN_ID,
    name: 'Soft Sparkle',
    installedVersion: '1.2.3',
    packageDigest: PACKAGE_DIGEST,
    signerFingerprint: SIGNER_FINGERPRINT,
    contributionNames: Object.freeze(['Soft Sparkle']),
    selectedCapabilities: Object.freeze([Object.freeze({
      id: 'myrelith.effect.video-frame.rgba8',
      version: 1,
      required: true,
    })]),
    status,
    detail: status === 'ready' ? 'Ready to render.' : 'Unavailable locally.',
    diagnostics,
  })
}

function inspection(id = 'inspection-1'): PluginPackageInspection {
  return Object.freeze({
    inspectionId: id,
    pluginId: PLUGIN_ID,
    name: 'Soft Sparkle',
    version: '1.2.3',
    packageDigest: PACKAGE_DIGEST,
    signerFingerprint: SIGNER_FINGERPRINT,
    installedVersion: '1.2.2',
    versionChanged: true,
    sameVersionReplacement: false,
    samePackage: false,
    moduleSha256: PACKAGE_DIGEST,
    memoryMaximumPages: 258,
    change: 'upgrade',
    contributionNames: Object.freeze(['Soft Sparkle']),
    selectedCapabilities: Object.freeze([Object.freeze({
      id: 'myrelith.effect.video-frame.rgba8',
      version: 1,
      required: true,
    })]),
    signerContinuity: true,
    trustState: 'user-trusted',
    trustDecisionRequired: false,
    compatibility: Object.freeze({
      status: 'compatible',
      apiVersion: 1,
      permissions: Object.freeze([Object.freeze({
        id: 'myrelith.effect.video-frame.rgba8',
        required: true,
        version: 1,
        status: 'available' as const,
      })]),
      contributions: Object.freeze([Object.freeze({
        id: 'sparkle',
        kind: 'video-effect' as const,
        version: 1,
        status: 'available' as const,
      })]),
      reasons: Object.freeze([]),
    }),
    permissions: Object.freeze([Object.freeze({
      id: 'myrelith.effect.video-frame.rgba8',
      minVersion: 1,
      maxVersion: 1,
      required: true,
      negotiatedVersion: 1,
      selectedVersion: 1,
      status: 'available' as const,
      decisionRequired: true,
      priorGrant: null,
      grantChange: 'new' as const,
    })]),
    diagnostics: Object.freeze([]),
  })
}

function managementHarness() {
  let generation = 9
  let inspectionSequence = 0
  let installed = installedPackage()
  let declarations: readonly PluginDeclarationCatalogEntry[] = Object.freeze([declaration()])
  let capturedInspectionBytes: Uint8Array | null = null
  const activationBundles = Object.freeze({
    resolve: vi.fn(async () => { throw new Error('not used') }),
  })
  const inspectPackage = vi.fn(async (bytes: Uint8Array) => {
    capturedInspectionBytes = bytes
    return inspection(`inspection-${++inspectionSequence}`)
  })
  const commitInstallation = vi.fn(async () => ({ pluginId: PLUGIN_ID }))
  const cancelInspection = vi.fn(() => true)
  const installedPackages = vi.fn(async () => Object.freeze({
    generation,
    packages: Object.freeze([installed]),
  }))
  const declarationCatalog = vi.fn(async () => Object.freeze({
    generation,
    declarations,
  }))
  const controller = {
    activationBundles,
    inspectPackage,
    commitInstallation,
    cancelInspection,
    disable: vi.fn(async () => ({ pluginId: PLUGIN_ID })),
    enable: vi.fn(async () => ({ pluginId: PLUGIN_ID })),
    setPermissionGrant: vi.fn(async () => ({ pluginId: PLUGIN_ID })),
    quarantine: vi.fn(async () => ({ pluginId: PLUGIN_ID })),
    revoke: vi.fn(async () => ({ pluginId: PLUGIN_ID })),
    uninstall: vi.fn(async () => true),
    recordDiagnostic: vi.fn(async () => {}),
    clearDiagnostics: vi.fn(async () => true),
    installedPackages,
    declarationCatalog,
  } as unknown as PluginInstallController
  return {
    controller,
    activationBundles,
    inspectPackage,
    commitInstallation,
    cancelInspection,
    installedPackages,
    declarationCatalog,
    getCapturedInspectionBytes: () => capturedInspectionBytes,
    setInstalled: (value: PluginInstalledPackageProjection) => { installed = value },
    setDeclarations: (value: readonly PluginDeclarationCatalogEntry[]) => { declarations = value },
    setGeneration: (value: number) => { generation = value },
  }
}

function runtimeHarness() {
  const editor: PluginEditorSession = {
    apply: vi.fn(async (request) => Object.freeze({
      status: 'applied' as const,
      effectResult: 'mutated' as const,
      rgbaBytes: request.rgbaBytes,
    })),
    close: vi.fn(async () => {}),
  }
  const exportSession = Object.freeze({
    apply: vi.fn(),
    close: vi.fn(async () => {}),
  })
  const migrationSession = Object.freeze({
    applyTarget: vi.fn(),
    close: vi.fn(async () => {}),
  })
  const controller = {
    openEditorSession: vi.fn(() => editor),
    preflightExport: vi.fn(async () => exportSession),
    openDescriptorMigrationChain: vi.fn(),
    preflightDescriptorMigrationAction: vi.fn(async () => migrationSession),
    getSnapshot: vi.fn(),
    clearDiagnostics: vi.fn(),
    invalidate: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
  } as unknown as PluginRuntimeController
  return { controller, editor, exportSession, migrationSession }
}

function lifecycleHarness() {
  let generation = 0
  let disposer: LoadedPluginDisposer | null = null
  const tokenGenerations = new WeakMap<object, number>()
  const captureToken = vi.fn(() => {
    const token = Object.freeze({}) as LoadedPluginLifecycleToken
    tokenGenerations.set(token, generation)
    return token
  })
  const registerDisposer = vi.fn(async (
    token: LoadedPluginLifecycleToken,
    candidate: LoadedPluginDisposer,
  ) => {
    if (tokenGenerations.get(token) !== generation) {
      await candidate()
      return false
    }
    disposer = candidate
    return true
  })
  const dispose = vi.fn(async () => {
    generation++
    const owned = disposer
    disposer = null
    await owned?.()
  })
  return { captureToken, registerDisposer, dispose }
}

function setup(options?: {
  readonly sentinel?: string | null
  readonly management?: ReturnType<typeof managementHarness>
  readonly runtime?: ReturnType<typeof runtimeHarness>
  readonly lifecycle?: ReturnType<typeof lifecycleHarness>
  readonly observer?: PluginRuntimeLifecycleObserver
  readonly createReviewToken?: () => string
}) {
  const storage = safetyStorage(options?.sentinel)
  const management = options?.management ?? managementHarness()
  const runtime = options?.runtime ?? runtimeHarness()
  const lifecycle = options?.lifecycle ?? lifecycleHarness()
  const createManagementController = vi.fn(async () => management.controller)
  const createRuntimeController = vi.fn(async () => runtime.controller)
  const dependencies: PluginAppControllerDependencies = {
    safetyStorage: storage,
    createManagementController,
    createRuntimeController,
    lifecycle,
    lifecycleObserver: options?.observer,
    createReviewToken: options?.createReviewToken,
  }
  const owner = createPluginAppControllerOwner(dependencies)
  const controller = owner.controller
  return {
    owner,
    controller,
    storage,
    management,
    runtime,
    lifecycle,
    createManagementController,
    createRuntimeController,
  }
}

function fileFromBuffer(buffer: ArrayBuffer, declaredSize = buffer.byteLength): PluginAppFile & {
  readonly arrayBuffer: ReturnType<typeof vi.fn>
} {
  return {
    size: declaredSize,
    arrayBuffer: vi.fn(async () => buffer),
  }
}

function executionRequest(bytes = new Uint8Array([1, 2, 3, 4])): PluginEffectBridgeHandlerRequest {
  return Object.freeze({
    requestId: 1,
    execution: Object.freeze({
      catalogGeneration: 9,
      signerFingerprint: SIGNER_FINGERPRINT,
      packageDigest: PACKAGE_DIGEST,
      pluginId: PLUGIN_ID,
      pluginVersion: '1.2.3',
      kind: 'video-effect',
      contributionVersion: 1,
      contributionId: 'sparkle',
      descriptorVersion: 1,
      entrypoint: 'render_sparkle',
      parameterRecord: Object.freeze({ enabled: true }),
      canonicalParameterJson: '{"enabled":true}',
    }),
    descriptorId: 'effect-1',
    timelineFrame: 0,
    frameRateNumerator: 30,
    frameRateDenominator: 1,
    width: 1,
    height: 1,
    stride: 4,
    rgbaBytes: bytes,
  })
}

function expectDeepFrozenData(value: unknown, seen = new Set<object>()): void {
  expect(typeof value).not.toBe('function')
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  expect(value).not.toBeInstanceOf(Uint8Array)
  expect(value).not.toBeInstanceOf(Map)
  expect(value).not.toBeInstanceOf(Set)
  expect(Object.isFrozen(value)).toBe(true)
  for (const nested of Object.values(value)) expectDeepFrozenData(nested, seen)
}

describe('plugin app controller', () => {
  test('eager construction reads only the sentinel and keeps management and runtime lazy', () => {
    const observer: PluginRuntimeLifecycleObserver = Object.freeze({
      onSandboxSnapshot: vi.fn(),
      onRuntimeSnapshot: vi.fn(),
    })
    const harness = setup({ observer })

    expect(harness.storage.getItem).toHaveBeenCalledOnce()
    expect(harness.createManagementController).not.toHaveBeenCalled()
    expect(harness.createRuntimeController).not.toHaveBeenCalled()
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()
    expect(harness.controller.getEffectBridgeHandler()).toBe(
      harness.controller.getEffectBridgeHandler(),
    )
    expectDeepFrozenData(harness.controller.getSnapshot())
  })

  test('publishes coherent host-authored views without private catalog or controller facts', async () => {
    const harness = setup()

    await harness.controller.refreshManagement()
    const snapshot = harness.controller.getSnapshot()

    expect(snapshot).toMatchObject({
      catalogGeneration: 9,
      installedPackages: [{
        id: PLUGIN_ID,
        status: 'ready',
        permissionNames: ['Video frame pixels v1'],
        diagnostics: [{
          code: 'timeout',
          message: 'Plugin work exceeded its host deadline.',
          occurredAtLabel: '2023-11-14T22:13:20.000Z',
        }],
      }],
      contributions: [{
        effectType: `plugin:${PLUGIN_ID}/sparkle`,
        status: 'ready',
        parameters: [{ kind: 'boolean', default: true }],
      }],
    })
    expectDeepFrozenData(snapshot)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('declarationCatalog')
    expect(serialized).not.toContain('inspectionId')
    expect(serialized).not.toContain('archiveBytes')
    expect(serialized).not.toContain('activationBundles')
    expect(serialized).not.toContain('storage')
    expect(serialized).not.toContain('runtimeController')
  })

  test('accepts the exact archive bound, zeroes owned bytes, and rejects cap plus one before reading', async () => {
    const harness = setup({ createReviewToken: () => 'review-exact' })
    const exactBuffer = new ArrayBuffer(PLUGIN_PACKAGE_LIMITS.maxArchiveBytes)
    new Uint8Array(exactBuffer).fill(7)
    const exactFile = fileFromBuffer(exactBuffer)

    const review = await harness.controller.inspectFile(exactFile)

    expect(review).toMatchObject({
      reviewToken: 'plugin-review-1-review-exact',
      signatureState: 'valid',
      trustState: 'user-trusted',
      versionChange: 'update',
      memoryLimitMiB: 16.125,
      permissions: [{
        name: 'Video frame pixels',
        grantState: 'new',
        selectedVersion: '1',
      }],
    })
    expect(exactFile.arrayBuffer).toHaveBeenCalledOnce()
    expect(harness.management.getCapturedInspectionBytes()).not.toBeNull()
    expect(harness.management.getCapturedInspectionBytes()?.every((value) => value === 0)).toBe(true)
    expect(JSON.stringify(harness.controller.getSnapshot())).not.toContain('inspection-1')

    const oversized = fileFromBuffer(new ArrayBuffer(0), PLUGIN_PACKAGE_LIMITS.maxArchiveBytes + 1)
    await expect(harness.controller.inspectFile(oversized)).rejects.toMatchObject({
      code: 'file-too-large',
    })
    expect(oversized.arrayBuffer).not.toHaveBeenCalled()
  })

  test('keeps one-use tokens unique with repeated entropy and consumes invalid decisions', async () => {
    const management = managementHarness()
    const commitGate = deferred<{ pluginId: string }>()
    management.commitInstallation.mockImplementation(async () => commitGate.promise)
    const harness = setup({
      management,
      createReviewToken: () => 'constant-entropy',
    })
    const first = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    const second = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))

    expect(first.reviewToken).toBe('plugin-review-1-constant-entropy')
    expect(second.reviewToken).toBe('plugin-review-2-constant-entropy')
    expect(management.cancelInspection).toHaveBeenCalledWith('inspection-1')
    await expect(harness.controller.installPlugin({
      reviewToken: first.reviewToken,
      trustSigner: false,
      grantedPermissionIds: [],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-expired' })
    await expect(harness.controller.installPlugin({
      reviewToken: second.reviewToken,
      trustSigner: false,
      grantedPermissionIds: [
        'myrelith.effect.video-frame.rgba8',
        'myrelith.effect.video-frame.rgba8',
      ],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-invalid' })

    await expect(harness.controller.installPlugin({
      reviewToken: second.reviewToken,
      trustSigner: false,
      grantedPermissionIds: [],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-expired' })
    const third = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    await expect(harness.controller.installPlugin({
      reviewToken: third.reviewToken,
      trustSigner: false,
      grantedPermissionIds: ['example.unsupported.capability'],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-invalid' })

    const fourth = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    const installing = harness.controller.installPlugin({
      reviewToken: fourth.reviewToken,
      trustSigner: false,
      grantedPermissionIds: ['myrelith.effect.video-frame.rgba8'],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })
    expect(harness.controller.getSnapshot()).toMatchObject({
      review: null,
      inspectionPhase: 'installing',
    })
    await expect(harness.controller.installPlugin({
      reviewToken: fourth.reviewToken,
      trustSigner: false,
      grantedPermissionIds: [],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-expired' })
    commitGate.resolve({ pluginId: PLUGIN_ID })
    await installing

    expect(management.commitInstallation).toHaveBeenCalledWith(
      'inspection-4',
      expect.objectContaining({
        permissionDecisions: [{
          id: 'myrelith.effect.video-frame.rgba8',
          granted: true,
        }],
      }),
    )
  })

  test('rejects preserved permissions because only current decision ids are accepted', async () => {
    const management = managementHarness()
    const base = inspection('inspection-preserved')
    const preserved = Object.freeze({
      ...base,
      permissions: Object.freeze([
        ...base.permissions,
        Object.freeze({
          ...base.permissions[0],
          id: 'example.preserved.capability',
          decisionRequired: false,
          priorGrant: Object.freeze({
            minVersion: 1,
            maxVersion: 1,
            required: false,
            selectedVersion: 1,
          }),
          grantChange: 'preserved' as const,
        }),
      ]),
    })
    management.inspectPackage.mockResolvedValue(preserved)
    const harness = setup({ management, createReviewToken: () => 'preserved' })
    const review = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    expect(review.permissions.find((permission) => permission.id === 'example.preserved.capability'))
      .toMatchObject({ available: true, grantable: false, grantState: 'preserved' })

    await expect(harness.controller.installPlugin({
      reviewToken: review.reviewToken,
      trustSigner: false,
      grantedPermissionIds: ['example.preserved.capability'],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-invalid' })

    expect(management.commitInstallation).not.toHaveBeenCalled()
    expect(management.cancelInspection).toHaveBeenCalledWith('inspection-preserved')
    expect(harness.controller.getSnapshot().review).toBeNull()
  })

  test('constant entropy cannot reuse a token across different package inspections', async () => {
    const management = managementHarness()
    let call = 0
    management.inspectPackage.mockImplementation(async () => {
      call++
      if (call === 1) return inspection('inspection-same')
      return Object.freeze({
        ...inspection('inspection-different'),
        pluginId: 'example.different-plugin',
        name: 'Different Plugin',
        packageDigest: `sha256:${'3'.repeat(64)}` as PluginPackageInspection['packageDigest'],
      })
    })
    const harness = setup({ management, createReviewToken: () => 'constant' })
    const first = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    const different = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))

    expect(first.reviewToken).not.toBe(different.reviewToken)
    await expect(harness.controller.installPlugin({
      reviewToken: first.reviewToken,
      trustSigner: false,
      grantedPermissionIds: [],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-expired' })
  })

  test('exposes exactly the two-method private export port and keeps export runtime lazy from editor use', async () => {
    const harness = setup()
    const port = harness.owner.exportCompositionPort
    type PublicExportLeak = 'exportCompositionPort' extends keyof PluginAppController ? true : false
    type PublicExportAccessorLeak = 'getExportCompositionPort' extends keyof PluginAppController
      ? true
      : false
    const publicExportLeak: PublicExportLeak = false
    const publicExportAccessorLeak: PublicExportAccessorLeak = false

    expect(publicExportLeak).toBe(false)
    expect(publicExportAccessorLeak).toBe(false)
    expect(Object.keys(port).sort()).toEqual(['getDeclarationCatalog', 'preflightExport'])
    expect(Object.keys(harness.controller)).not.toContain('getExportCompositionPort')
    expect(Object.keys(harness.controller)).not.toContain('exportCompositionPort')
    expect(Object.keys(harness.controller)).not.toContain('preflightDescriptorMigrationAction')
    expect(Object.keys(harness.owner).sort()).toEqual([
      'close',
      'controller',
      'exportCompositionPort',
      'preflightDescriptorMigrationAction',
    ])
    const catalog = await port.getDeclarationCatalog()
    expectDeepFrozenData(catalog)
    expect(JSON.stringify(harness.controller.getSnapshot())).not.toContain('declarationCatalog')
    await expect(port.preflightExport(Object.freeze({ requiredEffects: Object.freeze([]) })))
      .resolves.toBe(harness.runtime.exportSession)
    expect(harness.runtime.controller.openEditorSession).not.toHaveBeenCalled()
    expect(harness.createRuntimeController).toHaveBeenCalledWith(
      harness.management.activationBundles,
      undefined,
    )
  })

  test('safe mode blocks synchronously and stale app-level preview output is zeroed', async () => {
    const runtime = runtimeHarness()
    const applyGate = deferred<Uint8Array>()
    const teardownGate = deferred<void>()
    runtime.editor.apply = vi.fn(async () => Object.freeze({
      status: 'applied' as const,
      effectResult: 'mutated' as const,
      rgbaBytes: await applyGate.promise,
    }))
    ;(runtime.controller.teardown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => teardownGate.promise,
    )
    const harness = setup({ runtime })
    const applying = harness.controller.getEffectBridgeHandler().apply(
      executionRequest(),
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(runtime.editor.apply).toHaveBeenCalledOnce())

    const safeMode = harness.controller.enterSafeMode()
    expect(harness.controller.getSnapshot().startup.mode).toBe('safe-mode')
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()
    const lateBytes = new Uint8Array([9, 9, 9, 9])
    applyGate.resolve(lateBytes)
    await expect(applying).resolves.toEqual({ status: 'bypassed' })
    expect([...lateBytes]).toEqual([0, 0, 0, 0])
    teardownGate.resolve()
    await expect(safeMode).resolves.toBe(true)
  })

  test('reviewed normal startup cancels and drains retained inspection state before continuing', async () => {
    const management = managementHarness()
    const harness = setup({
      sentinel: JSON.stringify({ version: 1, batchId: 'interrupted' }),
      management,
      createReviewToken: () => 'startup-review',
    })
    const review = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))

    const continuing = harness.controller.continueWithReviewedNormalStartup()
    expect(harness.controller.getSnapshot()).toMatchObject({
      startup: { mode: 'review-required' },
    })

    await expect(continuing).resolves.toBe(true)
    expect(management.cancelInspection).toHaveBeenCalledWith('inspection-1')
    expect(harness.controller.getSnapshot()).toMatchObject({
      review: null,
      inspectionPhase: 'idle',
    })
    expect(harness.controller.getSnapshot().startup.mode).toBe('normal')
    await expect(harness.controller.installPlugin({
      reviewToken: review.reviewToken,
      trustSigner: false,
      grantedPermissionIds: [],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })).rejects.toMatchObject({ code: 'review-expired' })
  })

  test('threads the injection-only observer only to the lazy runtime factory', async () => {
    const observer: PluginRuntimeLifecycleObserver = Object.freeze({
      onSandboxSnapshot: vi.fn(),
      onRuntimeSnapshot: vi.fn(),
    })
    const harness = setup({ observer })

    expect(JSON.stringify(harness.controller.getSnapshot())).not.toContain('onSandboxSnapshot')
    await harness.controller.getEffectBridgeHandler().apply(
      executionRequest(),
      new AbortController().signal,
    )
    expect(harness.createRuntimeController).toHaveBeenCalledWith(
      harness.management.activationBundles,
      observer,
    )
  })

  test('close aborts and drains a pending file read, zeroes late bytes, and never inspects', async () => {
    const readGate = deferred<ArrayBuffer>()
    const lateBuffer = new ArrayBuffer(4)
    new Uint8Array(lateBuffer).fill(9)
    const harness = setup()
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    const file: PluginAppFile = {
      size: 4,
      arrayBuffer: vi.fn(async () => readGate.promise),
    }
    const inspecting = harness.controller.inspectFile(file)
    await vi.waitFor(() => expect(file.arrayBuffer).toHaveBeenCalledOnce())
    const publishedBeforeClose = listener.mock.calls.length
    const closing = harness.owner.close('close-during-read')

    readGate.resolve(lateBuffer)
    await expect(inspecting).rejects.toMatchObject({ code: 'stale-operation' })
    await closing

    expect([...new Uint8Array(lateBuffer)]).toEqual([0, 0, 0, 0])
    expect(harness.management.inspectPackage).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(publishedBeforeClose)
  })

  test('close during package verification drains and cancels the late retained inspection', async () => {
    const management = managementHarness()
    const inspectGate = deferred<PluginPackageInspection>()
    management.inspectPackage.mockImplementation(async () => inspectGate.promise)
    const harness = setup({ management })
    const inspecting = harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    await vi.waitFor(() => expect(management.inspectPackage).toHaveBeenCalledOnce())
    const closing = harness.owner.close('close-during-inspect')

    inspectGate.resolve(inspection('late-inspection'))
    await expect(inspecting).rejects.toMatchObject({ code: 'stale-operation' })
    await closing

    expect(management.cancelInspection).toHaveBeenCalledWith('late-inspection')
    expect(harness.controller.getSnapshot().review).toBeNull()
  })

  test('close retries and surfaces late inspection cancellation failure without skipping runtime cleanup', async () => {
    const management = managementHarness()
    const inspectGate = deferred<PluginPackageInspection>()
    management.inspectPackage.mockImplementation(async () => inspectGate.promise)
    management.cancelInspection.mockImplementation(() => { throw new Error('late cancel failed') })
    const harness = setup({ management })
    const inspecting = harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    await vi.waitFor(() => expect(management.inspectPackage).toHaveBeenCalledOnce())
    const closing = harness.owner.close('close-with-late-cancel-failure')

    const inspectionExpectation = expect(inspecting).rejects.toThrow('late cancel failed')
    const closeResult = closing.then(() => null, (cause: unknown) => cause)
    inspectGate.resolve(inspection('late-failing-inspection'))
    await inspectionExpectation
    const closeCause = await closeResult
    expect(closeCause).toBeInstanceOf(AggregateError)
    expect((closeCause as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'late cancel failed' }),
    ]))

    expect((management.cancelInspection.mock.calls as unknown[][]).filter(
      (call) => call[0] === 'late-failing-inspection',
    ).length).toBeGreaterThanOrEqual(2)
    expect(harness.lifecycle.dispose).toHaveBeenCalledOnce()
  })

  test('close drains an in-flight refresh without publishing terminal late state', async () => {
    const management = managementHarness()
    const installedGate = deferred<{
      readonly generation: number
      readonly packages: readonly PluginInstalledPackageProjection[]
    }>()
    management.installedPackages.mockImplementation(async () => installedGate.promise)
    const harness = setup({ management })
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    const refreshing = harness.controller.refreshManagement()
    await vi.waitFor(() => expect(management.installedPackages).toHaveBeenCalledOnce())
    const publishedBeforeClose = listener.mock.calls.length
    const closing = harness.owner.close('close-during-refresh')

    installedGate.resolve(Object.freeze({
      generation: 9,
      packages: Object.freeze([installedPackage()]),
    }))
    await refreshing
    await closing
    expect(listener).toHaveBeenCalledTimes(publishedBeforeClose)
  })

  test('close drains a durable install mutation and suppresses every late app publication', async () => {
    const management = managementHarness()
    const commitGate = deferred<{ pluginId: string }>()
    management.commitInstallation.mockImplementation(async () => commitGate.promise)
    const harness = setup({ management, createReviewToken: () => 'mutation' })
    const review = await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    const listener = vi.fn()
    harness.controller.subscribe(listener)
    const installing = harness.controller.installPlugin({
      reviewToken: review.reviewToken,
      trustSigner: false,
      grantedPermissionIds: ['myrelith.effect.video-frame.rgba8'],
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })
    await vi.waitFor(() => expect(management.commitInstallation).toHaveBeenCalledOnce())
    const publishedBeforeClose = listener.mock.calls.length
    const closing = harness.owner.close('close-during-mutation')

    commitGate.resolve({ pluginId: PLUGIN_ID })
    await installing
    await closing
    expect(listener).toHaveBeenCalledTimes(publishedBeforeClose)
  })

  test('token construction failure cancels the verified inspection before returning', async () => {
    const management = managementHarness()
    const harness = setup({
      management,
      createReviewToken: () => { throw new Error('entropy failed') },
    })

    await expect(harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1))))
      .rejects.toThrow('entropy failed')
    expect(management.cancelInspection).toHaveBeenCalledWith('inspection-1')
    expect(harness.controller.getSnapshot().review).toBeNull()
  })

  test('terminal close attempts review cancellation and runtime cleanup and aggregates both failures', async () => {
    const management = managementHarness()
    const runtime = runtimeHarness()
    management.cancelInspection.mockImplementation(() => { throw new Error('cancel failed') })
    runtime.editor.close = vi.fn(async () => { throw new Error('editor close failed') })
    ;(runtime.controller.teardown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('runtime close failed'),
    )
    const harness = setup({
      management,
      runtime,
      createReviewToken: () => 'review-close',
    })
    await harness.controller.inspectFile(fileFromBuffer(new ArrayBuffer(1)))
    await harness.controller.getEffectBridgeHandler().apply(
      executionRequest(),
      new AbortController().signal,
    )

    const first = harness.owner.close('app-close')
    const second = harness.owner.close('ignored')
    expect(second).toBe(first)
    await expect(first).rejects.toBeInstanceOf(AggregateError)
    expect(management.cancelInspection).toHaveBeenCalledWith('inspection-1')
    expect(runtime.editor.close).toHaveBeenCalledWith('app-close')
    expect(runtime.controller.teardown).toHaveBeenCalledWith('app-close')
    expect(() => harness.controller.subscribe(vi.fn())).toThrow(PluginAppControllerError)
  })
})
