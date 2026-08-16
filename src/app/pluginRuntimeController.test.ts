import { describe, expect, test, vi } from 'vitest'
import type {
  PluginActivationBundleResolver,
  VerifiedPluginActivationBundle,
} from './pluginInstallController'
import {
  PluginSandboxError,
  type PluginSandboxActivationRequest,
  type PluginSandboxController,
  type PluginSandboxMigrationRequest,
  type PluginSandboxRenderRequest,
  type PluginSandboxSession,
} from './pluginSandboxController'
import {
  createPluginRuntimeController,
  type PluginEffectApplyRequest,
  type PluginExecutionIdentity,
  type PluginExportEffectRequirement,
} from './pluginRuntimeController'
import { PLUGIN_WASM_OPCODE_TABLE_DIGESTS } from '../workers/plugin-wasm/policyTables'
import type {
  PluginRuntimeLifecycleSnapshot,
  PluginSandboxLifecycleSnapshot,
} from './pluginRuntimeLifecycleObserver'

interface SandboxHarness {
  readonly controller: PluginSandboxController
  readonly activations: PluginSandboxActivationRequest[]
  readonly sessions: PluginSandboxSession[]
  readonly renderRequests: PluginSandboxRenderRequest[]
  readonly migrationRequests: PluginSandboxMigrationRequest[]
  readonly closeReasons: string[]
  maxConcurrentRenders: number
}

function sandboxHarness(options: {
  readonly activate?: (
    request: PluginSandboxActivationRequest,
    activationIndex: number,
  ) => void | Promise<void>
  readonly render?: (
    request: PluginSandboxRenderRequest,
    sessionIndex: number,
  ) => Promise<{ readonly identity: boolean; readonly rgbaBytes: Uint8Array }>
  readonly migrate?: (
    request: PluginSandboxMigrationRequest,
    sessionIndex: number,
  ) => Promise<Uint8Array>
  readonly close?: (reason: string, sessionIndex: number) => void | Promise<void>
} = {}): SandboxHarness {
  const activations: PluginSandboxActivationRequest[] = []
  const sessions: PluginSandboxSession[] = []
  const renderRequests: PluginSandboxRenderRequest[] = []
  const migrationRequests: PluginSandboxMigrationRequest[] = []
  const closeReasons: string[] = []
  let concurrentRenders = 0
  const harness: SandboxHarness = {
    activations,
    sessions,
    renderRequests,
    migrationRequests,
    closeReasons,
    maxConcurrentRenders: 0,
    controller: {
      async activate(request) {
        activations.push(request)
        const activationIndex = activations.length - 1
        await options.activate?.(request, activationIndex)
        const sessionIndex = sessions.length
        let closed = false
        const session: PluginSandboxSession = {
          generation: sessionIndex + 1,
          facts: {
            policy: request.expectations.policy,
            opcodeTableDigest: request.expectations.opcodeTableDigest!,
            importedMemory: {
              minimumPages: request.expectations.memoryMaximumPages,
              maximumPages: request.expectations.memoryMaximumPages,
            },
            definedFunctionCount: 1,
            tableCount: 0,
            elementSegmentCount: 0,
            dataSegmentCount: 0,
            exportedFunctions: [...request.expectations.renderEntrypoints],
          },
          async render(renderRequest) {
            if (closed) throw new Error('closed fake session')
            renderRequests.push(renderRequest)
            concurrentRenders++
            harness.maxConcurrentRenders = Math.max(
              harness.maxConcurrentRenders,
              concurrentRenders,
            )
            try {
              return options.render
                ? await options.render(renderRequest, sessionIndex)
                : { identity: false, rgbaBytes: renderRequest.rgbaBytes.slice() }
            } finally {
              concurrentRenders--
            }
          },
          async migrate(migrationRequest) {
            if (closed) throw new Error('closed fake session')
            migrationRequests.push(migrationRequest)
            return options.migrate
              ? options.migrate(migrationRequest, sessionIndex)
              : migrationRequest.canonicalInputBytes.slice()
          },
          async close(reason) {
            if (closed) return
            closed = true
            closeReasons.push(reason)
            await options.close?.(reason, sessionIndex)
          },
        }
        sessions.push(session)
        return session
      },
      async teardown(reason) {
        closeReasons.push(`controller:${reason}`)
      },
    },
  }
  return harness
}

function bundle(
  pluginId = 'com.example.fixture',
  overrides: Partial<VerifiedPluginActivationBundle> = {},
): VerifiedPluginActivationBundle & { readonly copyCount: () => number } {
  let copies = 0
  const contribution = Object.freeze({
    kind: 'video-effect' as const,
    id: 'fixture',
    name: 'Fixture',
    contributionVersion: 1,
    descriptorVersion: 2,
    entrypoint: 'myrelith_effect_fixture',
    migrations: Object.freeze([Object.freeze({
      fromVersion: 1,
      toVersion: 2,
      entrypoint: 'myrelith_migrate_fixture_1_2',
    })]),
    parameters: Object.freeze([Object.freeze({
      key: 'strength',
      name: 'Strength',
      kind: 'number' as const,
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.1,
      animatable: false,
    })]),
  })
  const value = {
    catalogGeneration: 7,
    pluginId,
    name: 'Fixture',
    version: '1.2.3',
    packageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001' as const,
    signerFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000002' as const,
    modulePath: 'runtime/plugin.wasm',
    moduleSha256: `sha256:module-${pluginId}`,
    moduleByteLength: 8,
    profile: Object.freeze({
      apiVersion: 1,
      memoryMaximumPages: 258,
      permissions: Object.freeze([Object.freeze({
        id: 'myrelith.effect.video-frame.rgba8',
        version: 1,
      })]),
    }),
    contributions: Object.freeze([contribution]),
    copyModuleBytes() {
      copies++
      return Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
    },
    ...overrides,
  }
  return Object.freeze({ ...value, copyCount: () => copies })
}

function identity(value = bundle()): PluginExecutionIdentity {
  const contribution = value.contributions[0]
  return {
    catalogGeneration: value.catalogGeneration,
    pluginId: value.pluginId,
    pluginVersion: value.version,
    packageDigest: value.packageDigest,
    signerFingerprint: value.signerFingerprint,
    kind: 'video-effect',
    contributionId: contribution.id,
    contributionVersion: contribution.contributionVersion,
    descriptorVersion: contribution.descriptorVersion,
    entrypoint: contribution.entrypoint,
  }
}

function exportRequirement(
  value = bundle(),
  overrides: Partial<PluginExportEffectRequirement> = {},
): PluginExportEffectRequirement {
  return {
    ...identity(value),
    maximumSurfaceWidth: 1,
    maximumSurfaceHeight: 1,
    maximumSurfaceStride: 4,
    maximumSurfaceByteLength: 4,
    ...overrides,
  }
}

function applyRequest(
  execution: PluginExecutionIdentity = identity(),
  overrides: Partial<PluginEffectApplyRequest> = {},
): PluginEffectApplyRequest {
  return {
    ...execution,
    requestId: 1,
    descriptorId: 'effect-fixture',
    canonicalParameterJson: '{"strength":0.5}',
    timelineFrame: 12,
    frameRateNumerator: 30,
    frameRateDenominator: 1,
    width: 1,
    height: 1,
    stride: 4,
    rgbaBytes: Uint8Array.of(10, 20, 30, 255),
    ...overrides,
  }
}

function resolverFor(
  values: ReadonlyMap<string, VerifiedPluginActivationBundle>,
): PluginActivationBundleResolver & {
  readonly calls: string[]
  setGeneration(value: number): void
} {
  const calls: string[] = []
  let generation = values.values().next().value?.catalogGeneration ?? 0
  return {
    calls,
    setGeneration(value) { generation = value },
    async generation(signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return generation
    },
    async resolve(pluginId, signal) {
      calls.push(pluginId)
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const value = values.get(pluginId)
      if (!value) throw new Error('missing fixture bundle')
      return value
    },
  }
}

describe('plugin runtime controller', () => {
  test.each([
    ['catalogGeneration', 8],
    ['pluginId', 'com.example.other'],
    ['pluginVersion', '1.2.4'],
    ['packageDigest', 'sha256:other-package'],
    ['signerFingerprint', 'sha256:other-signer'],
    ['contributionId', 'other'],
    ['contributionVersion', 2],
    ['descriptorVersion', 1],
    ['entrypoint', 'myrelith_effect_other'],
  ] as const)('rejects stale %s before copying or activating bytes', async (field, mismatched) => {
    const installed = bundle()
    const planned = {
      ...identity(installed),
      [field]: mismatched,
    }
    const resolver = resolverFor(new Map([
      [installed.pluginId, installed],
      [planned.pluginId, installed],
    ]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    const result = await editor.apply(applyRequest(planned))

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'stale-plan' } })
    expect(installed.copyCount()).toBe(0)
    expect(sandbox.activations).toHaveLength(0)
    await editor.close('test-complete')
  })

  test('encodes the planner-owned parameter text exactly once and returns owned exact bytes', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    let dispatchedParameterJson = ''
    const sandbox = sandboxHarness({
      render: async (request) => {
        dispatchedParameterJson = new TextDecoder().decode(request.canonicalParameterBytes)
        return {
          identity: true,
          rgbaBytes: Uint8Array.from(request.rgbaBytes, (byte) => byte ^ 0xff),
        }
      },
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()
    const canonicalParameterJson = '{"strength":0.5000000000000001}'

    const result = await editor.apply(applyRequest(identity(installed), {
      canonicalParameterJson,
    }))

    expect(result).toEqual({
      status: 'applied',
      effectResult: 'identity',
      rgbaBytes: Uint8Array.of(245, 235, 225, 0),
    })
    expect(dispatchedParameterJson).toBe(canonicalParameterJson)
    expect(installed.copyCount()).toBe(1)
    await editor.close('test-complete')
  })

  test.each([
    ['empty', ''],
    ['one-byte', '{'],
    ['leading BOM', '\ufeff{}'],
    ['cap-plus-one', `{${'a'.repeat(65_535)}}`],
  ])('rejects %s parameter bytes before activation', async (_label, canonicalParameterJson) => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    const result = await editor.apply(applyRequest(identity(installed), {
      canonicalParameterJson,
    }))

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'invalid-input' } })
    expect(installed.copyCount()).toBe(0)
    expect(sandbox.activations).toHaveLength(0)
    await editor.close('test-complete')
  })

  test('accepts the exact 65,536-byte parameter cap without re-canonicalizing', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()
    const canonicalParameterJson = `{${'a'.repeat(65_534)}}`

    expect(new TextEncoder().encode(canonicalParameterJson)).toHaveLength(65_536)
    expect((await editor.apply(applyRequest(identity(installed), {
      canonicalParameterJson,
    }))).status).toBe('applied')
    expect(sandbox.renderRequests[0].canonicalParameterBytes).toHaveLength(65_536)
    await editor.close('test-complete')
  })

  test('accepts the exact imported-memory pixel capacity', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    const result = await editor.apply(applyRequest(identity(installed), {
      width: 16_384,
      height: 1,
      stride: 65_536,
      rgbaBytes: new Uint8Array(65_536),
    }))

    expect(result.status).toBe('applied')
    expect(sandbox.renderRequests).toHaveLength(1)
    await editor.close('test-complete')
  })

  test('rejects one pixel beyond imported-memory capacity before activation', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    const result = await editor.apply(applyRequest(identity(installed), {
      width: 16_385,
      height: 1,
      stride: 65_540,
      rgbaBytes: new Uint8Array(65_540),
    }))

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'invalid-input' } })
    expect(installed.copyCount()).toBe(0)
    expect(sandbox.activations).toHaveLength(0)
    await editor.close('test-complete')
  })

  test('reuses one verified bundle within an editor generation', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    expect((await editor.apply(applyRequest(identity(installed), { requestId: 1 }))).status)
      .toBe('applied')
    expect((await editor.apply(applyRequest(identity(installed), { requestId: 2 }))).status)
      .toBe('applied')

    expect(resolver.calls).toEqual([installed.pluginId])
    expect(sandbox.activations).toHaveLength(1)
    await editor.close('test-complete')
  })

  test('invalidates an editor runtime when the planned catalog generation changes', async () => {
    const first = bundle()
    const second = bundle(first.pluginId, { catalogGeneration: 8 })
    const installed = new Map<string, VerifiedPluginActivationBundle>([[first.pluginId, first]])
    const resolver = resolverFor(installed)
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    expect((await editor.apply(applyRequest(identity(first), { requestId: 1 }))).status)
      .toBe('applied')
    installed.set(first.pluginId, second)
    resolver.setGeneration(second.catalogGeneration)
    expect((await editor.apply(applyRequest(identity(second), { requestId: 2 }))).status)
      .toBe('applied')

    expect(resolver.calls).toEqual([first.pluginId, first.pluginId])
    expect(sandbox.closeReasons).toContain('editor-plan-identity-changed')
    expect(sandbox.activations).toHaveLength(2)
    await editor.close('test-complete')
  })

  test('rejects a cached editor runtime after another tab advances authorization', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    expect((await editor.apply(applyRequest(identity(installed), { requestId: 1 }))).status)
      .toBe('applied')
    resolver.setGeneration(installed.catalogGeneration + 1)
    const revoked = await editor.apply(applyRequest(identity(installed), { requestId: 2 }))

    expect(revoked).toMatchObject({
      status: 'failed',
      failure: { code: 'stale-generation' },
    })
    expect(sandbox.renderRequests).toHaveLength(1)
    expect(sandbox.closeReasons).toContain('stale-generation')
    await editor.close('test-complete')
  })

  test('zeroes a completed frame when cross-tab authorization changes during render', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    let returnedBytes: Uint8Array | null = null
    const sandbox = sandboxHarness({
      render: async (request) => {
        returnedBytes = request.rgbaBytes.slice()
        resolver.setGeneration(installed.catalogGeneration + 1)
        return { identity: false, rgbaBytes: returnedBytes }
      },
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    const revoked = await editor.apply(applyRequest(identity(installed)))

    expect(revoked).toMatchObject({
      status: 'failed',
      failure: { code: 'stale-generation' },
    })
    expect(returnedBytes).not.toBeNull()
    expect([...returnedBytes!]).toEqual([0, 0, 0, 0])
    await editor.close('test-complete')
  })

  test('freezes and activates export bundles once during preflight', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })

    const session = await controller.preflightExport({
      requiredEffects: [exportRequirement(installed), exportRequirement(installed)],
    })
    expect(resolver.calls).toEqual([installed.pluginId])
    expect(sandbox.activations).toHaveLength(1)
    expect(installed.copyCount()).toBe(1)

    expect((await session.apply(applyRequest(identity(installed), { requestId: 1 }))).status)
      .toBe('applied')
    expect((await session.apply(applyRequest(identity(installed), { requestId: 2 }))).status)
      .toBe('applied')
    expect(resolver.calls).toEqual([installed.pluginId])
    expect(sandbox.activations).toHaveLength(1)
    await session.close('export-complete')
  })

  test('rejects a signed contribution that was not frozen during export preflight', async () => {
    const original = bundle()
    const secondContribution = Object.freeze({
      ...original.contributions[0],
      id: 'other',
      name: 'Other',
      entrypoint: 'myrelith_effect_other',
      migrations: Object.freeze([]),
    })
    const installed = bundle(original.pluginId, {
      contributions: Object.freeze([original.contributions[0], secondContribution]),
    })
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const session = await controller.preflightExport({
      requiredEffects: [exportRequirement(installed)],
    })

    const result = await session.apply(applyRequest({
      ...identity(installed),
      contributionId: secondContribution.id,
      contributionVersion: secondContribution.contributionVersion,
      descriptorVersion: secondContribution.descriptorVersion,
      entrypoint: secondContribution.entrypoint,
    }))

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'stale-plan' } })
    expect(sandbox.renderRequests).toHaveLength(0)
    await session.close('export-complete')
  })

  test('stops a prepared export after another tab advances authorization', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const session = await controller.preflightExport({
      requiredEffects: [exportRequirement(installed)],
    })
    resolver.setGeneration(installed.catalogGeneration + 1)

    const revoked = await session.apply(applyRequest(identity(installed)))

    expect(revoked).toMatchObject({
      status: 'failed',
      failure: { code: 'stale-generation' },
    })
    expect(sandbox.renderRequests).toHaveLength(0)
    await session.close('export-complete')
  })

  test('repeats sandbox policy activation on a raw-cache hit across owners', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const first = controller.openEditorSession()
    const second = controller.openEditorSession()

    expect((await first.apply(applyRequest(identity(installed), { descriptorId: 'first' }))).status)
      .toBe('applied')
    await first.close('first-complete')
    expect((await second.apply(applyRequest(identity(installed), { descriptorId: 'second' }))).status)
      .toBe('applied')

    expect(installed.copyCount()).toBe(1)
    expect(sandbox.activations).toHaveLength(2)
    expect(sandbox.activations[0].expectations.opcodeTableDigest)
      .toBe(PLUGIN_WASM_OPCODE_TABLE_DIGESTS['myrelith-wasm-migration-integer-v1'])
    await second.close('second-complete')
  })

  test('wraps third-party sandbox activation in the injected crash-sentinel batch', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness()
    const events: string[] = []
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
      async runActivationBatch(pluginId, activate) {
        events.push(`before:${pluginId}:${sandbox.activations.length}`)
        const session = await activate()
        events.push(`after:${pluginId}:${sandbox.activations.length}`)
        return session
      },
    })
    const editor = controller.openEditorSession()

    expect((await editor.apply(applyRequest(identity(installed)))).status).toBe('applied')
    expect(events).toEqual([
      `before:${installed.pluginId}:0`,
      `after:${installed.pluginId}:1`,
    ])
    await editor.close('test-complete')
  })

  test('disables one editor plugin after three consecutive runtime failures', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness({
      render: async () => {
        throw new PluginSandboxError({
          code: 'plugin-failure',
          message: 'untrusted plugin detail',
          terminal: true,
          pluginCode: 9,
        })
      },
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editor = controller.openEditorSession()

    for (let requestId = 1; requestId <= 3; requestId++) {
      const result = await editor.apply(applyRequest(identity(installed), {
        requestId,
        descriptorId: `failure-${requestId}`,
      }))
      expect(result).toMatchObject({ status: 'failed', failure: { code: 'plugin-failure' } })
    }
    const disabled = await editor.apply(applyRequest(identity(installed), {
      requestId: 4,
      descriptorId: 'disabled',
    }))
    expect(disabled).toMatchObject({ status: 'failed', failure: { code: 'session-disabled' } })
    expect(resolver.calls).toHaveLength(3)
    expect(controller.getSnapshot().diagnostics.every((diagnostic) => (
      !diagnostic.message.includes('untrusted plugin detail')
    ))).toBe(true)
    await editor.close('test-complete')
  })

  test('clears only one runtime diagnostic bucket without resetting sequence or lifecycle state', async () => {
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(new Map()),
      sandboxController: sandboxHarness().controller,
    })
    await controller.invalidate('com.example.alpha', 'test')
    await controller.invalidate('com.example.beta', 'test')
    const before = controller.getSnapshot()
    const beta = before.diagnostics.find((diagnostic) => (
      diagnostic.pluginId === 'com.example.beta'
    ))!

    controller.clearDiagnostics('com.example.alpha')
    controller.clearDiagnostics('com.example.alpha')
    controller.clearDiagnostics('com.example.missing')
    const cleared = controller.getSnapshot()

    expect(cleared.diagnostics).toEqual([beta])
    expect(cleared).toMatchObject({
      activeCallCount: before.activeCallCount,
      queuedCallCount: before.queuedCallCount,
      liveOwnerCount: before.liveOwnerCount,
      residentRuntimeCount: before.residentRuntimeCount,
      cache: before.cache,
    })

    await controller.invalidate('com.example.alpha', 'retry')
    expect(controller.getSnapshot().diagnostics).toEqual([
      beta,
      expect.objectContaining({
        pluginId: 'com.example.alpha',
        sequence: beta.sequence + 1,
      }),
    ])
    controller.clearDiagnostics('com.example.alpha')
    controller.clearDiagnostics('com.example.beta')
    await controller.teardown('test-complete')
    expect(controller.getSnapshot().diagnostics).toEqual([])
  })

  test('enforces the tab-global eight-runtime LRU across distinct owners', async () => {
    const installed = new Map<string, ReturnType<typeof bundle>>()
    for (let index = 0; index < 9; index++) {
      const value = bundle(`com.example.fixture${index}`)
      installed.set(value.pluginId, value)
    }
    const resolver = resolverFor(installed)
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const editors = []
    for (const value of installed.values()) {
      const editor = controller.openEditorSession()
      editors.push(editor)
      expect((await editor.apply(applyRequest(identity(value), {
        descriptorId: value.pluginId,
      }))).status).toBe('applied')
    }

    expect(controller.getSnapshot().residentRuntimeCount).toBe(8)
    expect(sandbox.closeReasons).toContain('runtime-lru-eviction')
    await Promise.all(editors.map((editor) => editor.close('test-complete')))
  })

  test('rejects editor creation after terminal controller teardown without creating an owner', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandboxHarness().controller,
    })

    await controller.teardown('test-terminal')

    expect(() => controller.openEditorSession()).toThrowError(expect.objectContaining({
      failure: expect.objectContaining({ code: 'closed' }),
    }))
    expect(controller.getSnapshot().liveOwnerCount).toBe(0)
  })

  test('reports bounded runtime ownership transitions and one terminal all-zero snapshot', async () => {
    const installed = new Map<string, ReturnType<typeof bundle>>()
    for (let index = 0; index < 3; index++) {
      const value = bundle(`com.example.observer${index}`)
      installed.set(value.pluginId, value)
    }
    const releases: Array<() => void> = []
    const sandbox = sandboxHarness({
      render: (request) => new Promise((resolve) => {
        releases.push(() => resolve({
          identity: false,
          rgbaBytes: request.rgbaBytes.slice(),
        }))
      }),
    })
    const snapshots: PluginRuntimeLifecycleSnapshot[] = []
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(installed),
      sandboxController: sandbox.controller,
      lifecycleObserver: {
        onSandboxSnapshot() {},
        onRuntimeSnapshot(snapshot) {
          snapshots.push(snapshot)
        },
      },
    })
    const editors = [...installed.values()].map(() => controller.openEditorSession())
    const applies = [...installed.values()].map((value, index) => editors[index].apply(
      applyRequest(identity(value), { requestId: index + 1, descriptorId: value.pluginId }),
    ))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(snapshots.some((snapshot) => (
      snapshot.activeCallCount === 2 && snapshot.queuedCallCount === 1
    ))).toBe(true)
    expect(snapshots.some((snapshot) => snapshot.liveOwnerCount === 3)).toBe(true)
    releases.splice(0).forEach((release) => release())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    releases.splice(0).forEach((release) => release())
    await expect(Promise.all(applies)).resolves.toEqual([
      expect.objectContaining({ status: 'applied' }),
      expect.objectContaining({ status: 'applied' }),
      expect.objectContaining({ status: 'applied' }),
    ])
    expect(snapshots.some((snapshot) => (
      snapshot.residentRuntimeCount === 3
        && snapshot.rawCacheEntryCount === 3
        && snapshot.rawCacheByteLength === 24
    ))).toBe(true)
    await Promise.all(editors.map((editor) => editor.close('observer-editor-close')))

    const migrationBundle = [...installed.values()][0]
    const action = await controller.preflightDescriptorMigrationAction({
      targets: [{
        ...identity(migrationBundle),
        descriptorId: 'observer-migration',
        fromDescriptorVersion: 1,
        canonicalParameterJson: '{"strength":0.5}',
        hasAnimatedParameters: false,
      }],
    })
    expect(snapshots.some((snapshot) => snapshot.migrationReservationCount === 1)).toBe(true)
    await action.close('observer-migration-close')
    expect(snapshots.at(-1)).toMatchObject({ migrationReservationCount: 0 })

    await controller.teardown('observer-runtime-terminal')
    const terminal = snapshots.filter((snapshot) => snapshot.terminal)
    expect(terminal).toEqual([{
      queuedCallCount: 0,
      activeCallCount: 0,
      liveOwnerCount: 0,
      migrationReservationCount: 0,
      residentRuntimeCount: 0,
      rawCacheEntryCount: 0,
      rawCacheByteLength: 0,
      terminal: true,
    }])
    expect(snapshots.every((snapshot) => Object.isFrozen(snapshot))).toBe(true)
  })

  test('shares concurrent teardown through sandbox and runtime terminal cleanup', async () => {
    const installed = bundle()
    let releaseOwner!: () => void
    const ownerCloseGate = new Promise<void>((resolve) => { releaseOwner = resolve })
    let releaseSandbox!: () => void
    const sandboxCloseGate = new Promise<void>((resolve) => { releaseSandbox = resolve })
    const sandbox = sandboxHarness({ close: () => ownerCloseGate })
    const lifecycleOrder: string[] = []
    const runtimeSnapshots: PluginRuntimeLifecycleSnapshot[] = []
    const sandboxTerminal: PluginSandboxLifecycleSnapshot = Object.freeze({
      brokerIframeCount: 0,
      candidateWorkerCount: 0,
      privatePortCount: 0,
      watchdogCount: 0,
      pendingActivationCount: 0,
      pendingRequestCount: 0,
      sessionCount: 0,
      terminal: true,
    })
    const sandboxTeardown = vi.fn(async () => {
      await sandboxCloseGate
      lifecycleOrder.push('sandbox-terminal')
      lifecycleObserver.onSandboxSnapshot(sandboxTerminal)
    })
    const lifecycleObserver = {
      onSandboxSnapshot(snapshot: PluginSandboxLifecycleSnapshot) {
        if (snapshot.terminal) expect(snapshot).toEqual(sandboxTerminal)
      },
      onRuntimeSnapshot(snapshot: PluginRuntimeLifecycleSnapshot) {
        runtimeSnapshots.push(snapshot)
        if (snapshot.terminal) lifecycleOrder.push('runtime-terminal')
      },
    }
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(new Map([[installed.pluginId, installed]])),
      sandboxController: { ...sandbox.controller, teardown: sandboxTeardown },
      lifecycleObserver,
    })
    const editor = controller.openEditorSession()
    await expect(editor.apply(applyRequest(identity(installed)))).resolves.toMatchObject({
      status: 'applied',
    })

    const first = controller.teardown('shared-terminal')
    const second = controller.teardown('ignored-second-reason')
    expect(second).toBe(first)
    const firstSettled = vi.fn()
    const secondSettled = vi.fn()
    void first.finally(firstSettled)
    void second.finally(secondSettled)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(firstSettled).not.toHaveBeenCalled()
    expect(secondSettled).not.toHaveBeenCalled()

    releaseOwner()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(firstSettled).not.toHaveBeenCalled()
    expect(secondSettled).not.toHaveBeenCalled()
    releaseSandbox()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])

    expect(sandboxTeardown).toHaveBeenCalledOnce()
    expect(sandboxTeardown).toHaveBeenCalledWith('shared-terminal')
    expect(lifecycleOrder).toEqual(['sandbox-terminal', 'runtime-terminal'])
    expect(runtimeSnapshots.filter((snapshot) => snapshot.terminal)).toEqual([{
      queuedCallCount: 0,
      activeCallCount: 0,
      liveOwnerCount: 0,
      migrationReservationCount: 0,
      residentRuntimeCount: 0,
      rawCacheEntryCount: 0,
      rawCacheByteLength: 0,
      terminal: true,
    }])
  })

  test('contains runtime observer exceptions without masking an operational failure', async () => {
    const installed = bundle()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(new Map([[installed.pluginId, installed]])),
      sandboxController: sandboxHarness().controller,
      lifecycleObserver: {
        onSandboxSnapshot() {},
        onRuntimeSnapshot() {
          throw new Error('observer must be inert')
        },
      },
    })
    const editor = controller.openEditorSession()

    await expect(editor.apply(applyRequest({
      ...identity(installed),
      catalogGeneration: installed.catalogGeneration + 1,
    }))).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'stale-plan' },
    })
    await editor.close('throwing-observer-close')
    await expect(controller.teardown('throwing-observer-terminal')).resolves.toBeUndefined()
  })

  test('fails an over-capacity export preflight before copying or activating partial owners', async () => {
    const installed = new Map<string, ReturnType<typeof bundle>>()
    for (let index = 0; index < 9; index++) {
      const value = bundle(`com.example.export${index}`)
      installed.set(value.pluginId, value)
    }
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(installed),
      sandboxController: sandbox.controller,
    })

    await expect(controller.preflightExport({
      requiredEffects: [...installed.values()].map((value) => exportRequirement(value)),
    })).rejects.toMatchObject({ failure: { code: 'busy' } })

    expect([...installed.values()].map((value) => value.copyCount()))
      .toEqual(new Array(9).fill(0))
    expect(sandbox.activations).toHaveLength(0)
    expect(controller.getSnapshot()).toMatchObject({
      liveOwnerCount: 0,
      residentRuntimeCount: 0,
    })
  })

  test('closes every partial runtime when export activation fails', async () => {
    const first = bundle('com.example.partial-first')
    const second = bundle('com.example.partial-second')
    const installed = new Map([
      [first.pluginId, first],
      [second.pluginId, second],
    ])
    const sandbox = sandboxHarness({
      activate: (_request, activationIndex) => {
        if (activationIndex === 1) {
          throw new PluginSandboxError({
            code: 'activation-failed',
            message: 'Plugin activation failed.',
            terminal: true,
          })
        }
      },
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(installed),
      sandboxController: sandbox.controller,
    })

    await expect(controller.preflightExport({
      requiredEffects: [exportRequirement(first), exportRequirement(second)],
    })).rejects.toMatchObject({ failure: { code: 'activation-failed' } })

    expect(sandbox.activations).toHaveLength(2)
    expect(sandbox.sessions).toHaveLength(1)
    expect(sandbox.closeReasons).toEqual(['export-preflight-rollback'])
    expect(controller.getSnapshot()).toMatchObject({
      liveOwnerCount: 0,
      residentRuntimeCount: 0,
    })
  })

  test('checks the exact maximum export surface before copying or activating a plugin', async () => {
    const installed = bundle('com.example.export-surface')
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(new Map([[installed.pluginId, installed]])),
      sandboxController: sandbox.controller,
    })

    const exact = await controller.preflightExport({
      requiredEffects: [exportRequirement(installed, {
        maximumSurfaceWidth: 16_384,
        maximumSurfaceHeight: 1,
        maximumSurfaceStride: 65_536,
        maximumSurfaceByteLength: 65_536,
      })],
    })
    expect(installed.copyCount()).toBe(1)
    expect(sandbox.activations).toHaveLength(1)
    await exact.close('exact-surface-complete')

    await expect(controller.preflightExport({
      requiredEffects: [exportRequirement(installed, {
        maximumSurfaceWidth: 16_385,
        maximumSurfaceHeight: 1,
        maximumSurfaceStride: 65_540,
        maximumSurfaceByteLength: 65_540,
      })],
    })).rejects.toMatchObject({
      failures: [{
        pluginId: installed.pluginId,
        failure: { code: 'invalid-input' },
      }],
    })
    expect(installed.copyCount()).toBe(1)
    expect(sandbox.activations).toHaveLength(1)
  })

  test('aggregates malformed and over-capacity export surfaces before activation', async () => {
    const malformed = bundle('com.example.export-malformed')
    const overCapacity = bundle('com.example.export-over-capacity')
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(new Map([
        [malformed.pluginId, malformed],
        [overCapacity.pluginId, overCapacity],
      ])),
      sandboxController: sandbox.controller,
    })

    await expect(controller.preflightExport({
      requiredEffects: [
        exportRequirement(malformed, { maximumSurfaceByteLength: 3 }),
        exportRequirement(overCapacity, {
          maximumSurfaceWidth: 16_385,
          maximumSurfaceHeight: 1,
          maximumSurfaceStride: 65_540,
          maximumSurfaceByteLength: 65_540,
        }),
      ],
    })).rejects.toMatchObject({
      failures: [{
        pluginId: malformed.pluginId,
        failure: { code: 'invalid-input' },
      }, {
        pluginId: overCapacity.pluginId,
        failure: { code: 'invalid-input' },
      }],
    })
    expect(malformed.copyCount()).toBe(0)
    expect(overCapacity.copyCount()).toBe(0)
    expect(sandbox.activations).toHaveLength(0)
  })

  test('aggregates ordered resolver and activation failures while rolling back all successes', async () => {
    const missing = bundle('com.example.aggregate-missing')
    const activationFailure = bundle('com.example.aggregate-activation')
    const successful = bundle('com.example.aggregate-success')
    const resolverCalls: string[] = []
    const resolver: PluginActivationBundleResolver = {
      async generation() { return 7 },
      async resolve(pluginId) {
        resolverCalls.push(pluginId)
        if (pluginId === missing.pluginId) {
          throw Object.assign(new Error('not installed'), { code: 'disabled' })
        }
        return pluginId === activationFailure.pluginId ? activationFailure : successful
      },
    }
    const sandbox = sandboxHarness({
      activate: (_request, activationIndex) => {
        if (activationIndex === 0) {
          throw new PluginSandboxError({
            code: 'activation-failed',
            message: 'Plugin activation failed.',
            terminal: true,
          })
        }
      },
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })

    await expect(controller.preflightExport({
      requiredEffects: [
        exportRequirement(missing),
        exportRequirement(activationFailure),
        exportRequirement(successful),
      ],
    })).rejects.toMatchObject({
      failures: [{
        pluginId: missing.pluginId,
        failure: { code: 'stale-plan' },
      }, {
        pluginId: activationFailure.pluginId,
        failure: { code: 'activation-failed' },
      }],
    })

    expect(resolverCalls).toEqual([
      missing.pluginId,
      activationFailure.pluginId,
      successful.pluginId,
    ])
    expect(sandbox.activations).toHaveLength(2)
    expect(successful.copyCount()).toBe(1)
    expect(sandbox.closeReasons).toEqual(['export-preflight-rollback'])
    expect(controller.getSnapshot()).toMatchObject({
      liveOwnerCount: 0,
      residentRuntimeCount: 0,
    })
  })

  test('never evicts or reactivates an export-pinned runtime', async () => {
    const installed = new Map<string, ReturnType<typeof bundle>>()
    for (let index = 0; index < 9; index++) {
      const value = bundle(`com.example.pinned${index}`)
      installed.set(value.pluginId, value)
    }
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(installed),
      sandboxController: sandbox.controller,
    })
    const required = [...installed.values()].slice(0, 8)
    const exportSession = await controller.preflightExport({
      requiredEffects: required.map((value) => exportRequirement(value)),
    })
    const editor = controller.openEditorSession()
    const ninth = [...installed.values()][8]

    const blocked = await editor.apply(applyRequest(identity(ninth), {
      descriptorId: 'ninth',
    }))
    expect(blocked).toMatchObject({ status: 'failed', failure: { code: 'busy' } })
    expect(sandbox.closeReasons).not.toContain('runtime-lru-eviction')
    expect(sandbox.activations).toHaveLength(8)

    const stillPinned = await exportSession.apply(applyRequest(identity(required[0]), {
      requestId: 2,
      descriptorId: 'export-pinned',
    }))
    expect(stillPinned.status).toBe('applied')
    expect(sandbox.activations).toHaveLength(8)
    await editor.close('editor-complete')
    await exportSession.close('export-complete')
  })

  test('terminal export close releases every pin and restores runtime capacity', async () => {
    const installed = new Map<string, ReturnType<typeof bundle>>()
    for (let index = 0; index < 9; index++) {
      const value = bundle(`com.example.release${index}`)
      installed.set(value.pluginId, value)
    }
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(installed),
      sandboxController: sandbox.controller,
    })
    const required = [...installed.values()].slice(0, 8)
    const exportSession = await controller.preflightExport({
      requiredEffects: required.map((value) => exportRequirement(value)),
    })

    await exportSession.close('terminal-export-close')
    expect(controller.getSnapshot().residentRuntimeCount).toBe(0)

    const ninth = [...installed.values()][8]
    const editor = controller.openEditorSession()
    expect((await editor.apply(applyRequest(identity(ninth), {
      descriptorId: 'after-export-close',
    }))).status).toBe('applied')
    expect(sandbox.activations).toHaveLength(9)
    await editor.close('test-complete')
  })

  test('runs at most two plugins and rejects the thirty-third queued call', async () => {
    let releaseRenders!: () => void
    const renderGate = new Promise<void>((resolve) => { releaseRenders = resolve })
    const installed = new Map<string, ReturnType<typeof bundle>>()
    for (let index = 0; index < 35; index++) {
      const value = bundle(`com.example.queue${index}`)
      installed.set(value.pluginId, value)
    }
    const sandbox = sandboxHarness({
      render: async (request) => {
        await renderGate
        return { identity: false, rgbaBytes: request.rgbaBytes.slice() }
      },
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolverFor(installed),
      sandboxController: sandbox.controller,
    })
    const editors = [...installed.values()].map(() => controller.openEditorSession())
    const calls = [...installed.values()].map((value, index) => editors[index].apply(
      applyRequest(identity(value), { descriptorId: `queued-${index}` }),
    ))
    for (let turn = 0; turn < 20 && sandbox.renderRequests.length < 2; turn++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }

    expect(controller.getSnapshot()).toMatchObject({
      activeCallCount: 2,
      queuedCallCount: 32,
    })
    await expect(calls[34]).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'queue-full' },
    })

    releaseRenders()
    const results = await Promise.all(calls.slice(0, 34))
    expect(results.every((result) => result.status === 'applied')).toBe(true)
    expect(sandbox.maxConcurrentRenders).toBe(2)
    await Promise.all(editors.map((editor) => editor.close('test-complete')))
  })

  test('runs a frozen sequential migration chain and validates the current schema', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness({
      migrate: async () => new TextEncoder().encode('{"strength":0.75}'),
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const session = await controller.openDescriptorMigrationChain({
      ...identity(installed),
      fromDescriptorVersion: 1,
      canonicalParameterJson: '{"strength":0.5}',
      hasAnimatedParameters: false,
    })

    const result = await session.apply({ requestId: 1 })
    expect(result).toEqual({
      status: 'migrated',
      descriptorVersion: 2,
      canonicalParameterJson: '{"strength":0.75}',
      parameters: { strength: 0.75 },
    })
    expect(sandbox.migrationRequests).toHaveLength(1)
    expect(resolver.calls).toHaveLength(2)
    await session.close('migration-complete')
  })

  test('preflights every ordered migration target before any plugin code runs', async () => {
    const first = bundle('com.example.migration-first')
    const secondBase = bundle('com.example.migration-second')
    const second = bundle(secondBase.pluginId, {
      contributions: Object.freeze([Object.freeze({
        ...secondBase.contributions[0],
        descriptorVersion: 3,
      })]),
    })
    const resolver = resolverFor(new Map([
      [first.pluginId, first],
      [second.pluginId, second],
    ]))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })

    await expect(controller.preflightDescriptorMigrationAction({
      targets: [
        {
          ...identity(first),
          descriptorId: 'first-effect',
          fromDescriptorVersion: 1,
          canonicalParameterJson: '{"strength":0.5}',
          hasAnimatedParameters: false,
        },
        {
          ...identity(second),
          descriptorId: 'second-effect',
          fromDescriptorVersion: 1,
          canonicalParameterJson: '{"strength":0.5}',
          hasAnimatedParameters: false,
        },
      ],
    })).rejects.toMatchObject({ failure: { code: 'stale-plan' } })

    expect(resolver.calls).toEqual([first.pluginId, second.pluginId])
    expect(first.copyCount()).toBe(0)
    expect(second.copyCount()).toBe(0)
    expect(sandbox.activations).toHaveLength(0)
    expect(controller.getSnapshot()).toMatchObject({
      liveOwnerCount: 0,
      residentRuntimeCount: 0,
    })
  })

  test('uses one fresh terminal owner per ordered migration target', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness({
      migrate: async () => new TextEncoder().encode('{"strength":0.75}'),
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const target = {
      ...identity(installed),
      fromDescriptorVersion: 1,
      canonicalParameterJson: '{"strength":0.5}',
      hasAnimatedParameters: false,
    }
    const action = await controller.preflightDescriptorMigrationAction({
      targets: [
        { ...target, descriptorId: 'first-effect' },
        { ...target, descriptorId: 'second-effect' },
      ],
    })

    await expect(action.applyTarget({ targetIndex: 0, requestId: 10 }))
      .resolves.toMatchObject({ status: 'migrated', descriptorVersion: 2 })
    expect(sandbox.activations).toHaveLength(1)
    expect(sandbox.closeReasons).toEqual(['migration-target-terminal'])
    expect(controller.getSnapshot()).toMatchObject({ liveOwnerCount: 0, residentRuntimeCount: 0 })

    await expect(action.applyTarget({ targetIndex: 1, requestId: 11 }))
      .resolves.toMatchObject({ status: 'migrated', descriptorVersion: 2 })
    expect(sandbox.activations).toHaveLength(2)
    expect(sandbox.sessions.map((session) => session.generation)).toEqual([1, 2])
    expect(sandbox.closeReasons).toEqual([
      'migration-target-terminal',
      'migration-target-terminal',
    ])
    expect(resolver.calls).toEqual([
      installed.pluginId,
      installed.pluginId,
      installed.pluginId,
      installed.pluginId,
    ])
    await action.close('migration-action-complete')
    await action.close('migration-action-complete-again')
  })

  test('reports migration close failure only after owner and reservation are terminal', async () => {
    const installed = bundle()
    let markMigrationStarted!: () => void
    let rejectMigration!: (cause: Error) => void
    const migrationStarted = new Promise<void>((resolve) => { markMigrationStarted = resolve })
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const sandbox = sandboxHarness({
      migrate: () => new Promise<Uint8Array>((_resolve, reject) => {
        rejectMigration = reject
        markMigrationStarted()
      }),
      close: async () => {
        rejectMigration(new Error('migration interrupted by close'))
        throw new Error('sandbox close failed after terminal cleanup')
      },
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const request = {
      targets: [{
        ...identity(installed),
        descriptorId: 'effect-fixture',
        fromDescriptorVersion: 1,
        canonicalParameterJson: '{"strength":0.5}',
        hasAnimatedParameters: false,
      }],
    }
    const action = await controller.preflightDescriptorMigrationAction(request)
    const applying = action.applyTarget({ targetIndex: 0, requestId: 30 })
    await migrationStarted

    await expect(action.close('caller-finally'))
      .rejects.toThrow('sandbox close failed after terminal cleanup')
    await expect(applying).resolves.toMatchObject({ status: 'failed' })
    expect(controller.getSnapshot()).toMatchObject({
      activeCallCount: 0,
      queuedCallCount: 0,
      liveOwnerCount: 0,
      residentRuntimeCount: 0,
    })
    expect(sandbox.closeReasons).toEqual(['caller-finally'])

    const retry = await controller.preflightDescriptorMigrationAction(request)
    await retry.close('retry-not-committed')
  })

  test('rejects a changed migration identity before bytes and retries from fresh preflight', async () => {
    const original = bundle()
    const changed = bundle(original.pluginId, { catalogGeneration: original.catalogGeneration + 1 })
    const installed = new Map<string, VerifiedPluginActivationBundle>([[original.pluginId, original]])
    const resolver = resolverFor(installed)
    const sandbox = sandboxHarness({
      migrate: async () => new TextEncoder().encode('{"strength":0.75}'),
    })
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const request = {
      targets: [{
        ...identity(original),
        descriptorId: 'effect-fixture',
        fromDescriptorVersion: 1,
        canonicalParameterJson: '{"strength":0.5}',
        hasAnimatedParameters: false,
      }],
    }
    const staleAction = await controller.preflightDescriptorMigrationAction(request)
    installed.set(original.pluginId, changed)

    await expect(staleAction.applyTarget({ targetIndex: 0, requestId: 20 }))
      .resolves.toMatchObject({ status: 'failed', failure: { code: 'stale-plan' } })
    expect(original.copyCount()).toBe(0)
    expect(changed.copyCount()).toBe(0)
    expect(sandbox.activations).toHaveLength(0)

    installed.set(original.pluginId, original)
    const retry = await controller.preflightDescriptorMigrationAction(request)
    await expect(retry.applyTarget({ targetIndex: 0, requestId: 21 }))
      .resolves.toMatchObject({ status: 'migrated', descriptorVersion: 2 })
    expect(sandbox.activations).toHaveLength(1)
    expect(resolver.calls).toHaveLength(4)
    await retry.close('retry-committed')
  })

  test('fails migration reservation when export pins consume all runtime capacity', async () => {
    const exports = Array.from({ length: 8 }, (_, index) => bundle(`com.example.export-${index}`))
    const migrating = bundle('com.example.migrating')
    const resolver = resolverFor(new Map(
      [...exports, migrating].map((value) => [value.pluginId, value]),
    ))
    const sandbox = sandboxHarness()
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandbox.controller,
    })
    const exportSession = await controller.preflightExport({
      requiredEffects: exports.map((value) => exportRequirement(value)),
    })

    await expect(controller.preflightDescriptorMigrationAction({
      targets: [{
        ...identity(migrating),
        descriptorId: 'migration-effect',
        fromDescriptorVersion: 1,
        canonicalParameterJson: '{"strength":0.5}',
        hasAnimatedParameters: false,
      }],
    })).rejects.toMatchObject({ failure: { code: 'busy' } })
    expect(migrating.copyCount()).toBe(0)
    expect(sandbox.activations).toHaveLength(8)
    await exportSession.close('export-complete')
  })

  test('rejects animated descriptor migration before bundle resolution', async () => {
    const installed = bundle()
    const resolver = resolverFor(new Map([[installed.pluginId, installed]]))
    const controller = createPluginRuntimeController({
      activationBundleResolver: resolver,
      sandboxController: sandboxHarness().controller,
    })

    await expect(controller.openDescriptorMigrationChain({
      ...identity(installed),
      fromDescriptorVersion: 1,
      canonicalParameterJson: '{"strength":0.5}',
      hasAnimatedParameters: true,
    })).rejects.toMatchObject({ failure: { code: 'invalid-input' } })
    expect(resolver.calls).toHaveLength(0)
  })
})
