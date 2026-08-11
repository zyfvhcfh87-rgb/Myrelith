import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_844
const DEFAULT_OUTPUT = 'output/playwright/issue-44-motion-analysis'

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
    command: `npm run qa:issue44:research -- --port ${options.port}`,
  }
}

function reportHtml(artifact) {
  const stabilization = artifact.success.evidence.stabilization
  const tracking = artifact.success.evidence.tracking
  const full = stabilization.tradeoffs.find((item) => item.strength === 1)
  const half = stabilization.tradeoffs.find((item) => item.strength === 0.5)
  const percent = (value) => `${(value * 100).toFixed(1)}%`
  const metric = (label, value, note) => `
    <article class="metric">
      <span>${label}</span><strong>${value}</strong><small>${note}</small>
    </article>`
  return `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #f8f7ff; background:
      radial-gradient(circle at 15% 10%, #503a8066, transparent 35%),
      linear-gradient(145deg, #12101b, #21182d 60%, #11141e); }
    main { width: min(1180px, calc(100% - 64px)); margin: 0 auto; padding: 54px 0; }
    .eyebrow { color: #d6b4ff; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0 10px; font-size: 42px; letter-spacing: -.04em; }
    .lead { color: #bbb5c9; max-width: 760px; line-height: 1.55; }
    .status { display: inline-flex; gap: 8px; margin-top: 18px; padding: 8px 12px;
      border: 1px solid #73e3ad55; border-radius: 999px; background: #173827aa; color: #8dffc5; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 34px 0; }
    .metric { min-height: 140px; padding: 18px; border: 1px solid #ffffff14;
      border-radius: 16px; background: #ffffff0a; box-shadow: 0 16px 40px #0003; }
    .metric span, .metric small { display: block; color: #a9a2b6; }
    .metric strong { display: block; margin: 14px 0 10px; font-size: 28px; }
    .panels { display: grid; grid-template-columns: 1.2fr 1fr; gap: 18px; }
    section { padding: 22px; border-radius: 18px; background: #17131fdd; border: 1px solid #ffffff12; }
    h2 { margin: 0 0 18px; font-size: 18px; }
    .tradeoff { display: grid; grid-template-columns: 90px 1fr 90px; align-items: center;
      gap: 14px; margin: 14px 0; color: #cfc8da; }
    .bar { height: 12px; overflow: hidden; border-radius: 99px; background: #31283d; }
    .bar i { display: block; height: 100%; background: linear-gradient(90deg, #9a6cff, #55d9b0); }
    ul { margin: 0; padding-left: 20px; line-height: 1.85; color: #c8c1d2; }
    footer { margin-top: 24px; color: #817a8d; font: 12px ui-monospace, monospace; }
  </style></head><body><main>
    <div class="eyebrow">MYRELITH · ISSUE 44 · BROWSER-LOCAL RESEARCH</div>
    <h1>Motion analysis feasibility</h1>
    <p class="lead">Deterministic similarity stabilization and point/box tracking ran in a dedicated,
      cancellable worker. Results are disposable analysis facts; no document state was touched.</p>
    <div class="status">✓ support probe · quality gates · cancellation cleanup</div>
    <div class="grid">
      ${metric('Pair transform error', `${stabilization.meanPairTransformErrorPixels.toFixed(3)} px`, 'synthetic ground truth mean')}
      ${metric('Full-strength jitter cut', percent(full.jitterReductionRatio), `${full.conservativeSafeZoom.toFixed(3)}× conservative crop zoom`)}
      ${metric('Point tracking error', `${tracking.pointMeanErrorPixels.toFixed(3)} px`, `${tracking.pointMaximumErrorPixels.toFixed(3)} px maximum`)}
      ${metric('Box center error', `${tracking.boxCenterMeanErrorPixels.toFixed(3)} px`, `${percent(tracking.boxScaleMeanRelativeError)} mean scale error`)}
    </div>
    <div class="panels">
      <section><h2>Strength ↔ crop trade-off</h2>
        <div class="tradeoff"><b>50%</b><div class="bar"><i style="width:${Math.max(2, half.jitterReductionRatio * 100)}%"></i></div><span>${percent(half.jitterReductionRatio)}</span></div>
        <div class="tradeoff"><b>100%</b><div class="bar"><i style="width:${Math.max(2, full.jitterReductionRatio * 100)}%"></i></div><span>${percent(full.jitterReductionRatio)}</span></div>
        <p class="lead">The crop estimate is conservative and must remain visible to the user; automatic stabilization never silently enlarges the frame.</p>
      </section>
      <section><h2>Failure and ownership checks</h2><ul>
        <li>Scene cut rejected: ${stabilization.sceneCutRejected}</li>
        <li>Tracking occlusion rejected: ${tracking.occlusionRejected}</li>
        <li>Cancellation: ${artifact.cancellation.errorName}</li>
        <li>Workers active after drain: ${artifact.finalDiagnostics.activeWorkers}</li>
        <li>OPFS probe files: ${artifact.finalDiagnostics.opfsProbeFilesCreated}/${artifact.finalDiagnostics.opfsProbeFilesRemoved} removed</li>
        <li>VideoFrames: ${artifact.finalDiagnostics.supportFramesCreated}/${artifact.finalDiagnostics.supportFramesClosed} closed</li>
      </ul></section>
    </div>
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
    browser = await chromium.launch({
      channel: options.channel,
      headless: !options.headed,
    })
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    attachProblemCollector(page, consoleProblems)
    await page.goto(`http://127.0.0.1:${options.port}/`, { waitUntil: 'domcontentloaded' })

    const support = await page.evaluate(async () => {
      const module = await import('/src/app/motionAnalysisResearchController.ts')
      return module.probeMotionAnalysisSupport()
    })
    if (!support.supported) {
      throw new Error(`Support probe failed: ${support.failures.join(' ')}`)
    }

    const cancellation = await page.evaluate(async () => {
      const module = await import('/src/app/motionAnalysisResearchController.ts')
      const before = module.motionAnalysisResearchDiagnostics()
      const controller = new AbortController()
      const startedAt = performance.now()
      let errorName = null
      try {
        await module.runBrowserMotionAnalysisResearch({
          skipSupportProbe: true,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        })
      } catch (error) {
        errorName = error instanceof DOMException ? error.name : String(error)
      }
      return {
        errorName,
        durationMs: performance.now() - startedAt,
        before,
        after: module.motionAnalysisResearchDiagnostics(),
      }
    })
    if (
      cancellation.errorName !== 'AbortError'
      || cancellation.after.activeWorkers !== 0
      || cancellation.after.workersCreated - cancellation.before.workersCreated !== 1
      || cancellation.after.workersTerminated - cancellation.before.workersTerminated !== 1
    ) throw new Error('Active cancellation did not terminate and drain exactly one worker')

    const success = await page.evaluate(async () => {
      const module = await import('/src/app/motionAnalysisResearchController.ts')
      return module.runBrowserMotionAnalysisResearch({ skipSupportProbe: true })
    })
    const finalDiagnostics = await page.evaluate(async () => {
      const module = await import('/src/app/motionAnalysisResearchController.ts')
      return module.motionAnalysisResearchDiagnostics()
    })
    if (
      finalDiagnostics.activeWorkers !== 0
      || finalDiagnostics.workersCreated !== finalDiagnostics.workersTerminated
      || finalDiagnostics.supportFramesCreated !== finalDiagnostics.supportFramesClosed
      || finalDiagnostics.opfsProbeFilesCreated !== finalDiagnostics.opfsProbeFilesRemoved
    ) throw new Error('Motion research resources did not drain exactly')
    if (
      success.evidence.decision.stabilization !== 'go'
      || success.evidence.decision.pointTracking !== 'go'
      || success.evidence.decision.boxTracking !== 'go'
    ) throw new Error('One or more motion-analysis quality decisions failed')

    const artifact = {
      schemaVersion: 1,
      scenario: 'issue-44-motion-analysis-v1',
      generatedAt: new Date().toISOString(),
      source: initialSource,
      host: hostIdentity(browser.version(), options),
      support,
      cancellation,
      success,
      finalDiagnostics,
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
      throw new Error('Source changed while Issue #44 evidence was running')
    }
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'motion-analysis.json'), `${JSON.stringify(artifact, null, 2)}\n`)
    writeFileSync(join(output, 'motion-analysis.png'), screenshot)
    process.stdout.write(`Motion-analysis evidence: ${join(output, 'motion-analysis.json')}\n`)
    process.stdout.write(`Browser screenshot: ${join(output, 'motion-analysis.png')}\n`)
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
