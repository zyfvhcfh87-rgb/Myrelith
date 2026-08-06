import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSourceIdentityUnchanged,
  buildBenchmarkApp,
  collectColdSamples,
  finalizeBrowserEvidence,
  MAX_CONTINUOUS_EXPORT_FRAMES,
  MAX_CONTINUOUS_PLAYBACK_DURATION_MS,
  parseArguments,
  runTypeScriptGate,
} from './run-benchmark.mjs'
import { join } from 'node:path'

test('cold samples each use and close a fresh BrowserContext', async () => {
  const contexts = []
  const browser = {
    async newContext(options) {
      const context = {
        id: contexts.length + 1,
        options,
        closed: false,
        async newPage() {
          return { contextId: context.id }
        },
        async close() {
          context.closed = true
        },
      }
      contexts.push(context)
      return context
    },
  }

  const samples = await collectColdSamples(
    browser,
    3,
    async (page) => page.contextId,
  )

  assert.deepEqual(samples, [1, 2, 3])
  assert.equal(contexts.length, 3)
  assert.ok(contexts.every((context) => context.closed))
  assert.notStrictEqual(contexts[0], contexts[1])
})

test('source identity rejects end-of-run drift', () => {
  const initial = {
    branch: 'feat/issue-54-performance-harness',
    commit: 'abc123',
    dirty: true,
    fingerprint: 'sha256:initial',
  }

  assert.doesNotThrow(() => assertSourceIdentityUnchanged(initial, { ...initial }))
  assert.throws(
    () => assertSourceIdentityUnchanged(initial, {
      ...initial,
      fingerprint: 'sha256:changed',
    }),
    /Source changed during the benchmark/,
  )
})

test('benchmark build runs the repository TypeScript gate before Vite', async () => {
  const calls = []
  await buildBenchmarkApp('C:\\repo', {
    runTypeScriptGate(root) {
      calls.push(`tsc:${root}`)
    },
    async buildVite({ root }) {
      calls.push(`vite:${root}`)
    },
  })

  assert.deepEqual(calls, ['tsc:C:\\repo', 'vite:C:\\repo'])
})

test('TypeScript gate uses the repository compiler in build mode', () => {
  let invocation
  runTypeScriptGate('C:\\repo', (file, args, options) => {
    invocation = { file, args, options }
  })

  assert.deepEqual(invocation, {
    file: process.execPath,
    args: [join('C:\\repo', 'node_modules', 'typescript', 'bin', 'tsc'), '-b'],
    options: { cwd: 'C:\\repo', stdio: 'inherit' },
  })
})

test('runner rejects durations beyond the continuously encoded source plan', () => {
  assert.throws(
    () => parseArguments([
      '--playback-ms',
      String(MAX_CONTINUOUS_PLAYBACK_DURATION_MS + 1),
    ]),
    /continuous encoded source window/,
  )
  assert.throws(
    () => parseArguments([
      '--export-frames',
      String(MAX_CONTINUOUS_EXPORT_FRAMES + 1),
    ]),
    /continuous encoded source window/,
  )
  assert.equal(
    parseArguments([
      '--playback-ms',
      String(MAX_CONTINUOUS_PLAYBACK_DURATION_MS),
      '--export-frames',
      String(MAX_CONTINUOUS_EXPORT_FRAMES),
    ]).options.exportFrames,
    MAX_CONTINUOUS_EXPORT_FRAMES,
  )
})

test('final browser evidence includes problems raised during screenshot, settling, and result formatting', async () => {
  const problems = ['warning: before result']
  let settledOnce = false
  let screenshotCount = 0
  let renderedSummary = ''
  const page = {
    async screenshot() {
      screenshotCount++
      if (screenshotCount === 1) problems.push('error: during screenshot')
      return Buffer.from(renderedSummary)
    },
    async evaluate() {
      if (!settledOnce) {
        settledOnce = true
        problems.push('pageerror: after result render')
      }
    },
    async waitForTimeout() {},
  }
  const finalizedSnapshots = []
  const evidence = await finalizeBrowserEvidence(
    page,
    problems,
    async (consoleProblems) => {
      finalizedSnapshots.push(consoleProblems)
      if (finalizedSnapshots.length === 1) {
        problems.push('warning: during result formatting')
      }
      renderedSummary = consoleProblems.join('\n')
      return renderedSummary
    },
  )

  assert.deepEqual(evidence.consoleProblems, [
    'warning: before result',
    'pageerror: after result render',
    'warning: during result formatting',
    'error: during screenshot',
  ])
  assert.deepEqual(finalizedSnapshots.at(-1), evidence.consoleProblems)
  assert.equal(evidence.finalizedResult, evidence.consoleProblems.join('\n'))
  assert.equal(screenshotCount, 2)
  assert.equal(evidence.screenshot.toString(), evidence.consoleProblems.join('\n'))
})
