/** Read-only receipt verification. No generated JS evaluation or WASM API. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { inspectBinary } from './inspect-binary.mjs';
import { inspectGlue } from './inspect-glue.mjs';

const root = new URL('../../../', import.meta.url);
const evidence = new URL('docs/evidence/issue201/whispercpp-generated/', root);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checkpoint = json(new URL('checkpoint.json', evidence));
for (const [base, entries] of [[root, checkpoint.sourceFiles], [root, checkpoint.referenceFiles], [evidence, checkpoint.records]]) {
  for (const record of entries) {
    const bytes = readFileSync(new URL(record.path, base));
    assert.equal(bytes.length, record.bytes, record.path);
    assert.equal(hash(bytes), record.sha256, record.path);
  }
}
const pins = json(new URL('artifacts.json', evidence));
assert.deepEqual(pins.artifacts.map(p => p.name), ['myrelith-whisper.mjs', 'myrelith-whisper.wasm']);
const artifacts = new Map(pins.artifacts.map(pin => {
  const packed = readFileSync(new URL(pin.packed, evidence));
  assert.equal(packed.length, pin.packedBytes); assert.equal(hash(packed), pin.packedSha256);
  const bytes = gunzipSync(packed, { maxOutputLength: 16 * 1024 * 1024 });
  assert.equal(bytes.length, pin.bytes); assert.equal(hash(bytes), pin.sha256);
  return [pin.name, bytes];
}));
const binary = inspectBinary(artifacts.get('myrelith-whisper.wasm'));
const glue = inspectGlue(artifacts.get('myrelith-whisper.mjs').toString('utf8'), binary);
assert.deepEqual(binary, json(new URL('binary-inspection.json', evidence)));
assert.deepEqual(glue, json(new URL('glue-inspection.json', evidence)));
for (const label of ['link-settings-configure', 'link-settings-compile-link']) {
  const command = json(new URL(label + '.json', evidence));
  const log = gunzipSync(readFileSync(new URL(label + '.txt.gz', evidence)), { maxOutputLength: 1024 * 1024 });
  assert.equal(command.exitCode, 0); assert.equal(log.length, command.logBytes); assert.equal(hash(log), command.logSha256);
}
assert.deepEqual(json(new URL('link-settings-cleanup.json', evidence)).remaining, []);
assert.equal(json(new URL('link-settings-result.json', evidence)).runtimeExecuted, false);
console.log(JSON.stringify({ status: 'static-receipts-verified', sourceFiles: checkpoint.sourceFiles.length,
  referenceFiles: checkpoint.referenceFiles.length, evidenceRecords: checkpoint.records.length,
  artifacts: pins.artifacts.map(p => ({ name: p.name, bytes: p.bytes, sha256: p.sha256 })),
  memory: binary.memories, imports: binary.imports.length, speechExports: glue.namedExports.length,
  generatedFactoryExecuted: false, wasmExecuted: false }, null, 2));
