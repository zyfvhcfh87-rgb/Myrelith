import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_857
const DEFAULT_OUTPUT = 'output/playwright/issue-108-motion-analysis-foundation'
const ARTIFACT_SCHEMA_VERSION = 1
const ARTIFACT_SCENARIO = 'issue-108-motion-analysis-foundation-v1'

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

function parseArguments(argv) {
  const options = {
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
    if (argument === '--headed') options.headed = true
    else if (argument === '--port') options.port = positiveInteger(next(), argument)
    else if (argument === '--output') options.output = next()
    else if (argument === '--channel') options.channel = next()
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
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

function attachProblemCollector(page, problems) {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
}

function hostIdentity(browserVersion, options) {
  const processors = cpus()
  return {
    browserChannel: options.channel,
    browserVersion,
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    cpuModel: processors[0]?.model ?? '<unknown>',
    logicalProcessors: processors.length || null,
    totalMemoryGiB: Math.round(totalmem() / 1024 ** 3 * 100) / 100,
    command: `npm run qa:issue108:foundation -- --port ${options.port}`,
  }
}

function reportHtml(artifact) {
  const result = artifact.result
  const completion = result.first.completion
  const metric = (label, value, note) => `
    <article class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`
  return `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #f8f7ff; background:
      radial-gradient(circle at 15% 10%, #503a8066, transparent 35%),
      linear-gradient(145deg, #12101b, #21182d 60%, #11141e); }
    main { width: min(1120px, calc(100% - 64px)); margin: 0 auto; padding: 54px 0; }
    .eyebrow { color: #d6b4ff; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0 10px; font-size: 42px; letter-spacing: -.04em; }
    .lead { color: #bbb5c9; max-width: 800px; line-height: 1.55; }
    .status { display: inline-flex; margin-top: 18px; padding: 8px 12px; border: 1px solid #73e3ad55;
      border-radius: 999px; background: #173827aa; color: #8dffc5; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 34px 0; }
    .metric { min-height: 140px; padding: 18px; border: 1px solid #ffffff14;
      border-radius: 16px; background: #ffffff0a; box-shadow: 0 16px 40px #0003; }
    .metric span, .metric small { display: block; color: #a9a2b6; }
    .metric strong { display: block; margin: 14px 0 10px; font-size: 28px; }
    section { padding: 22px; border-radius: 18px; background: #17131fdd; border: 1px solid #ffffff12; }
    h2 { margin: 0 0 18px; font-size: 18px; }
    ul { margin: 0; padding-left: 20px; line-height: 1.9; color: #c8c1d2; }
    footer { margin-top: 24px; color: #817a8d; font: 12px ui-monospace, monospace; }
  </style></head><body><main>
    <div class="eyebrow">MYRELITH · ISSUE 108 · ORIGIN-LOCAL FOUNDATION</div>
    <h1>Motion-analysis job and cache foundation</h1>
    <p class="lead">A real encoded source was decoded and downsampled in a dedicated worker, streamed through
      the bounded job controller, committed to the strict OPFS cache, then read back byte-for-byte.</p>
    <div class="status">✓ support · decode ownership · resource bounds · cache round-trip</div>
    <div class="grid">
      ${metric('Decoded samples', String(completion.sampledFrameCount), `${result.source.width}×${result.source.height} H.264 source`)}
      ${metric('Peak retained frames', String(completion.maxRetainedFrames), 'hard ceiling: 300')}
      ${metric('Peak retained bytes', `${(completion.maxRetainedBytes / 1024 / 1024).toFixed(2)} MiB`, 'hard ceiling: 32 MiB')}
      ${metric('Cache round-trip', result.second.fromCache ? 'exact hit' : 'failed', `${result.second.resultBytes} result bytes`)}
    </div>
    <section><h2>Ownership and lifecycle checks</h2><ul>
      <li>First run was a cache miss: ${!result.first.fromCache}</li>
      <li>Second run was a cache hit: ${result.second.fromCache}</li>
      <li>Peak active jobs / decoders: ${result.scheduler.maxActiveJobCount} / ${result.scheduler.maxActiveDecoderCount}</li>
      <li>Worker lifecycle: ${result.workerDiagnostics.workersCreated} created / ${result.workerDiagnostics.workersTerminated} terminated / ${result.workerDiagnostics.activeWorkers} active</li>
      <li>Windows consumed: ${result.windows.length}</li>
      <li>Exact attachment cache removed after evidence: ${result.cacheRemoved}</li>
      <li>Console and page problems: ${artifact.consoleProblems.length}</li>
    </ul></section>
    <footer>${artifact.source.branch} · ${artifact.source.commit.slice(0, 12)} · ${artifact.source.fingerprint}</footer>
  </main></body></html>`
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const root = cwd()
  const output = isAbsolute(options.output) ? options.output : resolve(root, options.output)
  const initialSource = await sourceIdentity(root)
  const consoleProblems = []
  let server
  let browser
  let context
  try {
    server = await createServer({
      root,
      server: { host: '127.0.0.1', port: options.port, strictPort: true },
    })
    await server.listen()
    browser = await chromium.launch({ channel: options.channel, headless: !options.headed })
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    attachProblemCollector(page, consoleProblems)
    await page.goto(
      `http://127.0.0.1:${options.port}/scripts/issue108/foundation-gate.html`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.getByRole('status').getByText('Passed', { exact: true }).waitFor({
      state: 'visible',
      timeout: 120_000,
    })
    const result = await page.evaluate(() => globalThis.__issue108FoundationResult)
    if (!result) throw new Error('Issue #108 gate did not publish its evidence')
    const artifact = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      scenario: ARTIFACT_SCENARIO,
      generatedAt: new Date().toISOString(),
      source: initialSource,
      host: hostIdentity(browser.version(), options),
      result,
      consoleProblems: [],
    }
    await page.setContent(reportHtml(artifact), { waitUntil: 'load' })
    await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(
      () => requestAnimationFrame(resolvePaint),
    )))
    const screenshot = await page.screenshot({ fullPage: true })
    artifact.consoleProblems = [...new Set(consoleProblems)]
    if (artifact.consoleProblems.length > 0) {
      throw new Error(`Browser captured problems: ${artifact.consoleProblems.join(' | ')}`)
    }
    const finalSource = await sourceIdentity(root)
    if (JSON.stringify(finalSource) !== JSON.stringify(initialSource)) {
      throw new Error('Source changed while Issue #108 evidence was running')
    }
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'motion-analysis-foundation.json'), `${JSON.stringify(artifact, null, 2)}\n`)
    writeFileSync(join(output, 'motion-analysis-foundation.png'), screenshot)
    process.stdout.write(`Motion-analysis foundation evidence: ${join(output, 'motion-analysis-foundation.json')}\n`)
    process.stdout.write(`Browser screenshot: ${join(output, 'motion-analysis-foundation.png')}\n`)
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
