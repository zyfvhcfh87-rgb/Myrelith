import { afterEach, describe, expect, test, vi } from 'vitest'
import { PLUGIN_WASM_BINARY_POLICY_VERSION } from '../domain/pluginWasmPolicy'
import {
  createPluginCandidateWorkerSource,
  installPluginCandidateWorker,
} from './plugin-candidate.worker'
import {
  PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS,
  PLUGIN_WASM_OPCODE_TABLE_DIGESTS,
} from './plugin-wasm/policyTables'
import { createPluginWasmPolicyParser } from './plugin-wasm/moduleParser'
import type { PluginWasmModuleExpectations } from './plugin-wasm/moduleParser'

const MINIMAL_RENDER_MODULE_HEX = '0061736d01000000010f01600a7f7f7f7f7f7f7f7f7f7f017f021701086d7972656c697468066d656d6f727902018202820203020100071b01176d7972656c6974685f6566666563745f6669787475726500000a0601040041000b'

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    { length: value.length / 2 },
    (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}

function u32(value: number): number[] {
  const bytes: number[] = []
  do {
    const payload = value & 0x7f
    value >>>= 7
    bytes.push(value === 0 ? payload : payload | 0x80)
  } while (value !== 0)
  return bytes
}

function moduleWithDefinedFunctions(count: number): Uint8Array {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const functionPayload = [...u32(count), ...Array<number>(count).fill(0)]
  const codePayload = [
    ...u32(count),
    ...Array.from({ length: count }, () => [0x04, 0x00, 0x41, 0x00, 0x0b]).flat(),
  ]
  return Uint8Array.from([
    ...original.subarray(0, 50),
    0x03,
    ...u32(functionPayload.length),
    ...functionPayload,
    ...original.subarray(54, 83),
    0x0a,
    ...u32(codePayload.length),
    ...codePayload,
  ])
}

function expectations(): PluginWasmModuleExpectations {
  return {
    policy: {
      binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
      profileId: 'myrelith-wasm-render-general-v1' as const,
    },
    memoryMaximumPages: 258,
    renderEntrypoints: ['myrelith_effect_fixture'],
    migrationEntrypoints: [],
  }
}

function policyParser() {
  return createPluginWasmPolicyParser({
    binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
    opcodeTables: PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS,
    opcodeTableDigests: PLUGIN_WASM_OPCODE_TABLE_DIGESTS,
  })
}

/** The shipped installer on a fake scope, connected over a real MessageChannel. */
function connectedCandidate(parse: ReturnType<typeof policyParser> = policyParser()) {
  const scope = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    close: vi.fn(),
  }
  installPluginCandidateWorker(scope, parse, {
    marker: 'test',
    protocolVersion: 1,
    parameterPointer: 0x01000000,
    pixelPointer: 0x01010000,
    ioPageBytes: 65_536,
  })
  const channel = new MessageChannel()
  scope.onmessage?.({
    data: { protocolVersion: 1, kind: 'connect', generation: 7, port: channel.port2 },
  } as MessageEvent<unknown>)
  const activate = (moduleBytes: Uint8Array): Promise<Record<string, unknown>> => (
    new Promise((resolve) => {
      channel.port1.onmessage = (event): void => resolve(event.data as Record<string, unknown>)
      channel.port1.start()
      channel.port1.postMessage({
        protocolVersion: 1,
        kind: 'activate',
        generation: 7,
        requestId: 1,
        moduleBytes: moduleBytes.buffer,
        expectations: {
          ...expectations(),
          opcodeTableDigest: PLUGIN_WASM_OPCODE_TABLE_DIGESTS['myrelith-wasm-render-general-v1'],
        },
      }, [moduleBytes.buffer])
    })
  )
  return {
    scope,
    activate,
    dispose: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

function spyOnEngine() {
  return {
    validate: vi.spyOn(WebAssembly, 'validate'),
    compile: vi.spyOn(WebAssembly, 'compile'),
    instantiate: vi.spyOn(WebAssembly, 'instantiate'),
  }
}

function activationFailure(message: string) {
  return {
    kind: 'failure',
    generation: 7,
    requestId: 1,
    failure: { code: 'activation-failed', message, terminal: true },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('plugin candidate worker', () => {
  test('rejects malformed bytes before every WebAssembly engine API', async () => {
    const engine = spyOnEngine()
    const candidate = connectedCandidate()
    try {
      await expect(candidate.activate(Uint8Array.of(0)))
        .resolves.toMatchObject(activationFailure('Unexpected end of WebAssembly bytes.'))
      expect(engine.validate).not.toHaveBeenCalled()
      expect(engine.compile).not.toHaveBeenCalled()
      expect(engine.instantiate).not.toHaveBeenCalled()
      expect(candidate.scope.close).toHaveBeenCalledOnce()
    } finally {
      candidate.dispose()
    }
  })

  test('rejects 8,193 defined functions before every WebAssembly engine API', async () => {
    const engine = spyOnEngine()
    const candidate = connectedCandidate()
    try {
      await expect(candidate.activate(moduleWithDefinedFunctions(8_193)))
        .resolves.toMatchObject(activationFailure('WebAssembly function count exceeds 8192.'))
      expect(engine.validate).not.toHaveBeenCalled()
      expect(engine.compile).not.toHaveBeenCalled()
      expect(engine.instantiate).not.toHaveBeenCalled()
    } finally {
      candidate.dispose()
    }
  })

  test('promotes a parsed candidate only after the complete engine sequence', async () => {
    const engine = spyOnEngine()
    const candidate = connectedCandidate()
    try {
      await expect(candidate.activate(hexBytes(MINIMAL_RENDER_MODULE_HEX))).resolves.toMatchObject({
        kind: 'ready',
        facts: {
          definedFunctionCount: 1,
          exportedFunctions: ['myrelith_effect_fixture'],
        },
      })
      const [validated] = engine.validate.mock.invocationCallOrder
      const [compiled] = engine.compile.mock.invocationCallOrder
      const [instantiated] = engine.instantiate.mock.invocationCallOrder
      expect(validated).toBeLessThan(compiled)
      expect(compiled).toBeLessThan(instantiated)
      const imports = engine.instantiate.mock.calls[0]![1] as {
        myrelith: { memory: WebAssembly.Memory }
      }
      expect(imports.myrelith.memory).toBeInstanceOf(WebAssembly.Memory)
      expect(imports.myrelith.memory.buffer.byteLength).toBe(258 * 65_536)
    } finally {
      candidate.dispose()
    }
  })

  test('uses one candidate-owned byte snapshot for policy and every engine phase', async () => {
    const engine = spyOnEngine()
    const parse = vi.fn(policyParser())
    const candidate = connectedCandidate(parse)
    try {
      await expect(candidate.activate(hexBytes(MINIMAL_RENDER_MODULE_HEX)))
        .resolves.toMatchObject({ kind: 'ready' })
      const parsedBytes = parse.mock.calls[0]![0]
      expect(engine.validate.mock.calls[0]![0]).toBe(parsedBytes)
      expect(engine.compile.mock.calls[0]![0]).toBe(parsedBytes)
      // The snapshot is cleared once activation settles.
      expect(parsedBytes.every((byte) => byte === 0)).toBe(true)
    } finally {
      candidate.dispose()
    }
  })

  test('stops activation when engine validation rejects policy-valid bytes', async () => {
    const engine = spyOnEngine()
    engine.validate.mockReturnValue(false)
    const candidate = connectedCandidate()
    try {
      await expect(candidate.activate(hexBytes(MINIMAL_RENDER_MODULE_HEX)))
        .resolves.toMatchObject(activationFailure('Policy-valid module failed engine validation.'))
      expect(engine.compile).not.toHaveBeenCalled()
      expect(engine.instantiate).not.toHaveBeenCalled()
      expect(candidate.scope.close).toHaveBeenCalledOnce()
    } finally {
      candidate.dispose()
    }
  })

  test('emits self-contained blob-worker source with the production marker', () => {
    const source = createPluginCandidateWorkerSource()

    expect(source).toContain('MYRELITH_PLUGIN_CANDIDATE_WORKER_V1')
    expect(source).not.toMatch(/\bimport\s*(?:\(|["'{*])/)
    expect(source).not.toContain('http://')
    expect(source).not.toContain('https://')
    expect(() => new Function('self', source)).not.toThrow()
  })

  test('activates the emitted worker source over a real MessageChannel', async () => {
    const scope = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      close: vi.fn(),
    }
    const source = createPluginCandidateWorkerSource()
    const executeWorkerSource = new Function('self', source) as (workerScope: typeof scope) => void
    executeWorkerSource(scope)
    expect(scope.onmessage).toBeTypeOf('function')

    const channel = new MessageChannel()
    const receive = (): Promise<Record<string, unknown>> => new Promise((resolve) => {
      channel.port1.onmessage = (event): void => resolve(event.data as Record<string, unknown>)
      channel.port1.start()
    })

    try {
      scope.onmessage?.({
        data: { protocolVersion: 1, kind: 'connect', generation: 11, port: channel.port2 },
      } as MessageEvent<unknown>)

      const moduleBytes = hexBytes(MINIMAL_RENDER_MODULE_HEX)
      const activationResponse = receive()
      channel.port1.postMessage({
        protocolVersion: 1,
        kind: 'activate',
        generation: 11,
        requestId: 1,
        moduleBytes: moduleBytes.buffer,
        expectations: {
          ...expectations(),
          opcodeTableDigest: PLUGIN_WASM_OPCODE_TABLE_DIGESTS['myrelith-wasm-render-general-v1'],
        },
      }, [moduleBytes.buffer])

      await expect(activationResponse).resolves.toMatchObject({
        kind: 'ready',
        generation: 11,
        requestId: 1,
      })

      const closeResponse = receive()
      channel.port1.postMessage({
        protocolVersion: 1,
        kind: 'close',
        generation: 11,
        requestId: 2,
        reason: 'emitted-source-test-complete',
      })
      await expect(closeResponse).resolves.toMatchObject({
        kind: 'closed',
        generation: 11,
        requestId: 2,
      })
      expect(scope.close).toHaveBeenCalledOnce()
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  test('promotes and renders on the same private worker port with exact-length output', async () => {
    const parser = createPluginWasmPolicyParser({
      binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
      opcodeTables: PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS,
      opcodeTableDigests: PLUGIN_WASM_OPCODE_TABLE_DIGESTS,
    })
    let closed = false
    const scope = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      close: vi.fn(() => { closed = true }),
    }
    installPluginCandidateWorker(scope, parser, {
      marker: 'test',
      protocolVersion: 1,
      parameterPointer: 0x01000000,
      pixelPointer: 0x01010000,
      ioPageBytes: 65_536,
    })
    const channel = new MessageChannel()
    const receive = (): Promise<Record<string, unknown>> => new Promise((resolve) => {
      channel.port1.onmessage = (event): void => resolve(event.data as Record<string, unknown>)
      channel.port1.start()
    })
    scope.onmessage?.({
      data: { protocolVersion: 1, kind: 'connect', generation: 7, port: channel.port2 },
    } as MessageEvent<unknown>)

    const moduleBytes = hexBytes(MINIMAL_RENDER_MODULE_HEX)
    const activationResponse = receive()
    channel.port1.postMessage({
      protocolVersion: 1,
      kind: 'activate',
      generation: 7,
      requestId: 1,
      moduleBytes: moduleBytes.buffer,
      expectations: {
        ...expectations(),
        opcodeTableDigest: PLUGIN_WASM_OPCODE_TABLE_DIGESTS['myrelith-wasm-render-general-v1'],
      },
    }, [moduleBytes.buffer])
    const activation = await activationResponse
    expect(activation).toMatchObject({
      kind: 'ready',
      generation: 7,
      requestId: 1,
    })

    const rgbaBytes = Uint8Array.of(2, 3, 5, 7)
    const parameterBytes = new TextEncoder().encode('{}')
    const renderResponse = receive()
    channel.port1.postMessage({
      protocolVersion: 1,
      kind: 'render',
      generation: 7,
      requestId: 2,
      entrypoint: 'myrelith_effect_fixture',
      width: 1,
      height: 1,
      stride: 4,
      timelineFrame: Number.MAX_SAFE_INTEGER,
      frameRateNumerator: 30_000,
      frameRateDenominator: 1_001,
      canonicalParameterBytes: parameterBytes.buffer,
      rgbaBytes: rgbaBytes.buffer,
    }, [parameterBytes.buffer, rgbaBytes.buffer])
    const rendered = await renderResponse
    expect(rendered).toMatchObject({ kind: 'rendered', generation: 7, requestId: 2, identity: false })
    expect([...new Uint8Array(rendered.rgbaBytes as ArrayBuffer)]).toEqual([2, 3, 5, 7])

    const closeResponse = receive()
    channel.port1.postMessage({
      protocolVersion: 1,
      kind: 'close',
      generation: 7,
      requestId: 3,
      reason: 'test-complete',
    })
    await expect(closeResponse).resolves.toMatchObject({ kind: 'closed', requestId: 3 })
    expect(closed).toBe(true)
    channel.port1.close()
  })
})
