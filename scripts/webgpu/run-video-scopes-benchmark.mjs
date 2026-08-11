import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'

const ROOT = resolve(import.meta.dirname, '..', '..')
const DEFAULT_PORT = 41_875

function parsePositiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return parsed
}

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    warmupIterations: 10,
    measuredIterations: 60,
    channel: 'chrome',
    headless: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--headless') options.headless = true
    else if (argument === '--port') {
      options.port = parsePositiveInteger(argv[++index], '--port')
    } else if (argument === '--warmup') {
      options.warmupIterations = parsePositiveInteger(argv[++index], '--warmup')
    } else if (argument === '--iterations') {
      options.measuredIterations = parsePositiveInteger(argv[++index], '--iterations')
    } else if (argument === '--channel') {
      options.channel = argv[++index]
      if (!options.channel) throw new RangeError('--channel requires a browser channel')
    } else {
      throw new RangeError(`Unknown argument: ${argument}`)
    }
  }
  if (options.port > 65_535) throw new RangeError('--port must be at most 65535')
  return options
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

async function sourceIdentity() {
  const files = git(['ls-files', '-co', '--exclude-standard'])
    .split(/\r?\n/u)
    .filter((file) => file && (
      file === 'src/domain/videoScopes.ts'
      || file.startsWith('src/workers/video-scopes')
      || file === 'src/workers/render.worker.ts'
      || file === 'scripts/webgpu/run-video-scopes-benchmark.mjs'
    ))
    .sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(await readFile(resolve(ROOT, file)))
    hash.update('\0')
  }
  return {
    commit: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    dirty: git(['status', '--porcelain=v1']).length > 0,
    fingerprint: `sha256:${hash.digest('hex')}`,
    files,
  }
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before readiness with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The strict-port server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
  ])
}

function formatMs(value) {
  return value === null ? 'unavailable' : `${value.toFixed(3)} ms`
}

function markdown(report) {
  const benchmark = report.benchmark
  const gpu = benchmark.latency.webGpuMs
  const adapter = benchmark.webGpu.adapter
  const recommendation = benchmark.webGpu.available
    && benchmark.correctness.exact
    && benchmark.deviceLoss.fallbackBackend === 'cpu'
    && benchmark.deviceLoss.exactCpuResult
    && gpu
    && benchmark.latency.medianSpeedupRatio >= 1.2
      ? 'Candidate only; repeat on the support matrix before any default change.'
      : 'No-go for production selection; keep the CPU path as the default.'
  return `# Issue #75 WebGPU video-scope evidence

- Captured: ${benchmark.capturedAt}
- Source: ${report.source.commit} (${report.source.branch}, dirty=${report.source.dirty})
- Source fingerprint: ${report.source.fingerprint}
- Browser: ${benchmark.environment.userAgent}
- CDP GPU: ${report.cdpGpu.deviceString ?? 'unavailable'}
- WebGPU adapter: ${adapter ? `${adapter.vendor} / ${adapter.architecture} / ${adapter.device} / ${adapter.description}` : 'unavailable'}
- Fixture: ${benchmark.fixture.width}x${benchmark.fixture.height}, sha256:${benchmark.fixture.sha256}

## Result

- Exact CPU/WebGPU parity: ${benchmark.correctness.exact} (${benchmark.correctness.comparedAnalyses} comparisons)
- CPU median / p95: ${formatMs(benchmark.latency.cpuMs.median)} / ${formatMs(benchmark.latency.cpuMs.p95)}
- WebGPU median / p95: ${gpu ? `${formatMs(gpu.median)} / ${formatMs(gpu.p95)}` : 'unavailable'}
- Median CPU/WebGPU speed ratio: ${benchmark.latency.medianSpeedupRatio?.toFixed(3) ?? 'unavailable'}x
- WebGPU startup (adapter + device + pipeline + parity self-test): ${formatMs(benchmark.latency.webGpuStartupMs)}
- First opt-in call wall time: ${formatMs(benchmark.latency.webGpuFirstCallWallMs)}
- CPU output allocation: ${benchmark.memory.cpuOutputBytesPerAnalysis.toLocaleString('en-US')} bytes
- WebGPU peak requested buffer bytes: ${benchmark.memory.webGpuPeakBufferBytes.toLocaleString('en-US')} bytes
- WebGPU active buffer bytes after analysis: ${benchmark.memory.webGpuActiveBufferBytesAfterAnalysis.toLocaleString('en-US')} bytes
- Driver/pipeline memory: unavailable through the WebGPU API
- Device loss exercised: ${benchmark.deviceLoss.exercised}; fallback=${benchmark.deviceLoss.fallbackBackend ?? 'unavailable'}; reason=${benchmark.deviceLoss.fallbackReason ?? 'unavailable'}; exact=${benchmark.deviceLoss.exactCpuResult ?? 'unavailable'}
- Cleanup: ${benchmark.cleanup.state}, ${benchmark.cleanup.activeBufferBytes} active buffer bytes
- Browser console warnings/errors: ${report.console.warnings.length}/${report.console.errors.length}
- Strict port released: ${report.portReleased}

## Recommendation

${recommendation}
`
}

async function portReleased(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return false
  } catch {
    return true
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const initialSource = await sourceIdentity()
  const origin = `http://127.0.0.1:${options.port}`
  const server = spawn(
    process.execPath,
    [
      resolve(ROOT, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(options.port),
      '--strictPort',
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        VITE_MYRELITH_WEBGPU_SCOPES_EXPERIMENT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let browser = null
  let report = null
  const serverErrors = []
  server.stderr.on('data', (chunk) => serverErrors.push(String(chunk)))

  try {
    await waitForServer(`${origin}/src/index.css`, server)
    browser = await chromium.launch({
      channel: options.channel,
      headless: options.headless,
      args: [
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
      ],
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    const warnings = []
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text())
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
    await page.goto(`${origin}/src/index.css`, { waitUntil: 'load' })
    const benchmark = await page.evaluate(async (benchmarkOptions) => {
      const module = await import('/src/workers/video-scopes-webgpu-benchmark.ts')
      return module.runVideoScopeWebGpuBenchmark(benchmarkOptions)
    }, {
      warmupIterations: options.warmupIterations,
      measuredIterations: options.measuredIterations,
    })
    const cdp = await browser.newBrowserCDPSession()
    const systemInfo = await cdp.send('SystemInfo.getInfo')
    await cdp.detach()
    const primaryDevice = systemInfo.gpu.devices?.[0] ?? {}
    const finalSource = await sourceIdentity()
    if (JSON.stringify(finalSource) !== JSON.stringify(initialSource)) {
      throw new Error('Relevant source identity changed during the benchmark')
    }
    report = {
      schemaVersion: 1,
      source: initialSource,
      benchmark,
      cdpGpu: {
        vendorId: primaryDevice.vendorId ?? null,
        deviceId: primaryDevice.deviceId ?? null,
        vendorString: primaryDevice.vendorString ?? null,
        deviceString: primaryDevice.deviceString ?? null,
        driverVendor: primaryDevice.driverVendor ?? null,
        driverVersion: primaryDevice.driverVersion ?? null,
        featureStatus: systemInfo.gpu.featureStatus,
      },
      console: { warnings, errors },
      serverErrors,
      port: options.port,
      portReleased: false,
    }
  } finally {
    await browser?.close()
    await stopServer(server)
  }

  if (!report) throw new Error('Benchmark did not produce a report')
  report.portReleased = await portReleased(`${origin}/src/index.css`)
  const outputDirectory = resolve(ROOT, '.tmp/issue-75-webgpu')
  await mkdir(outputDirectory, { recursive: true })
  const stamp = report.benchmark.capturedAt.replaceAll(':', '-').replaceAll('.', '-')
  const jsonPath = resolve(outputDirectory, `${stamp}.json`)
  const markdownPath = resolve(outputDirectory, `${stamp}.md`)
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(markdownPath, markdown(report), 'utf8')
  process.stdout.write(`${basename(jsonPath)}\n${basename(markdownPath)}\n`)

  const integrityErrors = []
  if (report.benchmark.webGpu.available && !report.benchmark.correctness.exact) {
    integrityErrors.push('CPU/WebGPU output differed')
  }
  if (report.benchmark.cleanup.state !== 'released') integrityErrors.push('adapter did not release')
  if (report.benchmark.cleanup.activeBufferBytes !== 0) integrityErrors.push('GPU buffers remained active')
  if (!report.portReleased) integrityErrors.push(`port ${options.port} remained open`)
  if (report.console.errors.length > 0) integrityErrors.push('browser console errors were recorded')
  if (integrityErrors.length > 0) throw new Error(integrityErrors.join('; '))
}

await main()
