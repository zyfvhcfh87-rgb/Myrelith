import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createEvidenceStore } from './evidenceStore.mjs'
import { bounded, parseOptions } from './run-resource-gate.mjs'

async function directory(run) {
  const parent = await mkdtemp(join(tmpdir(), 'issue198-evidence-'))
  try { await run(join(parent, 'new-run')) } finally { await rm(parent, { recursive: true, force: true }) }
}
test('persists raw failing values before close and hashes exact resulting bytes', async () => directory(async (path) => {
  const store = await createEvidenceStore(path)
  const name = await store.record({ kind: 'failed', value: Number.NaN })
  assert.equal(JSON.parse(await readFile(join(path, name), 'utf8')).value.nonFiniteNumber, 'NaN')
  await store.close()
  for (const entry of JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))) {
    const bytes = await readFile(join(path, entry.name))
    assert.equal(bytes.length, entry.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256)
  }
}))
test('complete binary chunks produce the exact file and reject duplicate completion', async () => directory(async (path) => {
  const store = await createEvidenceStore(path)
  await store.binary({ name: 'source.mp4', totalBytes: 4, offset: 0, bytes: [1, 2] })
  await store.binary({ name: 'source.mp4', totalBytes: 4, offset: 2, bytes: [3, 4] })
  assert.deepEqual([...await readFile(join(path, 'source.mp4'))], [1, 2, 3, 4])
  await assert.rejects(store.binary({ name: 'source.mp4', totalBytes: 4, offset: 0, bytes: [1] }), /order/)
  await store.close()
}))
test('partial binary evidence survives failure/close and is explicitly marked partial', async () => directory(async (path) => {
  const store = await createEvidenceStore(path)
  await store.binary({ name: 'source.mp4', totalBytes: 4, offset: 0, bytes: [9, 8] })
  await assert.rejects(store.binary({ name: 'source.mp4', totalBytes: 4, offset: 3, bytes: [7] }), /order/)
  await store.close()
  assert.deepEqual([...await readFile(join(path, 'source.mp4.part'))], [9, 8])
  const closed = JSON.parse(await readFile(join(path, '00000.json'), 'utf8'))
  assert.deepEqual(closed.partial, [{ name: 'source.mp4', persistedBytes: 2, expectedBytes: 4 }])
}))
test('path traversal, unsafe byte values and overlong records fail without escaping the run', async () => directory(async (path) => {
  const store = await createEvidenceStore(path)
  await assert.rejects(store.binary({ name: '../source.mp4', totalBytes: 1, offset: 0, bytes: [1] }), /name/)
  await assert.rejects(store.binary({ name: 'source.mp4', totalBytes: 1, offset: 0, bytes: [256] }), /chunk/)
  await assert.rejects(store.record({ value: 'x'.repeat(2 * 1024 * 1024) }), /bound/)
  await store.close()
}))
test('an existing output directory cannot overwrite prior evidence', async () => directory(async (path) => {
  const store = await createEvidenceStore(path)
  await assert.rejects(createEvidenceStore(path), /EEXIST/)
  await store.close()
}))
test('close drains concurrent acknowledged records before hashing a complete manifest', async () => directory(async (path) => {
  const store = await createEvidenceStore(path)
  const records = Array.from({ length: 8 }, (_, value) => store.record({ value, sequence: -1 }))
  const closing = store.close()
  await assert.rejects(store.record({ value: 'late' }), /closed/)
  const names = await Promise.all(records); await closing
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
  assert.equal(manifest.length, 9)
  for (const [index, name] of names.entries()) assert.equal(JSON.parse(await readFile(join(path, name), 'utf8')).sequence, index)
}))
test('the runner requires a full immutable SHA and exactly one reviewed segment', () => {
  assert.throws(() => parseOptions([]), /full commit/)
  assert.throws(() => parseOptions(['--expected-sha', 'a'.repeat(40), '--segment', 'all']), /segment/)
  assert.deepEqual(parseOptions(['--expected-sha', 'a'.repeat(40), '--segment', 'raster']), { port: 5198, segment: 'raster', expectedSha: 'a'.repeat(40), output: null })
})
test('bounded steps return successful values and reject a stalled step', async () => {
  assert.equal(await bounded(Promise.resolve(17), 100, 'ready'), 17)
  await assert.rejects(bounded(new Promise(() => {}), 5, 'stalled'), /stalled exceeded/)
})
