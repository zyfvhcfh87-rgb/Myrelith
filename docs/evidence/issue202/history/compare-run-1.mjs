// Explicit research runner: never imported by the app and never regenerates goldens.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {evaluate, presentation} from './candidate.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, '../../..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const sha = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
const freeze = read('oracle-freeze-v1.json');
for (const entry of freeze.files) if (sha(entry.path) !== entry.sha256) throw new Error(`Frozen source changed: ${entry.path}`);
const cases = read('inputs-v1.json').cases;
const goldens = new Map(read('goldens-v1.json').results.map(r => [r.id, r.expected]));
const views = new Map(read('presentations-v1.json').rows.map(r => [r.id, r]));

function compare(actual, expected) {
  const errors = [], continuous = [];
  function visit(a, e, key = '') {
    if (Array.isArray(e)) {
      if (!Array.isArray(a) || a.length !== e.length) { errors.push({key, kind: 'shape'}); return; }
      e.forEach((v, i) => visit(a[i], v, `${key}/${i}`));
    } else if (e && typeof e === 'object') {
      if (!a || Object.keys(a).sort().join() !== Object.keys(e).sort().join()) { errors.push({key, kind: 'shape'}); return; }
      Object.keys(e).forEach(k => visit(a[k], e[k], `${key}/${k}`));
    } else if (typeof e === 'number') {
      if (a !== e) errors.push({key, kind: 'discrete', actual: a, expected: e});
    } else {
      const value = Number(e), absolute = Math.abs(a-value);
      const relative = value === 0 ? (absolute === 0 ? 0 : Infinity) : absolute/Math.abs(value);
      const ok = Number.isFinite(a) && (absolute <= 1e-10 || relative <= 1e-9);
      continuous.push({absolute, relative});
      if (!ok) errors.push({key, kind: 'numeric', actual: a, expected: e, absolute, relative: Number.isFinite(relative) ? relative : 'infinite'});
    }
  }
  visit(actual, expected);
  const absolute = Math.max(0, ...continuous.map(x => x.absolute));
  const relative = Math.max(0, ...continuous.map(x => x.relative));
  return {passed: errors.length === 0, maximumAbsoluteError: absolute,
    maximumRelativeError: Number.isFinite(relative) ? relative : 'infinite', errors};
}

const scalar = cases.map(c => {
  const actual = evaluate(c.input);
  return {id: c.id, ...compare(actual, goldens.get(c.id)), actual};
});
const storage = cases.filter(c => c.halfStorageComparison).map(c => {
  const actual = evaluate(c.input, 'binary16-storage');
  const working = compare(actual, goldens.get(c.id));
  if (c.input.op === 'scope') return {id: c.id, kind: 'discrete-scope', passed: working.errors.every(e => e.kind !== 'discrete'), actual, errors: working.errors};
  const projected = presentation(c.input, actual), expected = views.get(c.id);
  const maximumCodeError = Math.max(...projected.code10.map((v, i) => Math.abs(v-Number(expected.code10[i]))));
  const alphaError = Math.abs(projected.alpha-Number(expected.alpha));
  return {id: c.id, kind: 'view-code', passed: maximumCodeError <= 1 && alphaError <= 1/1023,
    maximumCodeError, alphaError, maximumWorkingError: working.maximumAbsoluteError,
    actual, code10: projected.code10, expectedCode10: expected.code10};
});
const summary = {scalarPassed: scalar.filter(r => r.passed).length, scalarTotal: scalar.length,
  storagePassed: storage.filter(r => r.passed).length, storageTotal: storage.length,
  scalarFailures: scalar.filter(r => !r.passed).map(r => r.id), storageFailures: storage.filter(r => !r.passed).map(r => r.id),
  maximumCodeError: Math.max(...storage.filter(r => r.kind === 'view-code').map(r => r.maximumCodeError))};
const evidence = {kind: 'issue202-numerical-comparison', measuredAt: new Date().toISOString(),
  node: process.version, baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, env: {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'}, encoding: 'utf8'}).trim(),
  files: [...freeze.files, ...['candidate.mjs', 'compare.mjs', 'oracle-freeze-v1.json'].map(name => ({path: name, sha256: sha(name)}))],
  qualification: 'CPU Float64 equations and binary16 storage sensitivity only; not Float32 shader, GPU, codec, lifecycle, memory or monitor qualification.',
  summary, scalar, storage};
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute output JSON path');
if (fs.existsSync(output)) throw new Error('Refusing to overwrite a prior result');
fs.writeFileSync(output, JSON.stringify(evidence, null, 2)+'\n');
process.stdout.write(JSON.stringify(summary)+'\n');
if (summary.scalarPassed !== summary.scalarTotal || summary.storagePassed !== summary.storageTotal) process.exitCode = 2;
