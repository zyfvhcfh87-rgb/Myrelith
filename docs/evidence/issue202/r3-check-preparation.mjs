// CPU-only: compile the disposable browser graph without serving, launching or executing it.
import {build} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {imagePlan} from './r3-ledger.mjs';

const root = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(root, '../../..');
const output = process.argv[2];
if (!output?.startsWith('/') || fs.existsSync(output) || path.dirname(output) !== root) throw new Error('Fresh owned preparation result required');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'};
delete env.ISSUE202_R3_SLOT;
const modules = new Set();
const audit = () => ({name: 'issue202-preparation-source-audit', enforce: 'pre', transform(_code, id) {
  const file = id.split('?')[0];
  if (file.startsWith(path.join(repository, 'src/'))) {
    assert.ok(file.startsWith(path.join(repository, 'src/domain/')) || file.startsWith(path.join(repository, 'src/pipeline/')), file);
    modules.add(file);
  }
}});
const tests = execFileSync(process.execPath, ['--test', path.join(root, 'r3-ledger.test.mjs'), path.join(root, 'r3-decisions.test.mjs')], {env, encoding: 'utf8'});
const reference = execFileSync('python3', [path.join(root, 'r3-make-reference.py'), '--verify'], {env, encoding: 'utf8'});
const gate = spawnSync(process.execPath, [path.join(root, 'run-r3.mjs'), path.join(root, 'r3-not-authorized.json')], {env, encoding: 'utf8'});
assert.equal(gate.status, 1); assert.match(gate.stderr, /Fresh exclusive R3 slot required/);
assert.equal(fs.existsSync(path.join(root, 'r3-not-authorized.json')), false);
const built = await build({configFile: false, root: repository, publicDir: false, plugins: [audit()],
  worker: {format: 'es', plugins: () => [audit()]},
  build: {write: false, minify: false, lib: {entry: path.join(root, 'r3-controller.mjs'), formats: ['es']}}});
const outputs = (Array.isArray(built) ? built : [built]).flatMap(bundle => bundle.output ?? []);
assert.ok(outputs.some(item => item.fileName.includes('worker')));
const sourceFiles = [...modules].sort().map(file => ({path: path.relative(root, file), sha256: sha(fs.readFileSync(file))}));
const result = {kind: 'issue202-r3-preparation-only', browserLaunched: false, shaderExecuted: false,
  measuredPerformance: false, nativeLifecycleTested: false, nodeVersion: process.version,
  startingCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, env, encoding: 'utf8'}).trim(),
  scriptSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), tests, reference: JSON.parse(reference),
  unauthorizedRunnerRejected: true, bundled: outputs.map(item => ({fileName: item.fileName,
    bytes: Buffer.byteLength(item.type === 'chunk' ? item.code : item.source)})), sourceFiles,
  budgets: ['candidate', 'baseline'].flatMap(kind => [[1920, 1080], [3840, 2160]].flatMap(([width, height]) =>
    ['preview', 'export'].map(phase => imagePlan(kind, width, height, phase))))};
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify({output, staticTests: 10, referenceCases: 40, productionModulesCompiled: sourceFiles.length,
  browserLaunched: false, shaderExecuted: false, measuredPerformance: false}) + '\n');
