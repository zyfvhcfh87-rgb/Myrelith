import { describe, expect, test, vi } from 'vitest'
import { PLUGIN_WASM_BINARY_POLICY_VERSION } from '../domain/pluginWasmPolicy'
import { createPluginCandidateCore } from './plugin-candidate.worker'
import type { PluginWasmModuleExpectations } from './plugin-wasm/moduleParser'

const MINIMAL_RENDER_MODULE_HEX = '0061736d01000000010f01600a7f7f7f7f7f7f7f7f7f7f017f021701086d7972656c697468066d656d6f727902018202820203020100071b01176d7972656c6974685f6566666563745f6669787475726500000a0601040041000b'

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    { length: value.length / 2 },
    (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
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
    expect(engine.validate).toHaveBeenCalledWith(moduleBytes)
    expect(engine.compile).toHaveBeenCalledWith(moduleBytes)
    expect(engine.createMemory).toHaveBeenCalledWith({ initial: 258, maximum: 258 })
    expect(engine.instantiate).toHaveBeenCalledWith(module, { myrelith: { memory } })
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
})
