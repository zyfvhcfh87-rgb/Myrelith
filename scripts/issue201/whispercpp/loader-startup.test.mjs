import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { verifiedWasmLocator, WASM_FILE_NAME } from './worker-protocol.mjs';
const evidence = new URL('../../../docs/evidence/issue201/whispercpp-preparation/', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('loader-source-pins.json', evidence)));
const hash = b => createHash('sha256').update(b).digest('hex');
const sources = new Map(pins.sources.map(pin => {
  const packed = readFileSync(new URL(pin.name, evidence)), bytes = gunzipSync(packed);
  assert.equal(packed.length, pin.bytes); assert.equal(hash(packed), pin.sha256);
  assert.equal(bytes.length, pin.decodedBytes); assert.equal(hash(bytes), pin.decodedSha256);
  return [pin.archiveMember, bytes.toString('utf8')];
}));
const preamble = sources.get('install/emscripten/src/preamble.js');

// Select only these exact pinned preprocessor branches. Unknown expressions
// reject rather than silently broadening the simulated loader profile.
const settings = new Map([
  ['SINGLE_FILE && SINGLE_FILE_BINARY_ENCODE', false], ['SINGLE_FILE', false], ['!SINGLE_FILE', true],
  ["expectToReceiveOnModule('wasmBinary') || WASM2JS", true], ['WASM_ASYNC_COMPILATION', true],
  ['CROSS_ORIGIN_STORAGE', false], ['ENVIRONMENT_MAY_BE_WEBVIEW', false],
  ['ENVIRONMENT_MAY_BE_NODE', false], ['ENVIRONMENT_MAY_BE_SHELL', false],
]);
function select(source) {
  const stack = []; let active = true; const lines = [];
  for (const line of source.split('\n')) {
    const ifMatch = line.match(/^#if (.*)$/);
    if (ifMatch) {
      const expression = ifMatch[1];
      // Nested inactive COS text may contain additional expressions; they
      // cannot contribute any executable source when its parent is disabled.
      if (active) assert.ok(settings.has(expression), expression);
      const choice = active && settings.get(expression) === true;
      stack.push({ parent: active, choice }); active = choice;
    } else if (/^#elif /.test(line)) {
      assert.equal(stack.at(-1).parent, false, 'unexpected active elif'); active = false;
    } else if (/^#else/.test(line)) {
      const frame = stack.at(-1); active = frame.parent && !frame.choice;
    } else if (/^#endif/.test(line)) active = stack.pop().parent;
    else if (active) lines.push(line);
  }
  assert.equal(stack.length, 0);
  return lines.join('\n');
}
function sourceFunction(signature) {
  const start = preamble.indexOf(signature + '\n'); assert.ok(start >= 0, signature);
  const end = preamble.indexOf('\n}', start); assert.ok(end > start);
  return preamble.slice(start, end + 2);
}
const syncSource = select(sourceFunction('function getBinarySync(file) {'));
const wasmSource = select(sourceFunction('async function getWasmBinary(binaryFile) {'));
const asyncSource = select(sourceFunction('async function instantiateAsync(binary, binaryFile, imports) {'))
  .replace("{{{ makeModuleReceiveExpr('fetchSettings', \"{ credentials: 'same-origin' }\") }}}", "{ credentials: 'same-origin' }");
assert.doesNotMatch(asyncSource, /#|\{\{\{/);
const resolution = preamble.match(/  if \(Module\['locateFile'\]\) \{\n    return locateFile\('\{\{\{ WASM_BINARY_FILE \}\}\}'\);\n  \}/)[0]
  .replace('{{{ WASM_BINARY_FILE }}}', WASM_FILE_NAME);
const startup = preamble.match(/  wasmBinaryFile \?\?= findWasmBinary\(\);/)[0];
const instantiate = preamble.match(/  var result = await instantiateAsync\(wasmBinary, wasmBinaryFile, info\);/)[0];

async function simulate(locate, binary = new Uint8Array([7, 9])) {
  const order = [], context = vm.createContext({ Module: { locateFile: locate }, wasmBinary: binary, wasmBinaryFile: undefined,
    Uint8Array, WebAssembly: undefined, // No compile/instantiate API exists in this VM.
    info: {}, locateFile: name => { order.push('resolve'); return locate(name); },
    fetch: () => { order.push('forbidden-fetch'); throw Error('unexpected-runtime-fetch'); },
    readAsync: async () => { order.push('forbidden-read'); throw Error('unexpected-runtime-fetch'); },
    readBinary: () => { order.push('forbidden-read'); throw Error('unexpected-runtime-fetch'); },
    err: () => {} });
  vm.runInContext(`${syncSource}\n${wasmSource}\n${asyncSource}\nfunction findWasmBinary(){${resolution}}`, context);
  // Replace only the final WebAssembly boundary with a byte-inspection stub.
  context.instantiateArrayBuffer = async file => {
    order.push('consume-supplied-bytes'); return context.getWasmBinary(file);
  };
  const bytes = await vm.runInContext(`(async()=>{${startup}\n${instantiate}\nreturn result;})()`, context);
  return { order, bytes, file: context.wasmBinaryFile };
}

test('pinned startup resolves its file before consuming supplied bytes: original locator fails', async () => {
  // Original 763baed adapter behavior, retained as a regression finding.
  await assert.rejects(simulate(() => { throw Error('unexpected-runtime-fetch'); }), /unexpected-runtime-fetch/);
});
test('exact reviewed name resolves, supplied bytes reach the stub with zero fetch/read fallback', async () => {
  const locator = verifiedWasmLocator({ fileName: WASM_FILE_NAME, sha256: 'a'.repeat(64) });
  const result = await simulate(locator);
  assert.deepEqual(result.order, ['resolve', 'consume-supplied-bytes']);
  assert.deepEqual([...result.bytes], [7, 9]);
  assert.equal(result.file, 'urn:myrelith:verified-wasm:' + 'a'.repeat(64));
});
test('unknown paths cannot resolve; losing supplied bytes cannot silently succeed', async () => {
  const identity = { fileName: WASM_FILE_NAME, sha256: 'a'.repeat(64) };
  const locator = verifiedWasmLocator(identity);
  identity.fileName = 'changed.wasm'; identity.sha256 = 'b'.repeat(64);
  assert.equal(locator(WASM_FILE_NAME), 'urn:myrelith:verified-wasm:' + 'a'.repeat(64));
  for (const path of ['other.wasm', '../' + WASM_FILE_NAME, 'https://example.com/' + WASM_FILE_NAME,
    WASM_FILE_NAME + '?v=1', 'myrelith-whisper.deferred.wasm']) assert.throws(() => locator(path), /unexpected-runtime-asset/);
  assert.throws(() => verifiedWasmLocator({ fileName: 'other.wasm', sha256: 'a'.repeat(64) }));
  await assert.rejects(simulate(locator, null));
});
test('recipe explicitly excludes COS, split modules, dynamic loaders and alternate WASM loading modes', () => {
  const recipe = readFileSync(new URL('CMakeLists.txt', import.meta.url), 'utf8');
  const sdkSettings = sources.get('install/emscripten/src/settings.js');
  for (const setting of ['CROSS_ORIGIN_STORAGE', 'CROSS_ORIGIN', 'SPLIT_MODULE', 'MAIN_MODULE', 'SIDE_MODULE',
    'AUTOLOAD_DYLIBS', 'SOURCE_PHASE_IMPORTS', 'WASM_ESM_INTEGRATION', 'WASM_WORKERS', 'PROXY_TO_PTHREAD', 'SINGLE_FILE', 'FETCH', 'WASMFS']) {
    assert.ok(sdkSettings.includes(`var ${setting} =`), setting); assert.ok(recipe.includes(`-s${setting}=0`), setting);
  }
  assert.ok(recipe.includes('-sWASM=1')); assert.ok(recipe.includes('-sWASM_ASYNC_COMPILATION=1'));
});
