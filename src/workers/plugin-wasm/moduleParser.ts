import {
  PLUGIN_WASM_BINARY_POLICY_VERSION,
  type PluginWasmProfileSelection,
} from '../../domain/pluginWasmPolicy'

const WASM_MAGIC = Object.freeze([0x00, 0x61, 0x73, 0x6d])
const WASM_VERSION_1 = Object.freeze([0x01, 0x00, 0x00, 0x00])
const I32 = 0x7f
const FUNCTION_TYPE = 0x60
const EXTERNAL_FUNCTION = 0x00
const EXTERNAL_MEMORY = 0x02
const MAX_TYPE_COUNT = 1_024
const MAX_FUNCTION_PARAMETERS = 128
const MAX_FUNCTION_RESULTS = 16
const MAX_FUNCTION_COUNT = 8_192
const MAX_EXPORT_COUNT = 8_192
const MAX_EXPANDED_SIGNATURE_FIELDS = 16_384
const MAX_DEFINED_FUNCTION_RUNTIME_SLOTS = 16_384
const MAX_RAW_DECLARATION_ENTRIES = 16_384
const MAX_COMBINED_DECLARATION_CHARGE = 32_768

export interface PluginWasmModuleExpectations {
  readonly policy: PluginWasmProfileSelection
  readonly memoryMaximumPages: number
  readonly renderEntrypoints: readonly string[]
  readonly migrationEntrypoints: readonly string[]
}

export interface PluginWasmModuleFacts {
  readonly policy: PluginWasmProfileSelection
  readonly importedMemory: {
    readonly minimumPages: number
    readonly maximumPages: number
  }
  readonly definedFunctionCount: number
  readonly exportedFunctions: readonly string[]
}

export class PluginWasmPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginWasmPolicyError'
  }
}

function fail(message: string): never {
  throw new PluginWasmPolicyError(message)
}

class ByteReader {
  readonly #bytes: Uint8Array
  readonly #end: number
  #offset: number

  constructor(bytes: Uint8Array, offset = 0, length = bytes.byteLength - offset) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      fail('Invalid byte-reader range.')
    }
    const end = offset + length
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) fail('Byte-reader range exceeds input.')
    this.#bytes = bytes
    this.#offset = offset
    this.#end = end
  }

  get done(): boolean {
    return this.#offset === this.#end
  }

  byte(): number {
    if (this.#offset >= this.#end) fail('Unexpected end of WebAssembly bytes.')
    return this.#bytes[this.#offset++]
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.#offset + length > this.#end) {
      fail('Declared WebAssembly byte range exceeds its container.')
    }
    const value = this.#bytes.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return value
  }

  subreader(length: number): ByteReader {
    const value = this.bytes(length)
    return new ByteReader(value)
  }

  u32(): number {
    let value = 0
    for (let index = 0; index < 5; index++) {
      const byte = this.byte()
      const payload = byte & 0x7f
      if (index === 4 && payload > 0x0f) fail('Unsigned LEB128 exceeds u32.')
      value += payload * 2 ** (index * 7)
      if ((byte & 0x80) === 0) {
        if (index > 0 && payload === 0) fail('Unsigned LEB128 is not canonical.')
        return value
      }
    }
    return fail('Unsigned LEB128 exceeds five bytes.')
  }

  name(): string {
    const bytes = this.bytes(this.u32())
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (cause) {
      throw new PluginWasmPolicyError(`WebAssembly name is not valid UTF-8: ${String(cause)}`)
    }
  }

  expectDone(label: string): void {
    if (!this.done) fail(`${label} has trailing bytes.`)
  }
}

interface FunctionType {
  readonly parameters: readonly number[]
  readonly results: readonly number[]
}

interface FunctionExport {
  readonly name: string
  readonly functionIndex: number
}

interface WasmDeclarationBudget {
  rawEntries: number
  expandedSignatureFields: number
  definedFunctionRuntimeSlots: number
}

function expectCombinedDeclarationBudget(budget: WasmDeclarationBudget): void {
  const combinedCharge = budget.rawEntries
    + budget.expandedSignatureFields
    + budget.definedFunctionRuntimeSlots
  if (combinedCharge > MAX_COMBINED_DECLARATION_CHARGE) {
    fail(
      `WebAssembly combined declaration charge exceeds ${MAX_COMBINED_DECLARATION_CHARGE}.`,
    )
  }
}

function chargeRawEntries(budget: WasmDeclarationBudget, count: number): void {
  if (budget.rawEntries > MAX_RAW_DECLARATION_ENTRIES - count) {
    fail(`WebAssembly raw declaration count exceeds ${MAX_RAW_DECLARATION_ENTRIES}.`)
  }
  budget.rawEntries += count
  expectCombinedDeclarationBudget(budget)
}

function chargeSignatureFields(budget: WasmDeclarationBudget, count: number): void {
  if (budget.expandedSignatureFields > MAX_EXPANDED_SIGNATURE_FIELDS - count) {
    fail(`WebAssembly expanded signature field count exceeds ${MAX_EXPANDED_SIGNATURE_FIELDS}.`)
  }
  budget.expandedSignatureFields += count
  expectCombinedDeclarationBudget(budget)
}

function chargeDefinedFunctionRuntimeSlots(
  budget: WasmDeclarationBudget,
  count: number,
): void {
  if (budget.definedFunctionRuntimeSlots > MAX_DEFINED_FUNCTION_RUNTIME_SLOTS - count) {
    fail(
      `WebAssembly defined-function runtime slot count exceeds ${MAX_DEFINED_FUNCTION_RUNTIME_SLOTS}.`,
    )
  }
  budget.definedFunctionRuntimeSlots += count
  expectCombinedDeclarationBudget(budget)
}

function expectBytes(reader: ByteReader, expected: readonly number[], label: string): void {
  for (const byte of expected) {
    if (reader.byte() !== byte) fail(`Invalid WebAssembly ${label}.`)
  }
}

function readValueTypes(
  reader: ByteReader,
  maximum: number,
  label: string,
  budget: WasmDeclarationBudget,
): readonly number[] {
  const count = reader.u32()
  if (count > maximum) fail(`WebAssembly function ${label} count exceeds ${maximum}.`)
  chargeSignatureFields(budget, count)
  const values: number[] = []
  for (let index = 0; index < count; index++) {
    const value = reader.byte()
    if (value !== I32) fail('The minimal render tracer accepts only i32 value types.')
    values.push(value)
  }
  return Object.freeze(values)
}

function readTypes(
  reader: ByteReader,
  budget: WasmDeclarationBudget,
): readonly FunctionType[] {
  const count = reader.u32()
  if (count > MAX_TYPE_COUNT) fail(`WebAssembly type count exceeds ${MAX_TYPE_COUNT}.`)
  chargeRawEntries(budget, count)
  const types: FunctionType[] = []
  for (let index = 0; index < count; index++) {
    if (reader.byte() !== FUNCTION_TYPE) fail('Only WebAssembly function types are supported.')
    const parameters = readValueTypes(
      reader,
      MAX_FUNCTION_PARAMETERS,
      'parameter',
      budget,
    )
    const results = readValueTypes(reader, MAX_FUNCTION_RESULTS, 'result', budget)
    types.push(Object.freeze({
      parameters,
      results,
    }))
  }
  reader.expectDone('type section')
  return Object.freeze(types)
}

function readFixedMemoryImport(
  reader: ByteReader,
  expectedPages: number,
  budget: WasmDeclarationBudget,
): PluginWasmModuleFacts['importedMemory'] {
  if (reader.u32() !== 1) fail('Exactly one WebAssembly import is required.')
  chargeRawEntries(budget, 1)
  if (reader.name() !== 'myrelith' || reader.name() !== 'memory') {
    fail('The only import must be myrelith.memory.')
  }
  if (reader.byte() !== EXTERNAL_MEMORY) fail('The myrelith.memory import must be a memory.')
  if (reader.u32() !== 1) fail('The imported memory must declare an exact minimum and maximum.')
  const minimumPages = reader.u32()
  const maximumPages = reader.u32()
  if (minimumPages !== expectedPages || maximumPages !== expectedPages) {
    fail('The imported memory bounds must equal the signed manifest request.')
  }
  reader.expectDone('import section')
  return Object.freeze({ minimumPages, maximumPages })
}

function readFunctionTypeIndexes(
  reader: ByteReader,
  budget: WasmDeclarationBudget,
  types: readonly FunctionType[],
): readonly number[] {
  const count = reader.u32()
  if (count > MAX_FUNCTION_COUNT) fail(`WebAssembly function count exceeds ${MAX_FUNCTION_COUNT}.`)
  chargeRawEntries(budget, count)
  const indexes: number[] = []
  for (let index = 0; index < count; index++) {
    const typeIndex = reader.u32()
    const functionType = types[typeIndex]
    if (!functionType) fail(`Defined function ${index} references missing type ${typeIndex}.`)
    chargeDefinedFunctionRuntimeSlots(budget, functionType.parameters.length)
    indexes.push(typeIndex)
  }
  reader.expectDone('function section')
  return Object.freeze(indexes)
}

function readExports(
  reader: ByteReader,
  budget: WasmDeclarationBudget,
): readonly FunctionExport[] {
  const count = reader.u32()
  if (count > MAX_EXPORT_COUNT) fail(`WebAssembly export count exceeds ${MAX_EXPORT_COUNT}.`)
  chargeRawEntries(budget, count)
  const exports: FunctionExport[] = []
  for (let index = 0; index < count; index++) {
    const name = reader.name()
    if (reader.byte() !== EXTERNAL_FUNCTION) fail('The minimal render tracer exports functions only.')
    exports.push(Object.freeze({ name, functionIndex: reader.u32() }))
  }
  reader.expectDone('export section')
  return Object.freeze(exports)
}

function readMinimalCode(reader: ByteReader, definedFunctionCount: number): void {
  if (reader.u32() !== definedFunctionCount) {
    fail('The code-body count must equal the defined-function count.')
  }
  for (let index = 0; index < definedFunctionCount; index++) {
    const body = reader.subreader(reader.u32())
    if (body.u32() !== 0) fail('The minimal render tracer has no locals.')
    if (body.byte() !== 0x41 || body.byte() !== 0x00 || body.byte() !== 0x0b) {
      fail('The minimal render tracer body must be i32.const 0 followed by end.')
    }
    body.expectDone('function body')
  }
  reader.expectDone('code section')
}

function isRenderSignature(type: FunctionType | undefined): boolean {
  return type !== undefined
    && type.parameters.length === 10
    && type.parameters.every((value) => value === I32)
    && type.results.length === 1
    && type.results[0] === I32
}

/** Parse attacker-authored module bytes inside the disposable candidate worker. */
export function parsePluginWasmModule(
  moduleBytes: Uint8Array,
  expectations: PluginWasmModuleExpectations,
): PluginWasmModuleFacts {
  if (expectations.policy.binaryPolicyVersion !== PLUGIN_WASM_BINARY_POLICY_VERSION) {
    fail('Unsupported WebAssembly binary-policy version.')
  }
  if (expectations.policy.profileId !== 'myrelith-wasm-render-general-v1') {
    fail('The migration-integer table is not available yet.')
  }
  if (expectations.migrationEntrypoints.length !== 0) {
    fail('Render-general modules cannot declare migration entrypoints.')
  }

  const reader = new ByteReader(moduleBytes)
  expectBytes(reader, WASM_MAGIC, 'magic')
  expectBytes(reader, WASM_VERSION_1, 'version')

  let previousSectionId = 0
  let types: readonly FunctionType[] | undefined
  let importedMemory: PluginWasmModuleFacts['importedMemory'] | undefined
  let functionTypeIndexes: readonly number[] | undefined
  let exports: readonly FunctionExport[] | undefined
  let sawCode = false
  const declarationBudget: WasmDeclarationBudget = {
    rawEntries: 0,
    expandedSignatureFields: 0,
    definedFunctionRuntimeSlots: 0,
  }

  while (!reader.done) {
    const sectionId = reader.byte()
    if (sectionId === 0 || sectionId <= previousSectionId) {
      fail('Custom, duplicate, or out-of-order sections are not accepted by the minimal tracer.')
    }
    previousSectionId = sectionId
    const section = reader.subreader(reader.u32())
    switch (sectionId) {
      case 1:
        types = readTypes(section, declarationBudget)
        break
      case 2:
        importedMemory = readFixedMemoryImport(
          section,
          expectations.memoryMaximumPages,
          declarationBudget,
        )
        break
      case 3:
        if (!types) fail('The type section must precede the function section.')
        functionTypeIndexes = readFunctionTypeIndexes(section, declarationBudget, types)
        break
      case 7:
        exports = readExports(section, declarationBudget)
        break
      case 10:
        if (!functionTypeIndexes) fail('The function section must precede code.')
        readMinimalCode(section, functionTypeIndexes.length)
        sawCode = true
        break
      default:
        fail(`Section ${sectionId} is not accepted by the minimal tracer.`)
    }
  }

  if (!types || !importedMemory || !functionTypeIndexes || !exports || !sawCode) {
    fail('The minimal render module is missing a required section.')
  }

  if (expectations.renderEntrypoints.length !== exports.length) {
    fail('Exported functions must exactly match signed render entrypoints.')
  }
  for (const expectedName of expectations.renderEntrypoints) {
    const exported = exports.find((entry) => entry.name === expectedName)
    if (!exported || exported.functionIndex >= functionTypeIndexes.length) {
      fail(`Missing signed render export ${expectedName}.`)
    }
    if (!isRenderSignature(types[functionTypeIndexes[exported.functionIndex]])) {
      fail(`Render export ${expectedName} has the wrong signature.`)
    }
  }

  const policy = Object.freeze({ ...expectations.policy })
  return Object.freeze({
    policy,
    importedMemory,
    definedFunctionCount: functionTypeIndexes.length,
    exportedFunctions: Object.freeze(exports.map((entry) => entry.name)),
  })
}
