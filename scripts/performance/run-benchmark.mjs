import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import {
  arch,
  cpus,
  platform,
  release,
  totalmem,
} from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { cwd, env, version as nodeVersion } from 'node:process'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'

const DEFAULT_PORT = 41_854
const DEFAULT_VIEWPORT = { width: 1_440, height: 900 }
const BENCHMARK_PATH = '/__webcut/performance'
export const MAX_CONTINUOUS_PLAYBACK_DURATION_MS = 2_000
export const MAX_CONTINUOUS_EXPORT_FRAMES = 31

function usage() {
  return `WebCut performance benchmark

Usage:
  node scripts/performance/run-benchmark.mjs [--headed] [--samples 7]
  node scripts/performance/run-benchmark.mjs --smoke

Options:
  --smoke                 Short harness rehearsal; skips export.
  --headed                Show Chromium while the run executes.
  --skip-export           Record export as unavailable by explicit choice.
  --samples N             Scrub/import sample count (default 7).
  --playback-runs N       Timed playback trials (default 3).
  --playback-ms N         Duration of each playback trial (max/default 2000).
  --memory-batches N      Post-warmup heap samples (default 7).
  --scrubs-per-batch N    Scrubs between heap samples (default 8).
  --export-frames N       Frames in each 4K export sample (max 31; default 30).
  --cold-samples N        Launcher/editor cold samples (default min(3, samples)).
  --channel NAME          Playwright Chromium channel (default chromium).
  --port N                Isolated local Vite port (default 41854).
  --output PATH           Artifact directory (default .tmp/benchmarks/<time>).
  --help                  Show this help.
`
}

function integer(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

export function parseArguments(argv) {
  const options = {
    smoke: false,
    headed: false,
    skipExport: false,
    sampleCount: 7,
    playbackRuns: 3,
    playbackDurationMs: 2_000,
    memoryBatches: 7,
    scrubsPerMemoryBatch: 8,
    exportFrames: 30,
    coldSamples: null,
    channel: 'chromium',
    port: DEFAULT_PORT,
    output: null,
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${argument} requires a value`)
      return value
    }
    if (argument === '--help') return { help: true, options }
    if (argument === '--smoke') options.smoke = true
    else if (argument === '--headed') options.headed = true
    else if (argument === '--skip-export') options.skipExport = true
    else if (argument === '--samples') options.sampleCount = integer(next(), argument)
    else if (argument === '--playback-runs') options.playbackRuns = integer(next(), argument)
    else if (argument === '--playback-ms') options.playbackDurationMs = integer(next(), argument)
    else if (argument === '--memory-batches') options.memoryBatches = integer(next(), argument)
    else if (argument === '--scrubs-per-batch') options.scrubsPerMemoryBatch = integer(next(), argument)
    else if (argument === '--export-frames') options.exportFrames = integer(next(), argument)
    else if (argument === '--cold-samples') options.coldSamples = integer(next(), argument)
    else if (argument === '--channel') options.channel = next()
    else if (argument === '--port') options.port = integer(next(), argument)
    else if (argument === '--output') options.output = next()
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (options.smoke) {
    options.sampleCount = 2
    options.playbackRuns = 1
    options.playbackDurationMs = 350
    options.memoryBatches = 2
    options.scrubsPerMemoryBatch = 2
    options.exportFrames = 3
    options.skipExport = true
    options.coldSamples = 1
  }
  if (options.playbackDurationMs > MAX_CONTINUOUS_PLAYBACK_DURATION_MS) {
    throw new Error(
      `--playback-ms exceeds the ${MAX_CONTINUOUS_PLAYBACK_DURATION_MS} ms continuous encoded source window`,
    )
  }
  if (options.exportFrames > MAX_CONTINUOUS_EXPORT_FRAMES) {
    throw new Error(
      `--export-frames exceeds the ${MAX_CONTINUOUS_EXPORT_FRAMES}-frame continuous encoded source window`,
    )
  }
  options.coldSamples ??= Math.min(3, options.sampleCount)
  return { help: false, options }
}

function gitText(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function gitBuffer(root, args) {
  return execFileSync('git', args, { cwd: root })
}

function hashGitOutput(root, args, hash) {
  return new Promise((resolveHash, rejectHash) => {
    const child = spawn('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    const maximumStderrCharacters = 64 * 1024
    child.stdout.on('data', (chunk) => hash.update(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= maximumStderrCharacters) return
      stderr += chunk.slice(0, maximumStderrCharacters - stderr.length)
    })
    child.once('error', rejectHash)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveHash()
        return
      }
      rejectHash(new Error(
        `git ${args.join(' ')} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`
          + (stderr ? `: ${stderr.trim()}` : ''),
      ))
    })
  })
}

export async function dirtyFingerprint(root, commit) {
  const status = gitBuffer(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const hash = createHash('sha256')
  hash.update(commit)
  hash.update('\0')
  hash.update(status)
  hash.update('\0')
  await hashGitOutput(root, ['diff', '--binary', 'HEAD'], hash)
  for (const record of status.toString('utf8').split('\0')) {
    if (!record.startsWith('?? ')) continue
    const relativePath = record.slice(3)
    const absolutePath = resolve(root, relativePath)
    hash.update('\0untracked\0')
    hash.update(relativePath)
    if (existsSync(absolutePath)) hash.update(readFileSync(absolutePath))
  }
  return {
    dirty: status.length > 0,
    fingerprint: `sha256:${hash.digest('hex')}`,
  }
}

async function sourceIdentity(root) {
  const commit = gitText(root, ['rev-parse', 'HEAD'])
  return {
    commit,
    branch: gitText(root, ['branch', '--show-current']) || '<detached>',
    ...await dirtyFingerprint(root, commit),
  }
}

export function assertSourceIdentityUnchanged(initial, current) {
  if (
    initial.commit !== current.commit
    || initial.branch !== current.branch
    || initial.dirty !== current.dirty
    || initial.fingerprint !== current.fingerprint
  ) {
    throw new Error(
      'Source changed during the benchmark; refusing to write artifacts from a drifting checkout',
    )
  }
}

function commandFor(options) {
  const flags = options.smoke ? ['--smoke'] : []
  if (options.headed) flags.push('--headed')
  if (!options.smoke) {
    if (options.skipExport) flags.push('--skip-export')
    if (options.sampleCount !== 7) flags.push(`--samples ${options.sampleCount}`)
    if (options.playbackRuns !== 3) flags.push(`--playback-runs ${options.playbackRuns}`)
    if (options.playbackDurationMs !== 2_000) flags.push(`--playback-ms ${options.playbackDurationMs}`)
    if (options.memoryBatches !== 7) flags.push(`--memory-batches ${options.memoryBatches}`)
    if (options.scrubsPerMemoryBatch !== 8) flags.push(`--scrubs-per-batch ${options.scrubsPerMemoryBatch}`)
    if (options.exportFrames !== 30) flags.push(`--export-frames ${options.exportFrames}`)
    if (options.coldSamples !== Math.min(3, options.sampleCount)) {
      flags.push(`--cold-samples ${options.coldSamples}`)
    }
  }
  if (options.channel !== 'chromium') flags.push(`--channel ${options.channel}`)
  if (options.port !== DEFAULT_PORT) flags.push(`--port ${options.port}`)
  if (options.output) flags.push(`--output ${JSON.stringify(options.output)}`)
  return `node scripts/performance/run-benchmark.mjs${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`
}

function outputDirectory(root, requested) {
  if (requested) return isAbsolute(requested) ? requested : resolve(root, requested)
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
  return join(root, '.tmp', 'benchmarks', timestamp)
}

function attachProblemCollector(page, problems) {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
}

async function settleBrowserWork(page) {
  await page.evaluate(() => new Promise((resolveWork) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(resolveWork, 0)
    }))
  }))
  await page.waitForTimeout(0)
}

export async function finalizeBrowserEvidence(page, problems, finalizeResult) {
  let previousProblemsKey = null
  let finalizedResult
  for (let attempt = 0; attempt < 5; attempt++) {
    await settleBrowserWork(page)
    const consoleProblems = [...new Set(problems)]
    const problemsKey = JSON.stringify(consoleProblems)
    if (problemsKey !== previousProblemsKey) {
      previousProblemsKey = problemsKey
      finalizedResult = await finalizeResult(consoleProblems)
      continue
    }

    const screenshot = await page.screenshot({ fullPage: false })
    await settleBrowserWork(page)
    const problemsAfterScreenshot = [...new Set(problems)]
    if (JSON.stringify(problemsAfterScreenshot) === problemsKey) {
      return { screenshot, consoleProblems, finalizedResult }
    }
  }
  throw new Error('Browser warning/error collection did not settle after benchmark work')
}

export function runTypeScriptGate(root, execute = execFileSync) {
  execute(
    process.execPath,
    [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'],
    { cwd: root, stdio: 'inherit' },
  )
}

export async function buildBenchmarkApp(root, deps = {}) {
  const runGate = deps.runTypeScriptGate ?? runTypeScriptGate
  const buildVite = deps.buildVite ?? build
  runGate(root)
  await buildVite({ root })
}

async function launcherInteractiveSample(page, baseUrl) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
  const primaryAction = page.getByRole('button', { name: /start a new project/i })
  await primaryAction.waitFor({ state: 'visible' })
  if (!(await primaryAction.isEnabled())) {
    throw new Error('Launcher primary action did not become enabled')
  }
  return page.evaluate(() => new Promise((resolveTiming) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolveTiming(performance.now())
    }))
  }))
}

async function waitForHarness(page, baseUrl) {
  await page.goto(`${baseUrl}${BENCHMARK_PATH}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__webcutPerformanceHarness !== undefined, null, {
    timeout: 120_000,
  })
  await page.locator('[data-harness-status="ready"]').waitFor({
    state: 'visible',
    timeout: 120_000,
  })
}

/** Each cold sample gets an independent HTTP cache and browser storage. */
export async function collectColdSamples(browser, sampleCount, collectSample) {
  const samples = []
  for (let index = 0; index < sampleCount; index++) {
    const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT })
    try {
      const page = await context.newPage()
      samples.push(await collectSample(page, index))
    } finally {
      await context.close()
    }
  }
  return samples
}

async function main() {
  const { help, options } = parseArguments(process.argv.slice(2))
  if (help) {
    process.stdout.write(usage())
    return
  }

  const root = cwd()
  const initialSource = await sourceIdentity(root)
  const artifactDirectory = outputDirectory(root, options.output)
  const priorHarnessFlag = env.VITE_WEBCUT_PERFORMANCE_HARNESS
  env.VITE_WEBCUT_PERFORMANCE_HARNESS = '1'

  let server
  let browser
  try {
    await buildBenchmarkApp(root)
    server = await preview({
      root,
      preview: {
        host: '127.0.0.1',
        port: options.port,
        strictPort: true,
      },
    })
    const baseUrl = `http://127.0.0.1:${options.port}`
    browser = await chromium.launch({
      channel: options.channel,
      headless: !options.headed,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
      ],
    })
    const browserVersion = browser.version()
    const consoleProblems = []
    const launcherInteractiveSamples = await collectColdSamples(
      browser,
      options.coldSamples,
      async (page) => {
      attachProblemCollector(page, consoleProblems)
        return launcherInteractiveSample(page, baseUrl)
      },
    )

    const editorFirstUsableFrameSamples = await collectColdSamples(
      browser,
      options.coldSamples,
      async (page) => {
        attachProblemCollector(page, consoleProblems)
        await waitForHarness(page, baseUrl)
        const sample = await page.evaluate(() => (
          window.__webcutPerformanceHarness.firstUsableFrameMs()
        ))
        await page.evaluate(() => window.__webcutPerformanceHarness.cleanup())
        return sample
      },
    )

    const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT })
    const page = await context.newPage()
    attachProblemCollector(page, consoleProblems)
    await waitForHarness(page, baseUrl)
    const hostCpus = cpus()
    const host = {
      branch: initialSource.branch,
      commit: initialSource.commit,
      dirty: initialSource.dirty,
      dirtyFingerprint: initialSource.fingerprint,
      nodeVersion,
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      cpuModel: hostCpus[0]?.model ?? '<unknown>',
      logicalProcessors: hostCpus.length || null,
      totalMemoryGiB: Math.round(totalmem() / (1024 ** 3) * 100) / 100,
      browserChannel: options.channel,
      browserVersion,
      command: commandFor(options),
    }
    const runOptions = {
      sampleCount: options.sampleCount,
      playbackRuns: options.playbackRuns,
      playbackDurationMs: options.playbackDurationMs,
      memoryBatches: options.memoryBatches,
      scrubsPerMemoryBatch: options.scrubsPerMemoryBatch,
      exportFrames: options.exportFrames,
      skipExport: options.skipExport,
    }
    const result = await page.evaluate(async (request) => (
      window.__webcutPerformanceHarness.run(request)
    ), {
      host,
      options: runOptions,
      launcherInteractiveSamples,
      editorFirstUsableFrameSamples,
    })
    await page.locator('[data-harness-status="complete"]').waitFor({
      state: 'visible',
      timeout: 30_000,
    })

    if (!result.artifact.resources.storesRestored) {
      throw new Error('Benchmark cleanup did not restore every isolated store')
    }
    if (
      result.artifact.resources.benchmarkObjectUrlsCreated
      !== result.artifact.resources.benchmarkObjectUrlsRevoked
    ) {
      throw new Error('Benchmark cleanup did not revoke every generated source URL')
    }

    const browserEvidence = await finalizeBrowserEvidence(
      page,
      consoleProblems,
      async (finalConsoleProblems) => {
        result.artifact.consoleProblems = finalConsoleProblems
        return page.evaluate((artifact) => (
          window.__webcutPerformanceHarness.formatArtifact(artifact)
        ), result.artifact)
      },
    )
    result.artifact.consoleProblems = browserEvidence.consoleProblems
    result.summaryMarkdown = browserEvidence.finalizedResult
    await page.close()
    await context.close()

    assertSourceIdentityUnchanged(initialSource, await sourceIdentity(root))
    mkdirSync(artifactDirectory, { recursive: true })
    writeFileSync(
      join(artifactDirectory, 'performance.json'),
      `${JSON.stringify(result.artifact, null, 2)}\n`,
      'utf8',
    )
    writeFileSync(
      join(artifactDirectory, 'summary.md'),
      result.summaryMarkdown,
      'utf8',
    )
    writeFileSync(join(artifactDirectory, 'benchmark.png'), browserEvidence.screenshot)

    process.stdout.write(`Performance artifact: ${join(artifactDirectory, 'performance.json')}\n`)
    process.stdout.write(`Human summary: ${join(artifactDirectory, 'summary.md')}\n`)
    process.stdout.write(`Chromium screenshot: ${join(artifactDirectory, 'benchmark.png')}\n`)
    if (result.artifact.consoleProblems.length > 0) {
      throw new Error(
        `Benchmark captured ${result.artifact.consoleProblems.length} browser warning/error(s); inspect ${basename(artifactDirectory)}.`,
      )
    }
  } finally {
    if (browser) await browser.close()
    if (server) await server.close()
    if (priorHarnessFlag === undefined) delete env.VITE_WEBCUT_PERFORMANCE_HARNESS
    else env.VITE_WEBCUT_PERFORMANCE_HARNESS = priorHarnessFlag
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
