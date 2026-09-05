import { expect, test, type Page } from '@playwright/test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeMonitorMedia } from './fixtures/monitor-media.js'

test.setTimeout(180_000)
test.use({ actionTimeout: 10_000 })
async function createProject(page: Page, count: number, proxies: boolean, codec: 'avc' | 'vp9' = 'avc', recorded?: string) {
  await page.goto('http://127.0.0.1:41732/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Live multicam QA')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  const data = recorded ?? await page.evaluate(encodeMonitorMedia, { seconds: 20, width: 1280, height: 720, codec })
  const importTask = page.evaluate(async ({ data, count, codec, proxies }) => {
    const importerPath = '/src/app/mediaImportController.ts', visualsPath = '/src/app/mediaVisualsController.ts'
    const proxyPath = '/src/app/proxyController.ts', mediaPath = '/src/state/mediaStore.ts'
    const { importMedia } = await import(importerPath)
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    for (let i = 0; i < count; i++) {
      const result = await importMedia(new File([bytes], `Camera ${i + 1}.${codec === 'avc' ? 'mp4' : 'webm'}`, { type: codec === 'avc' ? 'video/mp4' : 'video/webm', lastModified: 195 }))
      if (result.status !== 'imported') throw new Error(JSON.stringify(result))
    }
    await (await import(visualsPath)).waitForMediaVisualsIdle()
    if (proxies) {
      const controller = await import(proxyPath)
      for (const id of (await import(mediaPath)).useMediaStore.getState().assets.keys()) {
        if (!controller.requestProxyGeneration(id)) throw new Error('Proxy generation was not accepted')
      }
      await controller.waitForProxyIdle()
    }
  }, { data, count, codec, proxies })
  if (recorded) {
    for (let i = 0; i < count; i++) await page.getByRole('button', { name: 'Keep 30 fps', exact: true }).click()
  }
  await importTask
  if (proxies) await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/state/proxyStore.ts'
    return [...(await import(path)).useProxyStore.getState().assets.values()].filter((item: { phase: string }) => item.phase === 'ready').length
  })).toBe(count)
  await page.getByRole('button', { name: 'New multicam' }).click()
  for (let i = 3; i <= count; i++) await page.getByRole('checkbox', { name: `Camera ${i}.${codec === 'avc' ? 'mp4' : 'webm'}` }).check()
  await page.getByRole('button', { name: 'Create multicam' }).click()
  await page.evaluate(async () => { const path = '/src/app/mediaVisualsController.ts'; await (await import(path)).waitForMediaVisualsIdle() })
  return data
}

async function resetPlayback(page: Page) {
  await playback(page, 'pauseAndDrainPlayback')
  await page.evaluate(async () => { const path = '/src/state/transportStore.ts'; (await import(path)).useTransportStore.getState().setPlayheadFrame(0) })
  const retry = page.getByRole('button', { name: 'Retry live previews' })
  if (await retry.isVisible()) await retry.click()
}

test('keyboard cuts use the integer playhead; focus and authored audio survive monitoring and a narrow layout', async ({ page }) => {
  const errors = captureProblems(page)
  await createProject(page, 2, false)
  await start(page)
  await playback(page, 'pauseAndDrainPlayback')
  await page.evaluate(async () => { const p = '/src/state/transportStore.ts'; (await import(p)).useTransportStore.getState().setPlayheadFrame(90) })
  const tile = page.getByRole('button', { name: 'Switch to Camera 2.mp4' })
  await tile.focus(); await page.keyboard.press('Enter')
  await expect(tile).toBeFocused(); await expect(tile).toHaveAttribute('aria-pressed', 'true')
  const facts = await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts', p = '/src/domain/multicam.ts'
    const state = (await import(d)).useDocumentStore.getState(), definition = state.project.multicams[0]
    const planner = (await import(p)).createMulticamPlanner(definition)
    const before = planner.select(89), after = planner.select(90)
    return { frame: (await import(t)).useTransportStore.getState().playheadFrame, switches: definition.switches,
      before: before.video.angleId, after: after.video.angleId, audioBefore: before.audio.angleId, audioAfter: after.audio.angleId }
  })
  expect(facts.frame).toBe(90); expect(facts.switches.at(-1).frame).toBe(90)
  expect(facts.before).not.toBe(facts.after); expect(facts.audioBefore).toBe(facts.audioAfter)
  await page.keyboard.press('Alt+1')
  await expect(page.getByRole('button', { name: 'Switch to Camera 1.mp4' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tile).toBeFocused()
  await page.setViewportSize({ width: 720, height: 800 })
  await page.getByRole('checkbox', { name: 'Live angle previews' }).scrollIntoViewIfNeeded()
  expect(await page.locator('.multicam-monitor-controls').evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false)
  expect((await page.getByRole('button', { name: 'Switch to Camera 1.mp4' }).boundingBox())!.width).toBeGreaterThanOrEqual(76)
  await page.screenshot({ path: '/private/tmp/issue195-monitor-720.png' })
  await page.getByRole('checkbox', { name: 'Live angle previews' }).uncheck()
  expect((await diagnostics(page)).admission.monitorOwners).toBe(0)
  expect(errors).toEqual([])
})

test('Source Monitor, proxy removal, clear and project replacement retire the product worker', async ({ page }) => {
  const errors = captureProblems(page)
  await createProject(page, 2, true)
  await start(page)
  await page.getByRole('button', { name: 'Preview Camera 2.mp4', exact: true }).click()
  await expect.poll(async () => (await diagnostics(page)).admission.monitorOwners).toBe(0)
  await expect(page.getByRole('button', { name: 'Retry live previews' })).toBeVisible()
  await page.getByRole('region', { name: 'Source Monitor', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(async () => (await diagnostics(page)).admission.blockers).not.toContain('source')
  await resetPlayback(page); await start(page)
  await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', p = '/src/app/proxyController.ts'
    const angle = (await import(d)).useDocumentStore.getState().project.multicams[0].angles[1]
    await (await import(p)).removeProxy(angle.assetId)
  })
  expect((await diagnostics(page)).admission.monitorOwners).toBe(0)
  await resetPlayback(page); await start(page)
  await page.evaluate(async () => { const p = '/src/app/localDerivedStorage.ts'; await (await import(p)).localDerivedStorage.clear() })
  expect((await diagnostics(page)).admission.monitorOwners).toBe(0)
  await resetPlayback(page); await start(page)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  // Project navigation may ask to discard an unsaved edit; this test owns it.
  await expect(page.getByRole('button', { name: 'Start a new project' })).toBeVisible()
  const ended = await diagnostics(page)
  expect(ended.admission.monitorOwners).toBe(0); expect(ended.worker).toBeUndefined()
  expect(errors).toEqual([])
})

test('unsupported VP9 originals retain paused previews and editing controls', async ({ page }) => {
  const errors = captureProblems(page)
  await createProject(page, 2, false, 'vp9')
  await page.getByRole('checkbox', { name: 'Live angle previews' }).check()
  await playback(page, 'play')
  await expect(page.getByRole('button', { name: 'Retry live previews' })).toBeVisible({ timeout: 12_000 })
  const state = await diagnostics(page)
  expect(state.admission.monitorOwners).toBe(0); expect(state.surfacePixels).toBe(0)
  expect(state.presentation.detail).toMatch(/AVC|Program playback|proxies/)
  await expect(page.getByRole('button', { name: 'Cut to Camera 2.webm' })).toBeEnabled()
  await playback(page, 'pauseAndDrainPlayback'); expect(errors).toEqual([])
})

test('recorded camera content decodes through fresh local proxies', async ({ page }, info) => {
  test.skip(!process.env.ISSUE195_RECORDED_MP4, 'Set ISSUE195_RECORDED_MP4 to the documented local MDN camera recording')
  const errors = captureProblems(page)
  await createProject(page, 2, true, 'avc', readFileSync(process.env.ISSUE195_RECORDED_MP4!).toString('base64'))
  await start(page)
  await expect(page.locator('.multicam-angle-canvas[data-live="true"]')).toHaveCount(1)
  await page.waitForTimeout(350)
  await info.attach('recorded-ownership', { body: JSON.stringify(await diagnostics(page)), contentType: 'application/json' })
  await playback(page, 'pauseAndDrainPlayback')
  expect((await diagnostics(page)).admission.monitorOwners).toBe(0); expect(errors).toEqual([])
})

test('sustained sessions keep bounded ownership across repeated playback and seeking', async ({ page }, info) => {
  const errors = captureProblems(page)
  await createProject(page, 4, true)
  const snapshots = []
  for (let cycle = 0; cycle < 8; cycle++) {
    await resetPlayback(page); await start(page)
    await page.waitForTimeout(6000)
    const live = await diagnostics(page)
    expect(live.presentation.phase, JSON.stringify(live)).toBe('live')
    expect(live.worker.ledger.peakFrameBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    snapshots.push({ live })
    await playback(page, 'pauseAndDrainPlayback')
    const closed = await diagnostics(page)
    expect(closed.worker).toBeNull(); expect(closed.admission.monitorOwners).toBe(0)
    expect(closed.surfacePixels).toBe(0); expect(closed.lastCleanup.unclosedReceivedBitmaps).toBe(0)
  }
  await info.attach('sustained-ownership', { body: JSON.stringify(snapshots), contentType: 'application/json' })
  expect(errors).toEqual([])
})

test('export preempts monitoring, uses originals, and recovery/relink preserve authored cuts', async ({ page }, info) => {
  const errors = captureProblems(page)
  const data = await createProject(page, 2, true)
  await start(page)
  const exported = await page.evaluate(async () => {
    const e = '/src/app/exportController.ts', p = '/src/domain/exportProfile.ts', m = '/node_modules/.vite/deps/mediabunny.js'
    const a = '/src/app/mediaResourceAdmission.ts', d = '/src/state/documentStore.ts'
    const { startExport, disposeExport } = await import(e), { DEFAULT_EXPORT_PROFILE } = await import(p)
    const before = JSON.stringify((await import(d)).useDocumentStore.getState().project)
    const pending = startExport({ ...DEFAULT_EXPORT_PROFILE, videoBitrate: 1_000_000 })
    const ownersAtStart = (await import(a)).mediaResourceAdmission.snapshot().monitorOwners
    let input
    try {
      const result = await pending
      if (!result || result.destination !== 'download') throw new Error('Expected local buffered export')
      const { Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioSampleSink } = await import(m)
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([result.buffer])) })
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack()
      if (!video || !audio) throw new Error('Export lost a track')
      const sample = await new VideoSampleSink(video).getSample(.5)
      if (!sample) throw new Error('Exported video is unavailable')
      sample.close()
      const sound = await new AudioSampleSink(audio).getSample(.5)
      if (!sound) throw new Error('Exported audio is unavailable')
      let rms = 0
      try {
        const pcm = new Float32Array(sound.numberOfFrames); sound.copyTo(pcm, { format: 'f32-planar', planeIndex: 0 })
        rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length)
      } finally { sound.close() }
      return { ownersAtStart, bytes: result.buffer.byteLength, duration: await input.computeDuration(), rms,
        unchanged: before === JSON.stringify((await import(d)).useDocumentStore.getState().project) }
    } finally { input?.dispose(); await disposeExport() }
  })
  expect(exported.ownersAtStart).toBe(0); expect(exported.bytes).toBeGreaterThan(10_000)
  expect(exported.duration).toBeGreaterThanOrEqual(20); expect(exported.duration).toBeLessThan(20.2)
  expect(exported.rms).toBe(0); expect(exported.unchanged).toBe(true)
  await info.attach('original-export', { body: JSON.stringify(exported), contentType: 'application/json' })
  await resetPlayback(page)
  await page.evaluate(async () => { const d = '/src/state/documentStore.ts'; const state = (await import(d)).useDocumentStore.getState(), def = state.project.multicams[0]; state.editMulticamDefinition({ kind: 'cut', definitionId: def.id, frame: 90, angleId: def.angles[1].id }) })
  const saved = await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', m = '/src/state/mediaStore.ts', f = '/src/domain/projectFile.ts'
    const { createProjectFileSnapshot, serializeProjectFile } = await import(f)
    const { project } = (await import(d)).useDocumentStore.getState(), media = (await import(m)).useMediaStore.getState()
    return { id: project.id, multicams: project.multicams, serialized: serializeProjectFile(createProjectFileSnapshot(project, media.descriptors.values(), media.collections)) }
  })
  expect(saved.serialized).not.toMatch(/blob:|cacheKey|multicamMonitor|nativeDecoder/)
  await expect.poll(async () => page.evaluate(async (id) => {
    const p = '/src/app/localProjectStorage.ts'
    return (await (await import(p)).localProjectStorage.listRecoveryJournals()).some((record: { documentId: string; generations: { serializedProject: string }[] }) => record.documentId === id
      && JSON.parse(record.generations.at(-1)!.serializedProject).multicams[0]?.switches.length === 2)
  }, saved.id), { timeout: 10_000 }).toBe(true)
  await page.reload()
  await page.getByRole('tab', { name: /^Recovery copies,/ }).click()
  await page.getByRole('button', { name: 'Recover Live multicam QA', exact: true }).click()
  await page.getByRole('button', { name: 'Recover with 2 offline', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  const restored = await page.evaluate(async (data) => {
    const d = '/src/state/documentStore.ts', m = '/src/state/mediaStore.ts', p = '/src/app/projectController.ts', a = '/src/app/mediaResourceAdmission.ts'
    const before = (await import(a)).mediaResourceAdmission.snapshot().monitorOwners
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const descriptors = [...(await import(m)).useMediaStore.getState().descriptors.values()] as { id: string; fileName: string }[]
    for (const descriptor of descriptors) {
      const result = await (await import(p)).connectActiveAssetMedia(descriptor.id, new File([bytes], descriptor.fileName, { type: 'video/mp4', lastModified: 195 }))
      if (result.status !== 'ready') throw new Error(JSON.stringify(result))
    }
    return { before, multicams: (await import(d)).useDocumentStore.getState().project.multicams }
  }, data)
  expect(restored.before).toBe(0); expect(restored.multicams).toEqual(saved.multicams)
  expect(errors).toEqual([])
})

test('native visibility, initial hidden admission, freeze and GPU loss retire the worker', async ({ playwright }, info) => {
  test.skip(process.env.ISSUE195_NATIVE_LIFECYCLE !== '1', 'Explicit opt-in only: this test opens and minimizes a separate native browser window')
  // A default Playwright context emulates focus. Use the actual native default
  // context with noDefaults, as calibrated by the research gate.
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const profile = mkdtempSync(join(tmpdir(), 'myrelith-issue195-acceptance-'))
  const child = spawn(playwright.chromium.executablePath(), ['--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--enable-automation', '--disable-background-networking', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let nativeLog = '', phase = 'launch'
  child.stderr.on('data', (chunk: Buffer) => { nativeLog = (nativeLog + chunk.toString()).slice(-8192) })
  let browser
  try {
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false } }, { timeout: 10_000 }).toBe(true)
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
    const context = browser.contexts()[0]!, page = context.pages()[0]!
    // Vite reconnects after a native freeze and otherwise reloads this page.
    // Disable only its pinned development HMR connection, as in the research
    // runner; browser visibility, native media and lifecycle APIs stay intact.
    await context.route('**/@vite/client', async (route) => {
      const response = await route.fetch(), code = await response.text()
      const connection = 'transport.connect(createHMRHandler(handleMessage));'
      if (!code.includes(connection)) throw new Error('Vite HMR calibration changed')
      await route.fulfill({ response, body: code.replace(connection, '/* HMR disabled for native lifecycle acceptance. */') })
    })
    const cdp = await context.newCDPSession(page), browserCdp = await browser.newBrowserCDPSession()
    await createProject(page, 2, false)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden')
    await page.evaluate(async () => { const p = '/src/app/multicamMonitorController.ts'; (await import(p)).setMulticamMonitorEnabled(true) })
    const initialHidden = await diagnostics(page)
    expect(initialHidden.admission.monitorOwners).toBe(0); expect(initialHidden.pendingSetup).toBe(false)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
    await page.getByRole('button', { name: 'Retry live previews' }).click(); await start(page)
    phase = 'visible-to-hidden'
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden')
    const hidden = await diagnostics(page)
    expect(hidden.admission.monitorOwners).toBe(0); expect(hidden.surfacePixels).toBe(0)
    phase = 'resume-after-hidden'
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await page.bringToFront(); await resetPlayback(page); await start(page)
    phase = 'freeze'
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden')
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
    // Native browsers freeze hidden pages. No lifecycle or media APIs are
    // mocked, and the frozen page receives no evaluate request.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await cdp.send('Page.setWebLifecycleState', { state: 'active' })
    const frozen = await diagnostics(page)
    expect(frozen.admission.monitorOwners).toBe(0); expect(frozen.surfacePixels).toBe(0)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await page.bringToFront()
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
    // Freeze acceptance is safe retirement and usable manual controls. Start
    // the independent GPU fault in a fresh project, since the browser may
    // reclaim Program/audio resources during suspension.
    await expect(page.getByRole('button', { name: 'Cut to Camera 2.mp4' })).toBeEnabled()
    phase = 'fresh-project-before-gpu-loss'
    await createProject(page, 2, false); await start(page)
    phase = 'gpu-loss'
    await browserCdp.send('Browser.crashGpuProcess')
    await expect.poll(async () => (await diagnostics(page)).admission.monitorOwners, { timeout: 10_000 }).toBe(0)
    const gpu = await diagnostics(page)
    expect(gpu.surfacePixels).toBe(0)
    await info.attach('native-lifecycle', { body: JSON.stringify({ initialHidden, hidden, frozen, gpu, version: browser.version() }), contentType: 'application/json' })
  } catch (cause) {
    await info.attach('native-browser-failure', { body: JSON.stringify({ phase, nativeLog, exitCode: child.exitCode, signalCode: child.signalCode }), contentType: 'application/json' })
    throw cause
  } finally {
    try { await browser?.close() } finally {
      // Closing a CDP connection does not reliably close its native browser.
      // This PID and disposable profile belong exclusively to this test.
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.kill('SIGKILL')
        })
      }
      rmSync(profile, { recursive: true, force: true })
    }
  }
})
async function diagnostics(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/app/multicamMonitorController.ts', admissionPath = '/src/app/mediaResourceAdmission.ts'
    return { ...((await import(path)).getMulticamMonitorDiagnostics()), admission: (await import(admissionPath)).mediaResourceAdmission.snapshot() }
  })
}
async function playback(page: Page, action: 'play' | 'pauseAndDrainPlayback') {
  await page.evaluate(async (action) => { const path = '/src/app/transportController.ts'; await (await import(path))[action]() }, action)
}
async function start(page: Page) {
  await page.getByRole('checkbox', { name: 'Live angle previews' }).check()
  await playback(page, 'play')
  await expect.poll(async () => (await diagnostics(page)).presentation, { timeout: 10_000 }).toMatchObject({ phase: 'live' })
}
function captureProblems(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()) })
  return errors
}

for (const [count, proxies] of [[2, false], [4, true], [8, true]] as const) {
  test(`${count} angles with ${proxies ? 'fresh proxies' : 'original AVC'} render through the product owner and retire on pause`, async ({ page }, info) => {
    const errors = captureProblems(page)
    await createProject(page, count, proxies)
    await expect(page).toHaveTitle(/Myrelith/)
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await start(page)
    await expect(page.locator('.multicam-angle-canvas[data-live="true"]')).toHaveCount(count - 1)
    await page.waitForTimeout(4200)
    const live = await diagnostics(page)
    expect(live.presentation.phase, JSON.stringify(live)).toBe('live')
    expect(live.admission.monitorOwners).toBe(1)
    expect(live.worker.ledger.peakDecoders).toBeLessThanOrEqual(count - 1)
    expect(live.worker.ledger.peakFrameBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    await info.attach('live-ownership', { body: JSON.stringify(live), contentType: 'application/json' })
    if (count === 8) await page.screenshot({ path: '/private/tmp/issue195-live-desktop.png' })
    if (count === 2) {
      await page.getByRole('checkbox', { name: 'Live angle previews' }).uncheck()
      await expect.poll(async () => (await diagnostics(page)).admission.monitorOwners).toBe(0)
      const closed = await diagnostics(page)
      expect(closed.lastCleanup.forced).toBe(false)
      expect(closed.lastCleanup.ledger).toMatchObject({ inputs: 0, nativeDecoders: 0, nativeFrames: 0, scratchSurfaces: 0 })
      expect(closed.lastCleanup.ledger.createdDecoders).toBe(closed.lastCleanup.ledger.closedDecoders)
      await info.attach('cooperative-close', { body: JSON.stringify(closed), contentType: 'application/json' })
    }
    await playback(page, 'pauseAndDrainPlayback')
    const stopped = await diagnostics(page)
    expect(stopped.admission.monitorOwners).toBe(0); expect(stopped.surfacePixels).toBe(0)
    expect(stopped.worker).toBeNull(); expect(stopped.lastCleanup.workers).toBe(0)
    expect(stopped.lastCleanup.unclosedReceivedBitmaps).toBe(0)
    expect(errors).toEqual([])
  })
}
