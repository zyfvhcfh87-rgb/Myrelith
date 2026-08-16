import type { PluginWasmProfileId } from '../../domain/pluginWasmPolicy'

export type PluginWasmImmediateKind =
  | 'none'
  | 'block-type'
  | 'branch'
  | 'branch-table'
  | 'call'
  | 'call-indirect'
  | 'typed-select'
  | 'local'
  | 'global'
  | 'table'
  | 'memory-argument'
  | 'memory-index'
  | 'i32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'reference-type'
  | 'reference-function'

export interface PluginWasmOpcodeTableArtifact {
  readonly artifactVersion: 1
  readonly profileId: PluginWasmProfileId
  readonly primary: Readonly<Record<string, PluginWasmImmediateKind>>
  readonly miscellaneous: Readonly<Record<string, string>>
  readonly simd: Readonly<Record<string, string>>
}

const noImmediatePrimary = [
  0x00, 0x01, 0x05, 0x0b, 0x0f, 0x1a, 0x1b,
  ...Array.from({ length: 0xc4 - 0x45 + 1 }, (_unused, index) => 0x45 + index),
]

const primaryImmediateKinds: Readonly<Record<number, PluginWasmImmediateKind>> = Object.freeze({
  0x02: 'block-type', 0x03: 'block-type', 0x04: 'block-type',
  0x0c: 'branch', 0x0d: 'branch', 0x0e: 'branch-table',
  0x10: 'call', 0x11: 'call-indirect', 0x1c: 'typed-select',
  0x20: 'local', 0x21: 'local', 0x22: 'local',
  0x23: 'global', 0x24: 'global', 0x25: 'table', 0x26: 'table',
  ...Object.fromEntries(
    Array.from({ length: 0x3e - 0x28 + 1 }, (_unused, index) => [0x28 + index, 'memory-argument']),
  ),
  0x3f: 'memory-index', 0x40: 'memory-index',
  0x41: 'i32', 0x42: 'i64', 0x43: 'f32', 0x44: 'f64',
  0xd0: 'reference-type', 0xd1: 'none', 0xd2: 'reference-function',
  0xfc: 'none', 0xfd: 'none',
})

const renderPrimary = Object.freeze(Object.fromEntries([
  ...noImmediatePrimary.map((opcode) => [String(opcode), 'none']),
  ...Object.entries(primaryImmediateKinds),
]) as Record<string, PluginWasmImmediateKind>)

const floatPrimary = new Set<number>([
  0x2a, 0x2b, 0x38, 0x39, 0x43, 0x44,
  ...Array.from({ length: 0x66 - 0x5b + 1 }, (_unused, index) => 0x5b + index),
  ...Array.from({ length: 0xa6 - 0x8b + 1 }, (_unused, index) => 0x8b + index),
  0xa8, 0xa9, 0xaa, 0xab, 0xae, 0xaf, 0xb0, 0xb1,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9,
  0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
])

const migrationPrimary = Object.freeze(Object.fromEntries(
  Object.entries(renderPrimary).filter(([opcode]) => !floatPrimary.has(Number(opcode))),
) as Record<string, PluginWasmImmediateKind>)

const renderMiscellaneous = Object.freeze(Object.fromEntries(
  Array.from({ length: 18 }, (_unused, subopcode) => [
    String(subopcode),
    subopcode === 8 ? 'data-memory'
      : subopcode === 9 ? 'data'
        : subopcode === 10 ? 'memory-memory'
          : subopcode === 11 ? 'memory'
            : subopcode === 12 ? 'element-table'
              : subopcode === 13 ? 'element'
                : subopcode === 14 ? 'table-table'
                  : subopcode >= 15 ? 'table'
                    : 'none',
  ]),
))

const migrationMiscellaneous = Object.freeze(Object.fromEntries(
  Object.entries(renderMiscellaneous).filter(([subopcode]) => {
    const value = Number(subopcode)
    return value >= 8 && value !== 15
  }),
))

const simdReserved = new Set([
  0x9a, 0xa2, 0xa5, 0xa6, 0xaf, 0xb0, 0xb2, 0xb3, 0xb4, 0xbb,
  0xc2, 0xc5, 0xc6, 0xcf, 0xd0, 0xd2, 0xd3, 0xd4, 0xe2, 0xee,
])
const renderSimd = Object.freeze(Object.fromEntries(
  Array.from({ length: 256 }, (_unused, subopcode) => subopcode)
    .filter((subopcode) => !simdReserved.has(subopcode))
    .map((subopcode) => [
      String(subopcode),
      subopcode <= 11 || subopcode === 92 || subopcode === 93
        ? 'memory-argument'
        : subopcode === 12
          ? 'bytes-16'
          : subopcode === 13
            ? 'shuffle-16'
            : subopcode >= 21 && subopcode <= 34
              ? `lane-${subopcode <= 23 ? 16 : subopcode <= 26 ? 8 : subopcode <= 28 || (subopcode >= 31 && subopcode <= 32) ? 4 : 2}`
              : subopcode >= 84 && subopcode <= 91
                ? `memory-lane-${subopcode === 84 || subopcode === 88 ? 16 : subopcode === 85 || subopcode === 89 ? 8 : subopcode === 86 || subopcode === 90 ? 4 : 2}`
                : 'none',
    ]),
))

const EMPTY_TABLE = Object.freeze({})

export const PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS: Readonly<Record<
  PluginWasmProfileId,
  PluginWasmOpcodeTableArtifact
>> = Object.freeze({
  'myrelith-wasm-render-general-v1': Object.freeze({
    artifactVersion: 1,
    profileId: 'myrelith-wasm-render-general-v1',
    primary: renderPrimary,
    miscellaneous: renderMiscellaneous,
    simd: renderSimd,
  }),
  'myrelith-wasm-migration-integer-v1': Object.freeze({
    artifactVersion: 1,
    profileId: 'myrelith-wasm-migration-integer-v1',
    primary: migrationPrimary,
    miscellaneous: migrationMiscellaneous,
    simd: EMPTY_TABLE,
  }),
})

// SHA-256 of the stable canonical JSON form returned by serializePluginWasmOpcodeTable().
export const PLUGIN_WASM_OPCODE_TABLE_DIGESTS: Readonly<Record<PluginWasmProfileId, string>> = Object.freeze({
  'myrelith-wasm-render-general-v1': 'sha256:0592d2aca9fb8f8ea053a8ae023ffb6fee296fd196f54760b3f7ac8fb04e400d',
  'myrelith-wasm-migration-integer-v1': 'sha256:50665e937691ad0ed3dc8890d8b8defd773343872d1f77636906fcd218acc744',
})

export function serializePluginWasmOpcodeTable(profileId: PluginWasmProfileId): string {
  return JSON.stringify(PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS[profileId])
}
