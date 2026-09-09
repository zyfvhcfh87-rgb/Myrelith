import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';
import { inspectBinary } from './inspect-binary.mjs';
import { inspectGlue } from './inspect-glue.mjs';
import { verifiedWasmLocator } from '../whispercpp/worker-protocol.mjs';

const evidence = new URL('../../../docs/evidence/issue201/whispercpp-generated/', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('artifacts.json', evidence)));
const hash = b => createHash('sha256').update(b).digest('hex');
const artifacts = new Map(pins.artifacts.map(pin => {
  const packed = readFileSync(new URL(pin.packed, evidence)), bytes = gunzipSync(packed);
  assert.equal(packed.length, pin.packedBytes); assert.equal(hash(packed), pin.packedSha256);
  assert.equal(bytes.length, pin.bytes); assert.equal(hash(bytes), pin.sha256);
  return [pin.name, bytes];
}));
const wasm = artifacts.get('myrelith-whisper.wasm');
const js = artifacts.get('myrelith-whisper.mjs').toString('utf8');
const binary = inspectBinary(wasm), glue = inspectGlue(js, binary);

test('actual generated binary defines exactly one bounded unshared wasm32 memory', () => {
  assert.deepEqual(binary.memories, [{ flags: 1, initial: 1024, maximum: 8192 }]);
  assert.equal(binary.imports.length, 59);
  assert.ok(binary.imports.every(i => i.kind === 0));
  assert.equal(binary.exports.filter(i => i.kind === 2).length, 1);
  assert.equal(binary.functionInstructionsValidated, false);
  assert.equal(binary.wasmExecuted, false);
});
test('memory sharing, memory64, unbounded/changed/missing memory and truncation reject', () => {
  const memory = binary.sections.find(s => s.id === 5), flagsOffset = memory.offset + 1;
  for (const flags of [0, 2, 3, 4, 5, 7]) {
    const changed = Buffer.from(wasm); changed[flagsOffset] = flags;
    assert.throws(() => inspectBinary(changed));
  }
  const max = Buffer.from(wasm); max[memory.offset + memory.bytes - 1]++;
  assert.throws(() => inspectBinary(max), /64\/512 MiB/);
  const missing = Buffer.from(wasm); missing[memory.offset] = 0;
  assert.throws(() => inspectBinary(missing));
  assert.throws(() => inspectBinary(wasm.subarray(0, wasm.length - 1)), /truncated/);
});
test('all generated imports resolve and all eleven adapter exports have their C ABI', () => {
  assert.equal(glue.namedImports.length, binary.imports.length);
  assert.equal(glue.namedExports.length, 11);
  assert.equal(glue.memoryExport, 'fa'); assert.equal(glue.tableExport, 'sa');
  assert.deepEqual(binary.tables, [{ type: 'funcref', flags: 1, initial: 1162, maximum: 1162 }]);
  const wrongAbi = structuredClone(binary);
  wrongAbi.exports.find(e => e.name === 'ha').parameters = ['i64'];
  assert.throws(() => inspectGlue(js, wrongAbi), /_speech_model_alloc/);
  const absent = structuredClone(binary); absent.exports = absent.exports.filter(e => e.name !== 'ha');
  assert.throws(() => inspectGlue(js, absent), /_speech_model_alloc/);
});
test('generated stack helpers reference global zero; import signatures and helpers reject drift', () => {
  assert.equal(glue.stack.globalIndex, 0);
  assert.equal(glue.stack.initialPointer, 5923760);
  const wrongStack = structuredClone(binary);
  wrongStack.exportedBodies.find(e => e.name === 'va').prefix[4] = 1;
  assert.throws(() => inspectGlue(js, wrongStack));
  const wrongImport = structuredClone(binary);
  wrongImport.imports.find(e => e.name === 'n').parameters[3] = 'f64';
  assert.throws(() => inspectGlue(js, wrongImport), /invoke_iiij/);
  assert.throws(() => inspectGlue(js.replace('function ___syscall_openat(dirfd,path,flags,varargs){SYSCALLS.varargs=varargs}',
    'function ___syscall_openat(dirfd,path,flags,varargs){fetch(path)}'), binary));
});
test('successful raw link records the stack and memory flags and the exact upstream archive inputs', () => {
  const command = readFileSync(new URL('actual-link-command.txt', evidence), 'utf8').trim();
  const log = gunzipSync(readFileSync(new URL('link-settings-compile-link.txt.gz', evidence))).toString('utf8');
  assert.ok(log.split('\n').includes(command), 'exact command comes from successful raw log');
  for (const flag of ['-z stack-size=5242880', '--max-memory=536870912', '--initial-memory=67108864',
    '--no-entry', '--no-stack-first', '--table-base=1', '--global-base=1024']) assert.ok(command.includes(flag), flag);
  assert.doesNotMatch(command, /--shared-memory|--import-memory|libparakeet\.a/);
  assert.deepEqual(command.split(' ').filter(s => s.endsWith('.a')), [
    'whisper-core/src/libwhisper.a', 'whisper-core/ggml/src/libggml.a',
    'whisper-core/ggml/src/libggml-cpu.a', 'whisper-core/ggml/src/libggml-base.a',
  ]);
  const units = JSON.parse(gunzipSync(readFileSync(new URL('compile_commands.json.gz', evidence))));
  assert.equal(units.length, 26);
});

async function suppliedBytePath(locator, bytes = new Uint8Array([7, 9])) {
  const order = [], context = vm.createContext({ Module: { locateFile: locator }, wasmBinary: bytes,
    wasmBinaryFile: undefined, info: {}, Uint8Array, WebAssembly: undefined,
    locateFile: name => { order.push('resolve:' + name); return locator(name); },
    readBinary: () => { order.push('readBinary'); throw Error('unexpected read'); },
    readAsync: async () => { order.push('readAsync'); throw Error('unexpected read'); },
    fetch: () => { order.push('fetch'); throw Error('unexpected fetch'); }, err: () => {},
  }, { codeGeneration: { strings: false, wasm: false } });
  // Only exact function definitions and the two startup statements are selected.
  // The factory, createWasm, receiveInstance, initRuntime and WASM constructors
  // are never evaluated. The final instantiation boundary is a byte-read stub.
  const selected = ['findWasmBinary', 'getBinarySync', 'getWasmBinary', 'instantiateAsync']
    .map(name => glue.sources[name]).join('\n');
  const locateStatement = glue.sources.createWasm.match(/wasmBinaryFile\?\?=findWasmBinary\(\);/)[0];
  const instantiateStatement = glue.sources.createWasm.match(/var result=await instantiateAsync\(wasmBinary,wasmBinaryFile,info\);/)[0];
  const module = new vm.SourceTextModule(`${selected}\nexport {getWasmBinary};\nexport async function simulate(){${locateStatement}${instantiateStatement}return result;}`, { context });
  await module.link(() => { throw Error('unexpected module import'); });
  await module.evaluate();
  context.instantiateArrayBuffer = async file => { order.push('consume-supplied-bytes'); return module.namespace.getWasmBinary(file); };
  const result = await module.namespace.simulate();
  return { order, bytes: [...result] };
}
test('actual generated supplied-byte loader resolves the exact name with no fetch/XHR/read', async () => {
  const locator = verifiedWasmLocator({ fileName: 'myrelith-whisper.wasm', sha256: hash(wasm) });
  const result = await suppliedBytePath(locator);
  assert.deepEqual(result, { order: ['resolve:myrelith-whisper.wasm', 'consume-supplied-bytes'], bytes: [7, 9] });
  // Fallback code really is present; absence of fallback traffic is conditional
  // on this verified supplied-byte path, not a blanket network-free glue claim.
  assert.equal(glue.hasFallbackFetchAndXhr, true);
});
test('unapproved generated filenames fail before the byte-consumption boundary', async () => {
  await assert.rejects(suppliedBytePath(() => { throw Error('unapproved path'); }), /unapproved path/);
});
