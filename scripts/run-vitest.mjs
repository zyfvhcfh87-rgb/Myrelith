import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const vitestPath = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const benchmarkRunnerTest = fileURLToPath(
  new URL('./performance/run-benchmark.test.mjs', import.meta.url),
)

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    let stderr = ''
    let startError = null
    child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      startError = error
    })
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, startError })
    })
  })
}

async function main() {
  const vitest = await run(
    process.execPath,
    [vitestPath, 'run', ...process.argv.slice(2)],
  )
  if (vitest.startError) throw vitest.startError
  if (vitest.signal) {
    throw new Error(`Vitest stopped after receiving ${vitest.signal}.`)
  }
  if (vitest.code !== 0) {
    process.exitCode = vitest.code ?? 1
    return
  }
  if (/(?:^|\r?\n)stderr\s*\|/m.test(vitest.stderr)) {
    throw new Error(
      'Test console gate failed: a passing test emitted stderr. '
        + 'Assert and mock the expected diagnostic, or fix the unexpected warning.',
    )
  }

  // These tests exercise the Node CLI module directly and intentionally use
  // node:test, so the canonical gate runs them after Vitest without recursion.
  const runner = await run(
    process.execPath,
    ['--test', benchmarkRunnerTest],
  )
  if (runner.startError) throw runner.startError
  if (runner.signal) {
    throw new Error(`Benchmark runner tests stopped after receiving ${runner.signal}.`)
  }
  process.exitCode = runner.code ?? 1
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
