import { chromium, firefox } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { createServer } from 'vite'
import { dirtyFingerprint } from '../performance/run-benchmark.mjs'

const DEFAULT_PORT = 41_209
const DEFAULT_OUTPUT = 'output/playwright/issue-208-portable'
const SCHEMA_VERSION = 1
const SCENARIO = 'issue-208-portable-core-v1'
const BROWSER_CHANNELS = new Set(['chromium', 'firefox'])
const PROJECT_NAME = 'Portable core'
const DOWNLOADED_COPY = 'Copy downloaded · unsaved changes'

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
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
  if (result.channel === 'webkit' || result.channel === 'safari') {
    throw new Error(
      'Playwright WebKit is not Safari. The portable path on Safari 26+ is a macOS pass of the real site, not this runner.',
    )
  }
  if (!BROWSER_CHANNELS.has(result.channel)) {
    throw new Error(`Unknown channel: ${result.channel}`)
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
    command: `npm run qa:issue208:portable -- --channel ${selected.channel} --port ${selected.port}${selected.headed ? ' --headed' : ''}`,
    safariNote: 'Safari 26+ must be driven on macOS. Linux WebKit is not that gate.',
  }
}

async function launchBrowser(selected) {
  if (selected.channel === 'firefox') {
    return firefox.launch({
      headless: !selected.headed,
      firefoxUserPrefs: { 'media.volume_scale': '0.0' },
    })
  }
  return chromium.launch({
    channel: 'chromium',
    headless: !selected.headed,
    args: ['--mute-audio'],
  })
}

function qualifyPortableSurface(context) {
  return context.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
      Object.defineProperty(window, name, {
        configurable: true,
        writable: true,
        value: undefined,
      })
    }
  })
}

async function nativeFileSystemAccess(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  try {
    const page = await context.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Start a new project' }).waitFor({ timeout: 120_000 })
    const facts = await page.evaluate(() => ({
      showOpenFilePicker: typeof window.showOpenFilePicker === 'function',
      showSaveFilePicker: typeof window.showSaveFilePicker === 'function',
      showDirectoryPicker: typeof window.showDirectoryPicker === 'function',
    }))
    return facts
  } finally {
    await context.close().catch(() => {})
  }
}

async function documentSnapshot(page) {
  return page.evaluate(async () => {
    const documents = await import('/src/state/documentStore.ts')
    const transport = await import('/src/state/transportStore.ts')
    const session = await import('/src/state/projectSessionStore.ts')
    const state = documents.useDocumentStore.getState()
    const clips = state.doc.tracks.flatMap((track) => track.clips)
    return {
      undoEntries: state.past.length,
      clipCount: clips.length,
      playhead: transport.useTransportStore.getState().playheadFrame,
      liveSaveEnabled: session.useProjectSessionStore.getState().liveSaveEnabled,
      hasUnsavedChanges: session.useProjectSessionStore.getState().hasUnsavedChanges,
      firstClipStart: clips[0]?.timelineRange.startFrame ?? null,
      firstClipDuration: clips[0]?.timelineRange.durationFrames ?? null,
    }
  })
}

async function stepTo(page, frame) {
  const forward = page.getByRole('button', { name: 'one frame forward' })
  for (let guard = 0; guard < 24; guard += 1) {
    const current = await documentSnapshot(page)
    if (current.playhead === frame) return current
    if (current.playhead > frame) break
    await forward.click()
  }
  await page.evaluate(async (target) => {
    const transport = await import('/src/state/transportStore.ts')
    transport.useTransportStore.getState().setPlayheadFrame(target)
  }, frame)
  return documentSnapshot(page)
}

async function clock(page) {
  return page.evaluate(async () => {
    const transport = await import('/src/app/transportController.ts')
    const context = transport.getPlaybackClockContext()
    return { state: context.state, currentTime: context.currentTime }
  })
}

async function settleImport(page) {
  const started = Date.now()
  while (Date.now() - started < 90_000) {
    const keepRate = page.getByRole('button', { name: /Keep .* fps/ })
    if (await keepRate.isVisible().catch(() => false)) await keepRate.click()
    const videoOnly = page.getByRole('button', { name: 'Import video only', exact: true })
    if (await videoOnly.isVisible().catch(() => false)) await videoOnly.click()
    const status = await page.locator('.media-item').first()
      .getAttribute('data-compatibility')
      .catch(() => null)
    if (status === 'ready' || status === 'limited') return status
    if (status === 'unsupported' || status === 'error') {
      const detail = await page.locator('.media-item').first().innerText()
      throw new Error(`Import finished as ${status}: ${detail}`)
    }
    await page.waitForTimeout(250)
  }
  throw new Error('Import did not reach Ready or Limited')
}

async function encodeFixture(page) {
  return page.evaluate(async () => {
    const mediabunny = await import('/node_modules/.vite/deps/mediabunny.js')
    const width = 160
    const height = 90
    const frames = 15
    const attempts = [
      ['vp9', 'webm', 'portable-core.webm', 'video/webm'],
      ['avc', 'mp4', 'portable-core.mp4', 'video/mp4'],
      ['av1', 'webm', 'portable-core.webm', 'video/webm'],
    ]
    const codecConfig = {
      vp9: 'vp09.00.10.08',
      avc: 'avc1.42001E',
      av1: 'av01.0.04M.08',
    }
    const failures = []
    for (const [codec, container, name, mime] of attempts) {
      const support = await VideoEncoder.isConfigSupported({
        codec: codecConfig[codec],
        width,
        height,
        bitrate: 500_000,
        framerate: 30,
      }).catch((cause) => ({ supported: false, reason: cause }))
      if (!support.supported) {
        failures.push(`${codec}: isConfigSupported false`)
        continue
      }
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('2D canvas is unavailable')
      const target = new mediabunny.BufferTarget()
      const output = new mediabunny.Output({
        target,
        format: container === 'webm'
          ? new mediabunny.WebMOutputFormat()
          : new mediabunny.Mp4OutputFormat(),
      })
      const source = new mediabunny.CanvasSource(canvas, {
        codec,
        bitrate: 500_000,
        keyFrameInterval: 1,
      })
      output.addVideoTrack(source, { frameRate: 30 })
      let finalized = false
      try {
        await output.start()
        for (let index = 0; index < frames; index += 1) {
          context.fillStyle = '#e23b2f'
          context.fillRect(0, 0, width, height)
          context.fillStyle = '#f4f1ea'
          context.fillRect(24, 22, 90, 36)
          await source.add(index / 30, 1 / 30)
        }
        await output.finalize()
        finalized = true
        if (!target.buffer?.byteLength) throw new Error('empty fixture')
        let binary = ''
        const bytes = new Uint8Array(target.buffer)
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return { name, mime, base64: btoa(binary), codec }
      } catch (cause) {
        failures.push(`${codec}: ${cause instanceof Error ? cause.message : String(cause)}`)
      } finally {
        if (!finalized) await output.cancel().catch(() => undefined)
        canvas.width = 0
        canvas.height = 0
      }
    }
    throw new Error(`No honest fixture encode: ${failures.join(' | ')}`)
  })
}

async function previewNonEmpty(page) {
  const shot = await page.getByTestId('preview-canvas').screenshot()
  return page.evaluate(async (base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    try {
      if (!context) return false
      context.drawImage(bitmap, 0, 0)
      const pixel = context.getImageData(
        Math.floor(bitmap.width / 2),
        Math.floor(bitmap.height / 2),
        1,
        1,
      ).data
      return pixel[3] > 0 && pixel[0] + pixel[1] + pixel[2] > 40
    } finally {
      bitmap.close()
      canvas.width = 0
      canvas.height = 0
    }
  }, shot.toString('base64'))
}

async function journalClipCount(page) {
  return page.evaluate(async () => {
    const storage = await import('/src/app/localProjectStorage.ts')
    const files = await import('/src/domain/projectFile.ts')
    const journals = await storage.localProjectStorage.listRecoveryJournals()
    const latest = journals[0]?.generations.at(-1)
    if (!latest) return -1
    const project = files.parseProjectFile(latest.serializedProject)
    return project.sequences.reduce((total, sequence) => (
      total + sequence.tracks.reduce((trackTotal, track) => trackTotal + track.clips.length, 0)
    ), 0)
  })
}

async function waitForStableRecovery(page, expected) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await journalClipCount(page) === expected) {
      await page.waitForTimeout(900)
      if (await journalClipCount(page) === expected) return
    } else {
      await page.waitForTimeout(200)
    }
  }
  throw new Error(`Recovery journal did not settle at ${expected} clips`)
}

async function placeOnTimeline(page) {
  const assetId = await page.evaluate(async () => {
    const media = await import('/src/state/mediaStore.ts')
    const assets = [...media.useMediaStore.getState().assets.values()]
    if (assets.length !== 1) throw new Error(`expected one imported asset, saw ${assets.length}`)
    return assets[0].id
  })
  await page.getByTestId('track-V1').evaluate((element, id) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('application/x-myrelith-asset', id)
    dataTransfer.setData('application/x-myrelith-asset-kind-video', '')
    const rect = element.getBoundingClientRect()
    const init = {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: rect.left + 8,
      clientY: rect.top + 12,
    }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      element.dispatchEvent(new DragEvent(type, init))
    }
  }, assetId)
  await page.locator('.clip-view').first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function optionalLauncher(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).waitFor({ timeout: 120_000 })
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  const rememberedProjectFilesOffered = await page.getByRole('button', {
    name: 'Open and remember a Myrelith project file',
    exact: true,
  }).count()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  return rememberedProjectFilesOffered > 0
}

async function createProject(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill(PROJECT_NAME)
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByLabel('Frame rate').selectOption('30/1')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.getByRole('button', { name: 'Commands' }).waitFor({ timeout: 60_000 })
}

function autoPresetFrom(text) {
  const match = /selects (Modern|Web|Compatibility)/.exec(text ?? '')
  if (match?.[1] === 'Modern') return 'modern'
  if (match?.[1] === 'Web') return 'web'
  if (match?.[1] === 'Compatibility') return 'compatibility'
  return null
}

async function runPortablePath(page, problems) {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('dialog', (dialog) => void dialog.accept())

  process.stdout.write('Issue 208 portable core: creating project\n')
  const rememberedProjectFilesOffered = await optionalLauncher(page)
  await createProject(page)
  const rememberedMediaImportOffered = await page.getByTitle(
    'Choose media and keep access for later sessions',
  ).count() > 0
  const encoded = await encodeFixture(page)
  const fixture = {
    name: encoded.name,
    mimeType: encoded.mime,
    buffer: Buffer.from(encoded.base64, 'base64'),
  }
  await page.getByLabel('Import media').setInputFiles(fixture)
  const importStatus = await settleImport(page)
  process.stdout.write(`Issue 208 portable core: import ${importStatus}\n`)
  await placeOnTimeline(page)

  const placed = await documentSnapshot(page)
  const splitFrame = (placed.firstClipStart ?? 0) + 4
  await page.locator('.clip-view').first().click()
  await stepTo(page, splitFrame)
  await page.locator('.clip-view').first().press('s')
  await page.locator('.clip-view').nth(1).waitFor({ state: 'visible', timeout: 10_000 })
  const recoveryBeforeUndo = await page.evaluate(async () => {
    const session = await import('/src/state/projectSessionStore.ts')
    return session.useProjectSessionStore.getState().lastRecoveryAt
  })
  await page.keyboard.press('Control+z')
  await page.locator('.clip-view').nth(1).waitFor({ state: 'hidden', timeout: 10_000 })
  await page.waitForFunction(async (previous) => {
    const session = await import('/src/state/projectSessionStore.ts')
    const state = session.useProjectSessionStore.getState()
    return state.recoveryPhase === 'idle'
      && state.lastRecoveryAt !== null
      && state.lastRecoveryAt !== previous
  }, recoveryBeforeUndo, { timeout: 15_000 })
  await page.keyboard.press('Control+Shift+z')
  await page.locator('.clip-view').nth(1).waitFor({ state: 'visible', timeout: 10_000 })
  await waitForStableRecovery(page, 2)
  const edited = await documentSnapshot(page)

  const previewAt = await stepTo(page, splitFrame)
  let previewNonEmptyFrame = false
  for (let attempt = 0; attempt < 20 && !previewNonEmptyFrame; attempt += 1) {
    previewNonEmptyFrame = await previewNonEmpty(page)
    if (!previewNonEmptyFrame) await page.waitForTimeout(300)
  }

  const beforeClock = await clock(page)
  const beforePlayhead = (await documentSnapshot(page)).playhead
  await page.getByRole('button', { name: 'play', exact: true }).click()
  const playbackDeadline = Date.now() + 15_000
  let afterPlayhead = beforePlayhead
  let afterClock = beforeClock
  while (Date.now() < playbackDeadline) {
    afterPlayhead = (await documentSnapshot(page)).playhead
    afterClock = await clock(page)
    if (afterPlayhead > beforePlayhead && afterClock.currentTime > beforeClock.currentTime) break
    await page.waitForTimeout(200)
  }
  if (await page.getByRole('button', { name: 'pause', exact: true }).count()) {
    await page.getByRole('button', { name: 'pause', exact: true }).click()
  }

  await page.getByText('Recovery copy updated', { exact: true }).waitFor({ timeout: 15_000 })
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const download = await downloadPromise
  const saveName = download.suggestedFilename()
  await download.saveAs(join(tmpdir(), saveName))
  const statusText = await page.getByText(DOWNLOADED_COPY, { exact: true }).textContent()
  const saved = await documentSnapshot(page)
  const journalClips = await page.evaluate(async () => {
    const storage = await import('/src/app/localProjectStorage.ts')
    const files = await import('/src/domain/projectFile.ts')
    const journals = await storage.localProjectStorage.listRecoveryJournals()
    const latest = journals[0]?.generations.at(-1)
    if (!latest) return -1
    const project = files.parseProjectFile(latest.serializedProject)
    return project.sequences.reduce((total, sequence) => (
      total + sequence.tracks.reduce((trackTotal, track) => trackTotal + track.clips.length, 0)
    ), 0)
  })
  process.stdout.write(`Issue 208 portable core: journal clips ${journalClips}\n`)
  await waitForStableRecovery(page, 2)

  await page.close()
  return {
    importStatus,
    edited,
    previewFrame: previewAt.playhead,
    previewNonEmpty: previewNonEmptyFrame,
    playback: {
      audioContextState: afterClock.state,
      clockAdvanced: afterClock.currentTime > beforeClock.currentTime,
      playheadBefore: beforePlayhead,
      playheadAfter: afterPlayhead,
    },
    save: {
      downloaded: saveName.endsWith('.myrelith'),
      extension: saveName.includes('.') ? saveName.slice(saveName.lastIndexOf('.')) : null,
      liveSaveEnabled: saved.liveSaveEnabled,
      statusText: statusText ?? '',
      stillDirty: saved.hasUnsavedChanges,
    },
    fixture,
    fixtureCodec: encoded.codec,
    rememberedProjectFilesOffered,
    rememberedMediaImportOffered,
    editUndoEntries: edited.undoEntries,
    clipCountAfterEdit: edited.clipCount,
  }
}

async function recoverAndExport(context, prior, problems) {
  const page = await context.newPage()
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')
  await page.getByRole('button', { name: `Recover ${PROJECT_NAME}`, exact: true }).click()
  await page.getByRole('heading', { name: 'Review recovered work', exact: true }).waitFor()
  await page.getByRole('button', { name: /Recover with \d+ offline|Recover project/ }).click()
  await page.getByRole('button', { name: 'Commands' }).waitFor({ timeout: 60_000 })
  const recovered = await documentSnapshot(page)
  process.stdout.write(`Issue 208 portable core: recovered clips ${recovered.clipCount}\n`)
  await page.getByLabel(`Relink ${prior.fixture.name}`, { exact: true }).setInputFiles(prior.fixture)
  await page.waitForFunction(async () => {
    const media = await import('/src/state/mediaStore.ts')
    return [...media.useMediaStore.getState().assets.values()].some((asset) => asset.objectUrl)
  }, undefined, { timeout: 30_000 })
  const relinkStatus = await settleImport(page)
  await page.getByText('Source offline', { exact: true }).waitFor({
    state: 'hidden',
    timeout: 30_000,
  }).catch(() => {})

  process.stdout.write('Issue 208 portable core: exporting\n')
  const pickerProbe = await page.evaluate(() => ({
    save: typeof window.showSaveFilePicker,
    open: typeof window.showOpenFilePicker,
    directory: typeof window.showDirectoryPicker,
  }))
  process.stdout.write(`Issue 208 portable core: pickers ${JSON.stringify(pickerProbe)}\n`)
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export video' })
  await dialog.waitFor()
  await dialog.getByRole('radio', { name: /^Auto(?![a-z])/ }).check()
  await dialog.getByText('Advanced settings').click()
  const destination = dialog.getByLabel('Export destination')
  const fileDestinationDisabled = await destination.locator('option[value="file"]').evaluate(
    (element) => element instanceof HTMLOptionElement && element.disabled,
  )
  const fileDestinationReason = await dialog.locator('#export-file-destination-help').textContent()
  await dialog.getByText(/Available — selects (Modern|Web|Compatibility)/).first().waitFor({ timeout: 120_000 })
  const autoText = await dialog.getByText(/Available — selects (Modern|Web|Compatibility)/).first().textContent()
  const autoChecked = await dialog.getByRole('radio', { name: /^Auto(?![a-z])/ }).isChecked()
  const start = dialog.getByRole('button', { name: 'Start export', exact: true })
  await start.waitFor({ timeout: 30_000 })
  await start.click()
  await dialog.getByText('Export ready', { exact: true }).waitFor({ timeout: 180_000 })
  const reopened = await page.evaluate(async () => {
    const link = document.querySelector('a.export-download')
    if (!(link instanceof HTMLAnchorElement) || !link.href) {
      throw new Error('Export download link is missing')
    }
    const mediabunny = await import('/node_modules/.vite/deps/mediabunny.js')
    const blob = await fetch(link.href).then((response) => response.blob())
    const input = new mediabunny.Input({
      formats: mediabunny.ALL_FORMATS,
      source: new mediabunny.BlobSource(blob),
    })
    let opened = 0
    let closed = 0
    try {
      const video = await input.getPrimaryVideoTrack()
      if (!video) return { reopenedVideo: false, samplesOpened: 0, samplesClosed: 0 }
      const sink = new mediabunny.VideoSampleSink(video)
      const sample = await sink.getSample(0)
      if (!sample) return { reopenedVideo: false, samplesOpened: 0, samplesClosed: 0 }
      opened += 1
      const reopenedVideo = video.displayWidth > 0
      sample.close()
      closed += 1
      return { reopenedVideo, samplesOpened: opened, samplesClosed: closed }
    } finally {
      input.dispose()
    }
  })
  const downloadPromise = page.waitForEvent('download')
  await page.locator('a.export-download').click()
  const exportedDownload = await downloadPromise
  await exportedDownload.delete().catch(() => {})

  return {
    contract: 'issue-208-portable-core-v1',
    schemaVersion: 1,
    publicSupportClaim: false,
    importStatus: prior.importStatus,
    editUndoEntries: prior.editUndoEntries,
    clipCountAfterEdit: prior.clipCountAfterEdit,
    previewFrame: prior.previewFrame,
    previewNonEmpty: prior.previewNonEmpty,
    playback: prior.playback,
    save: prior.save,
    recoveryRestoredClipCount: recovered.clipCount,
    relinked: relinkStatus === 'ready' || relinkStatus === 'limited',
    exportResult: {
      destination: 'download',
      autoPreset: autoPresetFrom(autoText),
      explicitSelectionLeftAtAuto: autoChecked,
      reopenedVideo: reopened.reopenedVideo,
      fileDestinationDisabled,
      fileDestinationReason: fileDestinationReason?.trim() || null,
    },
    optional: {
      rememberedProjectFilesOffered: prior.rememberedProjectFilesOffered,
      rememberedMediaImportOffered: prior.rememberedMediaImportOffered,
      pluginIsolationClaimed: false,
    },
    resources: {
      samplesOpened: reopened.samplesOpened,
      samplesClosed: reopened.samplesClosed,
    },
    fixtureCodec: prior.fixtureCodec,
  }
}

function reportHtml(artifact) {
  const decision = artifact.decision
  const core = decision.core
  const reasons = decision.reasons.length === 0 ? 'none' : decision.reasons.join(', ')
  const native = artifact.nativeFileSystemAccess
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #f8fbff; background: linear-gradient(145deg, #10141c, #182033); }
    main { width: min(1040px, calc(100% - 48px)); margin: auto; padding: 48px 0; }
    .eyebrow { color: #9ecbff; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0; font-size: 40px; }
    .lead, li, footer { color: #b9c4d4; line-height: 1.55; }
    .status { display: inline-flex; margin: 16px 0 24px; padding: 8px 12px; border-radius: 999px;
      border: 1px solid ${core === 'go' ? '#72f0bd55' : '#f0c57255'};
      color: ${core === 'go' ? '#93ffd0' : '#ffd093'}; background: #ffffff10; }
    section { padding: 18px; border: 1px solid #ffffff14; border-radius: 16px; background: #ffffff09; }
    footer { margin-top: 22px; font: 12px ui-monospace, monospace; }
  </style></head><body><main>
    <div class="eyebrow">MYRELITH · ISSUE 208 · PORTABLE CORE</div>
    <h1>Import, edit, preview, save, export</h1>
    <p class="lead">This run used the file-input and download path. Pickers were removed for this qualification so Recents and live save stayed off. Native picker presence is recorded separately and is not a support claim.</p>
    <div class="status">core ${core} · Auto ${decision.autoPreset ?? 'none'} · publicSupportClaim=${artifact.facts.publicSupportClaim}</div>
    <section>
      <h2>Core reasons</h2>
      <p>${reasons}</p>
      <h2>Native file pickers before qualification</h2>
      <ul>
        <li>showOpenFilePicker: ${native.showOpenFilePicker}</li>
        <li>showSaveFilePicker: ${native.showSaveFilePicker}</li>
        <li>showDirectoryPicker: ${native.showDirectoryPicker}</li>
      </ul>
      <h2>Playback</h2>
      <p>clock ${artifact.facts.playback.audioContextState} · frames ${artifact.facts.playback.playheadBefore} → ${artifact.facts.playback.playheadAfter}</p>
    </section>
    <footer>${artifact.host.browserChannel} ${artifact.host.browserVersion}<br>${artifact.source.branch} · ${artifact.source.commit.slice(0, 12)} · ${artifact.source.fingerprint}</footer>
  </main></body></html>`
}

function validateDecision(decision, facts) {
  if (facts?.contract !== SCENARIO || facts?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Issue #208 portable-core contract or schema drifted')
  }
  if (facts.publicSupportClaim !== false || decision.publicSupportClaim !== false) {
    throw new Error('Issue #208 portable core must not make a public support claim')
  }
  if (decision.core !== 'go') {
    throw new Error(`Issue #208 portable core is ${decision.core}: ${decision.reasons.join(', ') || 'no reasons'}\n${JSON.stringify({
      clips: facts.clipCountAfterEdit,
      recovered: facts.recoveryRestoredClipCount,
      auto: facts.exportResult.autoPreset,
      autoChecked: facts.exportResult.explicitSelectionLeftAtAuto,
      fileDisabled: facts.exportResult.fileDestinationDisabled,
      fileReason: facts.exportResult.fileDestinationReason,
    })}`)
  }
  const reasonText = JSON.stringify(decision)
  if (/firefox|safari|chrome|webkit|gecko|useragent/i.test(reasonText)) {
    throw new Error('Issue #208 portable-core decision used a browser-name or user-agent string')
  }
}

async function runChannel(selected, serverOrigin, root) {
  const initialSource = await sourceIdentity(root)
  const problems = []
  const browser = await launchBrowser(selected)
  try {
    const native = await nativeFileSystemAccess(browser, serverOrigin)
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
      baseURL: serverOrigin,
    })
    await qualifyPortableSurface(context)
    const page = await context.newPage()
    let facts
    try {
      const prior = await runPortablePath(page, problems)
      facts = await recoverAndExport(context, prior, problems)
    } finally {
      await context.close().catch(() => {})
    }
    const decision = await (async () => {
      const probe = await browser.newContext()
      try {
        const probePage = await probe.newPage()
        await probePage.goto(serverOrigin, { waitUntil: 'domcontentloaded' })
        const decision = await probePage.evaluate(async (value) => {
          const decisionModule = await import('/src/dev/issue208/portableCoreDecision.ts')
          return decisionModule.decidePortableCore(value)
        }, facts)
        return decision
      } finally {
        await probe.close().catch(() => {})
      }
    })()
    if (problems.length > 0) {
      throw new Error(`Page problems:\n${problems.join('\n')}`)
    }
    validateDecision(decision, facts)
    return { facts, decision, nativeFileSystemAccess: native, browserVersion: browser.version(), initialSource }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function main() {
  const selected = options(process.argv.slice(2))
  const root = cwd()
  const output = isAbsolute(selected.output) ? selected.output : resolve(root, selected.output)
  let server
  try {
    server = await createServer({
      root,
      server: { host: '127.0.0.1', port: selected.port, strictPort: true },
    })
    await server.listen()
    const origin = `http://127.0.0.1:${selected.port}/`
    let outcome
    try {
      outcome = await runChannel(selected, origin, root)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const clockFailed = message.includes('audio-clock')
      if (!selected.headed && clockFailed) {
        process.stdout.write('Headless audio clock did not advance. Retrying headed.\n')
        outcome = await runChannel({ ...selected, headed: true }, origin, root)
        outcome.headedRetry = true
      } else {
        throw error
      }
    }
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(outcome.initialSource)) {
      throw new Error('Source changed while Issue #208 portable core was running')
    }
    const artifact = {
      schemaVersion: SCHEMA_VERSION,
      scenario: SCENARIO,
      generatedAt: new Date().toISOString(),
      source: outcome.initialSource,
      host: hostIdentity(outcome.browserVersion, selected.headed ? selected : {
        ...selected,
        headed: Boolean(outcome.headedRetry),
      }),
      nativeFileSystemAccess: outcome.nativeFileSystemAccess,
      portableSurfaceQualifiedByRemovingPickers: true,
      headedRetry: Boolean(outcome.headedRetry),
      facts: outcome.facts,
      decision: outcome.decision,
    }
    const reportBrowser = await launchBrowser({
      ...selected,
      headed: Boolean(outcome.headedRetry) || selected.headed,
    })
    const reportContext = await reportBrowser.newContext({ viewport: { width: 1280, height: 900 } })
    const reportPage = await reportContext.newPage()
    await reportPage.setContent(reportHtml(artifact), { waitUntil: 'load' })
    await reportPage.evaluate(() => new Promise((resolvePaint) => {
      requestAnimationFrame(() => requestAnimationFrame(resolvePaint))
    }))
    const screenshot = await reportPage.screenshot({ fullPage: true })
    await reportBrowser.close().catch(() => {})
    mkdirSync(output, { recursive: true })
    const stem = `portable-${selected.channel}`
    writeFileSync(join(output, `${stem}.json`), `${JSON.stringify(artifact, null, 2)}\n`)
    writeFileSync(join(output, `${stem}.png`), screenshot)
    process.stdout.write(`Issue 208 portable-core evidence: ${join(output, `${stem}.json`)}\n`)
    process.stdout.write(`Core decision: ${outcome.decision.core}\n`)
    process.stdout.write(`Auto preset: ${outcome.decision.autoPreset ?? 'none'}\n`)
    process.stdout.write(`Browser screenshot: ${join(output, `${stem}.png`)}\n`)
  } finally {
    if (server) await server.close().catch(() => {})
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
