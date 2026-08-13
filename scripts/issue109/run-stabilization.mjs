import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_858
const DEFAULT_OUTPUT = 'output/playwright/issue-109-video-stabilization'
const SCHEMA_VERSION = 1

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
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
    command: `npm run qa:issue109:stabilization -- --port ${selected.port}`,
  }
}

function reportHtml(artifact) {
  const result = artifact.result
  const metric = (label, value, note) => `
    <article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #faf8ff; background:
      radial-gradient(circle at 18% 10%, #713f9866, transparent 35%),
      linear-gradient(145deg, #11101a, #271832 62%, #10151e); }
    main { width: min(1120px, calc(100% - 64px)); margin: auto; padding: 52px 0; }
    .eyebrow { color: #ddb8ff; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0; font-size: 42px; letter-spacing: -.04em; }
    .lead { max-width: 820px; color: #c0b8ca; line-height: 1.55; }
    .status { display: inline-flex; margin: 16px 0 30px; padding: 8px 12px; border: 1px solid #70e8ae55;
      border-radius: 999px; color: #8dffc5; background: #163827aa; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    article, section { padding: 19px; border: 1px solid #ffffff14; border-radius: 17px; background: #ffffff09; }
    article span, article small { display: block; color: #aaa2b7; }
    article strong { display: block; margin: 14px 0 8px; font-size: 27px; }
    section { margin-top: 18px; background: #17131fdd; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    ul { margin: 0; padding-left: 20px; color: #cbc4d4; line-height: 1.9; }
    footer { margin-top: 22px; color: #847d8e; font: 12px ui-monospace, monospace; }
  </style></head><body><main>
    <div class="eyebrow">MYRELITH · ISSUE 109 · PRODUCT STABILIZATION</div>
    <h1>Bounded similarity stabilization</h1>
    <p class="lead">A source-bound encoded handheld fixture was decoded in Chromium, analyzed through the production job/cache foundation, compiled into ordinary tracks, and resolved through the shared animation evaluator.</p>
    <div class="status">✓ local analysis · exact crop · atomic authoring · cache round-trip</div>
    <div class="grid">
      ${metric('Analyzed samples', result.analysis.samples, `${result.source.width}×${result.source.height} source`)}
      ${metric('Safe zoom', `${result.plan.safeZoom.toFixed(4)}×`, `${(result.plan.requiredCropRatio * 100).toFixed(2)}% required crop`)}
      ${metric('Keys / track', result.analysis.retainedKeysPerTrack, 'hard ceiling: 1,024')}
      ${metric('Cache round-trip', result.analysis.cachedFromSecondRun ? 'exact hit' : 'failed', 'same source + mapping + projection')}
    </div>
    <section><h2>Product invariants</h2><ul>
      <li>Authored properties: ${result.authoredProperties.join(', ')}</li>
      <li>History entries: ${result.historyEntries}</li>
      <li>Modeled jitter reduction: ${(result.plan.jitterReductionRatio * 100).toFixed(1)}%</li>
      <li>Peak active jobs / decoders: ${result.scheduler.maxActiveJobCount} / ${result.scheduler.maxActiveDecoderCount}</li>
      <li>Worker lifecycle: ${result.workerDiagnostics.workersCreated} created / ${result.workerDiagnostics.workersTerminated} terminated / ${result.workerDiagnostics.activeWorkers} active</li>
      <li>Exact attachment cache removed: ${result.cacheRemoved}</li>
      <li>Console and page problems: ${artifact.consoleProblems.length}</li>
    </ul></section>
    <footer>${artifact.source.branch} · ${artifact.source.commit.slice(0, 12)} · ${artifact.source.fingerprint}</footer>
  </main></body></html>`
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
    server = await createServer({ root, server: { host: '127.0.0.1', port: selected.port, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ channel: selected.channel, headless: !selected.headed })
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') problems.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    await page.goto(`http://127.0.0.1:${selected.port}/scripts/issue109/stabilization-gate.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const text = document.querySelector('[role="status"]')?.textContent ?? ''
      return text === 'Passed' || text.startsWith('Failed:')
    }, undefined, { timeout: 120_000 })
    const statusText = await page.locator('[role="status"]').textContent()
    if (statusText !== 'Passed') {
      const gateError = await page.evaluate(() => globalThis.__issue109StabilizationError)
      throw new Error(gateError || statusText || 'Issue #109 gate failed')
    }
    const result = await page.evaluate(() => globalThis.__issue109StabilizationResult)
    if (!result) throw new Error('Issue #109 gate did not publish evidence')
    const artifact = {
      schemaVersion: SCHEMA_VERSION,
      scenario: 'issue-109-video-stabilization-v1',
      generatedAt: new Date().toISOString(),
      source: initialSource,
      host: hostIdentity(browser.version(), selected),
      result,
      consoleProblems: [],
    }
    await page.setContent(reportHtml(artifact), { waitUntil: 'load' })
    await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
    const screenshot = await page.screenshot({ fullPage: true })
    artifact.consoleProblems = [...new Set(problems)]
    if (artifact.consoleProblems.length > 0) throw new Error(`Browser captured problems: ${artifact.consoleProblems.join(' | ')}`)
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(initialSource)) {
      throw new Error('Source changed while Issue #109 evidence was running')
    }
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'video-stabilization.json'), `${JSON.stringify(artifact, null, 2)}\n`)
    writeFileSync(join(output, 'video-stabilization.png'), screenshot)
    process.stdout.write(`Video stabilization evidence: ${join(output, 'video-stabilization.json')}\n`)
    process.stdout.write(`Browser screenshot: ${join(output, 'video-stabilization.png')}\n`)
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
