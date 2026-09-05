#!/usr/bin/env node
/** Local-only reproducible browser gate. Artifacts contain facts, never media bytes. */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer as createPortReservation } from 'node:net'
import { resolve } from 'node:path'
import os from 'node:os'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { evaluateCell } from './decision.mjs'

const root = process.cwd(), artifactDir = resolve(root, '.tmp/issue195')
mkdirSync(artifactDir, { recursive: true })
const smoke = process.argv.includes('--smoke')
const lifecycleOnly = process.argv.includes('--lifecycle-only')
if (smoke && lifecycleOnly) throw new Error('Choose smoke or lifecycle-only')
const candidate = process.argv.includes('--candidate=cursor') ? 'finite-seek-v2' : 'owned-native-v3'
const profileArg = process.argv.find((arg) => arg.startsWith('--profile='))?.split('=')[1]
const profiles = profileArg ? [profileArg] : smoke || lifecycleOnly ? ['avc-1080'] : ['avc-1080', 'vp9-1080', 'avc-2160']
if (profiles.some((p) => !['avc-1080', 'vp9-1080', 'avc-2160'].includes(p))) throw new Error('Unknown profile')
const outputPath = resolve(artifactDir, `${lifecycleOnly ? 'lifecycle' : smoke ? 'smoke' : 'research'}${profileArg ? `-${profileArg}` : ''}.json`)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const files = [...new Set([...git('ls-files').split('\n'), ...readdirSync('scripts/issue195').map((name) => `scripts/issue195/${name}`), 'docs/MULTICAM_MONITOR_RESEARCH.md'])].sort()
const sourceHash = createHash('sha256')
for (const path of files) { sourceHash.update(path); sourceHash.update('\0'); sourceHash.update(readFileSync(path)); sourceHash.update('\0') }
const fileDigests = Object.fromEntries(files.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]))
const flags = ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--enable-automation']
const ignoredDefaultFlags = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
const result = { schema: 'myrelith-issue195-v1', candidate, lifecycleOnly, startedAt: new Date().toISOString(),
  source: { commit: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), sha256: sourceHash.digest('hex'), files, fileDigests,
    trackedPatch: git('diff', 'HEAD', '--', '.', ':!.tmp'),
    researchSources: Object.fromEntries(files.filter((path) => path.startsWith('scripts/issue195/') || path === 'docs/MULTICAM_MONITOR_RESEARCH.md').map((path) => [path, readFileSync(path, 'utf8')])) },
  machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().map((cpu) => cpu.model),
    logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryAtStart: os.freemem() },
  launch: { headless: false, channel: 'chromium', args: flags, ignoreDefaultArgs: ignoredDefaultFlags, viewport: { width: 1600, height: 1000 } },
  runs: [], profiles: [], faults: [], errors: [] }
const save = () => writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
const server = await createServer({
  // Vite 8.1.1 still connects its injected client when server.ws=false. Disable
  // only that client's HMR connection, leaving media and lifecycle APIs intact.
  // Fail loudly if the pinned implementation changes instead of silently
  // invalidating the freeze experiment with a reconnect-triggered page reload.
  plugins: [{ name: 'issue195-no-client-hmr', transform(code, id) {
    if (!id.endsWith('/vite/dist/client/client.mjs')) return
    const connection = 'transport.connect(createHMRHandler(handleMessage));'
    if (!code.includes(connection)) throw new Error('Vite client HMR calibration changed')
    return code.replace(connection, '/* HMR connection disabled by Issue 195 research runner. */')
  } }],
  server: { host: '127.0.0.1', port: 42195, strictPort: true, hmr: false, ws: false,
  headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } } })
let browser
let browserCdp
let nativeProcess
let nativeProfile
async function processMemory() {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo')
  const pids = processInfo.map((process) => process.id).filter((id) => Number.isSafeInteger(id) && id > 0)
  let rss = null
  try { rss = execFileSync('ps', ['-o', 'pid=,rss=,comm=', '-p', pids.join(',')], { encoding: 'utf8' }).trim() }
  catch { /* A short-lived utility process can exit between CDP and ps. */ }
  return { at: new Date().toISOString(), processInfo, rssKiBByProcess: rss,
    caveat: 'RSS snapshots include shared pages and the entire isolated browser; neither a per-wall allocation ledger nor physical memory usage.' }
}
async function lab(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => {
    const path = '/scripts/issue195/lab.ts'
    return (await import(path))[method](...args)
  }, { method, args })
}
async function freshPage() {
  const context = lifecycleOnly ? browser.contexts()[0] : await browser.newContext({ viewport: result.launch.viewport })
  const page = await context.newPage()
  if (lifecycleOnly) await page.setViewportSize(result.launch.viewport)
  await page.bringToFront()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (error) => result.errors.push({ kind: 'pageerror', message: error.message }))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) result.errors.push({ kind: message.type(), message: message.text() }) })
  await page.goto('http://127.0.0.1:42195/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Issue 195 isolated research')
  await page.getByLabel('Resolution').selectOption('1080')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.getByRole('button', { name: 'Commands', exact: true }).waitFor()
  return { page, context }
}
try {
  await server.listen()
  if (lifecycleOnly) {
    // Focus emulation belongs to the originating CDP session. A second CDP
    // session cannot reliably undo Playwright's original override. Start an
    // isolated native browser and use the public noDefaults CDP connection.
    const reservation = createPortReservation()
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    nativeProfile = mkdtempSync(resolve(os.tmpdir(), 'myrelith-issue195-native-'))
    const nativeArgs = [...flags, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--user-data-dir=${nativeProfile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1600,1000', 'about:blank']
    nativeProcess = spawn(chromium.executablePath(), nativeArgs, { stdio: 'ignore' })
    const endpoint = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (nativeProcess.exitCode !== null) throw new Error('Native research browser exited during startup')
      try { const response = await fetch(`${endpoint}/json/version`); if (response.ok) { ready = true; break } } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Native browser startup deadline')
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true })
    result.launch = { ...result.launch, args: nativeArgs, ignoreDefaultArgs: [], connection: 'connectOverCDP noDefaults:true' }
  } else browser = await chromium.launch({ channel: 'chromium', headless: false, args: flags, ignoreDefaultArgs: ignoredDefaultFlags })
  result.browserVersion = browser.version()
  browserCdp = await browser.newBrowserCDPSession()
  result.browserFacts = await browserCdp.send('Browser.getVersion')
  result.gpu = await browserCdp.send('SystemInfo.getInfo')
  result.browserArguments = await browserCdp.send('Browser.getBrowserCommandLine')
  if (nativeProfile && !result.browserArguments.arguments.includes(`--user-data-dir=${nativeProfile}`)) throw new Error('Debug endpoint is not the owned research browser')
  for (const profile of profiles) {
    const { page, context } = await freshPage()
    const facts = { profile, sources: [], proxies: [] }
    result.profiles.push(facts)
    try {
      await lab(page, 'setCandidate', candidate)
      result.navigator = await page.evaluate(async () => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null, visibility: document.visibilityState, isolated: crossOriginIsolated,
        battery: navigator.getBattery ? await navigator.getBattery().then((battery) => ({ charging: battery.charging, level: battery.level })) : null }))
      facts.hevcProbe = await page.evaluate(async () => {
        const config = { codec: 'hvc1.1.6.L120.B0', width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 }
        try { return { requestedConfig: config, ...await VideoEncoder.isConfigSupported(config), evidence: 'capability only; not an encoded concurrent-decoder cell' } }
        catch (error) { return { requestedConfig: config, supported: false, error: String(error) } }
      })
      const count = smoke ? 2 : 8
      for (let angle = 0; angle < count; angle++) {
        process.stdout.write(`Generate ${profile} camera ${angle + 1}/${count}\n`)
        facts.sources.push(await page.evaluate(async ({ profile, angle }) => {
          const path = '/scripts/issue195/fixtures.ts'
          return (await import(path)).generate(profile, angle)
        }, { profile, angle }))
        save()
      }
      facts.project = await lab(page, 'prepare', count)
      for (const representation of ['original', 'proxy']) {
        if (representation === 'proxy') {
          process.stdout.write(`Generate ${profile} production proxies\n`)
          facts.proxies = await lab(page, 'generateProxies'); save()
        }
        for (let repeat = 0; repeat < (lifecycleOnly ? 0 : smoke ? 1 : 2); repeat++) {
          let baseline
          for (const wallCount of smoke ? [0, 2] : [0, 2, 4, 8]) {
            process.stdout.write(`Measure ${profile} ${representation} ${wallCount || 'baseline'} run ${repeat + 1}\n`)
            const memory = [await processMemory()]
            const memoryTimer = setInterval(() => { void processMemory().then((sample) => memory.push(sample)).catch(() => {}) }, 1000)
            let measured
            try { measured = await lab(page, 'benchmark', wallCount, representation) }
            finally { clearInterval(memoryTimer) }
            if (!wallCount) baseline = measured
            const decision = wallCount ? evaluateCell(measured, baseline) : null
            result.runs.push({ profile, repeat, ...measured, memory, decision }); save()
            if (!smoke && wallCount && measured.admission?.admitted && !decision.passed) {
              process.stdout.write(`Measure ${profile} ${representation} ${wallCount} adaptive 5 fps run ${repeat + 1}\n`)
              const fallback = await lab(page, 'benchmark', wallCount, representation, true)
              result.runs.push({ profile, repeat, ...fallback, decision: evaluateCell(fallback, baseline) }); save()
            }
          }
        }
      }
      if (!smoke) {
        if (!lifecycleOnly) {
          await lab(page, 'armFault', 8, 'proxy')
          await new Promise((resolve) => setTimeout(resolve, 450))
          await page.screenshot({ path: resolve(artifactDir, `${profile}-wall.png`) })
          await lab(page, 'fault', 'cancel')
        }
        const pageCdp = await context.newCDPSession(page)
        // This second session cannot undo standard Playwright's original focus
        // override. Only lifecycle-only's native noDefaults connection supplies
        // valid hidden/frozen evidence; always record observed visibility.
        await pageCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
        result.lifecycleFocusEmulation = lifecycleOnly ? 'noDefaults native default context' : 'standard Playwright override; lifecycle observations not valid proof'
        // Proxy faults run first because removing a source/proxy is destructive
        // to this disposable context's fixture set.
        for (const kind of ['cancel', 'seek-storm', 'switch', 'context-loss-injected', 'pressure-policy']) {
          process.stdout.write(`Fault ${profile} ${kind}\n`)
          await lab(page, 'armFault', 8, 'proxy')
          result.faults.push({ profile, ...await lab(page, 'fault', kind) }); save()
          if (kind === 'switch') await page.evaluate(async () => { const p = '/src/state/documentStore.ts'; (await import(p)).useDocumentStore.getState().undo() })
        }
        await lab(page, 'armFault', 8, 'proxy')
        await pageCdp.send('Memory.simulatePressureNotification', { level: 'critical' })
        result.faults.push({ profile, ...await lab(page, 'observedFault', 'browser-critical-pressure'),
          caveat: 'Actual CDP browser memory-pressure notification; automatic page notification is not guaranteed.' }); save()
        await lab(page, 'armFault', 8, 'proxy')
        const { windowId } = await pageCdp.send('Browser.getWindowForTarget')
        await pageCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
        await new Promise((resolve) => setTimeout(resolve, 1200))
        result.faults.push({ profile, ...await lab(page, 'observedFault', 'background-minimized-window') }); save()
        await pageCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); await page.bringToFront()
        await lab(page, 'armFault', 8, 'proxy')
        await pageCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
        await new Promise((resolve) => setTimeout(resolve, 150))
        await pageCdp.send('Page.setWebLifecycleState', { state: 'frozen' })
        await new Promise((resolve) => setTimeout(resolve, 1200))
        await pageCdp.send('Page.setWebLifecycleState', { state: 'active' })
        result.faults.push({ profile, ...await lab(page, 'observedFault', 'frozen-page') }); save()
        await pageCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); await page.bringToFront()
        for (const kind of ['proxy-invalidation', 'source-removal', 'project-replacement']) {
          await lab(page, 'armFault', kind === 'proxy-invalidation' ? 8 : 2, kind === 'proxy-invalidation' ? 'proxy' : 'original')
          result.faults.push({ profile, ...await lab(page, 'fault', kind) }); save()
        }
        // Crash only this disposable Chromium instance's GPU process. This is
        // stronger than dispatching a synthetic contextlost event, but is still
        // not physical device removal or evidence for other browser engines.
        if (profile === profiles.at(-1)) {
          await lab(page, 'armFault', 2, 'original')
          try {
            await browserCdp.send('Browser.crashGpuProcess')
            await new Promise((resolve) => setTimeout(resolve, 700))
            result.faults.push({ profile, ...await lab(page, 'observedFault', 'isolated-gpu-process-crash') })
          } catch (error) { result.faults.push({ profile, kind: 'isolated-gpu-process-crash', unsupportedOrFailed: String(error) }) }
          save()
        }
      }
      if (!lifecycleOnly) await page.screenshot({ path: resolve(artifactDir, `${profile}-editor.png`) })
    } finally { if (!lifecycleOnly) await context.close() }
  }
} catch (cause) {
  result.failure = cause instanceof Error ? { message: cause.message, stack: cause.stack } : String(cause)
  process.exitCode = 1
} finally {
  if (nativeProcess) { try { await browserCdp?.send('Browser.close') } catch { /* already closed */ } }
  await browser?.close(); await server.close()
  if (nativeProcess) {
    const running = () => nativeProcess.exitCode === null && nativeProcess.signalCode === null
    for (let i = 0; i < 50 && running(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    if (running()) nativeProcess.kill('SIGTERM')
    for (let i = 0; i < 50 && running(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    if (running()) result.errors.push({ kind: 'cleanup', message: 'Owned native browser did not exit; temporary profile retained' })
    else if (nativeProfile) rmSync(nativeProfile, { recursive: true, force: true })
  }
  const endHash = createHash('sha256')
  for (const path of files) { endHash.update(path); endHash.update('\0'); endHash.update(readFileSync(path)); endHash.update('\0') }
  result.source.endSha256 = endHash.digest('hex')
  result.source.unchangedDuringRun = result.source.endSha256 === result.source.sha256
  if (!result.source.unchangedDuringRun) process.exitCode = 1
  result.finishedAt = new Date().toISOString(); result.machine.freeMemoryAtEnd = os.freemem(); save()
  process.stdout.write(`Evidence: ${outputPath}\n`)
}
