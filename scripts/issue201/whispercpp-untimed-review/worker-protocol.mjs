import { inspectTinyQ8, MODEL_BYTES, MODEL_SHA256 } from './model-format.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_HEAP = 536_870_912;
export const WASM_FILE_NAME = 'myrelith-whisper.wasm';
const exactKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const fail = (code) => { throw Error(code); };

export function verifiedWasmLocator(identity) {
  if (identity.fileName !== WASM_FILE_NAME || !/^[a-f0-9]{64}$/.test(identity.sha256)) fail('unreviewed-runtime');
  const { fileName: expectedName, sha256 } = identity;
  // Emscripten resolves a name even when wasmBinary is already supplied. This
  // locator grants only that exact resolution. Its opaque, non-network result
  // cannot become an HTTP fallback if the generated loader loses its bytes.
  return (fileName) => {
    if (fileName !== expectedName) fail('unexpected-runtime-asset');
    return `urn:myrelith:verified-wasm:${sha256}`;
  };
}

export function readSpeechOutput(module, samples, status) {
  if (status !== 0 && status !== 1) fail(`inference-${status}`);
  const untimed = status === 1;
  const count = module._speech_segment_count();
  if (!Number.isInteger(count) || count < 0 || count > 1000 || (untimed && count === 0)) fail('segment-count');
  const segments = []; let previousEnd = 0, characters = 0, windowText = '';
  for (let i = 0; i < count; i++) {
    const from = module._speech_segment_t0(i), to = module._speech_segment_t1(i);
    if (untimed) {
      // The native adapter withholds all endpoints for this whole window.
      // Never reconstruct timing from the input duration or earlier segments.
      if (from !== -1 || to !== -1) fail('untimed-endpoints');
    } else if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < previousEnd
      || to <= from || to * 160 > samples) fail('segment-time');
    const heap = module.HEAPU8, pointer = module._speech_segment_text(i);
    if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer >= heap.length) fail('segment-pointer');
    let end = pointer;
    while (end < heap.length && end - pointer <= 16000 && heap[end] !== 0) end++;
    if (end === heap.length || end - pointer > 16000) fail('segment-bytes');
    const text = utf8.decode(heap.subarray(pointer, end));
    characters += text.length;
    if (!text.trim() || text.length > 4000 || characters > 20000) fail('segment-text');
    if (untimed) windowText += text;
    else { segments.push({ text, fromCentiseconds: from, toCentiseconds: to }); previousEnd = to; }
  }
  return untimed ? { timing: 'unavailable', reason: 'timestamp-coverage', text: windowText }
    : { timing: 'model', segments };
}

// Future worker entry injects a statically imported, separately reviewed local
// factory and immutable WASM identity. There is intentionally no runtime import
// or built-artifact identity in this source-preparation package yet.
export function createSpeechWorkerProtocol({ createModule, wasmIdentity, crypto, emit, close,
  now = () => performance.now() }) {
  if (!exactKeys(wasmIdentity, ['bytes', 'sha256', 'fileName']) || !Number.isSafeInteger(wasmIdentity.bytes)
    || wasmIdentity.bytes <= 0 || !/^[a-f0-9]{64}$/.test(wasmIdentity.sha256)) fail('unreviewed-runtime');
  const locateFile = verifiedWasmLocator(wasmIdentity);
  const expectedWasmBytes = wasmIdentity.bytes, expectedWasmSha256 = wasmIdentity.sha256;
  let module = null, owner = null, lastId = 0, busy = false, ended = false;
  let state = 'empty', windows = 0;
  const current = () => { if (ended) fail('terminated'); };
  const digest = async (buffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
  function heap() {
    const value = module?.HEAPU8;
    if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)
      || value.buffer.byteLength > MAX_HEAP) fail('heap-profile');
    return value;
  }
  function copy(buffer, allocate) {
    const pointer = allocate();
    const target = heap(); // Refresh after malloc/growth; never retain stale heap views.
    if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer % 4 !== 0
      || pointer > target.length - buffer.byteLength) fail('allocation');
    target.set(new Uint8Array(buffer), pointer);
  }
  function finish(id, code) {
    if (ended) return;
    ended = true; state = 'closed';
    let cooperativeZero = false;
    try { cooperativeZero = module !== null && module._speech_close() === 0 && module._speech_owned() === 0; } catch { /* Trap: host must terminate. */ }
    module = null;
    try { emit({ v: 1, owner, id, kind: code ? 'error' : 'closed', code: code ?? null, cooperativeZero }); }
    finally { close(); }
  }
  return async function receive(message) {
    if (ended) return;
    const id = message?.id;
    if (busy) { finish(Number.isSafeInteger(id) ? id : 0, 'overlapping-request'); return; }
    busy = true;
    let modelBuffer = null, wasmBuffer = null, pcmBuffer = null;
    try {
      const base = ['v', 'owner', 'id', 'kind'];
      const extra = message?.kind === 'load' ? ['model', 'wasm'] : message?.kind === 'run' ? ['pcm', 'language'] : [];
      if (!exactKeys(message, [...base, ...extra]) || message.v !== 1
        || !Number.isSafeInteger(id) || id <= lastId || typeof message.owner !== 'string'
        || message.owner.length < 1 || message.owner.length > 64
        || (owner !== null && owner !== message.owner)) fail('request-identity');
      owner ??= message.owner; lastId = id;
      if (message.kind === 'close') { finish(id); return; }
      if (message.kind === 'load') {
        if (state !== 'empty') fail('load-state');
        state = 'loading'; modelBuffer = message.model; wasmBuffer = message.wasm;
        if (!(modelBuffer instanceof ArrayBuffer) || modelBuffer.byteLength !== MODEL_BYTES
          || !(wasmBuffer instanceof ArrayBuffer) || wasmBuffer.byteLength !== expectedWasmBytes) fail('asset-size');
        if (await digest(modelBuffer) !== MODEL_SHA256) fail('model-digest'); current();
        inspectTinyQ8(new Uint8Array(modelBuffer));
        if (await digest(wasmBuffer) !== expectedWasmSha256) fail('runtime-digest'); current();
        const created = await createModule({ wasmBinary: new Uint8Array(wasmBuffer),
          locateFile, print: () => {}, printErr: () => {},
          onAbort: () => { state = 'faulted'; } });
        if (ended) { try { created._speech_close(); } catch { /* Owner already closed. */ } return; }
        module = created; current(); heap();
        if (state === 'faulted') fail('runtime-abort');
        copy(modelBuffer, () => module._speech_model_alloc(MODEL_BYTES));
        const status = module._speech_load();
        modelBuffer = null; wasmBuffer = null;
        if (status !== 0 || module._speech_owned() !== 1) fail(`load-${status}`);
        state = 'ready'; emit({ v: 1, owner, id, kind: 'ready', heapBytes: heap().byteLength });
      } else if (message.kind === 'run') {
        if (state !== 'ready' || !['en', 'fr'].includes(message.language)) fail('run-state');
        if (windows >= 12) fail('window-count');
        pcmBuffer = message.pcm;
        if (!(pcmBuffer instanceof ArrayBuffer) || pcmBuffer.byteLength % 4 !== 0
          || pcmBuffer.byteLength < 6400 || pcmBuffer.byteLength > 1_920_000) fail('pcm-size');
        const samples = pcmBuffer.byteLength / 4;
        for (const value of new Float32Array(pcmBuffer)) if (!Number.isFinite(value)) fail('pcm-value');
        const started = now(); state = 'running'; windows++;
        copy(pcmBuffer, () => module._speech_pcm_alloc(samples));
        pcmBuffer = null;
        const status = module._speech_run(message.language === 'en' ? 0 : 1);
        if (state === 'faulted') fail('runtime-abort');
        if (now() - started >= 120000) fail('window-deadline');
        if (status !== 0 && status !== 1) fail(`inference-${status}`);
        const generatedTokens = module._speech_tokens();
        if (!Number.isInteger(generatedTokens) || generatedTokens < 0 || generatedTokens > 448
          || module._speech_owned() !== 1) fail('inference-ledger');
        const output = readSpeechOutput(module, samples, status);
        state = 'ready'; emit({ v: 1, owner, id, kind: 'result', generatedTokens, ...output, heapBytes: heap().byteLength });
      } else fail('request-kind');
    } catch (error) { finish(Number.isSafeInteger(id) ? id : 0, error.message); }
    finally { modelBuffer = null; wasmBuffer = null; pcmBuffer = null; busy = false; }
  };
}
