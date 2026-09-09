import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cleanupInOrder, superviseChild } from './lifecycle.mjs'
test('stalled trace and context close cannot skip subsequent release', async () => {
  const visited = [], report = {}
  await cleanupInOrder([
    ['trace', () => { visited.push('trace'); return new Promise(() => {}) }],
    ['context', () => { visited.push('context'); return new Promise(() => {}) }],
    ['release', () => { visited.push('release') }],
  ], 10, report)
  assert.deepEqual(visited, ['trace', 'context', 'release']); assert.match(report.trace, /deadline/); assert.match(report.context, /deadline/)
})
test('independent supervisor terminates an inert child whose event loop is blocked', async () => {
  const child = spawn(process.execPath, ['-e', 'while (true) {}'], { stdio: 'ignore' })
  let expired = false
  try {
    const result = await superviseChild(child, 100, async () => { expired = true; child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)) })
    assert.equal(expired, true); assert.equal(result.expired, true); assert.equal(child.signalCode, 'SIGKILL')
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
})
