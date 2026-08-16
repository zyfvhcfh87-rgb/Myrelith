import { describe, expect, test, vi } from 'vitest'
import { PLUGIN_WASM_BINARY_POLICY_VERSION } from '../domain/pluginWasmPolicy'
import {
  createPluginCandidateCore,
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

describe('plugin candidate worker core', () => {
  test('rejects malformed bytes before every WebAssembly engine API', async () => {
    const engine = {
      validate: vi.fn(() => true),
      compile: vi.fn(),
      createMemory: vi.fn(),
      instantiate: vi.fn(),
    }
    const core = createPluginCandidateCore(engine)

    await expect(core.activate({
      moduleBytes: Uint8Array.of(0),
      expectations: expectations(),
    })).rejects.toThrow('Unexpected end of WebAssembly bytes.')

    expect(engine.validate).not.toHaveBeenCalled()
    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.createMemory).not.toHaveBeenCalled()
    expect(engine.instantiate).not.toHaveBeenCalled()
  })

  test('rejects 8,193 defined functions before every WebAssembly engine API', async () => {
    const engine = {
      validate: vi.fn(() => true),
      compile: vi.fn(),
      createMemory: vi.fn(),
      instantiate: vi.fn(),
    }

    await expect(createPluginCandidateCore(engine).activate({
      moduleBytes: moduleWithDefinedFunctions(8_193),
      expectations: expectations(),
    })).rejects.toThrow('WebAssembly function count exceeds 8192.')

    expect(engine.validate).not.toHaveBeenCalled()
    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.createMemory).not.toHaveBeenCalled()
    expect(engine.instantiate).not.toHaveBeenCalled()
  })

  test('promotes a parsed candidate only after the complete engine sequence', async () => {
    const order: string[] = []
    const module = { kind: 'module' }
    const memory = { kind: 'memory' }
    const instance = { kind: 'instance' }
    const engine = {
      validate: vi.fn(() => {
        order.push('validate')
        return true
      }),
      compile: vi.fn(async () => {
        order.push('compile')
        return module
      }),
      createMemory: vi.fn(() => {
        order.push('memory')
        return memory
      }),
      instantiate: vi.fn(async () => {
        order.push('instantiate')
        return instance
      }),
    }
    const moduleBytes = hexBytes(MINIMAL_RENDER_MODULE_HEX)

    await expect(createPluginCandidateCore(engine).activate({
      moduleBytes,
      expectations: expectations(),
    })).resolves.toMatchObject({
      module,
      memory,
      instance,
      facts: {
        definedFunctionCount: 1,
        exportedFunctions: ['myrelith_effect_fixture'],
      },
    })

    expect(order).toEqual(['validate', 'compile', 'memory', 'instantiate'])
    expect(engine.validate).toHaveBeenCalledTimes(1)
    expect(engine.compile).toHaveBeenCalledTimes(1)
    expect(engine.createMemory).toHaveBeenCalledWith({ initial: 258, maximum: 258 })
    expect(engine.instantiate).toHaveBeenCalledWith(module, { myrelith: { memory } })
  })

  test('uses one candidate-owned byte snapshot for policy and every engine phase', async () => {
    const validBytes = hexBytes(MINIMAL_RENDER_MODULE_HEX)
    const substitutedBytes = hexBytes('0061736d01000000')
    let reads = 0
    const engine = {
      validate: vi.fn((_moduleBytes: Uint8Array) => true),
      compile: vi.fn(async (_moduleBytes: Uint8Array) => ({ kind: 'module' })),
      createMemory: vi.fn(() => ({ kind: 'memory' })),
      instantiate: vi.fn(async () => ({ kind: 'instance' })),
    }

    await expect(createPluginCandidateCore(engine).activate({
      get moduleBytes() {
        reads++
        return reads === 1 ? validBytes : substitutedBytes
      },
      expectations: expectations(),
    })).resolves.toMatchObject({
      facts: { exportedFunctions: ['myrelith_effect_fixture'] },
    })

    const validatedBytes = engine.validate.mock.calls[0]![0]
    const compiledBytes = engine.compile.mock.calls[0]![0]
    expect(reads).toBe(1)
    expect(validatedBytes).toBe(compiledBytes)
    expect(validatedBytes).not.toBe(validBytes)
    expect(validatedBytes.every((byte) => byte === 0)).toBe(true)
    expect(validBytes).toEqual(hexBytes(MINIMAL_RENDER_MODULE_HEX))
  })

  test('stops activation when engine validation rejects policy-valid bytes', async () => {
    const engine = {
      validate: vi.fn(() => false),
      compile: vi.fn(async () => ({ kind: 'module' })),
      createMemory: vi.fn(() => ({ kind: 'memory' })),
      instantiate: vi.fn(async () => ({ kind: 'instance' })),
    }

    await expect(createPluginCandidateCore(engine).activate({
      moduleBytes: hexBytes(MINIMAL_RENDER_MODULE_HEX),
      expectations: expectations(),
    })).rejects.toThrow('The policy-valid WebAssembly module failed engine validation.')

    expect(engine.compile).not.toHaveBeenCalled()
    expect(engine.createMemory).not.toHaveBeenCalled()
    expect(engine.instantiate).not.toHaveBeenCalled()
  })

  test('emits self-contained blob-worker source with the production marker', () => {
    const source = createPluginCandidateWorkerSource()

    expect(source).toContain('MYRELITH_PLUGIN_CANDIDATE_WORKER_V1')
    expect(source).not.toMatch(/\bimport\s*(?:\(|["'{*])/)
    expect(source).not.toContain('http://')
    expect(source).not.toContain('https://')
    expect(() => new Function('self', source)).not.toThrow()
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
