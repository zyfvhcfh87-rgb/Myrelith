import { describe, expect, test } from 'vitest'
import { PLUGIN_WASM_BINARY_POLICY_VERSION } from '../../domain/pluginWasmPolicy'
import { parsePluginWasmModule } from './moduleParser'

const MINIMAL_RENDER_MODULE_HEX = '0061736d01000000010f01600a7f7f7f7f7f7f7f7f7f7f017f021701086d7972656c697468066d656d6f727902018202820203020100071b01176d7972656c6974685f6566666563745f6669787475726500000a0601040041000b'

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    { length: value.length / 2 },
    (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}

function moduleWithHiddenInvalidTypeIndex(): Uint8Array {
  return hexBytes(MINIMAL_RENDER_MODULE_HEX
    .replace('03020100', '0303020001')
    .replace('0a0601040041000b', '0a0b02040041000b040041000b'))
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

function moduleWithTypeCount(count: number): Uint8Array {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const renderType = [0x60, 0x0a, ...Array<number>(10).fill(0x7f), 0x01, 0x7f]
  const extraTypes = Array.from({ length: count - 1 }, () => [0x60, 0x00, 0x00]).flat()
  const payload = [...u32(count), ...renderType, ...extraTypes]
  return Uint8Array.from([
    ...original.subarray(0, 8),
    0x01,
    ...u32(payload.length),
    ...payload,
    ...original.subarray(25),
  ])
}

function moduleWithPrimaryType(parameterCount: number, resultCount: number): Uint8Array {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const payload = [
    0x01,
    0x60,
    ...u32(parameterCount),
    ...Array<number>(parameterCount).fill(0x7f),
    ...u32(resultCount),
    ...Array<number>(resultCount).fill(0x7f),
  ]
  return Uint8Array.from([
    ...original.subarray(0, 8),
    0x01,
    ...u32(payload.length),
    ...payload,
    ...original.subarray(25),
  ])
}

describe('plugin WebAssembly module policy', () => {
  test('accepts the canonical minimal render module tracer', () => {
    expect(parsePluginWasmModule(hexBytes(MINIMAL_RENDER_MODULE_HEX), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toEqual({
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      importedMemory: {
        minimumPages: 258,
        maximumPages: 258,
      },
      definedFunctionCount: 1,
      exportedFunctions: ['myrelith_effect_fixture'],
    })
  })

  test('rejects an unknown binary-policy version', () => {
    expect(() => parsePluginWasmModule(hexBytes(MINIMAL_RENDER_MODULE_HEX), {
      policy: {
        binaryPolicyVersion: 2 as typeof PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('Unsupported WebAssembly binary-policy version.')
  })

  test('rejects an unexported function with an out-of-range type index', () => {
    expect(() => parsePluginWasmModule(moduleWithHiddenInvalidTypeIndex(), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('Defined function 1 references missing type 1.')
  })

  test('rejects a type count above the version-one ceiling', () => {
    expect(() => parsePluginWasmModule(moduleWithTypeCount(1_025), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('WebAssembly type count exceeds 1024.')
  })

  test('rejects a function type with more than 128 parameters', () => {
    expect(() => parsePluginWasmModule(moduleWithPrimaryType(129, 1), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('WebAssembly function parameter count exceeds 128.')
  })

  test('rejects a function type with more than 16 results', () => {
    expect(() => parsePluginWasmModule(moduleWithPrimaryType(10, 17), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('WebAssembly function result count exceeds 16.')
  })
})
