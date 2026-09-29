import { expect, test, type Page } from '@playwright/test'

// Chromium's fake camera/microphone and an auto-selected browser tab stand in
// for real devices and the native share chooser. Output stays muted.
test.use({
  launchOptions: { args: ['--mute-audio', '--use-fake-device-for-media-stream',
    '--auto-select-tab-capture-source-by-title=Capture Target'] },
  permissions: ['camera', 'microphone'],
})

function collectProblems(page: Page, problems: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') problems.push(`${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
}

async function createProject(page: Page): Promise<void> {
  // The decode checks find the app's own pre-bundled Mediabunny in resource
  // timing. It now loads lazily, after the dev server's first 250 module
  // requests would have filled Chromium's default resource-timing buffer.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5_000))
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Capture QA')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
}

/** The ordinary import path asks about a frame-rate mismatch; keep the project rate. */
async function acceptImportTiming(page: Page): Promise<void> {
  const keep = page.getByRole('button', { name: /^Keep \d+(\.\d+)? fps$/ })
  await keep.waitFor({ timeout: 15_000 }).then(() => keep.click(), () => {})
}

async function openTab(page: Page, name: 'Camera' | 'Screen') {
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Record' })
  await panel.getByRole('tab', { name }).click()
  return panel
}

function captureAssets(page: Page) {
  return page.evaluate(() => {
    const stores = (window as unknown as { __stores: { media: { getState(): { assets: Map<string, {
      fileName: string; kind: string; hasAudio: boolean; durationFrames: number; width: number | null }> } } } }).__stores
    return [...stores.media.getState().assets.values()].filter((asset) => asset.fileName.startsWith('capture_'))
      .map(({ fileName, kind, hasAudio, durationFrames, width }) => ({ fileName, kind, hasAudio, durationFrames, width }))
  })
}

function captureFiles(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    try {
      const directory = await root.getDirectoryHandle('myrelith-captures-v1')
      const names: string[] = []
      for await (const entry of (directory as unknown as { values(): AsyncIterable<{ name: string }> }).values()) names.push(entry.name)
      return names.sort()
    } catch { return [] }
  })
}

test('camera: record, stop, and keep an A/V take in the Media Pool', async ({ page }) => {
  const problems: string[] = []
  collectProblems(page, problems)
  await createProject(page)
  const panel = await openTab(page, 'Camera')
  await panel.getByRole('button', { name: 'Record camera' }).click()
  await expect(page.getByRole('button', { name: /^REC \d+:\d\d\.\d$/ })).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByLabel('Live preview of the recording')).toBeVisible()
  await page.waitForFunction(() => /0:0[3-9]/.test(document.querySelector('.voiceover-elapsed')?.textContent ?? ''),
    undefined, { timeout: 15_000 })
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByRole('status')).toContainText('Recording ready to review', { timeout: 15_000 })
  await panel.getByRole('button', { name: 'Keep in Media Pool' }).click()
  await acceptImportTiming(page)
  await expect(panel.getByRole('status')).toContainText('Saved to the Media Pool', { timeout: 20_000 })
  const [asset] = await captureAssets(page)
  expect(asset).toMatchObject({ kind: 'video', hasAudio: true, width: 1280 })
  // About three seconds at 30 fps.
  expect(asset!.durationFrames).toBeGreaterThanOrEqual(80)
  expect(await captureFiles(page)).toEqual([asset!.fileName])

  // The kept take is ordinary media: place it, play it, and decode it.
  const problemsBeforeDecode = problems.length
  const playback = await page.evaluate(async () => {
    const stores = (window as unknown as { __stores: Record<string, { getState(): Record<string, unknown> }> }).__stores
    const media = stores.media.getState() as { assets: Map<string, { id: string; fileName: string }> }
    const kept = [...media.assets.values()].find((candidate) => candidate.fileName.startsWith('capture_'))!
    const placementPath = '/src/app/mediaPlacementController.ts'
    const transportPath = '/src/app/transportController.ts'
    const previewStatusPath = '/src/state/previewStatusStore.ts'
    const { placeImportedAsset } = await import(placementPath)
    const { togglePlayback } = await import(transportPath)
    const { usePreviewStatusStore } = await import(previewStatusPath)
    const doc = (stores.document.getState() as { doc: { id: string } }).doc
    const placed = placeImportedAsset(doc.id, kept.id, 'V1', 0)
    togglePlayback()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    togglePlayback()
    const playhead = (stores.transport.getState() as { playheadFrame: number }).playheadFrame
    const renderError = usePreviewStatusStore.getState().renderError
    // The app's own pre-bundled Mediabunny (same instance, no duplicate load).
    const mediabunnyPath = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((name) => /\/deps\/mediabunny\.js/.test(name))!
    const { ALL_FORMATS, BlobSource, Input, VideoSampleSink } = await import(mediabunnyPath)
    const root = await navigator.storage.getDirectory()
    const file = await (await (await root.getDirectoryHandle('myrelith-captures-v1')).getFileHandle(kept.fileName)).getFile()
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const track = (await input.getPrimaryVideoTrack())!
    const duration = await track.computeDuration()
    const sink = new VideoSampleSink(track)
    const decoded: number[] = []
    for (const time of [0, duration / 2, duration - 0.05]) {
      const sample = await sink.getSample(time)
      if (sample) { decoded.push(sample.timestamp); sample.close() }
    }
    return { placed: placed.status, playhead, renderError, decoded }
  })
  expect(playback.placed).toBe('placed')
  expect(playback.playhead).toBeGreaterThan(20)
  expect(playback.renderError).toBeNull()
  expect(playback.decoded).toHaveLength(3)
  expect(problemsBeforeDecode).toBe(0)
  expect(problems).toEqual([])
})

test('screen: closing the shared tab ends the take for review; Discard deletes it', async ({ page, context }) => {
  await createProject(page)
  const target = await context.newPage()
  await target.setContent('<title>Capture Target</title><div id=b style="width:400px;height:300px;background:red"></div>' +
    '<script>let f=0;setInterval(()=>{b.style.background=(f++%2)?"red":"blue"},60)</script>')
  await page.bringToFront()
  const panel = await openTab(page, 'Screen')
  await panel.getByRole('button', { name: 'Choose screen and record' }).click()
  await expect(panel.getByRole('status')).toContainText('Recording', { timeout: 15_000 })
  await expect(panel.getByText('Browser tab', { exact: true })).toBeVisible()
  await page.waitForTimeout(2_000)
  await target.close() // the shared source goes away, like "Stop sharing"
  await expect(panel.getByRole('status')).toContainText('Recording ready to review', { timeout: 15_000 })
  await expect(panel.getByText(/Sharing or the camera stopped/)).toBeVisible()
  expect((await captureFiles(page)).length).toBe(1)
  await panel.getByRole('button', { name: 'Discard' }).click()
  await expect(panel.getByRole('status')).toContainText('Recording discarded', { timeout: 10_000 })
  expect(await captureFiles(page)).toEqual([])
})

test('a camera take cut off by a reload is recovered from its complete fragments', async ({ page }) => {
  await createProject(page)
  const panel = await openTab(page, 'Camera')
  await panel.getByRole('button', { name: 'Record camera' }).click()
  await page.waitForFunction(() => /0:0[3-9]/.test(document.querySelector('.voiceover-elapsed')?.textContent ?? ''),
    undefined, { timeout: 20_000 })
  await page.reload()
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Capture recovery')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  const entry = page.getByRole('button', { name: 'Record, 1 recording drafts to recover' })
  await expect(entry).toBeVisible({ timeout: 15_000 })
  expect(await captureAssets(page)).toEqual([])
  await entry.click()
  const recovery = page.getByRole('dialog', { name: 'Record' })
  await recovery.getByRole('button', { name: 'Recover' }).click()
  await acceptImportTiming(page)
  await expect(recovery.getByText('Draft recovered into the Media Pool.')).toBeVisible({ timeout: 20_000 })
  const [asset] = await captureAssets(page)
  expect(asset).toMatchObject({ kind: 'video', hasAudio: true })
  expect(asset!.durationFrames).toBeGreaterThanOrEqual(30)
})

test('a static shared tab with a microphone keeps writing to disk and holds its last picture', async ({ page, context }) => {
  await createProject(page)
  const target = await context.newPage()
  // Never changes after the first paint: the capture may deliver almost no frames.
  await target.setContent('<title>Capture Target</title><h1 style="font:48px sans-serif">Static slide</h1>')
  await page.bringToFront()
  const panel = await openTab(page, 'Screen')
  await panel.getByLabel('Microphone', { exact: true }).check()
  await panel.getByRole('button', { name: 'Choose screen and record' }).click()
  await expect(panel.getByRole('status')).toContainText('Recording', { timeout: 15_000 })
  const readProgress = () => page.evaluate(async () => {
    const storePath = '/src/state/avCaptureStore.ts'
    const { useAvCaptureStore } = await import(storePath)
    const progress = useAvCaptureStore.getState().progress as { bytes: number; durationUs: number } | null
    return progress ? { bytes: progress.bytes, durationUs: progress.durationUs } : { bytes: 0, durationUs: 0 }
  })
  const progressAt = async (seconds: number) => {
    let latest = { bytes: 0, durationUs: 0 }
    await expect.poll(async () => { latest = await readProgress(); return latest.durationUs },
      { timeout: 20_000 }).toBeGreaterThanOrEqual(seconds * 1_000_000)
    return latest
  }
  const early = await progressAt(2)
  const later = await progressAt(5)
  // Fragments keep reaching disk while the picture is static (bounded memory, crash-safe).
  expect(later.bytes).toBeGreaterThan(early.bytes)
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByRole('status')).toContainText('Recording ready to review', { timeout: 15_000 })
  const reopened = await page.evaluate(async () => {
    const mediabunnyPath = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((name) => /\/deps\/mediabunny\.js/.test(name))!
    const { ALL_FORMATS, BlobSource, Input } = await import(mediabunnyPath)
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('myrelith-captures-v1')
    let file: File | null = null
    for await (const entry of (directory as unknown as { values(): AsyncIterable<FileSystemFileHandle> }).values()) file = await entry.getFile()
    const input = new Input({ source: new BlobSource(file!), formats: ALL_FORMATS })
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    return { video: await video?.computeDuration(), audio: await audio?.computeDuration() }
  })
  // The last picture is held to the end, matching the narration.
  expect(reopened.audio).toBeGreaterThan(4.5)
  expect(reopened.video).toBeGreaterThan(4.5)
  expect(Math.abs(reopened.video! - reopened.audio!)).toBeLessThan(1.1)
  await panel.getByRole('button', { name: 'Discard' }).click()
  await expect(panel.getByRole('status')).toContainText('Recording discarded', { timeout: 10_000 })
})
