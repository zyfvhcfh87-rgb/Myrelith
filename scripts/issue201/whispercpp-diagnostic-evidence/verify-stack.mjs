// Static byte and saved-disassembly review only; no native execution or rebuild.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { inspectBinary } from '../whispercpp-review/inspect-binary.mjs'

const root = new URL('../../../', import.meta.url)
const read = name => readFileSync(new URL(name, root))
const bytes = gunzipSync(read('docs/evidence/issue201/whispercpp-generated/myrelith-whisper.wasm.gz'))
const sha256 = createHash('sha256').update(bytes).digest('hex')
assert.equal(sha256, '9df26c6b690de120e6f1fb5ce17a25ebb2b016a73f0477b24376f558ee00ce72')
const binary = inspectBinary(bytes), code = binary.sections.find(section => section.id === 10)
assert.ok(code)
let position = code.offset
function u32() {
  let value = 0
  for (let i = 0; i < 5; i++) {
    assert.ok(position < bytes.length)
    const byte = bytes[position++]; value += (byte & 127) * 2 ** (7 * i)
    if (byte < 128) { assert.ok(value <= 0xffffffff); return value }
  }
  throw new Error('Invalid u32')
}
const count = u32(), bodies = new Map()
assert.equal(binary.imports.length, 59); assert.equal(count, 1309)
for (let index = binary.imports.length; index < binary.imports.length + count; index++) {
  const size = u32(), start = position, end = start + size
  assert.ok(end <= bytes.length); bodies.set(index, { start, end }); position = end
}
assert.equal(position, code.offset + code.bytes)
function observedCall(index, offset, target) {
  const body = bodies.get(index)
  assert.ok(offset >= body.start && offset < body.end)
  assert.equal(bytes[offset], 0x10)
  position = offset + 1
  assert.equal(u32(), target)
  return { caller: index, byteOffset: offset, byteOffsetHex: '0x' + offset.toString(16), target,
    bytes: bytes.subarray(offset, position).toString('hex'), body }
}
// These are captured instruction offsets, not guessed symbol offsets. Read the
// saved WAT alongside the source for semantic identification; a byte search is
// not a general instruction decoder and the optimized module has no names.
const calls = [observedCall(198, 0xd607, 542), observedCall(198, 0xd613, 540), observedCall(540, 0x473b5, 219)]
const wat = index => gunzipSync(read(`docs/evidence/issue201/whispercpp-null-buffer-source/function-${index}.wat.gz`)).toString()
const allocation = wat(540), scheduler = wat(198), base = wat(219)
assert.ok(base.startsWith(' (func $160 (param $0 i32) (result i32)'))
assert.match(base, /\(i32.const 124\)/)
assert.match(base, /\(i32.const 138\)/)
assert.equal([...allocation.matchAll(/\(call \$160\b/g)].length, 3)
assert.equal([...scheduler.matchAll(/\(call \$481\b/g)].length, 2)
assert.match(scheduler, /\(drop\s+\(call \$483/)
const original = JSON.parse(read('docs/evidence/issue201/whispercpp-runtime-run-02/runtime-results-02.json'))
const stack = original.results.at(-1).failedState.events.find(event => event.type === 'native-diagnostics')
  .detail.records.find(row => row.kind === 'exception').text
assert.match(stack, /wasm-function\[540\]:0x473b5/)
assert.match(stack, /wasm-function\[198\]:0xd613/)
process.stdout.write(JSON.stringify({ status: 'static-captured-offsets-verified', wasmSha256: sha256,
  importedFunctions: binary.imports.length, definedFunctions: count, calls,
  optimizedModuleSymbolNamesAvailable: false,
  mappingQualification: 'Source identities come from matching control flow, data accesses and assertion literals in saved disassembly, not a debug symbol table.',
  ignoredReserveReturnVisible: true, observedAllocationCall: 'second scheduler call; first get-base call in graph allocator leaf loop',
  reserveReturnValueObserved: false, failedAllocationSizeObserved: false,
  heapExhaustionProven: false, wasmExecuted: false, compiled: false }, null, 2) + '\n')
