import {
  concatBytes,
  decodeU32Leb,
  encodeU32Leb,
  utf8Bytes,
} from './bytes'

export const ISSUE77_MEMORY_PAGE_BYTES = 65_536
export const ISSUE77_MEMORY_PAGES = 258
export const ISSUE77_PARAMETER_POINTER = 0x0100_0000
export const ISSUE77_PIXEL_POINTER = 0x0101_0000
export const STATEFUL_SAMPLE_EXPORT = 'myrelith_effect_stateful'
export const STATEFUL_SAMPLE_MODULE_PATH = 'runtime/stateful.wasm'
export const ISSUE77_PLUGIN_SCHEMA_VERSION = 1

export const ISSUE77_WASM_LIMITS = Object.freeze({
  types: 1_024,
  parametersPerType: 128,
  resultsPerType: 16,
  signatureFields: 16_384,
  functions: 8_192,
  localsPerFunction: 2_048,
  localsPerModule: 16_384,
  tables: 16,
  tableEntries: 4_096,
  memories: 1,
  memoryMinimumPages: 258,
  memoryMaximumPages: 1_025,
  globals: 2_048,
  exports: 8_192,
  elementSegments: 1_024,
  elementEntries: 4_096,
  dataSegments: 1_024,
  dataBytes: 8 * 1024 * 1024,
  codeBodyBytes: 256 * 1024,
  codeModuleBytes: 16 * 1024 * 1024,
  instructionsPerBody: 65_536,
  instructionsPerModule: 1_048_576,
  controlDepth: 256,
  branchTableLabels: 1_024,
  branchTableLabelsPerBody: 16_384,
  branchTableLabelsPerModule: 65_536,
  initializerOpcodes: 64,
  initializerOpcodesPerModule: 16_384,
  rawDeclarations: 16_384,
  combinedDeclarationCharge: 32_768,
})

const WASM_HEADER = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
const I32 = 0x7f

function vector(items: readonly Uint8Array[]): Uint8Array {
  return concatBytes([encodeU32Leb(items.length), ...items])
}

function wasmName(value: string): Uint8Array {
  const bytes = utf8Bytes(value)
  return concatBytes([encodeU32Leb(bytes.byteLength), bytes])
}

function section(id: number, payload: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(id), encodeU32Leb(payload.byteLength), payload])
}

function functionType(parameters: number, results: number): Uint8Array {
  return concatBytes([
    Uint8Array.of(0x60),
    encodeU32Leb(parameters),
    new Uint8Array(parameters).fill(I32),
    encodeU32Leb(results),
    new Uint8Array(results).fill(I32),
  ])
}

function fixedMemoryImport(memoryPages: number): Uint8Array {
  const entry = concatBytes([
    wasmName('myrelith'),
    wasmName('memory'),
    Uint8Array.of(0x02, 0x01),
    encodeU32Leb(memoryPages),
    encodeU32Leb(memoryPages),
  ])
  return section(2, vector([entry]))
}

function exportFirstFunction(name: string): Uint8Array {
  return section(7, vector([
    concatBytes([wasmName(name), Uint8Array.of(0x00), encodeU32Leb(0)]),
  ]))
}

function codeBody(bytes: Uint8Array): Uint8Array {
  return concatBytes([encodeU32Leb(bytes.byteLength), bytes])
}

function moduleWithSections(sections: readonly Uint8Array[]): Uint8Array {
  return concatBytes([WASM_HEADER, ...sections])
}

export function buildStatefulRenderModule(memoryPages = ISSUE77_MEMORY_PAGES): Uint8Array {
  const typeSection = section(1, vector([functionType(10, 1)]))
  const functionSection = section(3, concatBytes([encodeU32Leb(1), encodeU32Leb(0)]))
  const globalSection = section(6, vector([
    Uint8Array.of(I32, 0x01, 0x41, 0x00, 0x0b),
  ]))
  const instructions = Uint8Array.of(
    0x00,
    0x23, 0x00,
    0x41, 0x01,
    0x6a,
    0x24, 0x00,
    0x20, 0x00,
    0x20, 0x00,
    0x2d, 0x00, 0x00,
    0x23, 0x00,
    0x6a,
    0x3a, 0x00, 0x00,
    0x41, 0x00,
    0x0b,
  )
  const codeSection = section(10, concatBytes([
    encodeU32Leb(1),
    codeBody(instructions),
  ]))
  return moduleWithSections([
    typeSection,
    fixedMemoryImport(memoryPages),
    functionSection,
    globalSection,
    exportFirstFunction(STATEFUL_SAMPLE_EXPORT),
    codeSection,
  ])
}

export function buildTypeCountModule(count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('type fixture count must be positive')
  const types: Uint8Array[] = [functionType(10, 1)]
  for (let index = 1; index < count; index++) types.push(functionType(0, 0))
  const functionSection = section(3, concatBytes([encodeU32Leb(1), encodeU32Leb(0)]))
  const body = codeBody(Uint8Array.of(0x00, 0x41, 0x00, 0x0b))
  return moduleWithSections([
    section(1, vector(types)),
    fixedMemoryImport(ISSUE77_MEMORY_PAGES),
    functionSection,
    exportFirstFunction('myrelith_effect_fixture'),
    section(10, concatBytes([encodeU32Leb(1), body])),
  ])
}

export function buildFunctionCountModule(count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('function fixture count must be positive')
  }
  const typeIndexes = new Uint8Array(count).fill(1)
  typeIndexes[0] = 0
  const bodies: Uint8Array[] = [codeBody(Uint8Array.of(0x00, 0x41, 0x00, 0x0b))]
  for (let index = 1; index < count; index++) {
    bodies.push(codeBody(Uint8Array.of(0x00, 0x0b)))
  }
  return moduleWithSections([
    section(1, vector([functionType(10, 1), functionType(0, 0)])),
    fixedMemoryImport(ISSUE77_MEMORY_PAGES),
    section(3, concatBytes([encodeU32Leb(count), typeIndexes])),
    exportFirstFunction('myrelith_effect_fixture'),
    section(10, concatBytes([encodeU32Leb(count), ...bodies])),
  ])
}

export function readSectionVectorCount(moduleBytes: Uint8Array, sectionId: number): number {
  let offset = WASM_HEADER.byteLength
  while (offset < moduleBytes.byteLength) {
    const id = moduleBytes[offset]
    if (id === undefined) throw new RangeError('truncated fixture section id')
    const size = decodeU32Leb(moduleBytes, offset + 1)
    const payloadOffset = size.nextOffset
    const payloadEnd = payloadOffset + size.value
    if (payloadEnd > moduleBytes.byteLength) throw new RangeError('truncated fixture section')
    if (id === sectionId) return decodeU32Leb(moduleBytes, payloadOffset).value
    offset = payloadEnd
  }
  throw new RangeError(`fixture section ${sectionId} is missing`)
}

export interface WasmCountBoundary {
  readonly maximum: number
  readonly atMaximum: () => Uint8Array
  readonly aboveMaximum: () => Uint8Array
}

export const ISSUE77_WASM_COUNT_BOUNDARIES = Object.freeze({
  types: Object.freeze({
    maximum: ISSUE77_WASM_LIMITS.types,
    atMaximum: () => buildTypeCountModule(ISSUE77_WASM_LIMITS.types),
    aboveMaximum: () => buildTypeCountModule(ISSUE77_WASM_LIMITS.types + 1),
  }) satisfies WasmCountBoundary,
  functions: Object.freeze({
    maximum: ISSUE77_WASM_LIMITS.functions,
    atMaximum: () => buildFunctionCountModule(ISSUE77_WASM_LIMITS.functions),
    aboveMaximum: () => buildFunctionCountModule(ISSUE77_WASM_LIMITS.functions + 1),
  }) satisfies WasmCountBoundary,
})

export function statefulSampleManifestJson(): string {
  return JSON.stringify({
    api: { maxVersion: 1, minVersion: 1 },
    contributions: [{
      contributionVersion: 1,
      descriptorVersion: 1,
      entrypoint: STATEFUL_SAMPLE_EXPORT,
      id: 'stateful',
      kind: 'video-effect',
      migrations: [],
      name: 'Stateful QA Fixture',
      parameters: [],
    }],
    id: 'com.myrelith.qa.stateful',
    name: 'Stateful QA Fixture',
    permissions: [{
      id: 'myrelith.effect.video-frame.rgba8',
      maxVersion: 1,
      minVersion: 1,
      required: true,
    }],
    runtime: {
      entry: STATEFUL_SAMPLE_MODULE_PATH,
      kind: 'wasm',
      memoryMaximumPages: ISSUE77_MEMORY_PAGES,
    },
    schemaVersion: ISSUE77_PLUGIN_SCHEMA_VERSION,
    version: '1.0.0',
  })
}

export type Issue77RenderArguments = readonly [
  number, number, number, number, number,
  number, number, number, number, number,
]

export function issue77RenderArguments(
  frame = 0,
  parameterByteLength = 2,
): Issue77RenderArguments {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError('fixture frame is invalid')
  return [
    ISSUE77_PIXEL_POINTER,
    1,
    1,
    4,
    frame >>> 0,
    Math.floor(frame / 0x1_0000_0000),
    30,
    1,
    ISSUE77_PARAMETER_POINTER,
    parameterByteLength,
  ]
}
