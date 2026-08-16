import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_980
const DEFAULT_OUTPUT = 'output/playwright/issue-77-plugin-acceptance'

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function options(argv) {
  const result = { headed: false, port: DEFAULT_PORT, output: DEFAULT_OUTPUT, channel: 'chromium' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${argument} requires a value`)
      return value
    }
    if (argument === '--headed') result.headed = true
    else if (argument === '--port') result.port = positiveInteger(next(), argument)
    else if (argument === '--output') result.output = next()
    else if (argument === '--channel') result.channel = next()
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return result
}

async function sourceIdentity(root) {
  const { execFileSync } = await import('node:child_process')
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const commit = git(['rev-parse', 'HEAD'])
  return { commit, branch: git(['branch', '--show-current']) || '<detached>', ...await dirtyFingerprint(root, commit) }
}

async function main() {
  const selected = options(process.argv.slice(2))
  const root = cwd()
  const output = isAbsolute(selected.output) ? selected.output : resolve(root, selected.output)
  const source = await sourceIdentity(root)
  const problems = []
  let server
  let browser
  let context
  try {
    server = await createServer({ root, server: { host: '127.0.0.1', port: selected.port, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ channel: selected.channel, headless: !selected.headed })
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') problems.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    await page.goto(`http://127.0.0.1:${selected.port}/scripts/issue77/plugin-acceptance-gate.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const status = document.querySelector('[role="status"]')?.textContent ?? ''
      return status === 'Passed' || status.startsWith('Failed:')
    }, undefined, { timeout: 120_000 })
    const status = await page.locator('[role="status"]').textContent()
    if (status !== 'Passed') throw new Error(await page.evaluate(() => globalThis.__issue77PluginAcceptanceError) || status || 'Issue 77 browser gate failed')
    const result = await page.evaluate(() => globalThis.__issue77PluginAcceptanceResult)
    if (!result?.lifecycle?.sandboxSnapshots?.at(-1)?.terminal || !result?.lifecycle?.runtimeSnapshots?.at(-1)?.terminal) {
      throw new Error('Issue 77 browser gate did not publish terminal lifecycle evidence')
    }
    if (problems.length > 0) throw new Error(`Browser captured problems: ${[...new Set(problems)].join(' | ')}`)
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(source)) throw new Error('Source changed while Issue 77 evidence was running')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'plugin-acceptance.json'), `${JSON.stringify({ source, result }, null, 2)}\n`)
    writeFileSync(join(output, 'plugin-acceptance.png'), await page.screenshot({ fullPage: true }))
    process.stdout.write(`Issue 77 evidence: ${join(output, 'plugin-acceptance.json')}\n`)
  } finally {
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (server) await server.close().catch(() => {})
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
