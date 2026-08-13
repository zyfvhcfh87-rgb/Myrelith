import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_893
const DEFAULT_OUTPUT = 'output/playwright/issue-111-lens-remap'
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

function hostIdentity(browserVersion, selected, gpu) {
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
    gpu,
    command: `npm run qa:issue111:lens-remap -- --port ${selected.port}`,
  }
}

function reportHtml(artifact) {
  const run = artifact.result.run
  const timing = (width) => run.timings.find((entry) => entry.width === width)
  const hd = timing(1_280)
  const fullHd = timing(1_920)
  const ultraHd = timing(3_840)
  const maximumPixelDelta = Math.max(...run.parity.map((entry) => entry.cpuVsExport.maximumChannelDelta))
  const maximumGeometryDelta = Math.max(...run.parity.map((entry) => entry.maximumGeometryDeltaPixels))
  const metric = (label, value, note) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #f8fbff; background: radial-gradient(circle at 12% 5%, #a24cff55, transparent 34%), linear-gradient(145deg, #0c101a, #15102a 55%, #0c2527); }
    main { width: min(1160px, calc(100% - 64px)); margin: auto; padding: 48px 0; }
    .eyebrow { color: #d4a5ff; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0; font-size: 43px; letter-spacing: -.04em; }
    .lead { max-width: 880px; color: #bac4d1; line-height: 1.55; }
    .status { display: inline-flex; margin: 15px 0 28px; padding: 8px 12px; border: 1px solid #72f0bd55; border-radius: 999px; color: #93ffd0; background: #15382aaa; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    article, section { padding: 19px; border: 1px solid #ffffff14; border-radius: 17px; background: #ffffff09; }
    article span, article small { display: block; color: #aeb9c7; }
    article strong { display: block; margin: 14px 0 8px; font-size: 25px; }
    section { margin-top: 18px; background: #111724dd; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    ul { margin: 0; padding-left: 20px; color: #cad2dc; line-height: 1.85; }
    footer { margin-top: 22px; color: #82909f; font: 12px ui-monospace, monospace; }
  </style></head><body><main>
    <div class="eyebrow">MYRELITH · ISSUE 111 · MANUAL LENS REMAP</div>
    <h1>Parity-safe source geometry</h1>
    <p class="lead">A disposable browser worker compared the bounded CPU oracle with one RGBA8 WebGL2 shader for preview and export, then proved finite memory, cancellation, context-loss failure, and a fresh-owner retry.</p>
    <div class="status">✓ ${run.decision} · explicit unsupported fallback · no production wiring</div>
    <div class="grid">
      ${metric('Pixel parity', `${maximumPixelDelta} byte`, `${run.parity.length} checked fixtures`)}
      ${metric('Geometry parity', `${maximumGeometryDelta.toFixed(4)} px`, '33×33 transform-feedback grid')}
      ${metric('1080p preview p95', `${fullHd.webglPreviewP95Ms.toFixed(2)} ms`, `${(1000 / fullHd.webglPreviewP95Ms).toFixed(1)} fps equivalent`)}
      ${metric('4K export p95', `${ultraHd.webglExportP95Ms.toFixed(2)} ms`, `${(ultraHd.exportPeakBytes / 1024 ** 2).toFixed(1)} MiB candidate peak`)}
    </div>
    <section><h2>Measured envelope</h2><ul>
      <li>720p preview/export p95: ${hd.webglPreviewP95Ms.toFixed(2)} / ${hd.webglExportP95Ms.toFixed(2)} ms; CPU oracle ${hd.cpuOracleMs.toFixed(2)} ms.</li>
      <li>1080p preview/export p95: ${fullHd.webglPreviewP95Ms.toFixed(2)} / ${fullHd.webglExportP95Ms.toFixed(2)} ms; CPU oracle ${fullHd.cpuOracleMs.toFixed(2)} ms.</li>
      <li>4K preview/export p95: ${ultraHd.webglPreviewP95Ms.toFixed(2)} / ${ultraHd.webglExportP95Ms.toFixed(2)} ms; CPU oracle ${ultraHd.cpuOracleMs.toFixed(2)} ms.</li>
      <li>MAX_TEXTURE_SIZE: ${run.support.maximumTextureSize}; all selectable project sizes and combined compositor budgets passed.</li>
      <li>Context loss failed the current owner: ${run.contextLoss.currentOwnerFailed}; fresh owner succeeded: ${run.contextLoss.freshOwnerSucceeded}.</li>
      <li>Workers: ${artifact.result.workerLifecycle.workersCreated} created / ${artifact.result.workerLifecycle.workersTerminated} terminated / ${artifact.result.workerLifecycle.activeWorkers} active; cancellation: ${artifact.result.cancellation.name}.</li>
      <li>Console and page problems: ${artifact.consoleProblems.length}</li>
    </ul></section>
    <footer>${run.fixtureVersion} · ${run.backendVersion}<br>${artifact.source.branch} · ${artifact.source.commit.slice(0, 12)} · ${artifact.source.fingerprint}</footer>
  </main></body></html>`
}

function validateGateResult(result) {
  const run = result?.run
  if (!run || run.decision !== 'go' || run.reasons?.length !== 0) {
    throw new Error('Issue #111 gate did not publish an unqualified go decision')
  }
  if (
    run.fixtureVersion !== 'issue-111-lens-fixtures-v1'
    || run.backendVersion !== 'webgl2-rgba8-manual-bilinear-v1'
    || run.fallbackPolicy !== 'explicit-unavailable-no-cpu-substitution'
  ) throw new Error('Issue #111 evidence provenance is stale or miswired')
  const expectedFixtures = [
    'neutral',
    'barrel',
    'pincushion',
    'tangential',
    'off-center',
    'strong-valid',
    'transparent-edge',
  ]
  if (run.parity.map((entry) => entry.fixtureId).join(',') !== expectedFixtures.join(',')) {
    throw new Error('Issue #111 parity fixture order or coverage drifted')
  }
  if (run.parity.some((entry) => (
    entry.cpuVsExport.maximumChannelDelta > 1
    || entry.previewVsExport.maximumChannelDelta > 1
    || entry.maximumGeometryDeltaPixels > 0.25
  ))) throw new Error('Issue #111 parity tolerance was exceeded')
  const transparent = run.parity.at(-1)
  if (transparent.cornerAlpha.some((alpha) => alpha !== 0)) {
    throw new Error('Issue #111 undefined-edge alpha was not transparent')
  }
  if (run.timings.map((entry) => `${entry.width}x${entry.height}`).join(',') !== '1280x720,1920x1080,3840x2160') {
    throw new Error('Issue #111 performance size coverage drifted')
  }
  for (const timing of run.timings) {
    const values = [timing.cpuOracleMs, timing.webglPreviewP95Ms, timing.webglExportP95Ms]
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('Issue #111 timing evidence is not finite')
    }
    if (!timing.surfaceBudget.allowed || timing.retainedBytes <= 0 || timing.exportPeakBytes <= timing.retainedBytes) {
      throw new Error('Issue #111 memory evidence is incomplete')
    }
  }
  if (
    run.timings[1].webglPreviewP95Ms > 1_000 / 30
    || !run.invalidFoldingRejected
    || !run.contextLoss.currentOwnerFailed
    || !run.contextLoss.freshOwnerSucceeded
    || run.resources.backendsCreated !== 2
    || run.resources.backendsDisposed !== 2
    || run.resources.retainedBytesAfterDispose !== 0
    || result.cancellation?.name !== 'AbortError'
    || result.workerLifecycle?.workersCreated !== 3
    || result.workerLifecycle?.workersTerminated !== 3
    || result.workerLifecycle?.activeWorkers !== 0
  ) throw new Error('Issue #111 lifecycle, safety, or 1080p preview gate failed')
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
    const browserSession = await browser.newBrowserCDPSession()
    const systemInfo = await browserSession.send('SystemInfo.getInfo')
    await browserSession.detach()
    const gpu = {
      devices: systemInfo.gpu?.devices ?? [],
      featureStatus: systemInfo.gpu?.featureStatus ?? {},
      driverBugWorkarounds: systemInfo.gpu?.driverBugWorkarounds ?? [],
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') problems.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    await page.goto(`http://127.0.0.1:${selected.port}/scripts/issue111/lens-remap-gate.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const text = document.querySelector('[role="status"]')?.textContent ?? ''
      return text === 'Passed' || text.startsWith('Failed:')
    }, undefined, { timeout: 200_000 })
    const statusText = await page.locator('[role="status"]').textContent()
    if (statusText !== 'Passed') {
      const gateError = await page.evaluate(() => globalThis.__issue111LensRemapError)
      throw new Error(gateError || statusText || 'Issue #111 gate failed')
    }
    const result = await page.evaluate(() => globalThis.__issue111LensRemapResult)
    validateGateResult(result)
    const artifact = {
      schemaVersion: SCHEMA_VERSION,
      scenario: 'issue-111-manual-lens-remap-v1',
      generatedAt: new Date().toISOString(),
      source: initialSource,
      host: hostIdentity(browser.version(), selected, gpu),
      result,
      consoleProblems: [],
    }
    await page.setContent(reportHtml(artifact), { waitUntil: 'load' })
    await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
    const screenshot = await page.screenshot({ fullPage: true })
    artifact.consoleProblems = [...new Set(problems)]
    if (artifact.consoleProblems.length > 0) throw new Error(`Browser captured problems: ${artifact.consoleProblems.join(' | ')}`)
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(initialSource)) throw new Error('Source changed while Issue #111 evidence was running')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'lens-remap.json'), `${JSON.stringify(artifact, null, 2)}\n`)
    writeFileSync(join(output, 'lens-remap.png'), screenshot)
    process.stdout.write(`Lens-remap evidence: ${join(output, 'lens-remap.json')}\n`)
    process.stdout.write(`Browser screenshot: ${join(output, 'lens-remap.png')}\n`)
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
