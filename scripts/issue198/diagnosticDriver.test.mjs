import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { diagnosticOptions, readDiagnosticInput, verifyDiagnosticInput } from './run-export-diagnostic.mjs'

test('diagnostic options pin a full SHA and cannot add another input, segment or retry', () => {
  assert.throws(() => diagnosticOptions([]), /full/)
  for (const key of ['--source', '--segment', '--retry', '--port']) assert.throws(() => diagnosticOptions(['--expected-sha', 'a'.repeat(40), key, 'changed']), /Unknown/)
  assert.deepEqual(diagnosticOptions(['--expected-sha', 'a'.repeat(40)]), { expectedSha: 'a'.repeat(40), output: null })
})
test('immutable byte identity rejects equal-sized mutation and a changed length', async () => {
  const bytes = Buffer.from([9, 8, 7, 6]), expected = { name: 'source.mp4', bytes: 4, sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.equal(verifyDiagnosticInput(bytes, expected).sha256, expected.sha256)
  assert.throws(() => verifyDiagnosticInput(Buffer.from([9, 8, 7, 5]), expected), /changed/)
  const path = await mkdtemp(join(tmpdir(), 'issue198-pinned-diagnostic-')), file = join(path, 'source.mp4')
  try {
    await writeFile(file, bytes); assert.deepEqual(await readDiagnosticInput(file, expected), bytes)
    await writeFile(file, Buffer.alloc(8)); await assert.rejects(readDiagnosticInput(file, expected), /size changed/)
    await writeFile(file, Buffer.from([9, 8, 7, 5])); await assert.rejects(readDiagnosticInput(file, expected), /changed/)
  } finally { await rm(path, { recursive: true, force: true }) }
})
