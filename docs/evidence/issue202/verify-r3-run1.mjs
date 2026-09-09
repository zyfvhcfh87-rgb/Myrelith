// Recompute saved evidence only. Does not launch, repair or rerun the experiment.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(root, '../../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
const rawBytes = fs.readFileSync(path.join(root, 'r3-run-1.json')), raw = JSON.parse(rawBytes);
assert.equal(sha(rawBytes), 'e04b854961c742f90f89546ae712c9743ab36b92097b797a8f37271da9bd2e6f');
const gate = 'd7b900a396c5a5cf004e1ddc7cc9fe5aeaae424f';
assert.equal(raw.startingCommit, gate); assert.equal(raw.completionCommit, gate);
assert.equal(raw.sourceIdentityUnchanged, true); assert.deepEqual(raw.changedSources, []);
assert.equal(raw.startingScriptSha256, raw.scriptSha256);
assert.equal(raw.scriptSha256, sha(fs.readFileSync(path.join(root, 'run-r3.mjs'))));
const env = {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'};
for (const file of raw.verified) {
  const rel = path.relative(repository, path.resolve(root, file.path));
  assert.equal(sha(execFileSync('git', ['show', `${gate}:${rel}`], {cwd: repository, env})), file.sha256);
}
assert.equal(raw.verified.length, 99);
assert.deepEqual(raw.teardown, {browserClosed: true, serverClosed: true});
assert.deepEqual(raw.experiment.counts, {created: 32, terminated: 32, active: 0});
assert.equal(raw.experiment.aborted, false); assert.equal(raw.experiment.fullProductDecision, 'not-qualified');
assert.equal(raw.experiment.jobs.length, 32);
assert.ok(!raw.console.some(row => ['error', 'warning', 'warn', 'pageerror'].includes(row.type)));
const clean = owner => {
  assert.equal(owner.cleanupPassed, true); assert.equal(owner.ledger.liveBytes, 0);
  assert.deepEqual(owner.ledger.live, []); assert.deepEqual(owner.ledger.rejected, []);
  assert.equal(owner.ledger.reservations, owner.ledger.releases);
  assert.ok(owner.ledger.peakBytes <= 268435456);
};
for (const job of raw.experiment.jobs) {
  assert.equal(job.forcedTermination, false); assert.equal(job.terminalOwnership, 'zero-owned-api-resources'); clean(job.result);
}
const fixture = read('r3-reference-v1.json');
function checkNumeric(owner) {
  clean(owner); assert.equal(owner.rows.length, 40); assert.equal(owner.numericPassed, true);
  for (let i = 0; i < 40; i++) {
    const actual = owner.rows[i], expected = fixture.rows[i];
    assert.equal(actual.frame, expected.frame); assert.equal(actual.patch, expected.patch);
    assert.deepEqual(actual.expectedWorking, expected.working.map(Number));
    assert.deepEqual(actual.expectedViewCode10, expected.viewCode10.map(Number));
    const errors = actual.actualViewCode10.map((v, c) => Math.abs(v - Number(expected.viewCode10[c])));
    const alphaError = Math.abs(actual.actualWorking[3] - Number(expected.working[3]));
    assert.equal(actual.maximumViewCodeError, Math.max(...errors)); assert.equal(actual.alphaError, alphaError);
    assert.ok(actual.passed && errors.every(e => e <= 1) && alphaError <= 1 / 1023);
  }
}
checkNumeric(raw.experiment.jobs[0].result);
const rank = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const timings = [];
for (const job of raw.experiment.jobs.filter(job => job.job.type === 'measure')) {
  const result = job.result, rows = result.rows, timing = result.timing;
  assert.equal(result.warmupFrames, 30); assert.equal(rows.length, 120);
  assert.deepEqual(job.partialRows, rows); assert.equal(timing.complete, true);
  rows.forEach((row, i) => {
    assert.equal(row.frame, i); assert.ok(Number.isFinite(row.totalMs) && row.totalMs >= 0);
    assert.ok(Math.abs(row.completionRelativeMs - row.startRelativeMs - row.totalMs) < 1e-6);
    assert.equal(row.deadlineMissed, job.job.phase === 'preview' && row.completionRelativeMs > row.deadlineMs);
  });
  const values = rows.map(row => row.totalMs);
  assert.equal(timing.p50Ms, rank(values, .5)); assert.equal(timing.p95Ms, rank(values, .95));
  assert.equal(timing.maximumMs, Math.max(...values)); assert.equal(timing.deadlineMisses, 0);
  assert.equal(timing.certificate, null); assert.equal(timing.absoluteDecision, 'pass-necessary-stage-only');
  timings.push({...job.job, p95Ms: timing.p95Ms, maximumMs: timing.maximumMs, setupMs: result.setupMs,
    peakBytes: result.ledger.peakBytes, rawAbsoluteDecision: timing.absoluteDecision,
    qualifiedDecision: job.job.kind === 'candidate' && job.job.phase === 'preview'
      ? 'unqualified-preview-completion-barrier' : 'pass-bounded-readback-stage-only'});
}
assert.equal(timings.length, 24);
for (const pair of raw.experiment.pairs) {
  const b = raw.experiment.jobs[pair.members.baseline].result.timing;
  const c = raw.experiment.jobs[pair.members.candidate].result.timing;
  assert.equal(pair.comparison.ratio, c.p95Ms / b.p95Ms);
  assert.equal(pair.comparison.decision, 'pass-necessary-stage-only');
  if (pair.phase === 'export') assert.ok(pair.comparison.ratio <= 4);
}
const cycles = raw.experiment.jobs.find(job => job.job.type === 'cycles').result.cycles;
assert.equal(cycles.length, 10); cycles.forEach(clean);
const cancellations = raw.experiment.jobs.filter(job => job.job.type === 'cancel');
assert.equal(cancellations.length, 5);
for (const job of cancellations) {
  assert.equal(job.cancellationPassed, true); assert.ok(job.cancellationAckMs <= 250);
  assert.equal(job.result.outcome, 'cancelled'); assert.equal(job.result.rows.length, 1);
}
const context = raw.experiment.jobs.at(-1).result;
assert.equal(context.loss.rejectedAfterLoss, true); clean(context.loss); checkNumeric(context.retry);
const sourceAudit = read('r3-completion-source-audit.json');
assert.equal(sourceAudit.scriptSha256, sha(fs.readFileSync(path.join(root, 'r3-audit-chromium-source.py'))));
assert.equal(sourceAudit.browserVersion, raw.browserVersion); assert.equal(sourceAudit.finish.callsFlush, true);
const result = {kind: 'issue202-r3-run1-qualified-analysis', rawSha256: sha(rawBytes),
  scriptSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), historicalSourceEntries: raw.verified.length,
  timingRows: 2880, numericCases: 40, retryCases: 40, sourceIdentityVerified: true, allOwnedLedgersZero: true,
  backend: raw.gpu.renderer, elapsedMs: raw.experiment.elapsedMs, timings,
  absoluteNoGoCertificates: 0, incompletePairs: 0, unqualifiedPreviewCompletionRuns: 6,
  previewDecision: 'unqualified-completion-barrier', exportStageDecision: 'pass-bounded-resident-readback-only',
  lifecycle: {apiOwnerCycles: 10, completedPreviewDrawCycles: 'unqualified-finish-only',
    cancellationsMs: cancellations.map(job => job.cancellationAckMs), contextLossRejected: true, freshOwnerNumericPassed: true},
  fullManagedProductDecision: 'no-go-current-scope-precision-and-output-prerequisites',
  reportingRule: 'An absolute no-go certificate remains no-go even if the paired ratio is unqualified. Run1 has no such timing certificate; its raw preview pass is instead unqualified by a failed measurement prerequisite.'};
const output = path.join(root, 'r3-analysis-1.json');
if (process.argv[2] === '--verify') assert.deepEqual(read('r3-analysis-1.json'), result);
else fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify({rawSha256: result.rawSha256, historicalSourceEntries: 99, timingRows: 2880,
  numericCases: 80, unqualifiedPreviewCompletionRuns: 6, allOwnedLedgersZero: true}) + '\n');
