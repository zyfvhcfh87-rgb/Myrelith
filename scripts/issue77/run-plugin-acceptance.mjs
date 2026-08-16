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
  const expectedSecurityDiagnostics = []
  let securityProbeRunning = true
  let server
  let browser
  let context
  let safetyContext
  try {
    server = await createServer({ root, server: { host: '127.0.0.1', port: selected.port, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ channel: selected.channel, headless: !selected.headed })
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() !== 'warning' && message.type() !== 'error') return
      const detail = `${message.type()}: ${message.text()}`
      if (securityProbeRunning
        && /Content Security Policy|violates the following Content Security Policy/u.test(detail)) {
        expectedSecurityDiagnostics.push(detail)
      } else {
        problems.push(detail)
      }
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
    securityProbeRunning = false
    if (!result?.lifecycle?.sandboxSnapshots?.at(-1)?.terminal || !result?.lifecycle?.runtimeSnapshots?.at(-1)?.terminal) {
      throw new Error('Issue 77 browser gate did not publish terminal lifecycle evidence')
    }
    if (!result?.sandboxCapabilities
      || Object.entries(result.sandboxCapabilities)
        .filter(([key]) => key !== 'terminalOwnership')
        .some(([, value]) => value !== true)) {
      throw new Error('Issue 77 browser gate did not prove every sandbox capability negative')
    }

    await page.goto(`http://127.0.0.1:${selected.port}/`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Start a new project' }).click()
    await page.getByRole('textbox', { name: 'Project name' }).fill('Issue 77 browser acceptance')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins' }).click()
    const manager = page.getByRole('dialog', { name: 'Manage plugins' })
    await manager.waitFor({ state: 'visible' })
    await manager.getByRole('button', { name: 'Inspect package…' }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Inspect package…')
    const initialFocus = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    if (!initialFocus.startsWith('Inspect package')) {
      throw new Error(`Plugin Manager initial focus was not visible and actionable: ${initialFocus}`)
    }
    await manager.getByLabel('Choose a plugin package').setInputFiles(
      join(root, 'samples/plugins/audited-invert-v1/audited-invert-v1.myrelith-plugin'),
    )
    const review = page.getByRole('dialog', { name: 'Review Audited Invert' })
    await review.waitFor({ state: 'visible' })
    const decisions = review.getByRole('checkbox')
    for (let index = 0; index < await decisions.count(); index += 1) {
      const decision = decisions.nth(index)
      if (await decision.isEnabled() && !await decision.isChecked()) await decision.check()
    }
    await review.getByRole('button', { name: 'Install plugin' }).click()
    await manager.getByRole('heading', { name: 'Audited Invert' }).waitFor({ state: 'visible' })
    const tinyPluginText = await manager.evaluate((dialog) => [...dialog.querySelectorAll('*')]
      .filter((element) => {
        const style = getComputedStyle(element)
        return element.textContent?.trim() && style.display !== 'none' && style.visibility !== 'hidden'
          && Number.parseFloat(style.fontSize) < 10
      }).map((element) => element.textContent?.trim()).slice(0, 5))
    if (tinyPluginText.length > 0) {
      throw new Error(`Plugin Manager contains sub-10px visible text: ${tinyPluginText.join(' | ')}`)
    }
    await manager.getByRole('button', { name: 'Review uninstall' }).click()
    await manager.getByRole('button', { name: 'Confirm uninstall' }).click()
    await manager.getByText('No plugins installed').waitFor({ state: 'visible' })
    await manager.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'Plugins' }).waitFor({ state: 'visible' })

    safetyContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await safetyContext.addInitScript(() => {
      localStorage.setItem(
        'myrelith.plugin-activation:v1',
        JSON.stringify({ version: 1, batchId: 'issue77-interrupted-activation' }),
      )
    })
    const safetyPage = await safetyContext.newPage()
    safetyPage.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') problems.push(`${message.type()}: ${message.text()}`)
    })
    safetyPage.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    await safetyPage.goto(`http://127.0.0.1:${selected.port}/`, { waitUntil: 'domcontentloaded' })
    await safetyPage.getByText('Startup review required').waitFor({ state: 'visible' })
    if (await safetyPage.getByRole('button', { name: 'Start a new project' }).count() !== 0) {
      throw new Error('Project launcher escaped the interrupted-activation startup gate')
    }
    const safeHeadingFocused = await safetyPage.getByRole('heading', { name: 'Plugin safe mode' }).evaluate(
      (heading) => document.activeElement === heading,
    )
    if (!safeHeadingFocused) throw new Error('Startup recovery heading did not receive focus')
    await safetyPage.getByRole('button', { name: 'Enter safe mode' }).click()
    await safetyPage.getByRole('button', { name: 'Safe mode active' }).waitFor({ state: 'visible' })
    await safetyPage.getByRole('button', { name: 'Start a new project' }).waitFor({ state: 'visible' })

    if (problems.length > 0) throw new Error(`Browser captured problems: ${[...new Set(problems)].join(' | ')}`)
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(source)) throw new Error('Source changed while Issue 77 evidence was running')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'plugin-acceptance.json'), `${JSON.stringify({
      source,
      result,
      expectedSecurityDiagnostics: [...new Set(expectedSecurityDiagnostics)],
      ui: {
        installedAndUninstalledThroughProductionUi: true,
        visibleInitialFocus: true,
        minimumObservedPluginTextPx: 10,
        interruptedActivationBlockedLauncher: true,
        safeModeRecoveryOpenedLauncher: true,
      },
    }, null, 2)}\n`)
    writeFileSync(join(output, 'plugin-acceptance.png'), await page.screenshot({ fullPage: true }))
    writeFileSync(join(output, 'plugin-safe-mode.png'), await safetyPage.screenshot({ fullPage: true }))
    process.stdout.write(`Issue 77 evidence: ${join(output, 'plugin-acceptance.json')}\n`)
  } finally {
    if (safetyContext) await safetyContext.close().catch(() => {})
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (server) await server.close().catch(() => {})
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1 })
