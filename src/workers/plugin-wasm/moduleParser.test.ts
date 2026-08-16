import { describe, expect, test } from 'vitest'
import { PLUGIN_WASM_BINARY_POLICY_VERSION } from '../../domain/pluginWasmPolicy'
import {
  parsePluginWasmModule,
  type PluginWasmModuleExpectations,
} from './moduleParser'
import { PLUGIN_WASM_OPCODE_TABLE_DIGESTS } from './policyTables'

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

function nameBytes(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)]
  return [...u32(bytes.length), ...bytes]
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...u32(payload.length), ...payload]
}

function pluginModule(options: {
  readonly parameterCount?: number
  readonly entrypoint?: string
  readonly instructions?: readonly number[]
  readonly memoryPages?: number
  readonly extraSectionsBeforeCode?: readonly number[]
  readonly extraSectionsAfterCode?: readonly number[]
} = {}): Uint8Array {
  const parameterCount = options.parameterCount ?? 10
  const entrypoint = options.entrypoint ?? 'myrelith_effect_fixture'
  const instructions = options.instructions ?? [0x41, 0x00]
  const memoryPages = options.memoryPages ?? 258
  const typePayload = [
    1,
    0x60,
    ...u32(parameterCount),
    ...Array<number>(parameterCount).fill(0x7f),
    1,
    0x7f,
  ]
  const importPayload = [
    1,
    ...nameBytes('myrelith'),
    ...nameBytes('memory'),
    0x02,
    0x01,
    ...u32(memoryPages),
    ...u32(memoryPages),
  ]
  const exportPayload = [1, ...nameBytes(entrypoint), 0x00, 0x00]
  const body = [0x00, ...instructions, 0x0b]
  const codePayload = [1, ...u32(body.length), ...body]
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...section(2, importPayload),
    ...section(3, [1, 0]),
    ...section(7, exportPayload),
    ...(options.extraSectionsBeforeCode ?? []),
    ...section(10, codePayload),
    ...(options.extraSectionsAfterCode ?? []),
  ])
}

function renderExpectations(memoryMaximumPages = 258): PluginWasmModuleExpectations {
  return {
    policy: {
      binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
      profileId: 'myrelith-wasm-render-general-v1' as const,
    },
    opcodeTableDigest: PLUGIN_WASM_OPCODE_TABLE_DIGESTS['myrelith-wasm-render-general-v1'],
    memoryMaximumPages,
    renderEntrypoints: ['myrelith_effect_fixture'],
    migrationEntrypoints: [],
  }
}

function migrationExpectations(): PluginWasmModuleExpectations {
  return {
    policy: {
      binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
      profileId: 'myrelith-wasm-migration-integer-v1' as const,
    },
    opcodeTableDigest: PLUGIN_WASM_OPCODE_TABLE_DIGESTS['myrelith-wasm-migration-integer-v1'],
    memoryMaximumPages: 258,
    renderEntrypoints: [],
    migrationEntrypoints: ['migrate_v1_v2'],
  }
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

function moduleWithMaximumFunctionsAndExports(): {
  readonly bytes: Uint8Array
  readonly entrypoints: readonly string[]
} {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const renderType = [0x60, 0x0a, ...Array<number>(10).fill(0x7f), 0x01, 0x7f]
  const typePayload = [0x02, ...renderType, 0x60, 0x00, 0x00]
  const functionPayload = [
    ...u32(8_192),
    0x00,
    ...Array<number>(8_191).fill(0x01),
  ]
  const entrypoints = Array.from({ length: 8_192 }, (_unused, index) => `e${index}`)
  const exportPayload = [
    ...u32(entrypoints.length),
    ...entrypoints.flatMap((name) => [
      ...u32(name.length),
      ...[...name].map((character) => character.charCodeAt(0)),
      0x00,
      0x00,
    ]),
  ]
  const codePayload = [
    ...u32(8_192),
    ...Array.from({ length: 8_192 }, () => [0x04, 0x00, 0x41, 0x00, 0x0b]).flat(),
  ]
  return {
    entrypoints,
    bytes: Uint8Array.from([
      ...original.subarray(0, 8),
      0x01,
      ...u32(typePayload.length),
      ...typePayload,
      ...original.subarray(25, 50),
      0x03,
      ...u32(functionPayload.length),
      ...functionPayload,
      0x07,
      ...u32(exportPayload.length),
      ...exportPayload,
      0x0a,
      ...u32(codePayload.length),
      ...codePayload,
    ]),
  }
}

function moduleWithExports(count: number): {
  readonly bytes: Uint8Array
  readonly entrypoints: readonly string[]
} {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const entrypoints = Array.from({ length: count }, (_unused, index) => `e${index}`)
  const payload = [
    ...u32(count),
    ...entrypoints.flatMap((name) => [
      ...u32(name.length),
      ...[...name].map((character) => character.charCodeAt(0)),
      0x00,
      0x00,
    ]),
  ]
  return {
    entrypoints,
    bytes: Uint8Array.from([
      ...original.subarray(0, 54),
      0x07,
      ...u32(payload.length),
      ...payload,
      ...original.subarray(83),
    ]),
  }
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

function moduleWithExpandedSignatureFieldsAboveLimit(): Uint8Array {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const renderType = [0x60, 0x0a, ...Array<number>(10).fill(0x7f), 0x01, 0x7f]
  const fullTypes = Array.from({ length: 113 }, () => [
    0x60,
    ...u32(128),
    ...Array<number>(128).fill(0x7f),
    ...u32(16),
    ...Array<number>(16).fill(0x7f),
  ]).flat()
  const partialType = [
    0x60,
    ...u32(102),
    ...Array<number>(102).fill(0x7f),
    0x00,
  ]
  const payload = [
    ...u32(115),
    ...renderType,
    ...fullTypes,
    ...partialType,
  ]
  return Uint8Array.from([
    ...original.subarray(0, 8),
    0x01,
    ...u32(payload.length),
    ...payload,
    ...original.subarray(25),
  ])
}

function moduleWithCombinedDeclarationChargeAboveLimit(): Uint8Array {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const renderType = [0x60, 0x0a, ...Array<number>(10).fill(0x7f), 0x01, 0x7f]
  const fullTypes = Array.from({ length: 113 }, () => [
    0x60,
    ...u32(128),
    ...Array<number>(128).fill(0x7f),
    ...u32(16),
    ...Array<number>(16).fill(0x7f),
  ]).flat()
  const finalType = [
    0x60,
    ...u32(101),
    ...Array<number>(101).fill(0x7f),
    0x00,
  ]
  const typePayload = [
    ...u32(115),
    ...renderType,
    ...fullTypes,
    ...finalType,
  ]
  const functionPayload = [...u32(1_638), ...Array<number>(1_638).fill(0)]
  const codePayload = [
    ...u32(1_638),
    ...Array.from({ length: 1_638 }, () => [0x04, 0x00, 0x41, 0x00, 0x0b]).flat(),
  ]
  return Uint8Array.from([
    ...original.subarray(0, 8),
    0x01,
    ...u32(typePayload.length),
    ...typePayload,
    ...original.subarray(25, 50),
    0x03,
    ...u32(functionPayload.length),
    ...functionPayload,
    ...original.subarray(54, 83),
    0x0a,
    ...u32(codePayload.length),
    ...codePayload,
  ])
}

function moduleWithCrossingSignatureVectorWithoutPayload(): Uint8Array {
  const original = hexBytes(MINIMAL_RENDER_MODULE_HEX)
  const renderType = [0x60, 0x0a, ...Array<number>(10).fill(0x7f), 0x01, 0x7f]
  const fullTypes = Array.from({ length: 113 }, () => [
    0x60,
    ...u32(128),
    ...Array<number>(128).fill(0x7f),
    ...u32(16),
    ...Array<number>(16).fill(0x7f),
  ]).flat()
  const finalCompleteType = [
    0x60,
    ...u32(100),
    ...Array<number>(100).fill(0x7f),
    0x00,
  ]
  const payload = [
    ...u32(116),
    ...renderType,
    ...fullTypes,
    ...finalCompleteType,
    0x60,
    0x02,
  ]
  return Uint8Array.from([
    ...original.subarray(0, 8),
    0x01,
    ...u32(payload.length),
    ...payload,
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
    })).toMatchObject({
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

  test('rejects more than 16,384 aggregate expanded signature fields', () => {
    expect(() => parsePluginWasmModule(moduleWithExpandedSignatureFieldsAboveLimit(), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('WebAssembly expanded signature field count exceeds 16384.')
  })

  test('rejects an aggregate signature crossing before iterating its vector payload', () => {
    expect(() => parsePluginWasmModule(moduleWithCrossingSignatureVectorWithoutPayload(), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('WebAssembly expanded signature field count exceeds 16384.')
  })

  test('charges reused parameter vectors to every defined function runtime slot', () => {
    expect(() => parsePluginWasmModule(moduleWithDefinedFunctions(1_639), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('WebAssembly defined-function runtime slot count exceeds 16384.')
  })

  test('rejects more than 16,384 aggregate raw declaration entries', () => {
    const fixture = moduleWithMaximumFunctionsAndExports()
    expect(() => parsePluginWasmModule(fixture.bytes, {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: fixture.entrypoints,
      migrationEntrypoints: [],
    })).toThrow('WebAssembly raw declaration count exceeds 16384.')
  })

  test('rejects a combined declaration charge above 32,768', () => {
    expect(() => parsePluginWasmModule(moduleWithCombinedDeclarationChargeAboveLimit(), {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: ['myrelith_effect_fixture'],
      migrationEntrypoints: [],
    })).toThrow('WebAssembly combined declaration charge exceeds 32768.')
  })

  test('binds the selected profile to its exact opcode-table digest', () => {
    expect(() => parsePluginWasmModule(pluginModule(), {
      ...renderExpectations(),
      opcodeTableDigest: `sha256:${'0'.repeat(64)}`,
    })).toThrow('WebAssembly opcode-table digest does not match the selected profile.')
  })

  test('accepts fixed SIMD in render-general and rejects a reserved SIMD hole', () => {
    const fixedSimd = pluginModule({
      instructions: [0xfd, 0x0c, ...Array<number>(16).fill(0), 0x1a, 0x41, 0x00],
    })
    expect(parsePluginWasmModule(fixedSimd, renderExpectations())).toMatchObject({
      definedFunctionCount: 1,
    })

    const reservedSimd = pluginModule({
      instructions: [0xfd, ...u32(0x9a), 0x41, 0x00],
    })
    expect(() => parsePluginWasmModule(reservedSimd, renderExpectations()))
      .toThrow('WebAssembly SIMD subopcode 154 is outside the selected profile.')
  })

  test('accepts integer migration code and rejects float or SIMD anywhere in that module', () => {
    const integerModule = pluginModule({ parameterCount: 6, entrypoint: 'migrate_v1_v2' })
    expect(parsePluginWasmModule(integerModule, migrationExpectations())).toMatchObject({
      exportedFunctions: ['migrate_v1_v2'],
    })

    const floatModule = pluginModule({
      parameterCount: 6,
      entrypoint: 'migrate_v1_v2',
      instructions: [0x43, 0, 0, 0, 0, 0x1a, 0x41, 0x00],
    })
    expect(() => parsePluginWasmModule(floatModule, migrationExpectations()))
      .toThrow('WebAssembly opcode 0x43 is outside the selected profile.')

    const simdModule = pluginModule({
      parameterCount: 6,
      entrypoint: 'migrate_v1_v2',
      instructions: [0xfd, 0x0c, ...Array<number>(16).fill(0), 0x1a, 0x41, 0x00],
    })
    expect(() => parsePluginWasmModule(simdModule, migrationExpectations()))
      .toThrow('WebAssembly SIMD subopcode 12 is outside the selected profile.')
  })

  test('accepts exactly 65,536 decoded body instructions and rejects plus one', () => {
    const exact = pluginModule({
      instructions: [...Array<number>(65_534).fill(0x01), 0x41, 0x00],
    })
    expect(parsePluginWasmModule(exact, renderExpectations())).toMatchObject({
      definedFunctionCount: 1,
    })

    const plusOne = pluginModule({
      instructions: [...Array<number>(65_535).fill(0x01), 0x41, 0x00],
    })
    expect(() => parsePluginWasmModule(plusOne, renderExpectations()))
      .toThrow('WebAssembly function instruction count exceeds 65536.')
  })

  test('rejects noncanonical signed immediates, active data, and a start section', () => {
    expect(() => parsePluginWasmModule(pluginModule({
      instructions: [0x41, 0x80, 0x00],
    }), renderExpectations())).toThrow('Signed LEB128 is not canonical.')

    const activeDataPayload = [1, 0, 0x41, 0, 0x0b, 0]
    expect(() => parsePluginWasmModule(pluginModule({
      extraSectionsAfterCode: section(11, activeDataPayload),
    }), renderExpectations())).toThrow('Only passive WebAssembly data segments are accepted.')

    expect(() => parsePluginWasmModule(pluginModule({
      extraSectionsBeforeCode: section(8, [0]),
    }), renderExpectations())).toThrow('WebAssembly start functions are forbidden.')
  })

  test('rejects the memory-page ceiling plus one before section traversal', () => {
    expect(() => parsePluginWasmModule(
      pluginModule({ memoryPages: 1_026 }),
      renderExpectations(1_026),
    )).toThrow('WebAssembly memory pages must be between 258 and 1025.')
  })

  test('rejects more than 8,192 exports before allocating the export vector', () => {
    const fixture = moduleWithExports(8_193)
    expect(() => parsePluginWasmModule(fixture.bytes, {
      policy: {
        binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
        profileId: 'myrelith-wasm-render-general-v1',
      },
      memoryMaximumPages: 258,
      renderEntrypoints: fixture.entrypoints,
      migrationEntrypoints: [],
    })).toThrow('WebAssembly export count exceeds 8192.')
  })
})
