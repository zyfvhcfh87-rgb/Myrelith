import { chromium, firefox } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_208
const DEFAULT_OUTPUT = 'output/playwright/issue-208-inventory'
const SCHEMA_VERSION = 1
const SCENARIO = 'issue-208-compatibility-inventory-v1'
const BROWSER_CHANNELS = new Set(['chromium', 'firefox'])

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

function options(argv) {
  const result = { headed: false, port: DEFAULT_PORT, output: DEFAULT_OUTPUT, channel: 'chromium' }
  for (let index = 0; index < argv.length; index++) {
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
  if (result.channel === 'webkit' || result.channel === 'safari') {
    throw new Error(
      'Playwright WebKit is not Safari. Run this inventory in shipped Safari 26+ on macOS by opening scripts/issue208/compatibility-inventory-gate.html.',
    )
  }
  if (!BROWSER_CHANNELS.has(result.channel)) {
    throw new Error(`Unknown channel: ${result.channel}`)
  }
  return result
}

function gitText(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

async function sourceIdentity(root) {
  const commit = gitText(root, ['rev-parse', 'HEAD'])
  return {
    commit,
    branch: gitText(root, ['branch', '--show-current']) || '<detached>',
    ...await dirtyFingerprint(root, commit),
  }
}

function hostIdentity(browserVersion, selected) {
  const processors = cpus()
  return {
    browserChannel: selected.channel,
    browserVersion,
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    cpuModel: processors[0]?.model ?? '<unknown>',
    logicalProcessors: processors.length || null,
    totalMemoryGiB: Math.round(totalmem() / 1024 ** 3 * 100) / 100,
    command: `npm run qa:issue208:inventory -- --channel ${selected.channel} --port ${selected.port}`,
    safariNote: 'Safari 26+ must be driven on macOS. Linux WebKit is not that gate.',
  }
}

function optionalList(optional) {
  return Object.entries(optional)
    .map(([id, available]) => `${id}: ${available ? 'available' : 'disabled'}`)
    .join('</li><li>')
}

function reportHtml(artifact) {
  const decision = artifact.result.decision
  const core = decision.core
  const reasons = decision.reasons.length === 0 ? 'none' : decision.reasons.join(', ')
  const auto = decision.autoPreset ?? 'none'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #f8fbff; background: linear-gradient(145deg, #10141c, #182033); }
    main { width: min(1040px, calc(100% - 48px)); margin: auto; padding: 48px 0; }
    .eyebrow { color: #9ecbff; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0; font-size: 40px; }
    .lead, li, footer { color: #b9c4d4; line-height: 1.55; }
    .status { display: inline-flex; margin: 16px 0 24px; padding: 8px 12px; border-radius: 999px;
      border: 1px solid ${core === 'go' ? '#72f0bd55' : '#f0c57255'};
      color: ${core === 'go' ? '#93ffd0' : '#ffd093'}; background: #ffffff10; }
    section { padding: 18px; border: 1px solid #ffffff14; border-radius: 16px; background: #ffffff09; }
    footer { margin-top: 22px; font: 12px ui-monospace, monospace; }
  </style></head><body><main>
    <div class="eyebrow">MYRELITH · ISSUE 208 · CAPABILITY INVENTORY</div>
    <h1>Facts, not a support claim</h1>
    <p class="lead">This run recorded WebCodecs, workers, audio clock, origin storage, File System Access, OPFS, WebGL2, and plugin isolation. Chromium stays the advertised product. Firefox/Safari names are not a public claim.</p>
    <div class="status">core ${core} · Auto ${auto} · publicSupportClaim=${artifact.result.publicSupportClaim}</div>
    <section>
      <h2>Core reasons</h2>
      <p>${reasons}</p>
      <h2>Optional features</h2>
      <ul><li>${optionalList(decision.optional)}</li></ul>
    </section>
    <footer>${artifact.host.browserChannel} ${artifact.host.browserVersion}<br>${artifact.source.branch} · ${artifact.source.commit.slice(0, 12)} · ${artifact.source.fingerprint}</footer>
  </main></body></html>`
}

function validateInventory(result) {
  if (result?.contract !== SCENARIO || result?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Issue #208 inventory contract or schema drifted')
  }
  if (result.publicSupportClaim !== false) {
    throw new Error('Issue #208 inventory must not make a public support claim')
  }
  if (!result.decision || (result.decision.core !== 'go' && result.decision.core !== 'no-go')) {
    throw new Error('Issue #208 inventory did not publish a core decision')
  }
  const reasonText = JSON.stringify(result.decision)
  if (/firefox|safari|chrome|webkit|gecko|useragent/i.test(reasonText)) {
    throw new Error('Issue #208 inventory decision used a browser-name or user-agent string')
  }
  if (result.workerLifecycle?.activeWorkers !== 0 || result.workerLifecycle?.workersTerminated !== 1) {
    throw new Error('Issue #208 inventory worker was not terminated')
  }
  const resources = result.resources
  if (
    resources.videoFramesCreated !== resources.videoFramesClosed
    || resources.audioDataCreated !== resources.audioDataClosed
    || resources.imageBitmapsCreated !== resources.imageBitmapsClosed
  ) {
    throw new Error('Issue #208 inventory leaked a media resource')
  }
}

async function launchBrowser(selected) {
  if (selected.channel === 'firefox') {
    return firefox.launch({
      headless: !selected.headed,
      firefoxUserPrefs: { 'media.volume_scale': '0.0' },
    })
  }
  return chromium.launch({
    channel: 'chromium',
    headless: !selected.headed,
    args: ['--mute-audio'],
  })
}

async function main() {
  const selected = options(process.argv.slice(2))
  const root = cwd()
  const output = isAbsolute(selected.output) ? selected.output : resolve(root, selected.output)
  const initialSource = await sourceIdentity(root)
  const problems = []
  let server
  let browser
  let context
  try {
    server = await createServer({
      root,
      server: { host: '127.0.0.1', port: selected.port, strictPort: true },
    })
    await server.listen()
    browser = await launchBrowser(selected)
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    await page.goto(
      `http://127.0.0.1:${selected.port}/scripts/issue208/compatibility-inventory-gate.html`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.getByRole('button', { name: 'Run inventory' }).click()
    await page.waitForFunction(() => {
      const text = document.querySelector('[role="status"]')?.textContent ?? ''
      return text === 'Passed' || text.startsWith('Failed:')
    }, undefined, { timeout: 180_000 })
    const statusText = await page.locator('[role="status"]').textContent()
    if (statusText !== 'Passed') {
      const gateError = await page.evaluate(() => globalThis.__issue208InventoryError)
      throw new Error(gateError || statusText || 'Issue #208 inventory failed')
    }
    const result = await page.evaluate(() => globalThis.__issue208InventoryResult)
    validateInventory(result)
    const artifact = {
      schemaVersion: SCHEMA_VERSION,
      scenario: SCENARIO,
      generatedAt: new Date().toISOString(),
      source: initialSource,
      host: hostIdentity(browser.version(), selected),
      result,
      pageErrors: problems,
    }
    await page.setContent(reportHtml(artifact), { waitUntil: 'load' })
    await page.evaluate(() => new Promise((resolvePaint) => {
      requestAnimationFrame(() => requestAnimationFrame(resolvePaint))
    }))
    const screenshot = await page.screenshot({ fullPage: true })
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(initialSource)) {
      throw new Error('Source changed while Issue #208 inventory was running')
    }
    mkdirSync(output, { recursive: true })
    const stem = `inventory-${selected.channel}`
    writeFileSync(join(output, `${stem}.json`), `${JSON.stringify(artifact, null, 2)}\n`)
    writeFileSync(join(output, `${stem}.png`), screenshot)
    process.stdout.write(`Issue 208 inventory evidence: ${join(output, `${stem}.json`)}\n`)
    process.stdout.write(`Core decision: ${result.decision.core}\n`)
    process.stdout.write(`Auto preset: ${result.decision.autoPreset ?? 'none'}\n`)
    process.stdout.write(`Browser screenshot: ${join(output, `${stem}.png`)}\n`)
  } finally {
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (server) await server.close().catch(() => {})
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
