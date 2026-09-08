import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const evidence = new URL('../../../docs/evidence/issue201/whispercpp-link-settings/', import.meta.url);
const recipe = readFileSync(new URL('CMakeLists.txt', import.meta.url), 'utf8');
const flags = [...recipe.slice(recipe.indexOf('target_link_options')).matchAll(/"(-[^"]+)"/g)].map(m => m[1]);
const original = JSON.parse(readFileSync(new URL('failed-link-arguments.json', evidence)));
const oldSettings = original.filter(arg => /^-s[A-Z]/.test(arg));
const cases = [original, flags, ...oldSettings.map(arg => [arg]),
  [...flags, '-sOPT_LEVEL=0'], [...flags, '-sMADE_UP_SETTING=0'],
  [...flags, '-sMAXIMUM_MEMORY=small'], [...flags, '-sINITIAL_MEMORY=67108865'],
  [...flags, '-sMAXIMUM_MEMORY=33554432'], [...flags, '-sCROSS_ORIGIN=1'],
  [...flags, '-sEXPORTED_FUNCTIONS=[1]'], [...flags, '-pthread'], [...flags, '-fopenmp'],
  [...flags, '-sSHARED_MEMORY=1']];
const run = spawnSync('/usr/bin/python3', [new URL('settings-source-audit.py', import.meta.url).pathname], {
  encoding: 'utf8', input: JSON.stringify(cases), timeout: 15000,
  env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools', PYTHONDONTWRITEBYTECODE: '1' },
});
assert.equal(run.status, 0, run.stderr);
const results = JSON.parse(run.stdout);
test('actual pinned argument parser reproduces the recorded final-link failure', () => {
  assert.equal(oldSettings.length, 37);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, 'PTHREADS is an internal setting and cannot be set from command line');
});
test('every original setting is audited independently: only PTHREADS rejects', () => {
  oldSettings.forEach((arg, i) => {
    const result = results[i + 2];
    assert.equal(result.ok, arg !== '-sPTHREADS=0', arg);
    if (result.ok) assert.deepEqual(Object.values(result.classifications), ['public'], arg);
  });
});
test('corrected recipe parses all values with no legacy, experimental or compatibility warnings', () => {
  const result = results[1]; assert.equal(result.ok, true, result.error);
  assert.equal(Object.keys(result.settings).length, 36);
  assert.ok(Object.values(result.classifications).every(v => v === 'public'));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.settings.EXPORT_NAME, 'createMyrelithWhisper');
  assert.deepEqual(result.settings.ENVIRONMENT, ['worker']);
  assert.deepEqual(result.settings.INCOMING_MODULE_JS_API, ['wasmBinary', 'locateFile', 'print', 'printErr', 'onAbort']);
  assert.deepEqual(result.settings.EXPORTED_RUNTIME_METHODS, ['HEAPU8', 'HEAPF32']);
  assert.equal(result.settings.EXPORTED_FUNCTIONS.length, 11);
  assert.deepEqual(result.memory, { PTHREADS: false, SHARED_MEMORY: false, WASM_WORKERS: 0,
    IMPORTED_MEMORY: 0, INITIAL_MEMORY: 67108864, MAXIMUM_MEMORY: 536870912, STACK_SIZE: 5242880,
    MEMORY_GROWTH_LINEAR_STEP: 16777216, MEMORY_GROWTH_GEOMETRIC_STEP: 0 });
  assert.ok(!flags.some(arg => /pthread|fopenmp|shared-memory/.test(arg)));
});
test('actual authority rejects internal, unknown, mistyped, malformed and conflicting inputs', () => {
  const errors = [/internal setting/, /non-existent setting/, /invalid byte size/, /multiple.*page size/,
    /cannot be less/, /not compatible/, /list members.*strings/];
  errors.forEach((pattern, i) => { const r = results[39 + i]; assert.equal(r.ok, false); assert.match(r.error, pattern); });
});
test('thread-enabling arguments and shared memory are observable positive counterexamples', () => {
  for (const result of results.slice(46, 48)) {
    assert.equal(result.ok, true, result.error); assert.equal(result.memory.PTHREADS, 1);
  }
  assert.equal(results[48].ok, true); assert.equal(results[48].memory.SHARED_MEMORY, 1);
  // This source check cannot qualify the output. Generated binary memory flags
  // and JS loader still require static inspection before any runtime grant.
});
