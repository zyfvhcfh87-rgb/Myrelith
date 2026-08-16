import {
  PLUGIN_WASM_BINARY_POLICY_VERSION,
  type PluginWasmProfileSelection,
} from '../../domain/pluginWasmPolicy'
import {
  PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS,
  PLUGIN_WASM_OPCODE_TABLE_DIGESTS,
  type PluginWasmOpcodeTableArtifact,
} from './policyTables'

const MIN_MEMORY_PAGES = 258
const MAX_MEMORY_PAGES = 1_025

export interface PluginWasmModuleExpectations {
  readonly policy: PluginWasmProfileSelection
  readonly opcodeTableDigest?: string
  readonly memoryMaximumPages: number
  readonly renderEntrypoints: readonly string[]
  readonly migrationEntrypoints: readonly string[]
}

export interface PluginWasmModuleFacts {
  readonly policy: PluginWasmProfileSelection
  readonly opcodeTableDigest: string
  readonly importedMemory: {
    readonly minimumPages: number
    readonly maximumPages: number
  }
  readonly definedFunctionCount: number
  readonly tableCount: number
  readonly elementSegmentCount: number
  readonly dataSegmentCount: number
  readonly exportedFunctions: readonly string[]
}

export class PluginWasmPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginWasmPolicyError'
  }
}

interface PluginWasmParserEnvironment {
  readonly binaryPolicyVersion: number
  readonly opcodeTables: Readonly<Record<string, PluginWasmOpcodeTableArtifact>>
  readonly opcodeTableDigests: Readonly<Record<string, string>>
}

/**
 * Self-contained parser factory. Its source is embedded into the broker-created
 * blob worker, so attacker-controlled bytes are scanned only in the disposable candidate.
 */
export function createPluginWasmPolicyParser(environment: PluginWasmParserEnvironment): (
  moduleBytes: Uint8Array,
  expectations: PluginWasmModuleExpectations,
) => PluginWasmModuleFacts {
  const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]
  const WASM_VERSION_1 = [0x01, 0x00, 0x00, 0x00]
  const FUNCTION_TYPE = 0x60
  const FUNCREF = 0x70
  const I32 = 0x7f
  const I64 = 0x7e
  const F32 = 0x7d
  const F64 = 0x7c
  const V128 = 0x7b
  const MAX_TYPE_COUNT = 1_024
  const MAX_FUNCTION_PARAMETERS = 128
  const MAX_FUNCTION_RESULTS = 16
  const MAX_FUNCTION_COUNT = 8_192
  const MAX_LOCALS_PER_FUNCTION = 2_048
  const MAX_RUNTIME_SLOTS = 16_384
  const MAX_TABLE_COUNT = 16
  const MAX_TABLE_ELEMENTS = 4_096
  const MAX_GLOBAL_COUNT = 2_048
  const MAX_EXPORT_COUNT = 8_192
  const MAX_ELEMENT_SEGMENTS = 1_024
  const MAX_ELEMENT_ITEMS = 4_096
  const MAX_DATA_SEGMENTS = 1_024
  const MAX_PASSIVE_DATA_BYTES = 8 * 1_024 * 1_024
  const MAX_CODE_BODY_BYTES = 256 * 1_024
  const MAX_CODE_BYTES = 16 * 1_024 * 1_024
  const MAX_BODY_INSTRUCTIONS = 65_536
  const MAX_MODULE_INSTRUCTIONS = 1_048_576
  const MAX_CONTROL_DEPTH = 256
  const MAX_BRANCH_TABLE_LABELS = 1_024
  const MAX_BODY_BRANCH_TABLE_LABELS = 16_384
  const MAX_MODULE_BRANCH_TABLE_LABELS = 65_536
  const MAX_INITIALIZER_INSTRUCTIONS = 64
  const MAX_MODULE_INITIALIZER_INSTRUCTIONS = 16_384
  const MAX_EXPANDED_SIGNATURE_FIELDS = 16_384
  const MAX_RAW_DECLARATION_ENTRIES = 16_384
  const MAX_COMBINED_DECLARATION_CHARGE = 32_768

  class PolicyError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'PluginWasmPolicyError'
    }
  }

  function fail(message: string): never {
    throw new PolicyError(message)
  }

  function expectSafeAdd(current: number, addition: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(addition) || addition < 0 || current > maximum - addition) {
      fail(`${label} exceeds ${maximum}.`)
    }
    return current + addition
  }

  class ByteReader {
    readonly bytesValue: Uint8Array
    readonly end: number
    offset: number

    constructor(bytes: Uint8Array, offset = 0, length = bytes.byteLength - offset) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
        fail('Invalid byte-reader range.')
      }
      const end = offset + length
      if (!Number.isSafeInteger(end) || end > bytes.byteLength) fail('Byte-reader range exceeds input.')
      this.bytesValue = bytes
      this.offset = offset
      this.end = end
    }

    get done(): boolean {
      return this.offset === this.end
    }

    peek(): number {
      if (this.offset >= this.end) fail('Unexpected end of WebAssembly bytes.')
      return this.bytesValue[this.offset]
    }

    byte(): number {
      const value = this.peek()
      this.offset++
      return value
    }

    bytes(length: number): Uint8Array {
      if (!Number.isSafeInteger(length) || length < 0 || this.offset > this.end - length) {
        fail('Declared WebAssembly byte range exceeds its container.')
      }
      const value = this.bytesValue.subarray(this.offset, this.offset + length)
      this.offset += length
      return value
    }

    subreader(length: number): ByteReader {
      return new ByteReader(this.bytes(length))
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

    signed(bits: 32 | 33 | 64): bigint {
      const maximumBytes = Math.ceil(bits / 7)
      const encoded: number[] = []
      let value = 0n
      let shift = 0n
      let finalByte = 0
      for (let index = 0; index < maximumBytes; index++) {
        finalByte = this.byte()
        encoded.push(finalByte)
        value |= BigInt(finalByte & 0x7f) << shift
        shift += 7n
        if ((finalByte & 0x80) === 0) break
        if (index === maximumBytes - 1) fail(`Signed LEB128 exceeds s${bits}.`)
      }
      if ((finalByte & 0x80) !== 0) fail(`Signed LEB128 exceeds s${bits}.`)
      if ((finalByte & 0x40) !== 0) value |= -1n << shift
      const minimum = -(1n << BigInt(bits - 1))
      const maximum = (1n << BigInt(bits - 1)) - 1n
      if (value < minimum || value > maximum) fail(`Signed LEB128 exceeds s${bits}.`)
      const canonical: number[] = []
      let remaining = value
      while (true) {
        let byte = Number(remaining & 0x7fn)
        remaining >>= 7n
        const sign = (byte & 0x40) !== 0
        const done = (remaining === 0n && !sign) || (remaining === -1n && sign)
        if (!done) byte |= 0x80
        canonical.push(byte)
        if (done) break
      }
      if (canonical.length !== encoded.length
        || canonical.some((byte, index) => byte !== encoded[index])) {
        fail('Signed LEB128 is not canonical.')
      }
      return value
    }

    name(): string {
      const bytes = this.bytes(this.u32())
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (cause) {
        throw new PolicyError(`WebAssembly name is not valid UTF-8: ${String(cause)}`)
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
  interface TableType {
    readonly minimum: number
    readonly maximum: number
  }
  interface GlobalType {
    readonly valueType: number
    readonly mutable: boolean
  }
  interface DeclarationBudget {
    rawEntries: number
    expandedSignatureFields: number
    runtimeSlots: number
  }
  interface ModuleBudget {
    instructions: number
    branchTableLabels: number
    initializerInstructions: number
    codeBytes: number
    passiveDataBytes: number
    elementItems: number
  }

  function expectCombinedDeclarationBudget(budget: DeclarationBudget): void {
    const combined = budget.rawEntries + budget.expandedSignatureFields + budget.runtimeSlots
    if (combined > MAX_COMBINED_DECLARATION_CHARGE) {
      fail(`WebAssembly combined declaration charge exceeds ${MAX_COMBINED_DECLARATION_CHARGE}.`)
    }
  }

  function chargeRaw(budget: DeclarationBudget, count: number): void {
    budget.rawEntries = expectSafeAdd(
      budget.rawEntries,
      count,
      MAX_RAW_DECLARATION_ENTRIES,
      'WebAssembly raw declaration count',
    )
    expectCombinedDeclarationBudget(budget)
  }

  function chargeSignatures(budget: DeclarationBudget, count: number): void {
    budget.expandedSignatureFields = expectSafeAdd(
      budget.expandedSignatureFields,
      count,
      MAX_EXPANDED_SIGNATURE_FIELDS,
      'WebAssembly expanded signature field count',
    )
    expectCombinedDeclarationBudget(budget)
  }

  function chargeRuntimeSlots(budget: DeclarationBudget, count: number): void {
    budget.runtimeSlots = expectSafeAdd(
      budget.runtimeSlots,
      count,
      MAX_RUNTIME_SLOTS,
      'WebAssembly defined-function runtime slot count',
    )
    expectCombinedDeclarationBudget(budget)
  }

  function expectBytes(reader: ByteReader, expected: readonly number[], label: string): void {
    for (const byte of expected) if (reader.byte() !== byte) fail(`Invalid WebAssembly ${label}.`)
  }

  function isValueType(value: number, migration: boolean): boolean {
    return migration ? value === I32 || value === I64 : [I32, I64, F32, F64, V128].includes(value)
  }

  function readValueType(reader: ByteReader, migration: boolean, label: string): number {
    const value = reader.byte()
    if (!isValueType(value, migration)) fail(`${label} uses a value type outside the selected profile.`)
    return value
  }

  function readValueTypes(
    reader: ByteReader,
    maximum: number,
    label: string,
    budget: DeclarationBudget,
    migration: boolean,
  ): readonly number[] {
    const count = reader.u32()
    if (count > maximum) fail(`WebAssembly function ${label} count exceeds ${maximum}.`)
    chargeSignatures(budget, count)
    const values: number[] = []
    for (let index = 0; index < count; index++) {
      values.push(readValueType(reader, migration, `WebAssembly function ${label}`))
    }
    return Object.freeze(values)
  }

  function readTypes(reader: ByteReader, budget: DeclarationBudget, migration: boolean): readonly FunctionType[] {
    const count = reader.u32()
    if (count > MAX_TYPE_COUNT) fail(`WebAssembly type count exceeds ${MAX_TYPE_COUNT}.`)
    chargeRaw(budget, count)
    const values: FunctionType[] = []
    for (let index = 0; index < count; index++) {
      if (reader.byte() !== FUNCTION_TYPE) fail('Only WebAssembly function types are supported.')
      values.push(Object.freeze({
        parameters: readValueTypes(reader, MAX_FUNCTION_PARAMETERS, 'parameter', budget, migration),
        results: readValueTypes(reader, MAX_FUNCTION_RESULTS, 'result', budget, migration),
      }))
    }
    reader.expectDone('type section')
    return Object.freeze(values)
  }

  function readFixedMemoryImport(
    reader: ByteReader,
    expectedPages: number,
    budget: DeclarationBudget,
  ): PluginWasmModuleFacts['importedMemory'] {
    if (reader.u32() !== 1) fail('Exactly one WebAssembly import is required.')
    chargeRaw(budget, 1)
    if (reader.name() !== 'myrelith' || reader.name() !== 'memory') {
      fail('The only import must be myrelith.memory.')
    }
    if (reader.byte() !== 0x02) fail('The myrelith.memory import must be a memory.')
    if (reader.u32() !== 1) fail('The imported memory must be fixed, non-shared, and 32-bit.')
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
    budget: DeclarationBudget,
    types: readonly FunctionType[],
  ): readonly number[] {
    const count = reader.u32()
    if (count > MAX_FUNCTION_COUNT) fail(`WebAssembly function count exceeds ${MAX_FUNCTION_COUNT}.`)
    chargeRaw(budget, count)
    const indexes: number[] = []
    for (let index = 0; index < count; index++) {
      const typeIndex = reader.u32()
      const functionType = types[typeIndex]
      if (!functionType) fail(`Defined function ${index} references missing type ${typeIndex}.`)
      chargeRuntimeSlots(budget, functionType.parameters.length)
      indexes.push(typeIndex)
    }
    reader.expectDone('function section')
    return Object.freeze(indexes)
  }

  function readLimits(reader: ByteReader): TableType {
    if (reader.u32() !== 1) fail('Every table must declare a non-shared 32-bit maximum.')
    const minimum = reader.u32()
    const maximum = reader.u32()
    if (minimum > maximum || maximum > MAX_TABLE_ELEMENTS) {
      fail(`WebAssembly table bounds exceed ${MAX_TABLE_ELEMENTS}.`)
    }
    return Object.freeze({ minimum, maximum })
  }

  function readTables(reader: ByteReader, budget: DeclarationBudget): readonly TableType[] {
    const count = reader.u32()
    if (count > MAX_TABLE_COUNT) fail(`WebAssembly table count exceeds ${MAX_TABLE_COUNT}.`)
    chargeRaw(budget, count)
    const tables: TableType[] = []
    let aggregateMinimum = 0
    let aggregateMaximum = 0
    for (let index = 0; index < count; index++) {
      if (reader.byte() !== FUNCREF) fail('Only funcref tables are accepted.')
      const table = readLimits(reader)
      aggregateMinimum = expectSafeAdd(aggregateMinimum, table.minimum, MAX_TABLE_ELEMENTS, 'Aggregate table minimum')
      aggregateMaximum = expectSafeAdd(aggregateMaximum, table.maximum, MAX_TABLE_ELEMENTS, 'Aggregate table maximum')
      tables.push(table)
    }
    reader.expectDone('table section')
    return Object.freeze(tables)
  }

  function readZeroDefinedMemories(reader: ByteReader, budget: DeclarationBudget): void {
    const count = reader.u32()
    chargeRaw(budget, count)
    if (count !== 0) fail('Defined WebAssembly memories are forbidden.')
    reader.expectDone('memory section')
  }

  function readInitializer(
    reader: ByteReader,
    expectedType: number,
    globals: readonly GlobalType[],
    migration: boolean,
    moduleBudget: ModuleBudget,
  ): void {
    const stack: number[] = []
    let instructionCount = 0
    while (true) {
      instructionCount++
      if (instructionCount > MAX_INITIALIZER_INSTRUCTIONS) {
        fail(`WebAssembly initializer instruction count exceeds ${MAX_INITIALIZER_INSTRUCTIONS}.`)
      }
      const opcode = reader.byte()
      if (opcode === 0x0b) break
      if (opcode === 0x41) {
        reader.signed(32)
        stack.push(I32)
      } else if (opcode === 0x42) {
        reader.signed(64)
        stack.push(I64)
      } else if (!migration && opcode === 0x43) {
        reader.bytes(4)
        stack.push(F32)
      } else if (!migration && opcode === 0x44) {
        reader.bytes(8)
        stack.push(F64)
      } else if (!migration && opcode === 0xfd) {
        if (reader.u32() !== 12) fail('Only v128.const is accepted in a global initializer.')
        reader.bytes(16)
        stack.push(V128)
      } else if (opcode === 0x23) {
        const index = reader.u32()
        const referenced = globals[index]
        if (!referenced || referenced.mutable) {
          fail('Initializer global.get must reference an earlier immutable numeric global.')
        }
        stack.push(referenced.valueType)
      } else if ([0x6a, 0x6b, 0x6c, 0x7c, 0x7d, 0x7e].includes(opcode)) {
        const type = opcode <= 0x6c ? I32 : I64
        if (stack.pop() !== type || stack.pop() !== type) fail('Initializer numeric operands have the wrong type.')
        stack.push(type)
      } else {
        fail('Initializer uses an opcode outside the selected profile.')
      }
    }
    moduleBudget.initializerInstructions = expectSafeAdd(
      moduleBudget.initializerInstructions,
      instructionCount,
      MAX_MODULE_INITIALIZER_INSTRUCTIONS,
      'WebAssembly module initializer instruction count',
    )
    if (stack.length !== 1 || stack[0] !== expectedType) {
      fail('Initializer result does not match the declared global type.')
    }
  }

  function readGlobals(
    reader: ByteReader,
    budget: DeclarationBudget,
    moduleBudget: ModuleBudget,
    migration: boolean,
  ): readonly GlobalType[] {
    const count = reader.u32()
    if (count > MAX_GLOBAL_COUNT) fail(`WebAssembly global count exceeds ${MAX_GLOBAL_COUNT}.`)
    chargeRaw(budget, count)
    const globals: GlobalType[] = []
    for (let index = 0; index < count; index++) {
      const valueType = readValueType(reader, migration, 'WebAssembly global')
      const mutableByte = reader.byte()
      if (mutableByte !== 0 && mutableByte !== 1) fail('WebAssembly global mutability is invalid.')
      readInitializer(reader, valueType, globals, migration, moduleBudget)
      globals.push(Object.freeze({ valueType, mutable: mutableByte === 1 }))
    }
    reader.expectDone('global section')
    return Object.freeze(globals)
  }

  function readExports(reader: ByteReader, budget: DeclarationBudget): readonly FunctionExport[] {
    const count = reader.u32()
    if (count > MAX_EXPORT_COUNT) fail(`WebAssembly export count exceeds ${MAX_EXPORT_COUNT}.`)
    chargeRaw(budget, count)
    const exports: FunctionExport[] = []
    const names = new Set<string>()
    for (let index = 0; index < count; index++) {
      const name = reader.name()
      if (names.has(name)) fail(`Duplicate WebAssembly export ${name}.`)
      names.add(name)
      if (reader.byte() !== 0x00) fail('Plugin modules may export functions only.')
      exports.push(Object.freeze({ name, functionIndex: reader.u32() }))
    }
    reader.expectDone('export section')
    return Object.freeze(exports)
  }

  function readOffsetExpression(reader: ByteReader, moduleBudget: ModuleBudget): void {
    if (reader.byte() !== 0x41) fail('Element offsets must use exactly i32.const.')
    reader.signed(32)
    if (reader.byte() !== 0x0b) fail('Element offset must end immediately after i32.const.')
    moduleBudget.initializerInstructions = expectSafeAdd(
      moduleBudget.initializerInstructions,
      2,
      MAX_MODULE_INITIALIZER_INSTRUCTIONS,
      'WebAssembly module initializer instruction count',
    )
  }

  function readElementExpression(reader: ByteReader, functionCount: number, moduleBudget: ModuleBudget): void {
    const opcode = reader.byte()
    if (opcode === 0xd2) {
      if (reader.u32() >= functionCount) fail('Element ref.func index is out of range.')
    } else if (opcode === 0xd0) {
      if (reader.byte() !== FUNCREF) fail('Element ref.null must use funcref.')
    } else {
      fail('Element initializer must be ref.func or ref.null funcref.')
    }
    if (reader.byte() !== 0x0b) fail('Element initializer must contain exactly one reference opcode.')
    moduleBudget.initializerInstructions = expectSafeAdd(
      moduleBudget.initializerInstructions,
      2,
      MAX_MODULE_INITIALIZER_INSTRUCTIONS,
      'WebAssembly module initializer instruction count',
    )
  }

  function readElements(
    reader: ByteReader,
    tables: readonly TableType[],
    functionCount: number,
    budget: DeclarationBudget,
    moduleBudget: ModuleBudget,
  ): number {
    const count = reader.u32()
    if (count > MAX_ELEMENT_SEGMENTS) fail(`WebAssembly element segment count exceeds ${MAX_ELEMENT_SEGMENTS}.`)
    chargeRaw(budget, count)
    for (let segmentIndex = 0; segmentIndex < count; segmentIndex++) {
      const flags = reader.u32()
      if (flags > 7) fail('Unsupported WebAssembly element segment flags.')
      if (flags === 0 || flags === 4) {
        if (!tables[0]) fail('Active element segment references missing table 0.')
        readOffsetExpression(reader, moduleBudget)
      } else if (flags === 2 || flags === 6) {
        if (!tables[reader.u32()]) fail('Active element segment table index is out of range.')
        readOffsetExpression(reader, moduleBudget)
      }
      const expressionItems = flags >= 4
      if ((flags === 1 || flags === 2 || flags === 3) && reader.byte() !== 0x00) {
        fail('Legacy element segments must use funcref element kind.')
      }
      if ((flags === 5 || flags === 6 || flags === 7) && reader.byte() !== FUNCREF) {
        fail('Element expressions must declare funcref.')
      }
      const itemCount = reader.u32()
      moduleBudget.elementItems = expectSafeAdd(
        moduleBudget.elementItems,
        itemCount,
        MAX_ELEMENT_ITEMS,
        'WebAssembly element item count',
      )
      for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
        if (expressionItems) readElementExpression(reader, functionCount, moduleBudget)
        else if (reader.u32() >= functionCount) fail('Element function index is out of range.')
      }
    }
    reader.expectDone('element section')
    return count
  }

  function readBlockType(reader: ByteReader, types: readonly FunctionType[], migration: boolean): void {
    const first = reader.peek()
    if (first === 0x40) {
      reader.byte()
      return
    }
    if ([I32, I64, F32, F64, V128].includes(first)) {
      readValueType(reader, migration, 'WebAssembly block')
      return
    }
    const typeIndex = reader.signed(33)
    if (typeIndex < 0n || typeIndex >= BigInt(types.length)) fail('Block type index is out of range.')
  }

  function readMemoryArgument(reader: ByteReader): void {
    const alignment = reader.u32()
    if (alignment > 32) fail('WebAssembly memory alignment exponent exceeds 32.')
    reader.u32()
  }

  function expectIndex(index: number, count: number, label: string): void {
    if (index >= count) fail(`${label} index is out of range.`)
  }

  function readMiscellaneousImmediate(
    reader: ByteReader,
    grammar: string,
    tables: readonly TableType[],
    elementCount: number,
    dataCount: number | undefined,
  ): boolean {
    let usesData = false
    const table = (): void => expectIndex(reader.u32(), tables.length, 'WebAssembly table')
    const data = (): void => {
      if (dataCount === undefined) fail('Bulk-memory data instructions require a preceding data-count section.')
      expectIndex(reader.u32(), dataCount, 'WebAssembly data segment')
      usesData = true
    }
    if (grammar === 'data-memory') {
      data()
      if (reader.u32() !== 0) fail('memory.init must select memory zero.')
    } else if (grammar === 'data') data()
    else if (grammar === 'memory-memory') {
      if (reader.u32() !== 0 || reader.u32() !== 0) fail('memory.copy must select memory zero twice.')
    } else if (grammar === 'memory') {
      if (reader.u32() !== 0) fail('memory.fill must select memory zero.')
    } else if (grammar === 'element-table') {
      expectIndex(reader.u32(), elementCount, 'WebAssembly element segment')
      table()
    } else if (grammar === 'element') expectIndex(reader.u32(), elementCount, 'WebAssembly element segment')
    else if (grammar === 'table-table') {
      table()
      table()
    } else if (grammar === 'table') table()
    return usesData
  }

  function readSimdImmediate(reader: ByteReader, grammar: string): void {
    if (grammar === 'memory-argument') readMemoryArgument(reader)
    else if (grammar === 'bytes-16') reader.bytes(16)
    else if (grammar === 'shuffle-16') {
      for (const lane of reader.bytes(16)) if (lane >= 32) fail('SIMD shuffle lane is out of range.')
    } else if (grammar.startsWith('lane-')) {
      const laneCount = Number(grammar.slice(5))
      if (reader.byte() >= laneCount) fail('SIMD lane is out of range.')
    } else if (grammar.startsWith('memory-lane-')) {
      const laneCount = Number(grammar.slice(12))
      readMemoryArgument(reader)
      if (reader.byte() >= laneCount) fail('SIMD memory lane is out of range.')
    }
  }

  function readFunctionBody(
    body: ByteReader,
    functionType: FunctionType,
    functionCount: number,
    types: readonly FunctionType[],
    tables: readonly TableType[],
    globals: readonly GlobalType[],
    elementCount: number,
    dataCount: number | undefined,
    opcodeTable: PluginWasmOpcodeTableArtifact,
    migration: boolean,
    declarationBudget: DeclarationBudget,
    moduleBudget: ModuleBudget,
  ): boolean {
    const localGroupCount = body.u32()
    chargeRaw(declarationBudget, localGroupCount)
    let localCount = 0
    for (let groupIndex = 0; groupIndex < localGroupCount; groupIndex++) {
      localCount = expectSafeAdd(
        localCount,
        body.u32(),
        MAX_LOCALS_PER_FUNCTION,
        'WebAssembly function local count',
      )
      readValueType(body, migration, 'WebAssembly local')
    }
    if (functionType.parameters.length > MAX_LOCALS_PER_FUNCTION - localCount) {
      fail(`WebAssembly function parameter-plus-local count exceeds ${MAX_LOCALS_PER_FUNCTION}.`)
    }
    chargeRuntimeSlots(declarationBudget, localCount)

    const control: Array<{ kind: number; elseSeen: boolean }> = [{ kind: -1, elseSeen: false }]
    let instructionCount = 0
    let branchTableLabels = 0
    let usesData = false
    while (true) {
      instructionCount++
      if (instructionCount > MAX_BODY_INSTRUCTIONS) {
        fail(`WebAssembly function instruction count exceeds ${MAX_BODY_INSTRUCTIONS}.`)
      }
      const opcode = body.byte()
      const grammar = opcodeTable.primary[String(opcode)]
      if (grammar === undefined) fail(`WebAssembly opcode 0x${opcode.toString(16)} is outside the selected profile.`)

      if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
        readBlockType(body, types, migration)
        if (control.length - 1 >= MAX_CONTROL_DEPTH) {
          fail(`WebAssembly control depth exceeds ${MAX_CONTROL_DEPTH}.`)
        }
        control.push({ kind: opcode, elseSeen: false })
        continue
      }
      if (opcode === 0x05) {
        const frame = control[control.length - 1]
        if (!frame || frame.kind !== 0x04 || frame.elseSeen) fail('WebAssembly else does not match a fresh if.')
        frame.elseSeen = true
        continue
      }
      if (opcode === 0x0b) {
        control.pop()
        if (control.length === 0) {
          body.expectDone('function body')
          break
        }
        continue
      }

      if (grammar === 'branch') expectIndex(body.u32(), control.length, 'WebAssembly branch label')
      else if (grammar === 'branch-table') {
        const labelCount = body.u32()
        if (labelCount > MAX_BRANCH_TABLE_LABELS) {
          fail(`WebAssembly branch-table label count exceeds ${MAX_BRANCH_TABLE_LABELS}.`)
        }
        branchTableLabels = expectSafeAdd(
          branchTableLabels,
          labelCount,
          MAX_BODY_BRANCH_TABLE_LABELS,
          'WebAssembly function branch-table label count',
        )
        for (let index = 0; index < labelCount; index++) {
          expectIndex(body.u32(), control.length, 'WebAssembly branch label')
        }
        expectIndex(body.u32(), control.length, 'WebAssembly branch default label')
      } else if (grammar === 'call') expectIndex(body.u32(), functionCount, 'WebAssembly function')
      else if (grammar === 'call-indirect') {
        expectIndex(body.u32(), types.length, 'WebAssembly type')
        expectIndex(body.u32(), tables.length, 'WebAssembly table')
      } else if (grammar === 'typed-select') {
        if (body.u32() !== 1) fail('Typed select must declare exactly one result type.')
        readValueType(body, migration, 'WebAssembly typed select')
      } else if (grammar === 'local') {
        expectIndex(body.u32(), functionType.parameters.length + localCount, 'WebAssembly local')
      } else if (grammar === 'global') expectIndex(body.u32(), globals.length, 'WebAssembly global')
      else if (grammar === 'table') expectIndex(body.u32(), tables.length, 'WebAssembly table')
      else if (grammar === 'memory-argument') readMemoryArgument(body)
      else if (grammar === 'memory-index' && body.u32() !== 0) fail('Memory instruction must select memory zero.')
      else if (grammar === 'i32') body.signed(32)
      else if (grammar === 'i64') body.signed(64)
      else if (grammar === 'f32') body.bytes(4)
      else if (grammar === 'f64') body.bytes(8)
      else if (grammar === 'reference-type' && body.byte() !== FUNCREF) fail('ref.null must use funcref.')
      else if (grammar === 'reference-function') expectIndex(body.u32(), functionCount, 'WebAssembly function')

      if (opcode === 0xfc) {
        const subopcode = body.u32()
        const miscellaneousGrammar = opcodeTable.miscellaneous[String(subopcode)]
        if (miscellaneousGrammar === undefined) {
          fail(`WebAssembly 0xfc subopcode ${subopcode} is outside the selected profile.`)
        }
        usesData = readMiscellaneousImmediate(
          body,
          miscellaneousGrammar,
          tables,
          elementCount,
          dataCount,
        ) || usesData
      } else if (opcode === 0xfd) {
        const subopcode = body.u32()
        const simdGrammar = opcodeTable.simd[String(subopcode)]
        if (simdGrammar === undefined) {
          fail(`WebAssembly SIMD subopcode ${subopcode} is outside the selected profile.`)
        }
        readSimdImmediate(body, simdGrammar)
      }
    }
    moduleBudget.instructions = expectSafeAdd(
      moduleBudget.instructions,
      instructionCount,
      MAX_MODULE_INSTRUCTIONS,
      'WebAssembly module instruction count',
    )
    moduleBudget.branchTableLabels = expectSafeAdd(
      moduleBudget.branchTableLabels,
      branchTableLabels,
      MAX_MODULE_BRANCH_TABLE_LABELS,
      'WebAssembly module branch-table label count',
    )
    return usesData
  }

  function readCode(
    reader: ByteReader,
    functionTypeIndexes: readonly number[],
    types: readonly FunctionType[],
    tables: readonly TableType[],
    globals: readonly GlobalType[],
    elementCount: number,
    dataCount: number | undefined,
    opcodeTable: PluginWasmOpcodeTableArtifact,
    migration: boolean,
    declarationBudget: DeclarationBudget,
    moduleBudget: ModuleBudget,
  ): boolean {
    if (reader.u32() !== functionTypeIndexes.length) {
      fail('The code-body count must equal the defined-function count.')
    }
    let usesData = false
    for (let index = 0; index < functionTypeIndexes.length; index++) {
      const bodyLength = reader.u32()
      if (bodyLength > MAX_CODE_BODY_BYTES) {
        fail(`WebAssembly code body byte length exceeds ${MAX_CODE_BODY_BYTES}.`)
      }
      moduleBudget.codeBytes = expectSafeAdd(
        moduleBudget.codeBytes,
        bodyLength,
        MAX_CODE_BYTES,
        'WebAssembly aggregate code-body byte length',
      )
      usesData = readFunctionBody(
        reader.subreader(bodyLength),
        types[functionTypeIndexes[index]]!,
        functionTypeIndexes.length,
        types,
        tables,
        globals,
        elementCount,
        dataCount,
        opcodeTable,
        migration,
        declarationBudget,
        moduleBudget,
      ) || usesData
    }
    reader.expectDone('code section')
    return usesData
  }

  function readData(reader: ByteReader, budget: DeclarationBudget, moduleBudget: ModuleBudget): number {
    const count = reader.u32()
    if (count > MAX_DATA_SEGMENTS) fail(`WebAssembly data segment count exceeds ${MAX_DATA_SEGMENTS}.`)
    chargeRaw(budget, count)
    for (let index = 0; index < count; index++) {
      if (reader.u32() !== 1) fail('Only passive WebAssembly data segments are accepted.')
      const byteLength = reader.u32()
      moduleBudget.passiveDataBytes = expectSafeAdd(
        moduleBudget.passiveDataBytes,
        byteLength,
        MAX_PASSIVE_DATA_BYTES,
        'WebAssembly passive data byte length',
      )
      reader.bytes(byteLength)
    }
    reader.expectDone('data section')
    return count
  }

  function isExactSignature(type: FunctionType | undefined, parameterCount: number): boolean {
    return type !== undefined
      && type.parameters.length === parameterCount
      && type.parameters.every((value) => value === I32)
      && type.results.length === 1
      && type.results[0] === I32
  }

  function parsePluginWasmModule(
    moduleBytes: Uint8Array,
    expectations: PluginWasmModuleExpectations,
  ): PluginWasmModuleFacts {
    if (!(moduleBytes instanceof Uint8Array)) fail('WebAssembly module bytes must be a Uint8Array.')
    if (expectations.policy.binaryPolicyVersion !== environment.binaryPolicyVersion) {
      fail('Unsupported WebAssembly binary-policy version.')
    }
    const opcodeTable = environment.opcodeTables[expectations.policy.profileId]
    const opcodeTableDigest = environment.opcodeTableDigests[expectations.policy.profileId]
    if (!opcodeTable || !opcodeTableDigest) fail('Unknown WebAssembly binary-policy profile.')
    if (expectations.opcodeTableDigest !== undefined
      && expectations.opcodeTableDigest !== opcodeTableDigest) {
      fail('WebAssembly opcode-table digest does not match the selected profile.')
    }
    const migration = expectations.policy.profileId === 'myrelith-wasm-migration-integer-v1'
    if (!migration && expectations.migrationEntrypoints.length !== 0) {
      fail('Render-general modules cannot declare migration entrypoints.')
    }
    if (!Number.isInteger(expectations.memoryMaximumPages)
      || expectations.memoryMaximumPages < MIN_MEMORY_PAGES
      || expectations.memoryMaximumPages > MAX_MEMORY_PAGES) {
      fail(`WebAssembly memory pages must be between ${MIN_MEMORY_PAGES} and ${MAX_MEMORY_PAGES}.`)
    }
    const expectedEntrypoints = [...expectations.renderEntrypoints, ...expectations.migrationEntrypoints]
    if (new Set(expectedEntrypoints).size !== expectedEntrypoints.length) {
      fail('Signed WebAssembly entrypoint names must be unique.')
    }

    const reader = new ByteReader(moduleBytes)
    expectBytes(reader, WASM_MAGIC, 'magic')
    expectBytes(reader, WASM_VERSION_1, 'version')
    const declarationBudget: DeclarationBudget = { rawEntries: 0, expandedSignatureFields: 0, runtimeSlots: 0 }
    const moduleBudget: ModuleBudget = {
      instructions: 0,
      branchTableLabels: 0,
      initializerInstructions: 0,
      codeBytes: 0,
      passiveDataBytes: 0,
      elementItems: 0,
    }

    const sectionRanks: Readonly<Record<number, number>> = {
      1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 12: 10, 10: 11, 11: 12,
    }
    let previousRank = 0
    let types: readonly FunctionType[] | undefined
    let importedMemory: PluginWasmModuleFacts['importedMemory'] | undefined
    let functionTypeIndexes: readonly number[] | undefined
    let tables: readonly TableType[] = Object.freeze([])
    let globals: readonly GlobalType[] = Object.freeze([])
    let exports: readonly FunctionExport[] | undefined
    let elementCount = 0
    let declaredDataCount: number | undefined
    let dataSegmentCount = 0
    let usesDataInstructions = false
    let sawCode = false
    let sawData = false

    while (!reader.done) {
      const sectionId = reader.byte()
      const rank = sectionRanks[sectionId]
      if (rank === undefined || rank <= previousRank) {
        fail('Custom, duplicate, unsupported, or out-of-order sections are not accepted.')
      }
      previousRank = rank
      const section = reader.subreader(reader.u32())
      if (sectionId === 1) types = readTypes(section, declarationBudget, migration)
      else if (sectionId === 2) importedMemory = readFixedMemoryImport(section, expectations.memoryMaximumPages, declarationBudget)
      else if (sectionId === 3) {
        if (!types) fail('The type section must precede the function section.')
        functionTypeIndexes = readFunctionTypeIndexes(section, declarationBudget, types)
      } else if (sectionId === 4) tables = readTables(section, declarationBudget)
      else if (sectionId === 5) readZeroDefinedMemories(section, declarationBudget)
      else if (sectionId === 6) globals = readGlobals(section, declarationBudget, moduleBudget, migration)
      else if (sectionId === 7) exports = readExports(section, declarationBudget)
      else if (sectionId === 8) fail('WebAssembly start functions are forbidden.')
      else if (sectionId === 9) {
        if (!functionTypeIndexes) fail('The function section must precede elements.')
        elementCount = readElements(section, tables, functionTypeIndexes.length, declarationBudget, moduleBudget)
      } else if (sectionId === 12) {
        declaredDataCount = section.u32()
        if (declaredDataCount > MAX_DATA_SEGMENTS) fail(`WebAssembly data segment count exceeds ${MAX_DATA_SEGMENTS}.`)
        section.expectDone('data-count section')
      } else if (sectionId === 10) {
        if (!types || !functionTypeIndexes) fail('Type and function sections must precede code.')
        usesDataInstructions = readCode(
          section,
          functionTypeIndexes,
          types,
          tables,
          globals,
          elementCount,
          declaredDataCount,
          opcodeTable,
          migration,
          declarationBudget,
          moduleBudget,
        )
        sawCode = true
      } else if (sectionId === 11) {
        dataSegmentCount = readData(section, declarationBudget, moduleBudget)
        sawData = true
      }
    }

    if (!types || !importedMemory || !functionTypeIndexes || !exports || !sawCode) {
      fail('The WebAssembly plugin module is missing a required section.')
    }
    if (declaredDataCount !== undefined && declaredDataCount !== dataSegmentCount) {
      fail('The WebAssembly data-count section does not match the data section.')
    }
    if (usesDataInstructions && declaredDataCount === undefined) {
      fail('Bulk-memory data instructions require a data-count section.')
    }
    if (!sawData && declaredDataCount !== undefined && declaredDataCount !== 0) {
      fail('A nonzero data-count requires a data section.')
    }
    if (exports.length !== expectedEntrypoints.length) {
      fail('Exported functions must exactly match signed plugin entrypoints.')
    }
    for (const exported of exports) {
      expectIndex(exported.functionIndex, functionTypeIndexes.length, 'Exported WebAssembly function')
      const type = types[functionTypeIndexes[exported.functionIndex]]
      if (expectations.renderEntrypoints.includes(exported.name)) {
        if (!isExactSignature(type, 10)) fail(`Render export ${exported.name} has the wrong signature.`)
      } else if (expectations.migrationEntrypoints.includes(exported.name)) {
        if (!isExactSignature(type, 6)) fail(`Migration export ${exported.name} has the wrong signature.`)
      } else {
        fail(`Unsigned WebAssembly export ${exported.name}.`)
      }
    }
    for (const expectedName of expectedEntrypoints) {
      if (!exports.some((entry) => entry.name === expectedName)) fail(`Missing signed WebAssembly export ${expectedName}.`)
    }

    return Object.freeze({
      policy: Object.freeze({ ...expectations.policy }),
      opcodeTableDigest,
      importedMemory,
      definedFunctionCount: functionTypeIndexes.length,
      tableCount: tables.length,
      elementSegmentCount: elementCount,
      dataSegmentCount,
      exportedFunctions: Object.freeze(exports.map((entry) => entry.name)),
    })
  }

  return parsePluginWasmModule
}

const parseWithVersionOnePolicy = createPluginWasmPolicyParser({
  binaryPolicyVersion: PLUGIN_WASM_BINARY_POLICY_VERSION,
  opcodeTables: PLUGIN_WASM_OPCODE_TABLE_ARTIFACTS,
  opcodeTableDigests: PLUGIN_WASM_OPCODE_TABLE_DIGESTS,
})

/** Parse attacker-authored module bytes inside the disposable candidate worker. */
export function parsePluginWasmModule(
  moduleBytes: Uint8Array,
  expectations: PluginWasmModuleExpectations,
): PluginWasmModuleFacts {
  try {
    return parseWithVersionOnePolicy(moduleBytes, expectations)
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'PluginWasmPolicyError') {
      throw new PluginWasmPolicyError(cause.message)
    }
    throw cause
  }
}
