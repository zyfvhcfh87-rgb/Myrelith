import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createEvidenceStore } from './evidenceStore.mjs'
import { closeOwnedResources } from './runnerLifecycle.mjs'
import { diagnosticEvidence, runWithDiagnosticEvidence } from './diagnosticEvidence.mjs'

test('stalled fsync and closure cannot block actual cleanup; raw bytes and partial receipts survive', { timeout: 2000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'issue198-stalled-store-')), directory = join(parent, 'raw')
  const store = await createEvidenceStore(directory), receipts = []
  const firstRecord = store.record({ kind: 'raw-before-stall', maximumDelta: 19 })
  await firstRecord
  let calls = 0, closedOwner = false
  const evidence = diagnosticEvidence({
    record: () => ++calls === 1 ? firstRecord : new Promise(() => {}), close: () => new Promise(() => {}),
  }, { directory, writeMs: 5, closeMs: 5, emitFallback: (value) => { receipts.push(value) } })
  try {
    await evidence.record({ kind: 'raw-before-stall', maximumDelta: 19 })
    const raw = await readFile(join(directory, '00000.json')), rawHash = createHash('sha256').update(raw).digest('hex')
    const began = performance.now()
    const result = await runWithDiagnosticEvidence(evidence,
      () => evidence.record({ kind: 'stalled', maximumDelta: 19 }),
      async () => {
        const cleanup = await closeOwnedResources([{ name: 'inert-owner', close: () => { closedOwner = true } }])
        return { cleanup: cleanup.cleanup, failure: cleanup.failure, alivePids: [], portOpen: false }
      })
    assert.equal(closedOwner, true)
    assert.match(result.failure.message, /durable record exceeded 5 ms/)
    assert.equal(result.evidence.closed, false)
    assert.equal(result.evidence.partial, true)
    assert.equal(result.evidence.acknowledgedRecords, 1)
    assert.ok(performance.now() - began < 500)
    assert.equal(createHash('sha256').update(await readFile(join(directory, '00000.json'))).digest('hex'), rawHash)
    await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' })
    const teardown = receipts.find((r) => r.receipt.kind === 'diagnostic-run-teardown')
    assert.equal(teardown.receipt.outcome, 'failed-incomplete')
    assert.deepEqual(teardown.receipt.cleanup, [{ name: 'inert-owner', status: 'closed' }])
    assert.ok(receipts.some((r) => r.receipt.kind === 'evidence-close-failed'))
  } finally { await store.close(); await rm(parent, { recursive: true, force: true }) }
})

test('a stalled fallback writer is also bounded and does not prevent cleanup', { timeout: 2000 }, async () => {
  let cleaned = false
  const stalled = () => new Promise(() => {})
  const evidence = diagnosticEvidence({ record: stalled, close: stalled }, {
    directory: 'inert-only', writeMs: 5, closeMs: 5, fallbackMs: 5, emitFallback: stalled,
  })
  const began = performance.now()
  const result = await runWithDiagnosticEvidence(evidence, () => evidence.record({ kind: 'stalled' }), async () => { cleaned = true; return { cleanup: [] } })
  assert.equal(cleaned, true)
  assert.equal(result.evidence.partial, true)
  assert.equal(result.evidence.closed, false)
  assert.match(result.failure.message, /durable record exceeded/)
  assert.ok(performance.now() - began < 500)
})

test('a late manifest-close stall changes completed collection into a partial failure', async () => {
  const receipts = [], recorded = []
  const evidence = diagnosticEvidence({ record: (value) => { recorded.push(value) }, close: () => new Promise(() => {}) }, {
    closeMs: 5, emitFallback: (value) => { receipts.push(value) },
  })
  const result = await runWithDiagnosticEvidence(evidence, () => evidence.record({ kind: 'observations' }), async () => ({ cleanup: [{ status: 'closed' }] }))
  assert.equal(recorded.length, 2)
  assert.equal(result.evidence.closed, false)
  assert.equal(result.evidence.partial, true)
  assert.match(result.failure.message, /evidence closure exceeded 5 ms/)
  assert.equal(receipts.at(-1).receipt.outcome, 'failed-incomplete')
})
