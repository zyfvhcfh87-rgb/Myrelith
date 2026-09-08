import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { closeOwnedResources } from './runnerLifecycle.mjs'

test('successful forced cleanup preserves the original failure and continues later owners', async () => {
  const original = new Error('Owner close failed'), calls = []
  const result = await closeOwnedResources([
    { name: 'browser-server', close() { throw original }, force() { calls.push('forced') } },
    { name: 'vite', close() { calls.push('later owner') }, force() { assert.fail('Closed owner must not be forced') } },
  ])
  assert.equal(result.failure, original)
  assert.deepEqual(calls, ['forced', 'later owner'])
  assert.deepEqual(result.cleanup.map(({ name, action, status }) => [name, action, status]), [
    ['browser-server', undefined, 'failed'], ['browser-server', 'force', 'closed'], ['vite', undefined, 'closed'],
  ])
})

test('a stalled owner and force close exit failed with raw/partial evidence and exact hashes retained', { timeout: 7000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'issue198-stalled-owner-')), directory = join(parent, 'new-run')
  // This inert Node child owns only an interval and temporary evidence. No browser, server, codec or native sampler.
  const source = `
    import { closeOwnedResources, runCommand } from ${JSON.stringify(new URL('./runnerLifecycle.mjs', import.meta.url).href)}
    import { createEvidenceStore } from ${JSON.stringify(new URL('./evidenceStore.mjs', import.meta.url).href)}
    await runCommand(async () => {
      const store = await createEvidenceStore(process.argv[1])
      await store.record({ kind: 'raw-trial', timing: Number.NaN, bytesCompared: 123 })
      await store.binary({ name: 'source.mp4', totalBytes: 4, offset: 0, bytes: [9, 8] })
      setInterval(() => {}, 1000)
      let laterOwnerClosed = false
      const started = performance.now()
      const { cleanup, failure } = await closeOwnedResources([
        { name: 'browser-server', close: () => new Promise(() => {}), force: () => new Promise(() => {}) },
        { name: 'vite', close: () => { laterOwnerClosed = true } },
      ], { closeMs: 5, forceMs: 5 })
      await store.record({ kind: 'run-teardown', cleanup, outcome: failure ? 'failed' : 'passed',
        error: failure?.message, laterOwnerClosed, elapsedMs: performance.now() - started })
      await store.close()
      if (failure) throw failure
    })
  `
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, directory], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 5000, killSignal: 'SIGKILL',
    }), (cause) => {
      assert.equal(cause.code, 1, `Expected the runner to exit itself: ${cause}`)
      assert.equal(cause.killed, false)
      assert.equal(cause.signal, null)
      assert.match(cause.stderr, /browser-server close exceeded 5 ms/)
      return true
    })
    const raw = JSON.parse(await readFile(join(directory, '00000.json'), 'utf8'))
    assert.deepEqual(raw.timing, { nonFiniteNumber: 'NaN' })
    assert.equal(raw.bytesCompared, 123)
    const teardown = JSON.parse(await readFile(join(directory, '00001.json'), 'utf8'))
    assert.equal(teardown.outcome, 'failed')
    assert.equal(teardown.laterOwnerClosed, true)
    assert.ok(teardown.elapsedMs < 1000, `Teardown exceeded its inert test budget: ${teardown.elapsedMs}`)
    assert.deepEqual(teardown.cleanup, [
      { name: 'browser-server', status: 'failed', error: 'browser-server close exceeded 5 ms' },
      { name: 'browser-server', action: 'force', status: 'failed', error: 'browser-server force close exceeded 5 ms' },
      { name: 'vite', status: 'closed' },
    ])
    assert.deepEqual([...await readFile(join(directory, 'source.mp4.part'))], [9, 8])
    const closed = JSON.parse(await readFile(join(directory, '00002.json'), 'utf8'))
    assert.deepEqual(closed.partial, [{ name: 'source.mp4', persistedBytes: 2, expectedBytes: 4 }])
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.length, 4)
    for (const entry of manifest) {
      const bytes = await readFile(join(directory, entry.name))
      assert.equal(bytes.length, entry.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256)
    }
  } finally { await rm(parent, { recursive: true, force: true }) }
})
