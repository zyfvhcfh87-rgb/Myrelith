import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_885
const DEFAULT_OUTPUT = 'output/playwright/issue-110-motion-tracking'
const SCHEMA_VERSION = 1

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

function options(argv) {
  const result = {
    headed: false,
    port: DEFAULT_PORT,
    output: DEFAULT_OUTPUT,
    channel: 'chromium',
  }
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
    command: `npm run qa:issue110:tracking -- --port ${selected.port}`,
  }
}

function reportHtml(artifact) {
  const result = artifact.result
  const metric = (label, value, note) => `
    <article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #f9fbff; background:
      radial-gradient(circle at 16% 8%, #0f9f8d55, transparent 34%),
      linear-gradient(145deg, #0c1219, #102a2a 58%, #151020); }
    main { width: min(1120px, calc(100% - 64px)); margin: auto; padding: 52px 0; }
    .eyebrow { color: #75f5d4; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0; font-size: 42px; letter-spacing: -.04em; }
    .lead { max-width: 820px; color: #b7c8cd; line-height: 1.55; }
    .status { display: inline-flex; margin: 16px 0 30px; padding: 8px 12px;
      border: 1px solid #64efac55; border-radius: 999px; color: #91ffcb; background: #15382aaa; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    article, section { padding: 19px; border: 1px solid #ffffff14; border-radius: 17px; background: #ffffff09; }
    article span, article small { display: block; color: #a9b8be; }
    article strong { display: block; margin: 14px 0 8px; font-size: 27px; }
    section { margin-top: 18px; background: #101a20dd; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    ul { margin: 0; padding-left: 20px; color: #c6d2d6; line-height: 1.9; }
    footer { margin-top: 22px; color: #7f9299; font: 12px ui-monospace, monospace; }
  </style></head><body><main>
    <div class="eyebrow">MYRELITH · ISSUE 110 · PRODUCT MOTION TRACKING</div>
    <h1>Bounded point and box tracking</h1>
    <p class="lead">A source-bound encoded fixture was decoded in Chromium, tracked through the production cache/job path, stopped on an exact occlusion, and applied as ordinary animation in one undo entry.</p>
    <div class="status">✓ local analysis · explicit loss · atomic authoring · exact cache hit</div>
    <div class="grid">
      ${metric('Point error', `${result.point.meanPixels.toFixed(3)} px`, `max ${result.point.maximumPixels.toFixed(3)} px`)}
      ${metric('Box center error', `${result.box.meanCenterPixels.toFixed(3)} px`, 'mean accepted-sample error')}
      ${metric('Box scale error', `${(result.box.meanScaleRelativeError * 100).toFixed(2)}%`, `max ${(result.box.maximumScaleRelativeError * 100).toFixed(2)}%`)}
      ${metric('Occlusion stop', `frame ${result.point.failure.localFrame}`, `${result.point.acceptedSamples} accepted samples`)}
    </div>
    <section><h2>Product invariants</h2><ul>
      <li>Point and box stop at frame ${result.source.occlusionFrame}; no extrapolated samples.</li>
      <li>Backward point run: ${result.backwardPoint.acceptedSamples} samples, ${result.backwardPoint.meanPixels.toFixed(3)} px mean error.</li>
      <li>Authored properties: ${result.authoredProperties.join(', ')}</li>
      <li>History entries: ${result.historyEntries}</li>
      <li>Point cache round-trip: ${result.point.cachedFromSecondRun ? 'exact hit' : 'failed'}</li>
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
    server = await createServer({
      root,
      server: { host: '127.0.0.1', port: selected.port, strictPort: true },
    })
    await server.listen()
    browser = await chromium.launch({
      channel: selected.channel,
      headless: !selected.headed,
    })
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        problems.push(`${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    await page.goto(
      `http://127.0.0.1:${selected.port}/scripts/issue110/motion-tracking-gate.html`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => {
      const text = document.querySelector('[role="status"]')?.textContent ?? ''
      return text === 'Passed' || text.startsWith('Failed:')
    }, undefined, { timeout: 120_000 })
    const statusText = await page.locator('[role="status"]').textContent()
    if (statusText !== 'Passed') {
      const gateError = await page.evaluate(() => globalThis.__issue110MotionTrackingError)
      throw new Error(gateError || statusText || 'Issue #110 gate failed')
    }
    const result = await page.evaluate(() => globalThis.__issue110MotionTrackingResult)
    if (!result) throw new Error('Issue #110 gate did not publish evidence')
    const artifact = {
      schemaVersion: SCHEMA_VERSION,
      scenario: 'issue-110-motion-tracking-v1',
      generatedAt: new Date().toISOString(),
      source: initialSource,
      host: hostIdentity(browser.version(), selected),
      result,
      consoleProblems: [],
    }
    await page.setContent(reportHtml(artifact), { waitUntil: 'load' })
    await page.evaluate(() => new Promise((resolvePaint) => (
      requestAnimationFrame(() => requestAnimationFrame(resolvePaint))
    )))
    const screenshot = await page.screenshot({ fullPage: true })
    artifact.consoleProblems = [...new Set(problems)]
    if (artifact.consoleProblems.length > 0) {
      throw new Error(`Browser captured problems: ${artifact.consoleProblems.join(' | ')}`)
    }
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(initialSource)) {
      throw new Error('Source changed while Issue #110 evidence was running')
    }
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'motion-tracking.json'), `${JSON.stringify(artifact, null, 2)}\n`)
    writeFileSync(join(output, 'motion-tracking.png'), screenshot)
    process.stdout.write(`Motion-tracking evidence: ${join(output, 'motion-tracking.json')}\n`)
    process.stdout.write(`Browser screenshot: ${join(output, 'motion-tracking.png')}\n`)
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
