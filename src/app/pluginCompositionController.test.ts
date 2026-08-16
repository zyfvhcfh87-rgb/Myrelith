import { describe, expect, test, vi } from 'vitest'
import type { PluginVideoEffectExecutionPlan } from '../domain/pluginVideoEffectStagePlan'
import type { PluginEffectBridgeHandlerRequest } from '../workers/plugin-effect-bridge-protocol'
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
import type {
  PluginEditorSession,
  PluginRuntimeController,
} from './pluginRuntimeController'
import {
  createPluginCompositionController,
  type PluginCompositionControllerDependencies,
} from './pluginCompositionController'

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
  diagnostics = [{ code: 'timeout' as const, occurredAt: 123 }],
): PluginInstalledPackageProjection {
  return Object.freeze({
    pluginId: PLUGIN_ID,
    name: 'Soft Sparkle',
    installedVersion: '1.2.3',
    packageDigest: PACKAGE_DIGEST,
    signerFingerprint: SIGNER_FINGERPRINT,
    contributionNames: Object.freeze(['Soft Sparkle']),
    selectedCapabilities: Object.freeze([Object.freeze({
      id: 'video-effect-frame-rgba8',
      version: 1,
      required: true,
    })]),
    status,
    detail: status === 'ready' ? 'Ready to render.' : 'Unavailable locally.',
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
  })
}

function inspection(): PluginPackageInspection {
  return Object.freeze({
    inspectionId: 'inspection-1',
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
    memoryMaximumPages: 64,
    change: 'upgrade',
    contributionNames: Object.freeze(['Soft Sparkle']),
    selectedCapabilities: Object.freeze([Object.freeze({
      id: 'video-effect-frame-rgba8',
      version: 1,
      required: true,
    })]),
    signerContinuity: true,
    trustDecisionRequired: false,
    compatibility: Object.freeze({
      status: 'compatible',
      apiVersion: 1,
      permissions: Object.freeze([Object.freeze({
        id: 'video-effect-frame-rgba8',
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
      id: 'video-effect-frame-rgba8',
      minVersion: 1,
      maxVersion: 1,
      required: true,
      negotiatedVersion: 1,
      selectedVersion: 1,
      status: 'available' as const,
      decisionRequired: false,
      priorGrant: Object.freeze({
        minVersion: 1,
        maxVersion: 1,
        required: true,
        selectedVersion: 1,
      }),
      grantChange: 'preserved' as const,
    })]),
    diagnostics: Object.freeze([Object.freeze({ code: 'timeout' as const, occurredAt: 123 })]),
  })
}

function managementHarness() {
  let generation = 7
  let installed = installedPackage()
  let declarations: readonly PluginDeclarationCatalogEntry[] = Object.freeze([declaration()])
  const activationBundles = Object.freeze({
    resolve: vi.fn(async () => { throw new Error('not used by the facade test runtime') }),
  })
  const installedPackages = vi.fn(async () => Object.freeze({
    generation,
    packages: Object.freeze([installed]),
  }))
  const declarationCatalog = vi.fn(async () => Object.freeze({
    generation,
    declarations,
  }))
  const inspectPackage = vi.fn(async () => inspection())
  const cancelInspection = vi.fn(() => true)
  const commitInstallation = vi.fn(async () => ({ pluginId: PLUGIN_ID }))
  const disable = vi.fn(async () => ({ pluginId: PLUGIN_ID }))
  const enable = vi.fn(async () => ({ pluginId: PLUGIN_ID }))
  const setPermissionGrant = vi.fn(async () => ({ pluginId: PLUGIN_ID }))
  const quarantine = vi.fn(async () => ({ pluginId: PLUGIN_ID }))
  const revoke = vi.fn(async () => ({ pluginId: PLUGIN_ID }))
  const uninstall = vi.fn(async () => true)
  const clearDiagnostics = vi.fn(async () => true)
  const controller = {
    activationBundles,
    inspectPackage,
    commitInstallation,
    cancelInspection,
    disable,
    enable,
    setPermissionGrant,
    quarantine,
    revoke,
    uninstall,
    recordDiagnostic: vi.fn(async () => {}),
    clearDiagnostics,
    installedPackages,
    declarationCatalog,
  } as unknown as PluginInstallController
  return {
    controller,
    activationBundles,
    installedPackages,
    declarationCatalog,
    inspectPackage,
    cancelInspection,
    commitInstallation,
    disable,
    enable,
    setPermissionGrant,
    quarantine,
    revoke,
    uninstall,
    clearDiagnostics,
    setGeneration(value: number) { generation = value },
    setInstalled(value: PluginInstalledPackageProjection) { installed = value },
    setDeclarations(value: readonly PluginDeclarationCatalogEntry[]) { declarations = value },
  }
}

function execution(): PluginVideoEffectExecutionPlan {
  return Object.freeze({
    catalogGeneration: 7,
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
  })
}

function bridgeRequest(bytes = new Uint8Array([1, 2, 3, 4])): PluginEffectBridgeHandlerRequest {
  return Object.freeze({
    requestId: 1,
    execution: execution(),
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
  const openEditorSession = vi.fn(() => editor)
  const preflightExport = vi.fn(async () => exportSession)
  const preflightDescriptorMigrationAction = vi.fn(async () => migrationSession)
  const clearDiagnostics = vi.fn()
  const invalidate = vi.fn(async () => {})
  const teardown = vi.fn(async () => {})
  const controller = {
    openEditorSession,
    preflightExport,
    openDescriptorMigrationChain: vi.fn(),
    preflightDescriptorMigrationAction,
    getSnapshot: vi.fn(),
    clearDiagnostics,
    invalidate,
    teardown,
  } as unknown as PluginRuntimeController
  return {
    controller,
    editor,
    exportSession,
    migrationSession,
    openEditorSession,
    preflightExport,
    preflightDescriptorMigrationAction,
    clearDiagnostics,
    invalidate,
    teardown,
  }
}

function lifecycleHarness(events: string[] = []) {
  let valid = true
  let disposer: LoadedPluginDisposer | null = null
  const token = Object.freeze({}) as LoadedPluginLifecycleToken
  const captureToken = vi.fn(() => {
    events.push('capture-token')
    return token
  })
  const registerDisposer = vi.fn(async (
    received: LoadedPluginLifecycleToken,
    candidate: LoadedPluginDisposer,
  ) => {
    events.push('register-disposer')
    expect(received).toBe(token)
    if (!valid) {
      await candidate()
      return false
    }
    disposer = candidate
    return true
  })
  const dispose = vi.fn(async () => {
    events.push('dispose-lifecycle')
    valid = false
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
  readonly createRuntime?: PluginCompositionControllerDependencies['createRuntimeController']
}) {
  const storage = safetyStorage(options?.sentinel)
  const management = options?.management ?? managementHarness()
  const runtime = options?.runtime ?? runtimeHarness()
  const lifecycle = options?.lifecycle ?? lifecycleHarness()
  const createManagementController = vi.fn(async () => management.controller)
  const createRuntimeController = vi.fn(options?.createRuntime ?? (async () => runtime.controller))
  const controller = createPluginCompositionController({
    safetyStorage: storage,
    createManagementController,
    createRuntimeController,
    lifecycle,
  })
  return {
    controller,
    storage,
    management,
    runtime,
    lifecycle,
    createManagementController,
    createRuntimeController,
  }
}

function expectDeeplyFrozenData(value: unknown, seen = new Set<object>()): void {
  expect(typeof value).not.toBe('function')
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  expect(value).not.toBeInstanceOf(Uint8Array)
  expect(value).not.toBeInstanceOf(Map)
  expect(value).not.toBeInstanceOf(Set)
  expect(Object.isFrozen(value)).toBe(true)
  for (const nested of Object.values(value)) expectDeeplyFrozenData(nested, seen)
}

describe('plugin composition controller', () => {
  test('eager construction reads only the sentinel and keeps both lazy gates inert', () => {
    const harness = setup()

    expect(harness.storage.getItem).toHaveBeenCalledOnce()
    expect(harness.createManagementController).not.toHaveBeenCalled()
    expect(harness.createRuntimeController).not.toHaveBeenCalled()
    expect(harness.lifecycle.captureToken).toHaveBeenCalledOnce()
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()
    expect(harness.controller.getEffectBridgeHandler()).toBe(
      harness.controller.getEffectBridgeHandler(),
    )
    expect(harness.controller.getSnapshot()).toMatchObject({
      startup: { mode: 'normal', sentinelStatus: 'clean' },
      managementPhase: 'idle',
      catalogGeneration: null,
      contributionSnapshot: null,
    })
    expectDeeplyFrozenData(harness.controller.getSnapshot())
  })

  test('review-required startup exposes no catalog or runtime until explicit normal review', async () => {
    const harness = setup({
      sentinel: JSON.stringify({ version: 1, batchId: 'interrupted' }),
    })
    const handler = harness.controller.getEffectBridgeHandler()

    await expect(handler.apply(bridgeRequest(), new AbortController().signal)).resolves.toEqual({
      status: 'bypassed',
    })
    expect(harness.createManagementController).not.toHaveBeenCalled()
    expect(harness.createRuntimeController).not.toHaveBeenCalled()
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()

    expect(harness.controller.continueWithReviewedNormalStartup()).toBe(true)
    await harness.controller.refreshManagement()
    expect(harness.createManagementController).toHaveBeenCalledOnce()
    expect(harness.createRuntimeController).not.toHaveBeenCalled()
    expect(harness.controller.getContributionSnapshot()?.catalogGeneration).toBe(7)
  })

  test('refresh retries split generations and publishes only one coherent catalog view', async () => {
    const management = managementHarness()
    management.installedPackages
      .mockResolvedValueOnce(Object.freeze({
        generation: 6,
        packages: Object.freeze([installedPackage('disabled')]),
      }))
      .mockResolvedValueOnce(Object.freeze({
        generation: 7,
        packages: Object.freeze([installedPackage()]),
      }))
    const harness = setup({ management })

    await harness.controller.refreshManagement()

    expect(management.installedPackages).toHaveBeenCalledTimes(2)
    expect(management.declarationCatalog).toHaveBeenCalledTimes(2)
    expect(harness.controller.getSnapshot()).toMatchObject({
      managementPhase: 'ready',
      catalogGeneration: 7,
      installedPackages: [{ status: 'ready' }],
      contributionSnapshot: { catalogGeneration: 7 },
    })
  })

  test('installed, catalog, inspection, and action projections are deeply frozen data only', async () => {
    const harness = setup()
    await harness.controller.refreshManagement()
    const projectedInspection = await harness.controller.inspectPackage(
      new Uint8Array([9, 8, 7]),
    )
    const snapshot = harness.controller.getSnapshot()

    expectDeeplyFrozenData(snapshot)
    expectDeeplyFrozenData(projectedInspection)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('archiveBytes')
    expect(serialized).not.toContain('activationBundles')
    expect(serialized).not.toContain('"trust":')
    expect(serialized).not.toContain('storage')
    expect(serialized).not.toContain('runtime')
    expect(snapshot.inspection).toEqual(projectedInspection)
  })

  test('the stable effect handler opens one editor session only on the first real apply', async () => {
    const harness = setup()
    const handler = harness.controller.getEffectBridgeHandler()
    expect(harness.createRuntimeController).not.toHaveBeenCalled()
    const firstBytes = new Uint8Array([1, 2, 3, 4])

    await expect(handler.apply(
      bridgeRequest(firstBytes),
      new AbortController().signal,
    )).resolves.toEqual({ status: 'applied', rgbaBytes: firstBytes })
    await handler.apply(bridgeRequest(new Uint8Array([5, 6, 7, 8])), new AbortController().signal)

    expect(harness.createManagementController).toHaveBeenCalledOnce()
    expect(harness.createRuntimeController).toHaveBeenCalledOnce()
    expect(harness.runtime.openEditorSession).toHaveBeenCalledOnce()
    expect(harness.runtime.editor.apply).toHaveBeenCalledTimes(2)
    expect(harness.runtime.editor.apply).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ parameterRecord: expect.anything() }),
      expect.any(AbortSignal),
    )
  })

  test('a lifecycle change during async runtime creation tears down the late candidate', async () => {
    const events: string[] = []
    const lifecycle = lifecycleHarness(events)
    const runtime = runtimeHarness()
    const creation = deferred<PluginRuntimeController>()
    const harness = setup({
      lifecycle,
      runtime,
      createRuntime: async () => {
        events.push('create-runtime')
        return creation.promise
      },
    })
    const result = harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(events).toContain('create-runtime'))

    await expect(harness.controller.enterSafeMode()).resolves.toBe(true)
    creation.resolve(runtime.controller)
    await expect(result).resolves.toEqual({ status: 'bypassed' })

    expect(events[0]).toBe('capture-token')
    expect(runtime.teardown).toHaveBeenCalledWith('stale-plugin-composition')
    expect(lifecycle.registerDisposer).not.toHaveBeenCalled()
  })

  test('a management mutation during async runtime creation tears down the stale candidate', async () => {
    const runtime = runtimeHarness()
    const creation = deferred<PluginRuntimeController>()
    const harness = setup({
      runtime,
      createRuntime: async () => creation.promise,
    })
    const applying = harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(harness.createRuntimeController).toHaveBeenCalledOnce())

    await harness.controller.disablePlugin(PLUGIN_ID)
    creation.resolve(runtime.controller)
    await expect(applying).resolves.toEqual({ status: 'bypassed' })

    expect(runtime.teardown).toHaveBeenCalledWith('stale-plugin-composition')
    expect(harness.lifecycle.registerDisposer).not.toHaveBeenCalled()
    expect(runtime.openEditorSession).not.toHaveBeenCalled()
  })

  test('safe mode blocks synchronously, then awaits editor and runtime cleanup', async () => {
    const runtime = runtimeHarness()
    const teardown = deferred<void>()
    runtime.teardown.mockImplementation(async () => teardown.promise)
    const harness = setup({ runtime })
    await harness.controller.refreshManagement()
    await harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )

    const closing = harness.controller.enterSafeMode()
    expect(harness.controller.getSnapshot().startup.mode).toBe('safe-mode')
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()
    await expect(harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )).resolves.toEqual({ status: 'bypassed' })
    expect(runtime.editor.close).toHaveBeenCalledWith('safe-mode')
    expect(runtime.teardown).toHaveBeenCalledWith('safe-mode')

    teardown.resolve()
    await expect(closing).resolves.toBe(true)
  })

  test('durable mutation invalidates runtime before coherent refresh and publication', async () => {
    const events: string[] = []
    const management = managementHarness()
    const runtime = runtimeHarness()
    management.disable.mockImplementation(async () => {
      events.push('durable-disable')
      management.setInstalled(installedPackage('disabled'))
      return { pluginId: PLUGIN_ID } as never
    })
    runtime.invalidate.mockImplementation(async () => { events.push('runtime-invalidate') })
    management.installedPackages.mockImplementation(async () => {
      events.push('installed-refresh')
      return Object.freeze({
        generation: 7,
        packages: Object.freeze([installedPackage('disabled')]),
      })
    })
    management.declarationCatalog.mockImplementation(async () => {
      events.push('catalog-refresh')
      return Object.freeze({ generation: 7, declarations: Object.freeze([declaration('disabled')]) })
    })
    const harness = setup({ management, runtime })
    await harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )
    events.length = 0

    await harness.controller.disablePlugin(PLUGIN_ID)

    expect(events[0]).toBe('durable-disable')
    expect(events[1]).toBe('runtime-invalidate')
    expect(events.slice(2).sort()).toEqual(['catalog-refresh', 'installed-refresh'])
    expect(harness.controller.getSnapshot()).toMatchObject({
      managementPhase: 'ready',
      installedPackages: [{ status: 'disabled' }],
      action: { kind: 'disable', phase: 'succeeded' },
    })
  })

  test('runtime invalidation failure enters safe mode and closes the loaded runtime', async () => {
    const runtime = runtimeHarness()
    runtime.invalidate.mockRejectedValue(new Error('invalidation failed'))
    const harness = setup({ runtime })
    await harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )

    await expect(harness.controller.disablePlugin(PLUGIN_ID)).rejects.toThrow(
      'invalidation failed',
    )

    expect(harness.controller.getSnapshot()).toMatchObject({
      startup: { mode: 'safe-mode' },
      action: {
        kind: 'disable',
        phase: 'failed',
        detail: 'The plugin action failed without exposing internal details.',
      },
    })
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()
    expect(runtime.editor.close).toHaveBeenCalledWith('runtime-invalidation-failed')
    expect(runtime.teardown).toHaveBeenCalledWith('runtime-invalidation-failed')
    await expect(harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )).resolves.toEqual({ status: 'bypassed' })
  })

  test('invocation ordering and epochs prevent an older mutation from publishing late', async () => {
    const management = managementHarness()
    const disableGate = deferred<void>()
    management.disable.mockImplementation(async () => {
      await disableGate.promise
      management.setInstalled(installedPackage('disabled'))
      return { pluginId: PLUGIN_ID } as never
    })
    management.enable.mockImplementation(async () => {
      management.setInstalled(installedPackage('ready'))
      return { pluginId: PLUGIN_ID } as never
    })
    const harness = setup({ management })
    const published: string[] = []
    const successfulCatalogVisibility: boolean[] = []
    harness.controller.subscribe((value) => {
      published.push(`${value.action.kind}:${value.action.phase}`)
      if (value.action.phase === 'succeeded') {
        successfulCatalogVisibility.push(
          harness.controller.getContributionSnapshot() !== undefined,
        )
      }
    })
    const disabling = harness.controller.disablePlugin(PLUGIN_ID)
    await vi.waitFor(() => expect(management.disable).toHaveBeenCalledOnce())
    const enabling = harness.controller.enablePlugin(PLUGIN_ID, new AbortController().signal)

    disableGate.resolve()
    await Promise.all([disabling, enabling])

    expect(management.disable.mock.invocationCallOrder[0]).toBeLessThan(
      management.enable.mock.invocationCallOrder[0],
    )
    expect(published).not.toContain('disable:succeeded')
    expect(harness.controller.getSnapshot()).toMatchObject({
      installedPackages: [{ status: 'ready' }],
      action: { kind: 'enable', phase: 'succeeded' },
    })
    expect(successfulCatalogVisibility).toEqual([true])
  })

  test('new preview work and catalog planning stay fenced for the full mutation', async () => {
    const management = managementHarness()
    const disableGate = deferred<void>()
    management.disable.mockImplementation(async () => {
      await disableGate.promise
      return { pluginId: PLUGIN_ID } as never
    })
    const harness = setup({ management })
    await harness.controller.refreshManagement()
    expect(harness.controller.getContributionSnapshot()).toBeDefined()

    const mutation = harness.controller.disablePlugin(PLUGIN_ID)
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()
    await expect(harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )).resolves.toEqual({ status: 'bypassed' })
    expect(harness.createRuntimeController).not.toHaveBeenCalled()

    disableGate.resolve()
    await mutation
    expect(harness.controller.getContributionSnapshot()).toBeDefined()
  })

  test('diagnostic clear persists first, clears only loaded runtime diagnostics, and keeps generation', async () => {
    const events: string[] = []
    const management = managementHarness()
    const runtime = runtimeHarness()
    management.clearDiagnostics.mockImplementation(async () => {
      events.push('persist-clear')
      management.setInstalled(installedPackage('ready', []))
      return true
    })
    runtime.clearDiagnostics.mockImplementation(() => { events.push('runtime-clear') })
    management.installedPackages.mockImplementation(async () => {
      events.push('installed-refresh')
      return Object.freeze({
        generation: 7,
        packages: Object.freeze([installedPackage('ready', [])]),
      })
    })
    management.declarationCatalog.mockImplementation(async () => {
      events.push('catalog-refresh')
      return Object.freeze({ generation: 7, declarations: Object.freeze([declaration()]) })
    })
    const harness = setup({ management, runtime })
    await harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )
    events.length = 0

    await expect(harness.controller.clearDiagnostics(PLUGIN_ID)).resolves.toBe(true)

    expect(events.slice(0, 2)).toEqual(['persist-clear', 'runtime-clear'])
    expect(runtime.invalidate).not.toHaveBeenCalled()
    expect(harness.controller.getSnapshot()).toMatchObject({
      catalogGeneration: 7,
      installedPackages: [{ diagnostics: [] }],
    })
  })

  test('inspection and installation never return registry records or retain archive bytes in snapshots', async () => {
    const harness = setup()
    const projected = await harness.controller.inspectPackage(new Uint8Array([4, 3, 2, 1]))
    const result = await harness.controller.commitInstallation(projected.inspectionId, {
      trustSigner: false,
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
      enableAfterInstall: false,
      permissionDecisions: Object.freeze([]),
    })

    expect(result).toBeUndefined()
    expect(harness.controller.getSnapshot().inspection).toBeNull()
    expect(JSON.stringify(harness.controller.getSnapshot())).not.toContain('archiveBytes')
    expect(harness.createRuntimeController).not.toHaveBeenCalled()
  })

  test('export and migration use one lazy runtime without opening the editor session', async () => {
    const harness = setup()
    const exportRequest = Object.freeze({ requiredEffects: Object.freeze([]) })
    const migrationRequest = Object.freeze({ targets: Object.freeze([]) })

    await expect(harness.controller.preflightExport(exportRequest)).resolves.toBe(
      harness.runtime.exportSession,
    )
    await expect(harness.controller.preflightDescriptorMigrationAction(
      migrationRequest,
    )).resolves.toBe(harness.runtime.migrationSession)

    expect(harness.createRuntimeController).toHaveBeenCalledOnce()
    expect(harness.runtime.preflightExport).toHaveBeenCalledWith(exportRequest, undefined)
    expect(harness.runtime.preflightDescriptorMigrationAction).toHaveBeenCalledWith(
      migrationRequest,
      undefined,
    )
    expect(harness.runtime.openEditorSession).not.toHaveBeenCalled()
    expect(harness.controller.getContributionSnapshot()).toBeUndefined()
  })

  test('a mutation during export preflight closes and rejects the stale session', async () => {
    const management = managementHarness()
    const runtime = runtimeHarness()
    const preflightGate = deferred<typeof runtime.exportSession>()
    const disableGate = deferred<void>()
    runtime.preflightExport.mockImplementation(async () => preflightGate.promise)
    management.disable.mockImplementation(async () => {
      await disableGate.promise
      return { pluginId: PLUGIN_ID } as never
    })
    const harness = setup({ management, runtime })
    const exporting = harness.controller.preflightExport(
      Object.freeze({ requiredEffects: Object.freeze([]) }),
    )
    await vi.waitFor(() => expect(runtime.preflightExport).toHaveBeenCalledOnce())

    const mutation = harness.controller.disablePlugin(PLUGIN_ID)
    preflightGate.resolve(runtime.exportSession)
    await expect(exporting).rejects.toMatchObject({ code: 'install-conflict' })
    expect(runtime.exportSession.close).toHaveBeenCalledWith('stale-plugin-composition')

    disableGate.resolve()
    await mutation
  })

  test('a mutation epoch fences and zeroes an in-flight preview result', async () => {
    const runtime = runtimeHarness()
    const applyGate = deferred<Uint8Array>()
    runtime.editor.apply = vi.fn(async () => {
      const bytes = await applyGate.promise
      return Object.freeze({
        status: 'applied' as const,
        effectResult: 'mutated' as const,
        rgbaBytes: bytes,
      })
    })
    const harness = setup({ runtime })
    const applying = harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(runtime.editor.apply).toHaveBeenCalledOnce())

    const mutation = harness.controller.disablePlugin(PLUGIN_ID)
    const resultBytes = new Uint8Array([9, 9, 9, 9])
    applyGate.resolve(resultBytes)

    await expect(applying).resolves.toEqual({ status: 'bypassed' })
    expect([...resultBytes]).toEqual([0, 0, 0, 0])
    await mutation
  })

  test('rejects unbounded plugin ids before they can enter action snapshots', () => {
    const harness = setup()

    expect(() => harness.controller.disablePlugin(`example.${'x'.repeat(200)}`)).toThrow(
      'Plugin id is invalid',
    )
    expect(harness.controller.getSnapshot().action.phase).toBe('idle')
    expect(harness.createManagementController).not.toHaveBeenCalled()
  })

  test('bypasses and zeroes a runtime result whose byte length is not exact', async () => {
    const runtime = runtimeHarness()
    const invalidBytes = new Uint8Array([7, 7, 7])
    runtime.editor.apply = vi.fn(async () => Object.freeze({
      status: 'applied' as const,
      effectResult: 'mutated' as const,
      rgbaBytes: invalidBytes,
    }))
    const harness = setup({ runtime })

    await expect(harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )).resolves.toEqual({ status: 'bypassed' })
    expect([...invalidBytes]).toEqual([0, 0, 0])
  })

  test('unknown failures are bounded and do not expose private exception content', async () => {
    const management = managementHarness()
    management.disable.mockRejectedValue(new Error('PRIVATE-MEDIA-PATH C:\\secret\\clip.mov'))
    const harness = setup({ management })

    await expect(harness.controller.disablePlugin(PLUGIN_ID)).rejects.toThrow('PRIVATE-MEDIA-PATH')

    expect(harness.controller.getSnapshot()).toMatchObject({
      managementPhase: 'error',
      action: {
        kind: 'disable',
        phase: 'failed',
        detail: 'The plugin action failed without exposing internal details.',
      },
    })
    expect(JSON.stringify(harness.controller.getSnapshot())).not.toContain('PRIVATE-MEDIA-PATH')
  })

  test('close is terminal, idempotent, and releases the registered editor/runtime once', async () => {
    const harness = setup()
    await harness.controller.getEffectBridgeHandler().apply(
      bridgeRequest(),
      new AbortController().signal,
    )

    const first = harness.controller.close('project-replaced')
    const second = harness.controller.close('ignored-second-reason')
    await Promise.all([first, second])

    expect(harness.runtime.editor.close).toHaveBeenCalledOnce()
    expect(harness.runtime.editor.close).toHaveBeenCalledWith('project-replaced')
    expect(harness.runtime.teardown).toHaveBeenCalledOnce()
    expect(harness.runtime.teardown).toHaveBeenCalledWith('project-replaced')
    expect(harness.lifecycle.dispose).toHaveBeenCalledOnce()
    expect(() => harness.controller.subscribe(vi.fn())).toThrow('closed')
  })
})
