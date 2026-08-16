export const AUDITED_INVERT_EXPORT = 'myrelith_effect_audited_invert'
export const AUDITED_INVERT_MEMORY_PAGES = 1_025
export const AUDITED_INVERT_PARAMETER_POINTER = 0x0100_0000
export const AUDITED_INVERT_PIXEL_POINTER = 0x0101_0000
export const AUDITED_INVERT_TRUE_PARAMETERS = '{"invert":true}'
export const AUDITED_INVERT_FALSE_PARAMETERS = '{"invert":false}'

const I32 = 0x7f
const EMPTY_BLOCK = 0x40
const OPCODE = Object.freeze({
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  branch: 0x0c,
  branchIf: 0x0d,
  return: 0x0f,
  localGet: 0x20,
  localSet: 0x21,
  load32: 0x28,
  load8Unsigned: 0x2d,
  load16Unsigned: 0x2f,
  store8: 0x3a,
  const32: 0x41,
  equalZero: 0x45,
  equal: 0x46,
  greaterOrEqualUnsigned: 0x4f,
  add: 0x6a,
  multiply: 0x6c,
  and: 0x71,
  xor: 0x73,
})

const WASM_HEADER = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)

function concat(parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function unsignedLeb(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('unsigned Wasm integer is out of range')
  }
  const output = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 0x80)
    if (remaining !== 0) byte |= 0x80
    output.push(byte)
  } while (remaining !== 0)
  return Uint8Array.from(output)
}

function signedLeb32(value) {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError('signed Wasm i32 is out of range')
  }
  const output = []
  let remaining = value | 0
  let complete = false
  while (!complete) {
    let byte = remaining & 0x7f
    remaining >>= 7
    complete = (remaining === 0 && (byte & 0x40) === 0)
      || (remaining === -1 && (byte & 0x40) !== 0)
    if (!complete) byte |= 0x80
    output.push(byte)
  }
  return Uint8Array.from(output)
}

function utf8(value) {
  return new TextEncoder().encode(value)
}

function wasmName(value) {
  const encoded = utf8(value)
  return concat([unsignedLeb(encoded.byteLength), encoded])
}

function vector(items) {
  return concat([unsignedLeb(items.length), ...items])
}

function section(id, payload) {
  return concat([Uint8Array.of(id), unsignedLeb(payload.byteLength), payload])
}

function op(code, ...immediates) {
  return concat([Uint8Array.of(code), ...immediates])
}

function localGet(index) {
  return op(OPCODE.localGet, unsignedLeb(index))
}

function localSet(index) {
  return op(OPCODE.localSet, unsignedLeb(index))
}

function i32Const(value) {
  return op(OPCODE.const32, signedLeb32(value))
}

function loadEqual(localIndex, offset, value, width) {
  const [opcode, alignment] = width === 4
    ? [OPCODE.load32, 2]
    : width === 2
      ? [OPCODE.load16Unsigned, 1]
      : [OPCODE.load8Unsigned, 0]
  return concat([
    localGet(localIndex),
    op(opcode, unsignedLeb(alignment), unsignedLeb(offset)),
    i32Const(value),
    op(OPCODE.equal),
  ])
}

function everyCondition(conditions) {
  const output = []
  for (const [index, condition] of conditions.entries()) {
    output.push(condition)
    if (index > 0) output.push(op(OPCODE.and))
  }
  return concat(output)
}

function returnCode(code) {
  return concat([i32Const(code), op(OPCODE.return)])
}

function parameterBytesAreFalse() {
  return everyCondition([
    loadEqual(8, 0, 0x6e69_227b, 4),
    loadEqual(8, 4, 0x7472_6576, 4),
    loadEqual(8, 8, 0x6166_3a22, 4),
    loadEqual(8, 12, 0x7d65_736c, 4),
  ])
}

function parameterBytesAreTrue() {
  return everyCondition([
    loadEqual(8, 0, 0x6e69_227b, 4),
    loadEqual(8, 4, 0x7472_6576, 4),
    loadEqual(8, 8, 0x7274_3a22, 4),
    loadEqual(8, 12, 0x6575, 2),
    loadEqual(8, 14, 0x7d, 1),
  ])
}

function invertChannel(offset) {
  return concat([
    localGet(0),
    localGet(0),
    op(OPCODE.load8Unsigned, unsignedLeb(0), unsignedLeb(offset)),
    i32Const(255),
    op(OPCODE.xor),
    op(OPCODE.store8, unsignedLeb(0), unsignedLeb(offset)),
  ])
}

function renderInstructions() {
  const pointersAreCanonical = everyCondition([
    concat([localGet(0), i32Const(AUDITED_INVERT_PIXEL_POINTER), op(OPCODE.equal)]),
    concat([localGet(8), i32Const(AUDITED_INVERT_PARAMETER_POINTER), op(OPCODE.equal)]),
  ])

  return concat([
    pointersAreCanonical,
    op(OPCODE.equalZero),
    op(OPCODE.if, Uint8Array.of(EMPTY_BLOCK)),
    returnCode(2),
    op(OPCODE.end),

    localGet(9),
    i32Const(utf8(AUDITED_INVERT_FALSE_PARAMETERS).byteLength),
    op(OPCODE.equal),
    op(OPCODE.if, Uint8Array.of(EMPTY_BLOCK)),
    parameterBytesAreFalse(),
    op(OPCODE.if, Uint8Array.of(EMPTY_BLOCK)),
    returnCode(1),
    op(OPCODE.else),
    returnCode(2),
    op(OPCODE.end),
    op(OPCODE.end),

    localGet(9),
    i32Const(utf8(AUDITED_INVERT_TRUE_PARAMETERS).byteLength),
    op(OPCODE.equal),
    op(OPCODE.if, Uint8Array.of(EMPTY_BLOCK)),
    parameterBytesAreTrue(),
    op(OPCODE.equalZero),
    op(OPCODE.if, Uint8Array.of(EMPTY_BLOCK)),
    returnCode(2),
    op(OPCODE.end),
    op(OPCODE.else),
    returnCode(2),
    op(OPCODE.end),

    localGet(0),
    localGet(3),
    localGet(2),
    op(OPCODE.multiply),
    op(OPCODE.add),
    localSet(10),

    op(OPCODE.block, Uint8Array.of(EMPTY_BLOCK)),
    op(OPCODE.loop, Uint8Array.of(EMPTY_BLOCK)),
    localGet(0),
    localGet(10),
    op(OPCODE.greaterOrEqualUnsigned),
    op(OPCODE.branchIf, unsignedLeb(1)),
    invertChannel(0),
    invertChannel(1),
    invertChannel(2),
    localGet(0),
    i32Const(4),
    op(OPCODE.add),
    localSet(0),
    op(OPCODE.branch, unsignedLeb(0)),
    op(OPCODE.end),
    op(OPCODE.end),
    i32Const(0),
    op(OPCODE.end),
  ])
}

export function buildAuditedInvertModule() {
  const renderType = concat([
    Uint8Array.of(0x60),
    unsignedLeb(10),
    new Uint8Array(10).fill(I32),
    unsignedLeb(1),
    Uint8Array.of(I32),
  ])
  const memoryImport = concat([
    wasmName('myrelith'),
    wasmName('memory'),
    Uint8Array.of(0x02, 0x01),
    unsignedLeb(AUDITED_INVERT_MEMORY_PAGES),
    unsignedLeb(AUDITED_INVERT_MEMORY_PAGES),
  ])
  const functionExport = concat([
    wasmName(AUDITED_INVERT_EXPORT),
    Uint8Array.of(0x00),
    unsignedLeb(0),
  ])
  const localDeclarations = vector([
    concat([unsignedLeb(1), Uint8Array.of(I32)]),
  ])
  const body = concat([localDeclarations, renderInstructions()])
  const encodedBody = concat([unsignedLeb(body.byteLength), body])

  return concat([
    WASM_HEADER,
    section(1, vector([renderType])),
    section(2, vector([memoryImport])),
    section(3, concat([unsignedLeb(1), unsignedLeb(0)])),
    section(7, vector([functionExport])),
    section(10, vector([encodedBody])),
  ])
}
