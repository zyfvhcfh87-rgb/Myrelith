import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const vitestPath = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
)
const child = spawn(
  process.execPath,
  [vitestPath, 'run', ...process.argv.slice(2)],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  },
)

let stderr = ''

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
})

child.stderr.on('data', (chunk) => {
  const text = chunk.toString()
  stderr += text
  process.stderr.write(chunk)
})

child.on('error', (error) => {
  console.error('Could not start Vitest:', error)
  process.exitCode = 1
})

child.on('close', (code, signal) => {
  if (signal) {
    console.error(`Vitest stopped after receiving ${signal}.`)
    process.exitCode = 1
    return
  }

  const emittedTestStderr = /(?:^|\r?\n)stderr\s*\|/m.test(stderr)
  if (code === 0 && emittedTestStderr) {
    console.error(
      '\nTest console gate failed: a passing test emitted stderr. '
        + 'Assert and mock the expected diagnostic, or fix the unexpected warning.',
    )
    process.exitCode = 1
    return
  }

  process.exitCode = code ?? 1
})
