// CPU-only audit of retained evidence and the final decision. Never launches a browser.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, '../../..');
const env = {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
let manifestEntries = 0;
for (const name of ['r3-run-1-manifest.json', 'r3-completed-manifest.json',
  'r3-completed-run-1-manifest.json', 'r4-manifest.json']) {
  for (const file of read(name).files) {
    assert.equal(sha(fs.readFileSync(path.resolve(root, file.path))), file.sha256, file.path);
    manifestEntries++;
  }
}
const audits = {};
for (const [script, args] of [
  ['verify-evidence.mjs', []],
  ['verify-r3-run1.mjs', ['--verify']],
  ['verify-r3-completed.mjs', ['--verify']],
]) {
  audits[script] = JSON.parse(execFileSync(process.execPath, [path.join(root, script), ...args],
    {cwd: repository, env, encoding: 'utf8'}));
}
assert.equal(audits['verify-evidence.mjs'].retainedScopeFailures, 1);
assert.equal(audits['verify-r3-run1.mjs'].unqualifiedPreviewCompletionRuns, 6);
assert.equal(audits['verify-r3-completed.mjs'].preview4kDecision, 'no-go-recorded-deadline-envelope');
assert.equal(audits['verify-r3-completed.mjs'].incompletePairs, 1);

let localLinks = 0;
for (const name of ['../../ISSUE_202_PLAN.md', 'final-decision.md', 'r3-completed-results.md']) {
  const file = path.resolve(root, name);
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), target.split('#')[0])), `${name}: ${target}`);
    localLinks++;
  }
}
execFileSync('git', ['diff', '--check'], {cwd: repository, env});
process.stdout.write(JSON.stringify({kind: 'issue202-final-saved-evidence-audit',
  researchDecision: 'no-go-product-promotion', browserLaunched: false,
  manifestEntries, localLinks, audits}) + '\n');
