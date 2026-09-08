// Saved-result audit only. Recomputes arithmetic without changing the frozen experiment.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(root, '../../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
const bytes = fs.readFileSync(path.join(root, 'r3-completed-run-1.json')), raw = JSON.parse(bytes);
assert.equal(sha(bytes), '250e58426d16ffc3e29bd668f4913bd122f0187e4290b4483654f042d524801c');
assert.equal(sha(fs.readFileSync(path.join(root, 'r3-run-1.json'))), 'e04b854961c742f90f89546ae712c9743ab36b92097b797a8f37271da9bd2e6f');
const gate = 'cd47ab73b2027a5f59be062dae2f1efb26fd22e0';
assert.equal(raw.startingCommit, gate); assert.equal(raw.completionCommit, gate);
assert.equal(raw.sourceIdentityUnchanged, true); assert.deepEqual(raw.changedSources, []);
assert.equal(raw.startingScriptSha256, raw.scriptSha256);
assert.equal(raw.scriptSha256, sha(fs.readFileSync(path.join(root, 'run-r3-completed.mjs'))));
const source = read('r3-completion-source-audit.json');
assert.equal(raw.browserVersion, source.browserVersion);
assert.equal(raw.runtimeVersion.revision, '@' + source.chromiumRevision);
const env = {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'};
for (const file of raw.verified) {
  const rel = path.relative(repository, path.resolve(root, file.path));
  assert.equal(sha(execFileSync('git', ['show', `${gate}:${rel}`], {cwd: repository, env})), file.sha256);
}
assert.equal(raw.verified.length, 109);
assert.deepEqual(raw.teardown, {browserClosed: true, serverClosed: true});
assert.deepEqual(raw.experiment.counts, {created: 20, terminated: 20, active: 0});
assert.equal(raw.experiment.jobs.length, 20); assert.equal(raw.experiment.aborted, false);
assert.ok(!raw.console.some(row => ['error', 'warning', 'warn', 'pageerror'].includes(row.type)));
function clean(owner) {
  assert.equal(owner.cleanupPassed, true); assert.equal(owner.ledger.liveBytes, 0);
  assert.deepEqual(owner.ledger.live, []); assert.deepEqual(owner.ledger.rejected, []);
  assert.equal(owner.ledger.reservations, owner.ledger.releases);
  assert.ok(owner.ledger.peakBytes <= 268435456);
}
function completion(owner) {
  assert.equal(owner.support.completion.completedSetupMs, owner.setupMs);
  assert.ok(owner.setupMs >= owner.support.completion.submissionSetupMs);
  assert.equal(owner.support.completion.setup, 'first resident composition returned through readPixels');
}
const fixture = read('r3-reference-v1.json');
function numeric(owner) {
  clean(owner); completion(owner); assert.equal(owner.numericPassed, true); assert.equal(owner.rows.length, 40);
  owner.rows.forEach((row, i) => {
    const expected = fixture.rows[i];
    assert.equal(row.frame, expected.frame); assert.equal(row.patch, expected.patch);
    assert.deepEqual(row.expectedWorking, expected.working.map(Number));
    assert.deepEqual(row.expectedViewCode10, expected.viewCode10.map(Number));
    const viewErrors = row.actualViewCode10.map((v, c) => Math.abs(v - Number(expected.viewCode10[c])));
    const alphaError = Math.abs(row.actualWorking[3] - Number(expected.working[3]));
    assert.equal(row.maximumViewCodeError, Math.max(...viewErrors)); assert.equal(row.alphaError, alphaError);
    assert.ok(row.passed && viewErrors.every(e => e <= 1) && alphaError <= 1 / 1023);
  });
}
raw.experiment.jobs.forEach(job => {
  assert.equal(job.forcedTermination, false); assert.equal(job.terminalOwnership, 'zero-owned-api-resources'); clean(job.result);
});
numeric(raw.experiment.jobs[0].result);
const rank = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summaries = [], failures = [];
let count = 0;
for (const job of raw.experiment.jobs.filter(job => job.job.type === 'measure')) {
  const result = job.result, rows = result.rows, t = result.timing;
  assert.equal(job.job.phase, 'preview'); assert.equal(result.warmupFrames, 30);
  assert.deepEqual(job.partialRows, rows);
  const misses = rows.filter(row => row.deadlineMissed);
  rows.forEach((row, i) => {
    assert.equal(row.frame, i); assert.ok(Number.isFinite(row.totalMs) && row.totalMs >= 0);
    assert.ok(Math.abs(row.completionRelativeMs - row.startRelativeMs - row.totalMs) < 1e-6);
    assert.equal(row.deadlineMissed, row.completionRelativeMs > row.deadlineMs);
    assert.ok(Math.abs(row.scheduledStartMs - i * (1000 / 30)) < 1e-6);
    assert.ok(Math.abs(row.deadlineMs - (i + 1) * (1000 / 30)) < 1e-6);
  });
  const values = rows.map(row => row.totalMs);
  assert.equal(t.maximumMs, Math.max(...values)); assert.equal(t.deadlineMisses, misses.length);
  if (t.complete) {
    assert.equal(rows.length, 120); assert.equal(t.p50Ms, rank(values, .5)); assert.equal(t.p95Ms, rank(values, .95));
    assert.ok(t.p95Ms <= 33.33 && t.maximumMs <= 100 && misses.length / 120 <= .01);
    assert.equal(t.absoluteDecision, 'pass-necessary-stage-only'); assert.equal(t.certificate, null);
  } else {
    assert.equal(job.job.kind, 'candidate'); assert.equal(job.job.width, 3840); assert.equal(job.job.repetition, 0);
    assert.equal(rows.length, 79); assert.equal(misses.length, 2);
    assert.equal(t.p50Ms, null); assert.equal(t.p95Ms, null);
    assert.equal(t.absoluteDecision, 'no-go-certificate');
    assert.equal(t.certificate, 'two-deadline-misses-disprove-1percent-of-120');
    assert.ok(misses.length / 120 > .01);
    failures.push({width: 3840, repetition: 0, measuredFrames: rows.length, decision: t.absoluteDecision,
      certificate: t.certificate, minimumMissRateOverPlanned120: misses.length / 120,
      misses: misses.map(row => ({frame: row.frame, totalMs: row.totalMs,
        startDelayMs: row.startRelativeMs - row.scheduledStartMs,
        deadlineOverrunMs: row.completionRelativeMs - row.deadlineMs}))});
  }
  if (job.job.kind === 'candidate') completion(result);
  count += rows.length;
  summaries.push({...job.job, measuredFrames: rows.length, p95Ms: t.p95Ms, maximumMs: t.maximumMs,
    deadlineMisses: t.deadlineMisses, absoluteDecision: t.absoluteDecision, certificate: t.certificate,
    completedSetupMs: result.setupMs, peakBytes: result.ledger.peakBytes});
}
assert.equal(summaries.length, 12); assert.equal(count, 1399); assert.equal(failures.length, 1);
let incompletePairs = 0;
for (const pair of raw.experiment.pairs) {
  const b = raw.experiment.jobs[pair.members.baseline].result.timing;
  const c = raw.experiment.jobs[pair.members.candidate].result.timing;
  if (c.complete) {
    assert.equal(pair.comparison.ratio, c.p95Ms / b.p95Ms);
    assert.equal(pair.comparison.decision, 'pass-necessary-stage-only');
  } else {
    incompletePairs++; assert.equal(pair.comparison.ratio, null);
    assert.equal(pair.comparison.decision, 'unqualified-incomplete-pair');
    assert.equal(c.absoluteDecision, 'no-go-certificate');
  }
}
assert.equal(incompletePairs, 1);
const cycles = raw.experiment.jobs.find(job => job.job.type === 'cycles').result.cycles;
assert.equal(cycles.length, 10); cycles.forEach(owner => { clean(owner); completion(owner); });
const cancellations = raw.experiment.jobs.filter(job => job.job.type === 'cancel');
assert.equal(cancellations.length, 5);
cancellations.forEach(job => {
  completion(job.result); assert.equal(job.cancellationPassed, true); assert.ok(job.cancellationAckMs <= 250);
  assert.equal(job.result.outcome, 'cancelled'); assert.equal(job.result.rows.length, 1);
});
const loss = raw.experiment.jobs.at(-1).result;
assert.equal(loss.loss.rejectedAfterLoss, true); clean(loss.loss); completion(loss.loss); numeric(loss.retry);
const result = {kind: 'issue202-r3-corrected-result-analysis', rawSha256: sha(bytes),
  scriptSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), historicalSourceEntries: 109,
  timingRows: count, numericCases: 40, retryCases: 40, completedRuns: 11, earlyNoGoRuns: 1,
  incompletePairs, sourceIdentityVerified: true, runtimeVersion: raw.runtimeVersion, backend: raw.gpu.renderer,
  summaries, failures, preview1080pDecision: 'pass-bounded-resident-stage-only',
  preview4kDecision: 'no-go-recorded-deadline-envelope',
  originalPreviewDecision: 'still-unqualified-finish-only-not-overwritten',
  fullManagedProductDecision: 'no-go-promotion',
  lifecycle: {completedDrawCycles: 10, cancellationAcknowledgementMs: cancellations.map(job => job.cancellationAckMs),
    contextLossRejected: true, freshOwnerNumericPassed: true, allOwnedLedgersZero: true, nativeReclamation: 'unmeasured'},
  decisionRule: 'An absolute no-go certificate is retained independently of an unqualified paired ratio. This run disproves the recorded 4K synthetic deadline envelope, not all 4K platforms or intrinsic per-frame shader speed.'};
if (process.argv[2] === '--verify') assert.deepEqual(read('r3-completed-analysis-1.json'), result);
else fs.writeFileSync(path.join(root, 'r3-completed-analysis-1.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify({rawSha256: result.rawSha256, historicalSourceEntries: 109, timingRows: count,
  preview1080pDecision: result.preview1080pDecision, preview4kDecision: result.preview4kDecision,
  earlyNoGoRuns: 1, incompletePairs: 1, allOwnedLedgersZero: true}) + '\n');
