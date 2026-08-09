import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  assertSourceIdentityUnchanged,
  buildBenchmarkApp,
  chromiumDeviceMetadata,
  collectColdSamples,
  createTemporaryBenchmarkOutput,
  dirtyFingerprint,
  finalizeBrowserEvidence,
  hashUntrackedPath,
  MAX_CONTINUOUS_EXPORT_FRAMES,
  MAX_CONTINUOUS_PLAYBACK_DURATION_MS,
  parseArguments,
  runTypeScriptGate,
  sampleChromiumProcessMemory,
  sampleHostProcessMemory,
  startBenchmarkPreview,
} from './run-benchmark.mjs'
import { execFileSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

function initializeRepository(root) {
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Myrelith test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@myrelith.invalid'], { cwd: root })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'fixture\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
}

function appendRepeated(path, chunk, count) {
  for (let index = 0; index < count; index++) {
    writeFileSync(path, chunk, { flag: index === 0 ? 'w' : 'a' })
  }
}

function expectedDirtyHash(root, commit, updateUntracked) {
  const status = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: root },
  )
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root })
  const hash = createHash('sha256')
    .update(commit)
    .update('\0')
    .update(status)
    .update('\0')
    .update(diff)
  for (const record of status.toString('utf8').split('\0')) {
    if (!record.startsWith('?? ')) continue
    const relativePath = record.slice(3)
    hash.update('\0untracked\0').update(relativePath)
    updateUntracked(hash, relativePath)
  }
  return `sha256:${hash.digest('hex')}`
}

function fakeStats(type, mode = 0) {
  const is = (expected) => type === expected
  return {
    dev: 1,
    ino: 1,
    size: 0,
    mtimeMs: 1,
    mode,
    isFile: () => is('regular'),
    isSymbolicLink: () => is('symlink'),
    isDirectory: () => is('directory'),
    isFIFO: () => is('fifo'),
    isSocket: () => is('socket'),
    isCharacterDevice: () => is('character-device'),
    isBlockDevice: () => is('block-device'),
  }
}

test('cold samples each use and close a fresh BrowserContext', async () => {
  const contexts = []
  const browser = {
    async newContext(options) {
      const context = {
        id: contexts.length + 1,
        options,
        closed: false,
        async newPage() {
          return { contextId: context.id }
        },
        async close() {
          context.closed = true
        },
      }
      contexts.push(context)
      return context
    },
  }

  const samples = await collectColdSamples(
    browser,
    3,
    async (page) => page.contextId,
  )

  assert.deepEqual(samples, [1, 2, 3])
  assert.equal(contexts.length, 3)
  assert.ok(contexts.every((context) => context.closed))
  assert.notStrictEqual(contexts[0], contexts[1])
})

test('source identity rejects end-of-run drift', () => {
  const initial = {
    branch: 'feat/issue-54-performance-harness',
    commit: 'abc123',
    dirty: true,
    fingerprint: 'sha256:initial',
  }

  assert.doesNotThrow(() => assertSourceIdentityUnchanged(initial, { ...initial }))
  assert.throws(
    () => assertSourceIdentityUnchanged(initial, {
      ...initial,
      fingerprint: 'sha256:changed',
    }),
    /Source changed during the benchmark/,
  )
})

test('dirty fingerprint streams a tracked diff larger than one MiB', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myrelith-benchmark-fingerprint-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Myrelith test'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@myrelith.invalid'], { cwd: root })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root })
    const trackedPath = join(root, 'large-diff.txt')
    writeFileSync(trackedPath, 'before\n'.repeat(200_000))
    execFileSync('git', ['add', 'large-diff.txt'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()

    writeFileSync(trackedPath, 'after\n'.repeat(200_000))
    const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    })
    assert.ok(diff.length > 1024 * 1024)
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: root },
    )
    const expectedFingerprint = `sha256:${createHash('sha256')
      .update(commit)
      .update('\0')
      .update(status)
      .update('\0')
      .update(diff)
      .digest('hex')}`

    const fingerprint = await dirtyFingerprint(root, commit)
    assert.equal(fingerprint.dirty, true)
    assert.equal(fingerprint.fingerprint, expectedFingerprint)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dirty fingerprint streams multiple untracked regular files larger than one MiB', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myrelith-benchmark-untracked-'))
  try {
    const commit = initializeRepository(root)
    const chunk = Buffer.alloc(64 * 1024, 0x5a)
    appendRepeated(join(root, 'large-a.bin'), chunk, 20)
    appendRepeated(join(root, 'large-b.bin'), chunk, 17)
    writeFileSync(join(root, 'small.txt'), 'small\n')
    let streamCount = 0
    const fingerprint = await dirtyFingerprint(root, commit, {
      createReadStream(path) {
        streamCount++
        return createReadStream(path, { highWaterMark: 64 * 1024 })
      },
    })
    const expected = expectedDirtyHash(root, commit, (hash, relativePath) => {
      const size = relativePath === 'large-a.bin'
        ? chunk.length * 20
        : relativePath === 'large-b.bin'
          ? chunk.length * 17
          : Buffer.byteLength('small\n')
      hash.update('\0regular\0').update(String(size)).update('\0')
      if (relativePath === 'small.txt') {
        hash.update('small\n')
        return
      }
      const count = relativePath === 'large-a.bin' ? 20 : 17
      for (let index = 0; index < count; index++) hash.update(chunk)
    })

    assert.equal(fingerprint.fingerprint, expected)
    assert.equal(streamCount, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('untracked symlinks, directories, and special files have explicit deterministic identities', async () => {
  const repositoryRoot = join(tmpdir(), 'myrelith-benchmark-repository')
  const symlinkTarget = join('..', 'outside', 'target.txt')
  const symlinkHash = createHash('sha256')
  await hashUntrackedPath(repositoryRoot, 'link.txt', symlinkHash, {
    async lstat() {
      return fakeStats('symlink')
    },
    async readlink() {
      return symlinkTarget
    },
  })
  const expectedSymlink = createHash('sha256')
    .update('\0untracked\0')
    .update('link.txt')
    .update('\0symlink\0')
    .update(symlinkTarget)
    .digest('hex')
  assert.equal(symlinkHash.digest('hex'), expectedSymlink)

  for (const [type, marker] of [
    ['directory', 'directory'],
    ['fifo', 'fifo'],
    ['unknown', 'special-mode-140000'],
  ]) {
    const hash = createHash('sha256')
    await hashUntrackedPath(repositoryRoot, `entry-${type}`, hash, {
      async lstat() {
        return fakeStats(type, 0o140000)
      },
    })
    const expected = createHash('sha256')
      .update('\0untracked\0')
      .update(`entry-${type}`)
      .update(`\0${marker}\0`)
      .digest('hex')
    assert.equal(hash.digest('hex'), expected)
  }
})

test('Chromium GPU metadata preserves renderer, driver, feature, and acceleration provenance', async () => {
  const metadata = await chromiumDeviceMetadata({
    async send(method) {
      assert.equal(method, 'SystemInfo.getInfo')
      return {
        gpu: {
          devices: [{
            vendorId: 0x1002,
            deviceId: 0x73ff,
            vendorString: 'AMD',
            deviceString: 'Radeon RX 6600',
            driverVendor: 'AMD',
            driverVersion: '99.1',
          }],
          auxAttributes: {
            glRenderer: 'ANGLE (AMD Radeon RX 6600)',
            glVendor: 'Google Inc. (AMD)',
          },
          featureStatus: {
            gpu_compositing: 'enabled',
            video_encode: 'disabled_software',
          },
        },
      }
    },
  })

  assert.deepEqual(metadata.renderer, {
    status: 'available',
    value: 'ANGLE (AMD Radeon RX 6600)',
  })
  assert.deepEqual(metadata.driverVersion, { status: 'available', value: '99.1' })
  assert.equal(metadata.acceleration.status, 'available')
  assert.equal(metadata.acceleration.mode, 'mixed')
  assert.deepEqual(metadata.featureStatus, {
    gpu_compositing: 'enabled',
    video_encode: 'disabled_software',
  })
})

test('Chromium GPU metadata reports explicit unavailable reasons when CDP is unsupported', async () => {
  const metadata = await chromiumDeviceMetadata({
    async send() {
      throw new Error('method not found')
    },
  })

  assert.equal(metadata.renderer.status, 'unavailable')
  assert.match(metadata.renderer.reason, /method not found/)
  assert.equal(metadata.acceleration.status, 'unavailable')
  assert.match(metadata.acceleration.reason, /SystemInfo\.getInfo/)
})

test('Chromium process memory sums a complete CDP renderer and GPU process table', async () => {
  const cdpSession = {
    async send(method) {
      assert.equal(method, 'SystemInfo.getProcessInfo')
      return {
        processInfo: [
          { id: 20, type: 'GPU', cpuTime: 2 },
          { id: 10, type: 'renderer', cpuTime: 1 },
          { id: 30, type: 'browser', cpuTime: 3 },
        ],
      }
    },
  }
  const result = await sampleChromiumProcessMemory(cdpSession, 2, {
    platform: 'test',
    async sampleHostProcessMemory(platformName, pids) {
      assert.equal(platformName, 'test')
      assert.deepEqual(pids, [10, 20, 30])
      return {
        hostSampler: 'test:private',
        primaryMetric: 'private-bytes',
        processes: pids.map((pid) => ({
          pid,
          rssBytes: pid * 20,
          privateBytes: pid * 10,
        })),
      }
    },
  })

  assert.equal(result.status, 'measured')
  assert.equal(result.sample.batchIndex, 2)
  assert.equal(result.sample.totalBytes, 600)
  assert.deepEqual(result.sample.processes.map((entry) => entry.pid), [10, 20, 30])
})

test('Windows host sampling embeds only validated numeric PIDs and returns private bytes', async () => {
  const result = await sampleHostProcessMemory('win32', [10, 20], {
    async executeText(file, args) {
      assert.equal(file, 'powershell.exe')
      assert.match(args.at(-1), /\$ids = @\(10,20\)/)
      assert.equal(args.includes('10,20'), false)
      return JSON.stringify([
        { pid: 10, rssBytes: 100, privateBytes: 80 },
        { pid: 20, rssBytes: 200, privateBytes: 160 },
      ])
    },
  })

  assert.equal(result.hostSampler, 'powershell:Get-Process')
  assert.equal(result.primaryMetric, 'private-bytes')
  assert.deepEqual(result.processes.map((entry) => entry.privateBytes), [80, 160])
})

test('Chromium process memory is unavailable instead of partial without renderer and GPU coverage', async () => {
  let calls = 0
  const result = await sampleChromiumProcessMemory({
    async send() {
      calls++
      return { processInfo: [{ id: 10, type: 'renderer', cpuTime: 1 }] }
    },
  }, 1, {
    platform: 'test',
    async sampleHostProcessMemory() {
      throw new Error('must not sample an incomplete CDP table')
    },
  })

  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /no GPU process/)
  assert.equal(calls, 3)
})

test('benchmark build runs the repository TypeScript gate before Vite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myrelith-benchmark-build-order-'))
  const outputDirectory = join(root, 'benchmark-output')
  const calls = []
  try {
    await buildBenchmarkApp(root, outputDirectory, {
      runTypeScriptGate(repositoryRoot) {
        calls.push({ step: 'tsc', root: repositoryRoot })
      },
      async buildVite({ root: repositoryRoot, build }) {
        calls.push({
          step: 'vite',
          root: repositoryRoot,
          outputDirectory: build.outDir,
          emptyOutDir: build.emptyOutDir,
        })
      },
    })

    assert.deepEqual(calls, [
      { step: 'tsc', root },
      {
        step: 'vite',
        root,
        outputDirectory,
        emptyOutDir: true,
      },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('successful benchmark build and preview preserve dist and remove the temporary output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myrelith-benchmark-success-'))
  const distDirectory = join(root, 'dist')
  const sentinelPath = join(distDirectory, 'deployable-sentinel.txt')
  let temporaryOutputDirectory
  let previewOutputDirectory
  try {
    mkdirSync(distDirectory)
    writeFileSync(sentinelPath, 'ordinary production build\n')

    const benchmarkOutput = await createTemporaryBenchmarkOutput()
    try {
      await buildBenchmarkApp(root, benchmarkOutput.outputDirectory, {
        runTypeScriptGate() {},
        async buildVite(config) {
          temporaryOutputDirectory = config.build.outDir
          assert.equal(isAbsolute(temporaryOutputDirectory), true)
          assert.notEqual(temporaryOutputDirectory, distDirectory)
          assert.equal(config.build.emptyOutDir, true)
          writeFileSync(join(temporaryOutputDirectory, 'index.html'), 'benchmark build\n')
        },
      })
      assert.equal(benchmarkOutput.outputDirectory, temporaryOutputDirectory)
      assert.equal(readFileSync(sentinelPath, 'utf8'), 'ordinary production build\n')
      await startBenchmarkPreview(root, benchmarkOutput.outputDirectory, 41_854, async (config) => {
        previewOutputDirectory = config.build.outDir
        assert.equal(config.root, root)
        assert.deepEqual(config.preview, {
          host: '127.0.0.1',
          port: 41_854,
          strictPort: true,
        })
        return { close() {} }
      })
    } finally {
      await benchmarkOutput.cleanup()
    }

    assert.equal(readFileSync(sentinelPath, 'utf8'), 'ordinary production build\n')
    assert.equal(previewOutputDirectory, temporaryOutputDirectory)
    assert.equal(existsSync(temporaryOutputDirectory), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed benchmark build preserves dist and removes the partial temporary output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myrelith-benchmark-failure-'))
  const distDirectory = join(root, 'dist')
  const sentinelPath = join(distDirectory, 'deployable-sentinel.txt')
  let temporaryOutputDirectory
  try {
    mkdirSync(distDirectory)
    writeFileSync(sentinelPath, 'ordinary production build\n')

    const benchmarkOutput = await createTemporaryBenchmarkOutput()
    try {
      await assert.rejects(
        buildBenchmarkApp(root, benchmarkOutput.outputDirectory, {
          runTypeScriptGate() {},
          async buildVite(config) {
            temporaryOutputDirectory = config.build.outDir
            writeFileSync(join(temporaryOutputDirectory, 'partial.txt'), 'partial build\n')
            throw new Error('fixture benchmark build failure')
          },
        }),
        /fixture benchmark build failure/,
      )
    } finally {
      await benchmarkOutput.cleanup()
    }

    assert.equal(readFileSync(sentinelPath, 'utf8'), 'ordinary production build\n')
    assert.equal(existsSync(temporaryOutputDirectory), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TypeScript gate uses the repository compiler in build mode', () => {
  const root = join(tmpdir(), 'myrelith-benchmark-repository')
  let invocation
  runTypeScriptGate(root, (file, args, options) => {
    invocation = { file, args, options }
  })

  assert.deepEqual(invocation, {
    file: process.execPath,
    args: [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'],
    options: { cwd: root, stdio: 'inherit' },
  })
})

test('runner rejects durations beyond the continuously encoded source plan', () => {
  assert.throws(
    () => parseArguments([
      '--playback-ms',
      String(MAX_CONTINUOUS_PLAYBACK_DURATION_MS + 1),
    ]),
    /continuous encoded source window/,
  )
  assert.throws(
    () => parseArguments([
      '--export-frames',
      String(MAX_CONTINUOUS_EXPORT_FRAMES + 1),
    ]),
    /continuous encoded source window/,
  )
  assert.equal(
    parseArguments([
      '--playback-ms',
      String(MAX_CONTINUOUS_PLAYBACK_DURATION_MS),
      '--export-frames',
      String(MAX_CONTINUOUS_EXPORT_FRAMES),
    ]).options.exportFrames,
    MAX_CONTINUOUS_EXPORT_FRAMES,
  )
  assert.equal(parseArguments([]).options.memoryBatches, 7)
  assert.equal(parseArguments(['--memory-batches', '9']).options.memoryBatches, 9)
  assert.equal(parseArguments(['--smoke']).options.memoryBatches, 2)
})

test('final browser evidence includes problems raised during screenshot, settling, and result formatting', async () => {
  const problems = ['warning: before result']
  let settledOnce = false
  let screenshotCount = 0
  let renderedSummary = ''
  const page = {
    async screenshot() {
      screenshotCount++
      if (screenshotCount === 1) problems.push('error: during screenshot')
      return Buffer.from(renderedSummary)
    },
    async evaluate() {
      if (!settledOnce) {
        settledOnce = true
        problems.push('pageerror: after result render')
      }
    },
    async waitForTimeout() {},
  }
  const finalizedSnapshots = []
  const evidence = await finalizeBrowserEvidence(
    page,
    problems,
    async (consoleProblems) => {
      finalizedSnapshots.push(consoleProblems)
      if (finalizedSnapshots.length === 1) {
        problems.push('warning: during result formatting')
      }
      renderedSummary = consoleProblems.join('\n')
      return renderedSummary
    },
  )

  assert.deepEqual(evidence.consoleProblems, [
    'warning: before result',
    'pageerror: after result render',
    'warning: during result formatting',
    'error: during screenshot',
  ])
  assert.deepEqual(finalizedSnapshots.at(-1), evidence.consoleProblems)
  assert.equal(evidence.finalizedResult, evidence.consoleProblems.join('\n'))
  assert.equal(screenshotCount, 2)
  assert.equal(evidence.screenshot.toString(), evidence.consoleProblems.join('\n'))
})
