import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { inspectTinyQ8, MODEL_SHA256 } from './model-format.mjs';
import { readSegments, createSpeechWorkerProtocol, WASM_FILE_NAME } from './worker-protocol.mjs';
import { createSpeechWorkerOwner } from './worker-owner.mjs';
import { createResidentCoverage, captureCompleteResident, RSS_INTERVAL_MS, RSS_DELTA_CAP } from './resident-coverage.mjs';
import { LAB_CASE_NAMES } from '../lab-contract.mjs';
const local = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const assets = '.tmp/issue201-whispercpp-preparation/';
const model = readFileSync(assets + 'ggml-tiny-q8_0.bin');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('approved model exact SHA, complete tensor profile and no trailing bytes', () => {
  assert.equal(sha(model), MODEL_SHA256);
  const result = inspectTinyQ8(model);
  assert.equal(result.tensorCount, 167); assert.equal(result.maxTokenBytes, 33);
  assert.equal(result.inventory.reduce((n, x) => n + (x.type === 8 ? 1 : 0), 0), 65);
  assert.equal(result.storedVocabulary, 50257);
});
test('format rejects wrong endian/English-only shape, corrupt vocab, tensor and tail', () => {
  for (const [offset, value] of [[0, 0x6c6d6767], [4, 51864], [44, 2006], [64376, -1], [572465, 8], [572473, 3]]) {
    const bytes = Buffer.from(model); bytes.writeInt32LE(value, offset);
    assert.throws(() => inspectTinyQ8(bytes));
  }
  assert.throws(() => inspectTinyQ8(model.subarray(0, model.length - 1)));
  const bytes = Buffer.from(model); bytes.write('decoder.positional_embedding', 572529); // corrupts tensor body, hash must reject
  assert.notEqual(sha(bytes), MODEL_SHA256);
});

// Execute the actual C helper's arithmetic body after the sole syntactic mapping
// of C pointer-member access to JS member access. This is a deterministic source
// proof on 0..448 integers, NOT compiled C / WASM / native inference evidence.
const helper = local('myrelith-token-budget.h');
const helperBody = helper.match(/myrelith_reserve_token\([^)]*\) \{([\s\S]*?)\n\}/)[1];
assert.match(helperBody, /^\s*if \(budget->used >= budget->limit\) return false;\s*budget->used \+= 1;\s*return true;\s*$/);
const reserve = vm.runInNewContext(`(budget) => { ${helperBody.replaceAll('->', '.')} }`);
test('actual C helper reserves token 448, rejects 449 before sample and cannot reset on retry', () => {
  const counter = { limit: 448, used: 0 }; let sampled = 0;
  // Different segments and discarded temperature retries share this same scope.
  for (const attempts of [120, 50, 150, 128, 20, 800]) {
    for (let i = 0; i < attempts; i++) { if (reserve(counter)) sampled++; }
  }
  assert.equal(sampled, 448); assert.equal(counter.used, 448);
});
test('all admitted integer limits exhaust exactly; a new call owns a fresh counter', () => {
  for (let limit = 1; limit <= 448; limit++) {
    const counter = { limit, used: 0 };
    for (let i = 0; i < limit; i++) assert.equal(reserve(counter), true);
    for (let i = 0; i < 3; i++) assert.equal(reserve(counter), false);
    assert.equal(counter.used, limit);
  }
});

function applyUnified(source, patch, path) {
  const section = patch.split(`--- a/${path}\n+++ b/${path}\n`)[1]?.split('\n--- a/')[0];
  assert.ok(section, path); let offset = 0; const lines = source.split('\n');
  for (const hunk of section.split(/(?=^@@ )/m).filter(x => x.startsWith('@@'))) {
    const match = hunk.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n/);
    assert.ok(match); const rows = hunk.slice(match[0].length).split('\n').filter(x => /^[ +-]/.test(x));
    const oldRows = rows.filter(x => x[0] !== '+').map(x => x.slice(1));
    const newRows = rows.filter(x => x[0] !== '-').map(x => x.slice(1));
    assert.equal(oldRows.length, Number(match[2] ?? 1)); assert.equal(newRows.length, Number(match[4] ?? 1));
    const index = Number(match[1]) - 1 + offset;
    assert.deepEqual(lines.slice(index, index + oldRows.length), oldRows);
    lines.splice(index, oldRows.length, ...newRows); offset += newRows.length - oldRows.length;
  }
  return lines.join('\n');
}
const identities = JSON.parse(local('patch-identities.json'));
const patched = new Map();
test('both patches apply with exact hunk context and exact before/after hashes', () => {
  for (const [kind, filename] of [['build', '01-optional-pthreads.patch'], ['guard', '02-whole-call-token-budget.patch']]) {
    for (const entry of identities[kind]) {
      const original = readFileSync(assets + 'source-review/' + entry.path, 'utf8');
      assert.equal(sha(original), entry.before);
      const result = applyUnified(original, local(filename), entry.path);
      assert.equal(sha(result), entry.after); patched.set(entry.path, result);
    }
  }
});
test('guard scope and profile dominate every greedy sample across seek and temperature loops', () => {
  const source = patched.get('src/whisper.cpp');
  const body = source.slice(source.indexOf('int whisper_full_with_state('), source.indexOf('\nint whisper_full(', source.indexOf('int whisper_full_with_state(')));
  assert.equal((body.match(/myrelith_token_budget token_budget =/g) ?? []).length, 1);
  assert.ok(body.indexOf('myrelith_token_budget token_budget =') < body.indexOf('while (true)'));
  assert.ok(body.indexOf('return -90;') < body.indexOf('whisper_pcm_to_mel_with_state'));
  assert.match(body, /params\.n_threads != 1.*params\.strategy != WHISPER_SAMPLING_GREEDY/s);
  assert.match(body, /params\.greedy\.best_of != 1/);
  assert.equal((body.match(/myrelith_reserve_token\(&token_budget\)/g) ?? []).length, 1);
  assert.equal((body.match(/whisper_sample_token\(\*ctx, decoder,/g) ?? []).length, 2);
  assert.ok(body.indexOf('myrelith_reserve_token(&token_budget)') < body.indexOf('whisper_sample_token(*ctx, decoder,'));
  assert.match(body, /if \(!myrelith_reserve_token\(&token_budget\)\) \{\s*result_all.clear\(\);\s*return -91;/);
  assert.equal((body.match(/token_budget\s*=/g) ?? []).length, 1);
});
test('wrapper uses only single-context full, fixed guard and complete-output admission', () => {
  const wrapper = local('adapter.cpp');
  assert.equal((wrapper.match(/whisper_full\(context,/g) ?? []).length, 1);
  assert.doesNotMatch(wrapper, /whisper_full_parallel|whisper_init_from_file|pthread_create/);
  for (const text of ['p.max_tokens_total = 448', 'p.tokens_generated = &generated', 'p.use_gpu = false',
    'p.flash_attn = true', 'p.n_threads = 1', 'p.temperature_inc = 0', 'p.audio_ctx = 0', 'p.vad = false']) assert.ok(wrapper.includes(text));
  assert.ok(wrapper.indexOf('if (should_abort(nullptr)) return -93') < wrapper.indexOf('return validate_output(sample_count)'));
});
test('build recipe fixes non-shared CPU SIMD memory and excludes demo/runtime alternatives', () => {
  const recipe = local('CMakeLists.txt');
  for (const text of ['WHISPER_WASM_PTHREADS OFF', 'GGML_WASM_SINGLE_THREAD ON', '-sPTHREADS=0', '-sFILESYSTEM=0', '-sDYNAMIC_EXECUTION=0',
    '-sINITIAL_MEMORY=67108864', '-sMAXIMUM_MEMORY=536870912', '-msimd128', 'GGML_OPENMP', 'GGML_CPU_REPACK']) assert.ok(recipe.includes(text));
  assert.equal(LAB_CASE_NAMES.length, 23); // Shared list imported, never forked.
});

function outputModule(text = ' hello') {
  const HEAPU8 = new Uint8Array(20000); HEAPU8.set(new TextEncoder().encode(text), 4);
  return { HEAPU8, _speech_segment_count: () => 1, _speech_segment_t0: () => 0,
    _speech_segment_t1: () => 100, _speech_segment_text: () => 4 };
}
test('outputs preserve centiseconds and reject malformed/overlapping/overhanging times', () => {
  const m = outputModule(); assert.equal(readSegments(m, 16000)[0].toCentiseconds, 100);
  for (const [from, to] of [[-1, 100], [0, 0], [0, 101], [0.5, 100], [0, NaN]]) {
    m._speech_segment_t0 = () => from; m._speech_segment_t1 = () => to;
    assert.throws(() => readSegments(m, 16000));
  }
  const overlap = outputModule(); overlap._speech_segment_count = () => 2;
  assert.throws(() => readSegments(overlap, 32000));
});
test('outputs reject bad UTF8, pointers, empty/oversized text and aggregate overflow', () => {
  for (const value of ['', ' '.repeat(30), 'a'.repeat(4001)]) assert.throws(() => readSegments(outputModule(value), 16000));
  const bad = outputModule(); bad.HEAPU8[4] = 0xff; assert.throws(() => readSegments(bad, 16000));
  for (const p of [0, -1, 1.5, 30000]) { bad._speech_segment_text = () => p; assert.throws(() => readSegments(bad, 16000)); }
  const full = outputModule('x'.repeat(4000)); full._speech_segment_count = () => 6;
  full._speech_segment_t0 = i => i; full._speech_segment_t1 = i => i + 1;
  assert.throws(() => readSegments(full, 16000));
});

const wasm = new Uint8Array([1, 2, 3, 4]); // Fake bytes; never compiled/instantiated.
function protocolHarness(overrides = {}) {
  let owned = 0, calls = 0, closed = 0;
  const events = [], m = outputModule();
  m.HEAPU8 = new Uint8Array(64 * 1024 * 1024);
  Object.assign(m, { _speech_model_alloc: () => 4, _speech_load: () => { owned = 1; return 0; },
    _speech_pcm_alloc: () => 4, _speech_run: () => { m.HEAPU8.set(new TextEncoder().encode(' hi\0'), 4); return 0; },
    _speech_tokens: () => 448, _speech_owned: () => owned, _speech_close: () => { owned = 0; return 0; } }, overrides.module);
  const receive = createSpeechWorkerProtocol({ createModule: async options => {
    calls++; assert.match(options.locateFile(WASM_FILE_NAME), /^urn:myrelith:verified-wasm:[a-f0-9]{64}$/); return m;
  },
    wasmIdentity: { bytes: wasm.length, sha256: sha(wasm), fileName: WASM_FILE_NAME }, crypto: webcrypto,
    emit: x => events.push(x), close: () => { closed++; }, ...overrides.options });
  const load = () => receive({ v: 1, owner: 'o', id: 1, kind: 'load',
    model: model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength), wasm: wasm.buffer.slice(0) });
  const run = (id = 2) => receive({ v: 1, owner: 'o', id, kind: 'run', pcm: new Float32Array(16000).buffer, language: 'en' });
  return { receive, load, run, events, m, calls: () => calls, closed: () => closed };
}
test('lazy factory, exact assets, one context, bounded complete output and close', async () => {
  const h = protocolHarness(); assert.equal(h.calls(), 0);
  await h.load(); assert.equal(h.calls(), 1); assert.equal(h.events[0].kind, 'ready');
  await h.run(); assert.equal(h.events[1].kind, 'result'); assert.equal(h.events[1].generatedTokens, 448);
  await h.receive({ v: 1, owner: 'o', id: 3, kind: 'close' });
  assert.equal(h.events.at(-1).cooperativeZero, true); assert.equal(h.closed(), 1);
});
test('corrupt model fails before factory; malformed identity and nonfinite PCM terminate', async () => {
  const h = protocolHarness();
  await h.receive({ v: 1, owner: 'o', id: 1, kind: 'load', model: new ArrayBuffer(model.length), wasm: wasm.buffer.slice(0) });
  assert.equal(h.calls(), 0); assert.equal(h.events[0].code, 'model-digest');
  const p = protocolHarness(); await p.load(); const values = new Float32Array(16000); values[0] = NaN;
  await p.receive({ v: 1, owner: 'o', id: 2, kind: 'run', pcm: values.buffer, language: 'fr' });
  assert.equal(p.events.at(-1).code, 'pcm-value');
});
test('token exhaustion, OOM/trap, output overhang and late deadlines never emit partial results', async () => {
  for (const module of [{ _speech_run: () => -91 }, { _speech_run: () => { throw Error('oom-trap'); } },
    { _speech_segment_t1: () => 101 }, { _speech_tokens: () => 449 }]) {
    const h = protocolHarness({ module }); await h.load(); await h.run();
    assert.equal(h.events.filter(x => x.kind === 'result').length, 0);
    assert.equal(h.events.at(-1).kind, 'error'); assert.equal(h.closed(), 1);
  }
  let time = 0; const h = protocolHarness({ options: { now: () => time }, module: { _speech_run: () => { time = 120000; return 0; } } });
  await h.load(); await h.run(); assert.equal(h.events.at(-1).code, 'window-deadline');
});
test('stale/duplicate ids and overlapping async load cannot revive a closed owner', async () => {
  const h = protocolHarness(); await h.load(); await h.run(1);
  assert.equal(h.events.at(-1).code, 'request-identity');
  const p = protocolHarness(); const loading = p.load();
  await p.receive({ v: 1, owner: 'o', id: 2, kind: 'close' }); await loading;
  assert.equal(p.events.at(-1).code, 'overlapping-request'); assert.equal(p.calls(), 0);
});
test('one job owns at most twelve windows and every heap growth refreshes the copy view', async () => {
  const h = protocolHarness(); await h.load();
  h.m._speech_pcm_alloc = () => { h.m.HEAPU8 = new Uint8Array(64 * 1024 * 1024); return 4; };
  for (let id = 2; id < 14; id++) await h.run(id);
  assert.equal(h.events.filter(x => x.kind === 'result').length, 12);
  await h.run(14); assert.equal(h.events.at(-1).code, 'window-count');
});

function hostHarness(now = () => 0) {
  const handlers = new Map(), timers = new Map(), sent = [], reports = [];
  let n = 0, terminations = 0;
  const worker = { addEventListener: (k, fn) => handlers.set(k, fn), removeEventListener: k => handlers.delete(k),
    postMessage: x => sent.push(x), terminate: () => { terminations++; } };
  const host = createSpeechWorkerOwner({ worker, owner: 'o', onDisposed: x => reports.push(x), now,
    setTimer: (fn, delay) => { timers.set(++n, { fn, delay }); return n; }, clearTimer: i => timers.delete(i) });
  return { host, sent, reports, timers, terminations: () => terminations,
    reply: x => handlers.get('message')?.({ data: x }) };
}
test('busy cancel terminates synchronously, rejects pending and never claims cooperative zero', async () => {
  const h = hostHarness(); const pending = h.host.run(new ArrayBuffer(6400), 'en');
  const rejected = assert.rejects(pending, /cancelled/); const result = await h.host.dispose(); await rejected;
  assert.equal(h.terminations(), 1); assert.equal(result.cooperativeZero, false); assert.equal(h.timers.size, 0);
  h.reply({ v: 1, owner: 'o', id: 1, kind: 'result' }); assert.equal(h.reports.length, 1);
});
test('idle close allows actual zero acknowledgement and terminates before disposal resolution', async () => {
  const h = hostHarness(); const closed = h.host.dispose();
  assert.equal([...h.timers.values()][0].delay, 100);
  h.reply({ v: 1, owner: 'wrong', id: 1, kind: 'closed', cooperativeZero: true }); assert.equal(h.terminations(), 0);
  h.reply({ v: 1, owner: 'o', id: 1, kind: 'closed', cooperativeZero: true });
  assert.equal((await closed).cooperativeZero, true); assert.equal(h.terminations(), 1);
});
test('host 120s deadline and idle 100ms fallback terminate even without worker event processing', async () => {
  const h = hostHarness(); const request = h.host.load(new ArrayBuffer(1), new ArrayBuffer(1));
  const rejected = assert.rejects(request, /host-deadline/);
  assert.equal([...h.timers.values()][0].delay, 120000); [...h.timers.values()][0].fn(); await rejected;
  assert.equal(h.terminations(), 1);
  const idle = hostHarness(); const closed = idle.host.dispose(); [...idle.timers.values()][0].fn();
  assert.equal((await closed).cooperativeZero, false); assert.equal(idle.terminations(), 1);
});
test('late replies cannot beat a delayed host timer; idle malformed replies are ignored', async () => {
  let time = 0; const h = hostHarness(() => time);
  h.reply({ v: 1, owner: 'o', kind: 'result' }); assert.equal(h.terminations(), 0);
  const pending = h.host.run(new ArrayBuffer(6400), 'en'); const rejected = assert.rejects(pending, /host-deadline/);
  time = 120000; h.reply({ v: 1, owner: 'o', id: 1, kind: 'result' }); await rejected;
  assert.equal(h.terminations(), 1); assert.equal(h.reports[0].cooperativeZero, false);
});

const sample = (at, bytes = 1000) => ({ startedAt: at - 5, at, beforePids: [1, 2], afterPids: [2, 1], rss: [[1, bytes], [2, 0]] });
test('100ms target does not relax actual 250ms cadence; 256ms failure is permanent', () => {
  assert.equal(RSS_INTERVAL_MS, 100);
  const c = createResidentCoverage(); c.observe(sample(0)); c.observe(sample(100));
  assert.equal(c.snapshot().qualified, true); c.observe(sample(356)); c.observe(sample(456));
  assert.equal(c.snapshot().maxGap, 256); assert.deepEqual(c.snapshot().failures, ['sample-gap']);
});
test('missing, duplicate, new or vanished Chromium process rows invalidate complete coverage', () => {
  for (const change of [{ afterPids: [1, 2, 3] }, { afterPids: [1] }, { rss: [[1, 1]] },
    { rss: [[1, 1], [1, 1]] }, { rss: [[1, NaN], [2, 1]] }]) {
    const c = createResidentCoverage(); c.observe({ ...sample(0), ...change });
    assert.ok(c.snapshot().failures.includes('incomplete-process-coverage')); assert.equal(c.snapshot().baseline, null);
  }
});
test('resident ceiling and terminal tail/in-flight capture gaps fail independently', () => {
  const c = createResidentCoverage(); c.observe(sample(0)); c.observe(sample(100, 1000 + RSS_DELTA_CAP));
  assert.equal(c.snapshot().qualified, true); c.observe(sample(200, 1001 + RSS_DELTA_CAP));
  assert.ok(c.snapshot().failures.includes('resident-ceiling'));
  c.checkGap(451); assert.ok(c.snapshot().failures.includes('sample-gap'));
  const slow = createResidentCoverage(); slow.observe({ ...sample(300), startedAt: 0 });
  assert.ok(slow.snapshot().failures.includes('capture-gap'));
});
test('complete RSS capture brackets the actual read with full Chromium inventories', async () => {
  const order = []; let time = 0;
  const result = await captureCompleteResident({ now: () => time++, getProcessIds: async () => { order.push('inventory'); return [1]; },
    readRssBytes: async pids => { order.push('rss'); assert.deepEqual(pids, [1]); return [[1, 100]]; } });
  assert.deepEqual(order, ['inventory', 'rss', 'inventory']); assert.equal(result.at, 1);
});
