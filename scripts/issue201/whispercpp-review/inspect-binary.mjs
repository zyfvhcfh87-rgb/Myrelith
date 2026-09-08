/** Structural byte inspection only. Never use a WebAssembly engine/API.
 * This bounded reader covers the generated profile's metadata; it does not
 * validate function instructions or replace the separate runtime gate.
 * Format authority: https://webassembly.github.io/spec/core/binary/modules.html
 */
import assert from 'node:assert/strict';

class Reader {
  constructor(bytes) { this.bytes = bytes; this.position = 0; }
  byte() { assert.ok(this.position < this.bytes.length, 'truncated binary'); return this.bytes[this.position++]; }
  take(count) {
    assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= this.bytes.length - this.position, 'truncated range');
    const bytes = this.bytes.subarray(this.position, this.position + count); this.position += count; return bytes;
  }
  u32() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte(); value += (byte & 127) * 2 ** (i * 7);
      if (byte < 128) { assert.ok(value <= 0xffffffff, 'u32 overflow'); return value; }
    }
    throw Error('overlong u32');
  }
  s32() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte(), shift = (i + 1) * 7; value += (byte & 127) * 2 ** (i * 7);
      if (byte < 128) {
        if (byte & 64) value -= 2 ** shift;
        assert.ok(value >= -0x80000000 && value <= 0x7fffffff, 'i32 overflow'); return value;
      }
    }
    throw Error('overlong i32');
  }
  name() { const size = this.u32(); assert.ok(size <= 256, 'metadata name budget'); return new TextDecoder('utf-8', { fatal: true }).decode(this.take(size)); }
  vector(read) { const size = this.u32(); assert.ok(size <= 100000, 'oversized vector'); return Array.from({ length: size }, () => read()); }
  done() { assert.equal(this.position, this.bytes.length, 'unconsumed section bytes'); }
}

const typeNames = new Map([[0x7f, 'i32'], [0x7e, 'i64'], [0x7d, 'f32'], [0x7c, 'f64'],
  [0x7b, 'v128'], [0x70, 'funcref'], [0x6f, 'externref']]);
function type(reader) { const value = typeNames.get(reader.byte()); assert.ok(value, 'unsupported metadata type'); return value; }
function limits(reader) {
  const flags = reader.byte(); assert.ok(flags === 0 || flags === 1, 'unsupported/shared/memory64 limits');
  const initial = reader.u32(), maximum = flags === 1 ? reader.u32() : null;
  if (maximum !== null) assert.ok(maximum >= initial, 'inverted limits');
  return { flags, initial, maximum };
}

export function inspectBinary(bytes) {
  assert.ok(bytes instanceof Uint8Array && bytes.length <= 16 * 1024 * 1024, 'binary byte budget');
  const reader = new Reader(bytes);
  assert.deepEqual([...reader.take(8)], [0, 97, 115, 109, 1, 0, 0, 0], 'WASM header');
  const sections = [], byId = new Map();
  const order = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11]; let rank = -1;
  while (reader.position < bytes.length) {
    assert.ok(sections.length < 64, 'section count budget');
    const id = reader.byte(), size = reader.u32(), offset = reader.position, payload = reader.take(size);
    if (id !== 0) {
      const next = order.indexOf(id); assert.ok(next > rank, 'duplicate/out-of-order section'); rank = next;
      byId.set(id, payload);
    }
    sections.push({ id, offset, bytes: size });
  }
  function section(id, read, fallback = []) {
    if (!byId.has(id)) return fallback;
    const source = new Reader(byId.get(id)), result = read(source); source.done(); return result;
  }
  const types = section(1, r => r.vector(() => {
    assert.equal(r.byte(), 0x60, 'only plain function types expected');
    return { parameters: r.vector(() => type(r)), results: r.vector(() => type(r)) };
  }));
  const imports = section(2, r => r.vector(() => {
    const module = r.name(), name = r.name(), kind = r.byte();
    assert.equal(kind, 0, 'non-function import (memory/table/global/tag) is forbidden');
    const typeIndex = r.u32(); assert.ok(types[typeIndex], 'unknown imported type');
    return { module, name, kind, typeIndex, ...types[typeIndex] };
  }));
  const functions = section(3, r => r.vector(() => { const i = r.u32(); assert.ok(types[i], 'unknown function type'); return i; }));
  const tables = section(4, r => r.vector(() => ({ type: type(r), ...limits(r) })));
  const memories = section(5, r => r.vector(() => limits(r)));
  assert.deepEqual(memories, [{ flags: 1, initial: 1024, maximum: 8192 }], 'exact defined unshared 64/512 MiB memory');
  const globals = section(6, r => r.vector(() => {
    const valueType = type(r), mutable = r.byte(); assert.equal(valueType, 'i32'); assert.ok(mutable <= 1);
    assert.equal(r.byte(), 0x41, 'constant i32 initializer expected');
    const initial = r.s32(); assert.equal(r.byte(), 0x0b); return { type: valueType, mutable, initial };
  }));
  const exports = section(7, r => r.vector(() => {
    const name = r.name(), kind = r.byte(), index = r.u32();
    if (kind === 0) {
      const typeIndex = index < imports.length ? imports[index].typeIndex : functions[index - imports.length];
      assert.ok(types[typeIndex], 'exported function index'); return { name, kind, index, ...types[typeIndex] };
    }
    assert.ok(kind === 1 && index < tables.length || kind === 2 && index < memories.length || kind === 3 && index < globals.length,
      'export index/kind');
    return { name, kind, index };
  }));
  assert.equal(new Set(exports.map(e => e.name)).size, exports.length, 'duplicate export');
  assert.equal(byId.has(8), false, 'no implicit binary start function');
  const bodies = section(10, r => r.vector(() => {
    const size = r.u32(), body = r.take(size);
    return { bytes: size, prefix: [...body.subarray(0, 16)] };
  }));
  assert.equal(bodies.length, functions.length, 'function/code counts');
  const exportedBodies = exports.filter(e => e.kind === 0 && e.index >= imports.length)
    .map(e => ({ name: e.name, index: e.index, ...bodies[e.index - imports.length] }));
  return { bytes: bytes.length, sections, types: types.length, imports, exports, tables, memories, globals,
    exportedBodies, definedFunctions: functions.length, functionInstructionsValidated: false, wasmExecuted: false };
}
