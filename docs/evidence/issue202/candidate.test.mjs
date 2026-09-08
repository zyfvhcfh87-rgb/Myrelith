import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {evaluate, hlgDecode, interpretTags, managedStageStatus, pqDecode, pqEncode, srgbDecode} from './candidate.mjs';

test('reference source and fixture bytes remain exactly frozen', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./oracle-freeze-v1.json', import.meta.url)));
  for (const f of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(f.path, import.meta.url))).digest('hex'), f.sha256, f.path);
});

test('PQ rejects non-finite and out-of-contract samples before conversion', () => {
  for (const v of [NaN, Infinity, -Infinity, -1, 1.1]) assert.throws(() => pqDecode(v));
  for (const v of [NaN, Infinity, -1, 10001]) assert.throws(() => pqEncode(v));
  assert.equal(pqDecode(0), 0);
  assert.equal(pqDecode(1), 10000);
  assert.ok(pqEncode(0) > 0);
});

test('source interpretation never invents a transfer, primaries, white or alpha', () => {
  const valid = {op: 'source', transfer: 'srgb', primaries: '709', rgb: ['.5', '.5', '.5'], white: '203', alpha: '1'};
  for (const patch of [{transfer: 'camera-log'}, {primaries: 'unknown'}, {white: null}, {white: '-1'}, {alpha: undefined}, {alpha: null}, {alpha: 'NaN'}, {alpha: '2'}, {rgb: ['-.1', '1', '0']}]) assert.throws(() => evaluate({...valid, ...patch}));
  assert.throws(() => evaluate({...valid, transfer: 'pq'}), /unsupported-hdr-colorimetry/);
});

test('legacy and unknown plugins/effects stay unavailable in the managed candidate', () => {
  for (const kind of ['plugin', 'legacy-lut', 'legacy-wheels', 'legacy-curves', 'legacy-lens', 'legacy-blend', 'future']) {
    const intent = Object.freeze({kind, version: 1});
    assert.equal(managedStageStatus(intent).supported, false);
    assert.equal(intent.version, 1);
  }
  assert.equal(managedStageStatus({kind: 'linear-exposure', version: 1}).supported, true);
  assert.equal(managedStageStatus({kind: 'linear-exposure', version: 2}).supported, false);
});

test('wide-gamut SDR is distinct from HDR and tags require independent agreement', () => {
  const p3 = {primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true};
  const pq = {primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false};
  assert.equal(interpretTags(p3, p3), 'sdr-p3');
  assert.equal(interpretTags(pq, pq), 'pq');
  assert.equal(interpretTags(pq, {...pq, transfer: 'hlg'}), 'unresolved-conflicting-tags');
  assert.equal(interpretTags({...pq, fullRange: null}, pq), 'unresolved-missing-tags');
  assert.equal(interpretTags({...pq, fullRange: 0}, {...pq, fullRange: 0}), 'unresolved-invalid-range');
  assert.equal(interpretTags(null, pq), 'unresolved-missing-tags');
});

test('negative control detects per-channel HLG instead of its luminance-coupled OOTF', () => {
  const input = [.75, .5, 1];
  const correct = hlgDecode(input);
  const wrong = input.map(v => hlgDecode([v, v, v])[0]);
  assert.ok(Math.max(...correct.map((v, i) => Math.abs(v-wrong[i]))) > 100);
});

test('negative controls expose nonlinear alpha processing and 8-bit level collapse', () => {
  assert.ok(Math.abs(srgbDecode(.5)*.5-srgbDecode(.5*.5)) > .05);
  const original = Array.from({length: 1024}, (_, i) => i/1023);
  assert.equal(new Set(original).size, 1024);
  assert.equal(new Set(original.map(v => Math.round(v*255))).size, 256);
});

test('recorded float16 scope failure stays visible under unchanged reference limits', () => {
  const inputs = JSON.parse(fs.readFileSync(new URL('./inputs-v1.json', import.meta.url))).cases;
  const c = inputs.find(c => c.id === 'scopes-pre-view-bin-edges');
  const scalar = evaluate(c.input);
  const half = evaluate(c.input, 'binary16-storage');
  assert.deepEqual(scalar.bins, [2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 2]);
  assert.notDeepEqual(half.bins, scalar.bins);
  assert.ok(half.nits[1] > 100);
  assert.ok(half.nits[5] < 1000);
});
