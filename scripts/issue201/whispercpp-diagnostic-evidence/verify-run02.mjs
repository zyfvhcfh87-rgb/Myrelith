// Read-only reconstruction of failed attempt02 evidence; never starts a runtime.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assessLabRun } from '../lab-contract.mjs'
import { createRuntimeResidentMonitor } from '../whispercpp-lab/resident-monitor.mjs'

const root = new URL('../../../', import.meta.url)
const folder = 'docs/evidence/issue201/whispercpp-runtime-run-02/'
const bytes = path => readFileSync(new URL(path, root))
const json = name => JSON.parse(bytes(folder + name))
const hash = value => createHash('sha256').update(value).digest('hex')
const run = json('runtime-results-02.json'), marker = json('runtime-attempt-02.json')
const release = json('runtime-independent-release-02.json')
const journal = bytes(folder + 'runtime-partial-02.jsonl').toString().trim().split('\n').map(JSON.parse)
assert.equal(marker.commit, '406cbcb6af10c3e57b71a367caf3b193ae03dddd')
assert.equal(run.source.commit, marker.commit)
assert.equal(marker.checkpointSha256, hash(bytes('docs/evidence/issue201/whispercpp-diagnostic-runtime-source/checkpoint.json')))
assert.equal(run.source.checkpointSha256, marker.checkpointSha256)
assert.deepEqual(assessLabRun(run.results), run.acceptance)
assert.deepEqual(journal.map(row => row.sequence), journal.map((_, index) => index + 1))
assert.deepEqual(journal.filter(row => row.type === 'case-result').map(row => row.value), run.results)
assert.deepEqual(journal.filter(row => row.type === 'resident-sample').map(row => row.value), run.memory)
assert.equal(journal.at(-1).type, 'run-complete')
assert.equal(run.journal.records + 1, journal.length)
assert.equal(run.journal.broken, false)
const monitor = createRuntimeResidentMonitor()
for (const epoch of run.memoryAssessment.epochs) {
  monitor.begin(epoch.label, epoch.openedAt)
  for (const sample of run.memory.filter(sample => sample.epoch === epoch.id)) monitor.observe(sample, sample.label)
  const { coverage: _coverage, ...receipt } = epoch.closed
  monitor.close(receipt)
}
assert.deepEqual(monitor.memory, run.memory)
assert.deepEqual(monitor.snapshot(), run.memoryAssessment)
const events = run.results.at(-1).failedState.events
const diagnosticIndex = events.findIndex(event => event.type === 'native-diagnostics')
assert.ok(diagnosticIndex >= 0 && diagnosticIndex < events.findIndex(event => event.type === 'error'))
const diagnostic = events[diagnosticIndex].detail
assert.equal(diagnostic.characters, diagnostic.records.reduce((total, row) => total + row.text.length, 0))
assert.ok(diagnostic.records.length <= diagnostic.limits.records && diagnostic.characters <= diagnostic.limits.characters)
assert.ok(diagnostic.records.every(row => row.text.length <= diagnostic.limits.perRecordCharacters))
assert.equal(release.runnerPid, marker.pid)
assert.equal(release.verifiedReleased, true)
assert.equal(run.finalInputVerification.status, 'verified')
assert.deepEqual(run.finalInputVerification.assets, run.source.assets)
const noEvent = type => !events.some(event => event.type === type)
const analysis = {
  status: 'raw-evidence-recomputed', runtimeSourceCommit: marker.commit, checkpointSha256: marker.checkpointSha256,
  acceptance: run.acceptance, passed: run.results.filter(result => result.passed).length,
  failedCaseElapsedMs: run.results.at(-1).elapsedMs, firstFailure: run.stopReason,
  rawSampleCount: run.memory.length, partialJournalRecords: journal.length,
  baselineBytes: run.memoryAssessment.firstBaseline, sampledPeakBytes: run.memoryAssessment.peak,
  sampledPeakDeltaBytes: run.memoryAssessment.peak - run.memoryAssessment.firstBaseline,
  maximumActiveEpochGapMs: run.memoryAssessment.maximumActiveEpochGapMs,
  observedEpochQualified: run.memoryAssessment.qualified, fullRuntimeQualification: false,
  readyEvent: !noEvent('ready'), audioPreparationReached: events.some(event => event.phase === 'prepare'),
  inferenceReached: events.some(event => event.phase === 'infer'), transcriptProduced: !noEvent('complete'),
  diagnosticRecords: diagnostic.records.length, diagnosticCharacters: diagnostic.characters,
  omittedRecords: diagnostic.omittedRecords, truncatedRecords: diagnostic.truncatedRecords,
  nativeDiagnostics: diagnostic.records,
  workerCleanup: run.results.at(-1).failedState.lastCleanup,
  browserCloseMs: run.browserClosures[0].elapsedMs, independentReleaseAt: release.at,
  sourceAndServedBytesUnchanged: true,
}
process.stdout.write(JSON.stringify(analysis, null, 2) + '\n')
