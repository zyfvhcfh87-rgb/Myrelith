import { describe, expect, test, vi } from 'vitest'
import { PLUGIN_WASM_BINARY_POLICY_VERSION } from '../domain/pluginWasmPolicy'
import { PLUGIN_WASM_OPCODE_TABLE_DIGESTS } from '../workers/plugin-wasm/policyTables'
import {
  PLUGIN_ACTIVATION_DEADLINE_MS,
  PluginSandboxError,
  configurePluginSandboxIframe,
  createPluginSandboxBrokerSrcdoc,
  createPluginSandboxController,
  type PluginSandboxBroker,
  type PluginSandboxBrokerFactory,
  type PluginSandboxActivationRequest,
  type PluginSandboxMigrationRequest,
  type PluginSandboxRenderRequest,
} from './pluginSandboxController'
import type { PluginSandboxLifecycleSnapshot } from './pluginRuntimeLifecycleObserver'

const MINIMAL_RENDER_MODULE_HEX = '0061736d01000000010f01600a7f7f7f7f7f7f7f7f7f7f017f021701086d7972656c697468066d656d6f727902018202820203020100071b01176d7972656c6974685f6566666563745f6669787475726500000a0601040041000b'

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    { length: value.length / 2 },
    (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}

function activation(): PluginSandboxActivationRequest {
  return {
    moduleBytes: hexBytes(MINIMAL_RENDER_MODULE_HEX),
    expectations: {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1' as const,
      },
      opcodeTableDigest: PLUGIN_WASM_OPCODE_TABLE_DIGESTS['myrelith-wasm-render-general-v1'],
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    },
  }
}

function renderRequest(): PluginSandboxRenderRequest {
  return {
    entrypoint: 'myrelith_effect_fixture',
    width: 1,
    height: 1,
    stride: 4,
    timelineFrame: 0,
    frameRateNumerator: 30,
    frameRateDenominator: 1,
    canonicalParameterBytes: Uint8Array.of(0x7b, 0x7d),
    rgbaBytes: Uint8Array.of(1, 2, 3, 4),
  }
}

function migrationRequest(): PluginSandboxMigrationRequest {
  return {
    entrypoint: 'myrelith_migrate_fixture',
    fromVersion: 1,
    toVersion: 2,
    canonicalInputBytes: Uint8Array.of(7, 11, 13),
  }
}

function expectZeroedViews(
  views: readonly Uint8Array[],
  expectedByteLengths: readonly number[],
): void {
  expect(views.map((view) => view.byteLength)).toEqual(expectedByteLengths)
  for (const view of views) {
    expect([...view]).toEqual(Array.from({ length: view.byteLength }, () => 0))
  }
}

function scriptedBrokerFactory(options: {
  readonly ignoreRender?: boolean
  readonly renderResponse?: (
    response: Record<string, unknown>,
  ) => Record<string, unknown>
} = {}): {
  readonly factory: PluginSandboxBrokerFactory
  readonly terminate: ReturnType<typeof vi.fn>
  readonly postLateRender: () => void
} {
  const terminate = vi.fn()
  let latePort: MessagePort | undefined
  let lateResponse: Record<string, unknown> | undefined
  return {
    terminate,
    postLateRender() {
      if (latePort && lateResponse) latePort.postMessage(lateResponse)
      latePort?.close()
      latePort = undefined
    },
    factory: async ({ generation }): Promise<PluginSandboxBroker> => {
      const channel = new MessageChannel()
      channel.port2.onmessage = (event): void => {
        const request = event.data as Record<string, unknown>
        if (request.kind === 'activate') {
          channel.port2.postMessage({
            protocolVersion: 1,
            kind: 'ready',
            generation,
            requestId: request.requestId,
            facts: {
              policy: activation().expectations.policy,
              opcodeTableDigest: activation().expectations.opcodeTableDigest,
              importedMemory: { minimumPages: 258, maximumPages: 258 },
              definedFunctionCount: 1,
              tableCount: 0,
              elementSegmentCount: 0,
              dataSegmentCount: 0,
              exportedFunctions: ['myrelith_effect_fixture'],
            },
          })
        } else if (request.kind === 'render' && !options.ignoreRender) {
          const baseResponse: Record<string, unknown> = {
            protocolVersion: 1,
            kind: 'rendered',
            generation,
            requestId: request.requestId,
            identity: false,
            rgbaBytes: request.rgbaBytes,
          }
          const response = options.renderResponse?.(baseResponse) ?? baseResponse
          const transfer = response.rgbaBytes instanceof ArrayBuffer
            ? [response.rgbaBytes]
            : []
          channel.port2.postMessage(response, transfer)
        } else if (request.kind === 'render') {
          latePort = channel.port2
          lateResponse = {
            protocolVersion: 1,
            kind: 'rendered',
            generation,
            requestId: request.requestId,
            identity: false,
            rgbaBytes: request.rgbaBytes,
          }
        } else if (request.kind === 'close') {
          channel.port2.postMessage({
            protocolVersion: 1,
            kind: 'closed',
            generation,
            requestId: request.requestId,
          })
        }
      }
      channel.port2.start()
      return {
        runtimePort: channel.port1,
        setFatalHandler() {},
        terminate(reason) {
          terminate(reason)
          channel.port1.close()
          if (!options.ignoreRender) channel.port2.close()
        },
      }
    },
  }
}

describe('plugin sandbox controller', () => {
  test('builds an exact allow-scripts opaque srcdoc with a blob-only worker path', () => {
    const iframe = document.createElement('iframe')
    configurePluginSandboxIframe(iframe, 'abc123', 'self.close()')

    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.srcdoc).toBe(createPluginSandboxBrokerSrcdoc('abc123', 'self.close()'))
    expect(iframe.srcdoc).toContain("worker-src blob:")
    expect(iframe.srcdoc).toContain("connect-src 'none'")
    expect(iframe.srcdoc).toContain('MYRELITH_PLUGIN_SANDBOX_BROKER_V1')
    expect(iframe.srcdoc).toContain("kind:'worker-created'")
    expect(iframe.srcdoc).not.toMatch(/https?:\/\//)
  })

  test('dispatches owned bytes and returns an exact-length render response', async () => {
    const harness = scriptedBrokerFactory()
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())
    const input = Uint8Array.of(11, 13, 17, 19)

    const result = await session.render({
      entrypoint: 'myrelith_effect_fixture',
      width: 1,
      height: 1,
      stride: 4,
      timelineFrame: 9,
      frameRateNumerator: 24,
      frameRateDenominator: 1,
      canonicalParameterBytes: new TextEncoder().encode('{}'),
      rgbaBytes: input,
    }, 100)

    expect([...result.rgbaBytes]).toEqual([11, 13, 17, 19])
    expect(input.byteLength).toBe(4)
    await session.close('test-complete')
    expect(harness.terminate).toHaveBeenCalledOnce()
  })

  test('starts the activation deadline before broker creation', async () => {
    const harness = scriptedBrokerFactory()
    const now = vi.fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(10 + PLUGIN_ACTIVATION_DEADLINE_MS + 1)
    const controller = createPluginSandboxController({ brokerFactory: harness.factory, now })
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill')

    try {
      await expect(controller.activate(activation())).rejects.toMatchObject({
        failure: { code: 'timeout', terminal: true },
      })
      expect(harness.terminate).toHaveBeenCalledOnce()
      const zeroedViews = fillSpy.mock.instances
        .filter((view, index): view is Uint8Array => (
          view instanceof Uint8Array && fillSpy.mock.calls[index]?.[0] === 0
        ))
      expectZeroedViews(zeroedViews, [activation().moduleBytes.byteLength])
    } finally {
      fillSpy.mockRestore()
    }
  })

  test('cancellation before candidate creation does not call the broker factory', async () => {
    const factory = vi.fn<PluginSandboxBrokerFactory>()
    const controller = createPluginSandboxController({ brokerFactory: factory })
    const abort = new AbortController()
    abort.abort()

    await expect(controller.activate(activation(), abort.signal)).rejects.toBeInstanceOf(PluginSandboxError)
    expect(factory).not.toHaveBeenCalled()
  })

  test('a call watchdog terminally tears down the broker and ignores late work', async () => {
    const harness = scriptedBrokerFactory({ ignoreRender: true })
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())

    await expect(session.render({
      entrypoint: 'myrelith_effect_fixture',
      width: 1,
      height: 1,
      stride: 4,
      timelineFrame: 0,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      canonicalParameterBytes: new TextEncoder().encode('{}'),
      rgbaBytes: Uint8Array.of(1, 2, 3, 4),
    }, 5)).rejects.toMatchObject({ failure: { code: 'timeout', terminal: true } })

    expect(harness.terminate).toHaveBeenCalledTimes(1)
    await expect(session.render({
      entrypoint: 'myrelith_effect_fixture',
      width: 1,
      height: 1,
      stride: 4,
      timelineFrame: 1,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      canonicalParameterBytes: new TextEncoder().encode('{}'),
      rgbaBytes: Uint8Array.of(4, 3, 2, 1),
    }, 5)).rejects.toMatchObject({ failure: { code: 'closed' } })
  })

  test('clears attached render and migration copies when the session is closed', async () => {
    const harness = scriptedBrokerFactory()
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())
    controller.teardown('closed-before-dispatch')
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill')

    try {
      await expect(session.render(renderRequest(), 100)).rejects.toMatchObject({
        failure: { code: 'closed' },
      })
      await expect(session.migrate(migrationRequest())).rejects.toMatchObject({
        failure: { code: 'closed' },
      })
      const zeroedViews = fillSpy.mock.instances
        .filter((view, index): view is Uint8Array => (
          view instanceof Uint8Array && fillSpy.mock.calls[index]?.[0] === 0
        ))
      expectZeroedViews(zeroedViews, [2, 4, 3])
    } finally {
      fillSpy.mockRestore()
    }
  })

  test('clears attached render and migration copies when another call is busy', async () => {
    const harness = scriptedBrokerFactory({ ignoreRender: true })
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())
    const pendingRender = session.render(renderRequest(), 10_000).catch((cause: unknown) => cause)
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill')

    try {
      await expect(session.render(renderRequest(), 100)).rejects.toMatchObject({
        failure: { code: 'busy' },
      })
      await expect(session.migrate(migrationRequest())).rejects.toMatchObject({
        failure: { code: 'busy' },
      })
      const zeroedViews = fillSpy.mock.instances
        .filter((view, index): view is Uint8Array => (
          view instanceof Uint8Array && fillSpy.mock.calls[index]?.[0] === 0
        ))
      expectZeroedViews(zeroedViews, [2, 4, 3])
    } finally {
      fillSpy.mockRestore()
      controller.teardown('busy-test-complete')
      expect(await pendingRender).toMatchObject({ failure: { code: 'closed' } })
      harness.postLateRender()
    }
  })

  test('clears attached render copies for a pre-aborted request', async () => {
    const harness = scriptedBrokerFactory()
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())
    const abort = new AbortController()
    abort.abort()
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill')

    try {
      await expect(session.render(renderRequest(), 100, abort.signal)).rejects.toMatchObject({
        failure: { code: 'aborted' },
      })
      const zeroedViews = fillSpy.mock.instances
        .filter((view, index): view is Uint8Array => (
          view instanceof Uint8Array && fillSpy.mock.calls[index]?.[0] === 0
        ))
      expectZeroedViews(zeroedViews, [2, 4])
    } finally {
      fillSpy.mockRestore()
    }
  })

  test('clears the attached migration copy for a pre-aborted request', async () => {
    const harness = scriptedBrokerFactory()
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())
    const abort = new AbortController()
    abort.abort()
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill')

    try {
      await expect(session.migrate(migrationRequest(), abort.signal)).rejects.toMatchObject({
        failure: { code: 'aborted' },
      })
      const zeroedViews = fillSpy.mock.instances
        .filter((view, index): view is Uint8Array => (
          view instanceof Uint8Array && fillSpy.mock.calls[index]?.[0] === 0
        ))
      expectZeroedViews(zeroedViews, [3])
    } finally {
      fillSpy.mockRestore()
    }
  })

  test.each([
    ['extra success key', (base: Record<string, unknown>) => ({ ...base, extra: true })],
    ['non-boolean identity', (base: Record<string, unknown>) => ({ ...base, identity: 'false' })],
    ['unknown failure code', (base: Record<string, unknown>) => ({
      protocolVersion: base.protocolVersion,
      kind: 'failure',
      generation: base.generation,
      requestId: base.requestId,
      failure: { code: 'not-a-code', message: 'bad', terminal: true },
    })],
    ['oversized failure message', (base: Record<string, unknown>) => ({
      protocolVersion: base.protocolVersion,
      kind: 'failure',
      generation: base.generation,
      requestId: base.requestId,
      failure: { code: 'plugin-failure', message: 'x'.repeat(513), terminal: true },
    })],
    ['out-of-range plugin code', (base: Record<string, unknown>) => ({
      protocolVersion: base.protocolVersion,
      kind: 'failure',
      generation: base.generation,
      requestId: base.requestId,
      failure: {
        code: 'plugin-failure',
        message: 'bad',
        terminal: true,
        pluginCode: 0x8000_0000,
      },
    })],
  ] as const)('terminally rejects a malformed %s response', async (_label, transform) => {
    const harness = scriptedBrokerFactory({ renderResponse: transform })
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())

    await expect(session.render({
      entrypoint: 'myrelith_effect_fixture',
      width: 1,
      height: 1,
      stride: 4,
      timelineFrame: 0,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      canonicalParameterBytes: new TextEncoder().encode('{}'),
      rgbaBytes: Uint8Array.of(1, 2, 3, 4),
    }, 100)).rejects.toMatchObject({ failure: { code: 'invalid-envelope', terminal: true } })

    expect(harness.terminate).toHaveBeenCalledOnce()
  })

  test('direct teardown settles a pending call and ignores a late worker reply', async () => {
    const harness = scriptedBrokerFactory({ ignoreRender: true })
    const controller = createPluginSandboxController({ brokerFactory: harness.factory })
    const session = await controller.activate(activation())
    const pending = session.render({
      entrypoint: 'myrelith_effect_fixture',
      width: 1,
      height: 1,
      stride: 4,
      timelineFrame: 0,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      canonicalParameterBytes: new TextEncoder().encode('{}'),
      rgbaBytes: Uint8Array.of(1, 2, 3, 4),
    }, 10_000)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    controller.teardown('direct-test-teardown')

    await expect(pending).rejects.toMatchObject({ failure: { code: 'closed', terminal: true } })
    harness.postLateRender()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(harness.terminate).toHaveBeenCalledOnce()
    await expect(session.render({
      entrypoint: 'myrelith_effect_fixture',
      width: 1,
      height: 1,
      stride: 4,
      timelineFrame: 1,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      canonicalParameterBytes: new TextEncoder().encode('{}'),
      rgbaBytes: Uint8Array.of(4, 3, 2, 1),
    }, 5)).rejects.toMatchObject({ failure: { code: 'closed' } })
  })

  test('reports every sandbox owner transition and one terminal all-zero snapshot', async () => {
    const harness = scriptedBrokerFactory({ ignoreRender: true })
    const snapshots: PluginSandboxLifecycleSnapshot[] = []
    const controller = createPluginSandboxController({
      brokerFactory: harness.factory,
      lifecycleObserver: {
        onSandboxSnapshot(snapshot) {
          snapshots.push(snapshot)
        },
        onRuntimeSnapshot() {},
      },
    })

    expect(snapshots.at(-1)).toEqual({
      brokerIframeCount: 0,
      candidateWorkerCount: 0,
      privatePortCount: 0,
      watchdogCount: 0,
      pendingActivationCount: 0,
      pendingRequestCount: 0,
      sessionCount: 0,
      terminal: false,
    })
    const session = await controller.activate(activation())
    expect(snapshots.some((snapshot) => (
      snapshot.pendingActivationCount === 1 && snapshot.watchdogCount === 1
    ))).toBe(true)
    expect(snapshots.at(-1)).toMatchObject({
      brokerIframeCount: 1,
      candidateWorkerCount: 1,
      privatePortCount: 2,
      watchdogCount: 0,
      pendingActivationCount: 0,
      pendingRequestCount: 0,
      sessionCount: 1,
      terminal: false,
    })

    const pending = session.render(renderRequest(), 10_000).catch((cause: unknown) => cause)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(snapshots.at(-1)).toMatchObject({
      watchdogCount: 1,
      pendingRequestCount: 1,
      sessionCount: 1,
      terminal: false,
    })

    await controller.teardown('observer-terminal')
    expect(await pending).toMatchObject({ failure: { code: 'closed' } })
    const terminal = snapshots.filter((snapshot) => snapshot.terminal)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toEqual({
      brokerIframeCount: 0,
      candidateWorkerCount: 0,
      privatePortCount: 0,
      watchdogCount: 0,
      pendingActivationCount: 0,
      pendingRequestCount: 0,
      sessionCount: 0,
      terminal: true,
    })
    expect(snapshots.every((snapshot) => Object.isFrozen(snapshot))).toBe(true)
  })

  test('counts pending broker resources until a deferred handshake abort fully drains', async () => {
    const snapshots: PluginSandboxLifecycleSnapshot[] = []
    const factory: PluginSandboxBrokerFactory = ({ signal, reportOwnership }) => {
      reportOwnership?.({
        brokerIframeCount: 1,
        candidateWorkerCount: 1,
        privatePortCount: 2,
      })
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reportOwnership?.({
            brokerIframeCount: 0,
            candidateWorkerCount: 0,
            privatePortCount: 0,
          })
          reject(new PluginSandboxError({
            code: 'aborted',
            message: 'Plugin activation was cancelled.',
            terminal: true,
          }))
        }, { once: true })
      })
    }
    const controller = createPluginSandboxController({
      brokerFactory: factory,
      lifecycleObserver: {
        onSandboxSnapshot(snapshot) {
          snapshots.push(snapshot)
        },
        onRuntimeSnapshot() {},
      },
    })

    const pending = controller.activate(activation()).catch((cause: unknown) => cause)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(snapshots.some((snapshot) => (
      snapshot.brokerIframeCount === 1
        && snapshot.candidateWorkerCount === 1
        && snapshot.privatePortCount === 2
        && snapshot.pendingActivationCount === 1
        && snapshot.watchdogCount === 1
        && !snapshot.terminal
    ))).toBe(true)

    await controller.teardown('pending-broker-terminal')
    expect(await pending).toMatchObject({ failure: { code: 'aborted' } })
    const terminal = snapshots.filter((snapshot) => snapshot.terminal)
    expect(terminal).toEqual([{
      brokerIframeCount: 0,
      candidateWorkerCount: 0,
      privatePortCount: 0,
      watchdogCount: 0,
      pendingActivationCount: 0,
      pendingRequestCount: 0,
      sessionCount: 0,
      terminal: true,
    }])
    expect(snapshots.findIndex((snapshot) => snapshot.terminal)).toBe(snapshots.length - 1)
  })

  test('contains observer exceptions without changing sandbox outcomes or cleanup', async () => {
    const harness = scriptedBrokerFactory()
    const controller = createPluginSandboxController({
      brokerFactory: harness.factory,
      lifecycleObserver: {
        onSandboxSnapshot() {
          throw new Error('observer must be inert')
        },
        onRuntimeSnapshot() {},
      },
    })

    const session = await controller.activate(activation())
    await expect(session.render(renderRequest(), 100)).resolves.toMatchObject({
      identity: false,
    })
    await expect(controller.teardown('throwing-observer')).resolves.toBeUndefined()
    expect(harness.terminate).toHaveBeenCalledOnce()
  })
})
