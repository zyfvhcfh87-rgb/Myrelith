import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownedProcessRows, parseProcessRows, sameProcessIdentity } from './process-identities.mjs'

const profile = '/private/tmp/issue199-observation/profile'
const browser = { pid: 100, parentPid: 90, started: 'Tue Sep 8 15:00:00 2026', command: `Chromium --user-data-dir=${profile}` }
const child = { pid: 101, parentPid: 100, started: browser.started, command: 'Chromium Helper --type=renderer' }
test('ownership includes exact private profile and descendants but excludes a prefix-matching unrelated profile', () => {
  const unrelated = { ...browser, pid: 200, command: `${browser.command}-other` }
  const grandchild = { ...child, pid: 102, parentPid: 101 }
  assert.deepEqual(ownedProcessRows([grandchild, unrelated, child, browser], profile).map((row) => row.pid).sort(), [100, 101, 102])
})
test('an observed orphan remains owned while a reused PID or changed command does not', () => {
  assert.equal(sameProcessIdentity(child, { ...child, parentPid: 1 }), true)
  assert.deepEqual(ownedProcessRows([{ ...child, parentPid: 1 }], profile, [child]), [{ ...child, parentPid: 1 }])
  assert.deepEqual(ownedProcessRows([{ ...child, started: 'Tue Sep 8 15:01:00 2026' }], profile, [child]), [])
  assert.deepEqual(ownedProcessRows([{ ...child, command: 'unrelated private work' }], profile, [child]), [])
})
test('macOS ps parser preserves exact identity fields and drops malformed data', () => {
  assert.deepEqual(parseProcessRows(` 100 90 Tue Sep  8 15:00:00 2026 ${browser.command}\ninvalid\n`), [browser])
})
