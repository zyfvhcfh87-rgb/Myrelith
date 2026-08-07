import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  createReadStream,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
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
const CHROMIUM_MEMORY_SOURCE = 'cdp:SystemInfo.getProcessInfo+host-os-process'
const CHROMIUM_GPU_SOURCE = 'cdp:SystemInfo.getInfo'
const PROCESS_MEMORY_BINDING = '__webcutSampleChromiumProcessMemory'
const MEMORY_SAMPLE_ATTEMPTS = 3
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
  --memory-batches N      Post-warmup Chromium process samples (default 7).
  --scrubs-per-batch N    Scrubs between process-memory samples (default 8).
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

function untrackedFileType(stats) {
  if (stats.isFile()) return 'regular'
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  if (stats.isFIFO()) return 'fifo'
  if (stats.isSocket()) return 'socket'
  if (stats.isCharacterDevice()) return 'character-device'
  if (stats.isBlockDevice()) return 'block-device'
  return `special-mode-${(stats.mode & 0o170000).toString(8)}`
}

async function hashRegularFile(
  absolutePath,
  initialStats,
  hash,
  createStream,
  inspectPath,
) {
  hash.update('\0regular\0')
  hash.update(String(initialStats.size))
  hash.update('\0')
  const stream = createStream(absolutePath)
  for await (const chunk of stream) hash.update(chunk)
  const finalStats = await inspectPath(absolutePath)
  if (
    !finalStats.isFile()
    || finalStats.dev !== initialStats.dev
    || finalStats.ino !== initialStats.ino
    || finalStats.size !== initialStats.size
    || finalStats.mtimeMs !== initialStats.mtimeMs
  ) {
    throw new Error(`Untracked file changed while fingerprinting: ${absolutePath}`)
  }
}

export async function hashUntrackedPath(
  root,
  relativePath,
  hash,
  deps = {},
) {
  const inspectPath = deps.lstat ?? lstat
  const inspectLink = deps.readlink ?? readlink
  const createStream = deps.createReadStream ?? createReadStream
  const absolutePath = resolve(root, relativePath)
  hash.update('\0untracked\0')
  hash.update(relativePath)
  let stats
  try {
    stats = await inspectPath(absolutePath)
  } catch (cause) {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') {
      hash.update('\0missing\0')
      return
    }
    throw cause
  }
  const fileType = untrackedFileType(stats)
  if (fileType === 'regular') {
    await hashRegularFile(absolutePath, stats, hash, createStream, inspectPath)
    return
  }
  hash.update(`\0${fileType}\0`)
  if (fileType === 'symlink') hash.update(await inspectLink(absolutePath))
}

export async function dirtyFingerprint(root, commit, deps = {}) {
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
    await hashUntrackedPath(root, relativePath, hash, deps)
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

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

function unavailableIdentity(reason) {
  return { status: 'unavailable', reason }
}

function availableIdentity(value) {
  return { status: 'available', value }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter((entry) => typeof entry[1] === 'string')
    .map(([key, entryValue]) => [key, entryValue])
    .toSorted(([left], [right]) => left.localeCompare(right)))
}

function gpuIdentityField(value, label) {
  return value
    ? availableIdentity(value)
    : unavailableIdentity(`Chromium SystemInfo.getInfo did not expose ${label}.`)
}

function accelerationIdentity(renderer, featureStatus) {
  const relevantFeatures = Object.entries(featureStatus).filter(([key]) => (
    /^(gpu_compositing|rasterization|webgl2?|webgpu|video_(decode|encode))$/i.test(key)
  ))
  const softwareRenderer = renderer
    ? /(swiftshader|llvmpipe|software rasterizer|software adapter)/i.test(renderer)
    : false
  const softwareFeatures = relevantFeatures.filter(([, value]) => /software/i.test(value))
  const hardwareFeatures = relevantFeatures.filter(([, value]) => (
    /(enabled|hardware)/i.test(value) && !/software/i.test(value)
  ))
  const basis = [
    ...(softwareRenderer ? [`renderer=${renderer}`] : []),
    ...relevantFeatures.map(([key, value]) => `${key}=${value}`),
  ]
  if (softwareRenderer && hardwareFeatures.length === 0) {
    return { status: 'available', mode: 'software', basis }
  }
  if (softwareFeatures.length > 0 && hardwareFeatures.length > 0) {
    return { status: 'available', mode: 'mixed', basis }
  }
  if (softwareRenderer || softwareFeatures.length > 0) {
    return { status: 'available', mode: 'software', basis }
  }
  if (hardwareFeatures.length > 0) {
    return { status: 'available', mode: 'hardware', basis }
  }
  return unavailableIdentity(
    'Chromium SystemInfo.getInfo did not expose enough renderer or feature-status evidence to identify hardware versus software acceleration.',
  )
}

function unavailableChromiumDeviceMetadata(reason) {
  return {
    source: CHROMIUM_GPU_SOURCE,
    renderer: unavailableIdentity(reason),
    vendor: unavailableIdentity(reason),
    driverVendor: unavailableIdentity(reason),
    driverVersion: unavailableIdentity(reason),
    acceleration: unavailableIdentity(reason),
    devices: [],
    featureStatus: {},
  }
}

export async function chromiumDeviceMetadata(cdpSession) {
  if (!cdpSession) {
    return unavailableChromiumDeviceMetadata(
      'A browser-level Chromium CDP session was unavailable.',
    )
  }
  try {
    const result = await cdpSession.send('SystemInfo.getInfo')
    const gpu = result?.gpu && typeof result.gpu === 'object' ? result.gpu : null
    if (!gpu) {
      return unavailableChromiumDeviceMetadata(
        'Chromium SystemInfo.getInfo returned no GPU information.',
      )
    }
    const rawDevices = Array.isArray(gpu.devices) ? gpu.devices : []
    const devices = rawDevices.map((device) => ({
      vendorId: Number.isSafeInteger(device?.vendorId) ? device.vendorId : 0,
      deviceId: Number.isSafeInteger(device?.deviceId) ? device.deviceId : 0,
      subSysId: Number.isSafeInteger(device?.subSysId) ? device.subSysId : null,
      revision: Number.isSafeInteger(device?.revision) ? device.revision : null,
      vendorString: nonEmptyString(device?.vendorString),
      deviceString: nonEmptyString(device?.deviceString),
      driverVendor: nonEmptyString(device?.driverVendor),
      driverVersion: nonEmptyString(device?.driverVersion),
    }))
    const primaryDevice = devices[0] ?? null
    const auxAttributes = gpu.auxAttributes && typeof gpu.auxAttributes === 'object'
      ? gpu.auxAttributes
      : {}
    const featureStatus = normalizedStringRecord(gpu.featureStatus)
    const renderer = nonEmptyString(auxAttributes.glRenderer)
    const vendor = nonEmptyString(auxAttributes.glVendor)
      ?? primaryDevice?.vendorString
      ?? null
    const driverVendor = primaryDevice?.driverVendor
      ?? nonEmptyString(auxAttributes.driverVendor)
      ?? null
    const driverVersion = primaryDevice?.driverVersion
      ?? nonEmptyString(auxAttributes.driverVersion)
      ?? null
    return {
      source: CHROMIUM_GPU_SOURCE,
      renderer: gpuIdentityField(renderer, 'a GPU renderer'),
      vendor: gpuIdentityField(vendor, 'a GPU vendor'),
      driverVendor: gpuIdentityField(driverVendor, 'a GPU driver vendor'),
      driverVersion: gpuIdentityField(driverVersion, 'a GPU driver version'),
      acceleration: accelerationIdentity(renderer, featureStatus),
      devices,
      featureStatus,
    }
  } catch (cause) {
    return unavailableChromiumDeviceMetadata(
      `Chromium SystemInfo.getInfo is unavailable: ${errorMessage(cause)}`,
    )
  }
}

function executeText(file, args) {
  return new Promise((resolveText, rejectText) => {
    execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        rejectText(new Error(
          `${file} process-memory sampling failed: ${stderr?.trim() || error.message}`,
        ))
        return
      }
      resolveText(stdout)
    })
  })
}

function normalizedHostProcess(entry) {
  const pid = Number(entry?.pid)
  const rssBytes = entry?.rssBytes === null || entry?.rssBytes === undefined
    ? null
    : Number(entry.rssBytes)
  const privateBytes = entry?.privateBytes === null || entry?.privateBytes === undefined
    ? null
    : Number(entry.privateBytes)
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || (rssBytes !== null && (!Number.isSafeInteger(rssBytes) || rssBytes < 0))
    || (privateBytes !== null && (!Number.isSafeInteger(privateBytes) || privateBytes < 0))
  ) return null
  return { pid, rssBytes, privateBytes }
}

async function sampleWindowsProcesses(pids, runText = executeText) {
  const script = [
    `$ids = @(${pids.join(',')})`,
    '$items = foreach ($processId in $ids) {',
    '  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue',
    '  if ($null -ne $process) {',
    "    [pscustomobject]@{ pid = $process.Id; rssBytes = $process.WorkingSet64; privateBytes = $process.PrivateMemorySize64 }",
    '  }',
    '}',
    '@($items) | ConvertTo-Json -Compress',
  ].join('\n')
  const output = await runText('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  const parsed = JSON.parse(output || '[]')
  const entries = (Array.isArray(parsed) ? parsed : [parsed])
    .map(normalizedHostProcess)
    .filter(Boolean)
  return {
    hostSampler: 'powershell:Get-Process',
    primaryMetric: 'private-bytes',
    processes: entries,
  }
}

function kibibytesFromProc(text, key) {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)
  return match ? Number(match[1]) * 1024 : null
}

async function sampleLinuxPrivateProcesses(pids, readText) {
  const processes = []
  for (const pid of pids) {
    const text = await readText(`/proc/${pid}/smaps_rollup`, 'utf8')
    const rssBytes = kibibytesFromProc(text, 'Rss')
    const privateClean = kibibytesFromProc(text, 'Private_Clean')
    const privateDirty = kibibytesFromProc(text, 'Private_Dirty')
    const privateHuge = kibibytesFromProc(text, 'Private_Hugetlb') ?? 0
    if (rssBytes === null || privateClean === null || privateDirty === null) {
      throw new Error(`/proc/${pid}/smaps_rollup omitted required memory fields`)
    }
    processes.push({
      pid,
      rssBytes,
      privateBytes: privateClean + privateDirty + privateHuge,
    })
  }
  return {
    hostSampler: 'linux:/proc/<pid>/smaps_rollup',
    primaryMetric: 'private-bytes',
    processes,
  }
}

async function sampleLinuxRssProcesses(pids, readText) {
  const processes = []
  for (const pid of pids) {
    const text = await readText(`/proc/${pid}/status`, 'utf8')
    const rssBytes = kibibytesFromProc(text, 'VmRSS')
    if (rssBytes === null) throw new Error(`/proc/${pid}/status omitted VmRSS`)
    processes.push({ pid, rssBytes, privateBytes: null })
  }
  return {
    hostSampler: 'linux:/proc/<pid>/status',
    primaryMetric: 'rss-bytes',
    processes,
  }
}

async function sampleLinuxProcesses(pids, readText = readFile) {
  try {
    return await sampleLinuxPrivateProcesses(pids, readText)
  } catch {
    return sampleLinuxRssProcesses(pids, readText)
  }
}

async function sampleDarwinProcesses(pids, runText = executeText) {
  const output = await runText('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')])
  const processes = output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, rssKiB] = line.trim().split(/\s+/).map(Number)
    return normalizedHostProcess({ pid, rssBytes: rssKiB * 1024, privateBytes: null })
  }).filter(Boolean)
  return {
    hostSampler: 'darwin:ps-rss',
    primaryMetric: 'rss-bytes',
    processes,
  }
}

export async function sampleHostProcessMemory(
  platformName,
  pids,
  deps = {},
) {
  if (platformName === 'win32') {
    return sampleWindowsProcesses(pids, deps.executeText)
  }
  if (platformName === 'linux') {
    return sampleLinuxProcesses(pids, deps.readFile)
  }
  if (platformName === 'darwin') {
    return sampleDarwinProcesses(pids, deps.executeText)
  }
  throw new Error(`Host process-memory sampling is unsupported on ${platformName}.`)
}

function normalizedCdpProcesses(result) {
  if (!Array.isArray(result?.processInfo)) {
    throw new Error('SystemInfo.getProcessInfo returned no process table')
  }
  const processes = result.processInfo.map((entry) => {
    const pid = Number(entry?.id)
    const type = nonEmptyString(entry?.type)
    const cpuTimeSeconds = Number(entry?.cpuTime)
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || !type
      || !Number.isFinite(cpuTimeSeconds)
      || cpuTimeSeconds < 0
    ) throw new Error('SystemInfo.getProcessInfo returned an invalid process entry')
    return { pid, type, cpuTimeSeconds }
  }).toSorted((left, right) => left.pid - right.pid)
  if (processes.length === 0) throw new Error('SystemInfo.getProcessInfo returned an empty process table')
  if (new Set(processes.map((entry) => entry.pid)).size !== processes.length) {
    throw new Error('SystemInfo.getProcessInfo returned duplicate process IDs')
  }
  if (!processes.some((entry) => /renderer/i.test(entry.type))) {
    throw new Error('SystemInfo.getProcessInfo exposed no renderer process')
  }
  if (!processes.some((entry) => /gpu/i.test(entry.type))) {
    throw new Error('SystemInfo.getProcessInfo exposed no GPU process')
  }
  return processes
}

function unavailableProcessMemorySample(reason) {
  return { status: 'unavailable', reason }
}

export async function sampleChromiumProcessMemory(
  cdpSession,
  batchIndex,
  deps = {},
) {
  if (!cdpSession) {
    return unavailableProcessMemorySample(
      'A browser-level Chromium CDP session was unavailable for SystemInfo.getProcessInfo.',
    )
  }
  const platformName = deps.platform ?? platform()
  const sampleHost = deps.sampleHostProcessMemory ?? sampleHostProcessMemory
  let lastReason = 'Chromium process-memory sampling did not complete.'
  for (let attempt = 0; attempt < MEMORY_SAMPLE_ATTEMPTS; attempt++) {
    try {
      const cdpProcesses = normalizedCdpProcesses(
        await cdpSession.send('SystemInfo.getProcessInfo'),
      )
      const host = await sampleHost(
        platformName,
        cdpProcesses.map((entry) => entry.pid),
      )
      const verifiedCdpProcesses = normalizedCdpProcesses(
        await cdpSession.send('SystemInfo.getProcessInfo'),
      )
      const processIdentity = (entries) => entries
        .map((entry) => `${entry.pid}:${entry.type}`)
        .join('\0')
      if (processIdentity(cdpProcesses) !== processIdentity(verifiedCdpProcesses)) {
        lastReason = 'The Chromium process table changed while the host sample was collected.'
        continue
      }
      const hostByPid = new Map(host.processes.map((entry) => [entry.pid, entry]))
      const missingPids = cdpProcesses
        .filter((entry) => !hostByPid.has(entry.pid))
        .map((entry) => entry.pid)
      if (missingPids.length > 0) {
        lastReason = `Host sampling missed Chromium process IDs ${missingPids.join(', ')}.`
        continue
      }
      const processes = cdpProcesses.map((entry) => {
        const hostEntry = hostByPid.get(entry.pid)
        const metricBytes = host.primaryMetric === 'private-bytes'
          ? hostEntry.privateBytes
          : hostEntry.rssBytes
        if (!Number.isSafeInteger(metricBytes) || metricBytes < 0) {
          throw new Error(
            `Host sampler omitted ${host.primaryMetric} for Chromium process ${entry.pid}`,
          )
        }
        return { ...entry, ...hostEntry, metricBytes }
      })
      return {
        status: 'measured',
        sample: {
          batchIndex,
          source: CHROMIUM_MEMORY_SOURCE,
          hostSampler: host.hostSampler,
          primaryMetric: host.primaryMetric,
          totalBytes: processes.reduce((sum, entry) => sum + entry.metricBytes, 0),
          processes,
        },
      }
    } catch (cause) {
      lastReason = errorMessage(cause)
    }
  }
  return unavailableProcessMemorySample(
    `Complete Chromium process-memory evidence is unavailable after ${MEMORY_SAMPLE_ATTEMPTS} attempts: ${lastReason}`,
  )
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
  let browserSystemSession
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
    try {
      browserSystemSession = await browser.newBrowserCDPSession()
    } catch {
      // Both GPU identity and process memory carry explicit unavailable reasons
      // when the selected Chromium channel does not support a browser session.
    }
    const chromiumMetadata = await chromiumDeviceMetadata(browserSystemSession)
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
    await page.exposeBinding(PROCESS_MEMORY_BINDING, async ({ page: bindingPage }, request) => {
      if (bindingPage !== page) {
        return unavailableProcessMemorySample(
          'The process-memory request did not originate from the benchmark page.',
        )
      }
      const batchIndex = Number(request?.batchIndex)
      if (!Number.isSafeInteger(batchIndex) || batchIndex < 1) {
        return unavailableProcessMemorySample(
          'The benchmark page requested an invalid process-memory batch index.',
        )
      }
      return sampleChromiumProcessMemory(browserSystemSession, batchIndex)
    })
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
      chromium: chromiumMetadata,
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
    if (browserSystemSession) await browserSystemSession.detach().catch(() => {})
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
