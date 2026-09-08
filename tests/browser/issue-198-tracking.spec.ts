import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { observePresentations, presentedAction } from './issue-198-presentation-fixture.js'

const filename = 'Mask tracking source.mp4'
const clipId = 'mask-tracking-source'
const previewLabel = 'Preview accepted mask tracking at the playhead'
const luminance = (rgba: number[]) => rgba[0]! + rgba[1]! + rgba[2]!

test.afterEach(async ({ page }, testInfo) => {
  if (page.isClosed()) return
  const diagnostics = await page.evaluate(() => {
    const probe = window.__issue198Presentation
    try { return { records: probe?.records ?? [], check: probe?.lastCheck ?? null } } finally { probe?.dispose(); delete window.__issue198Presentation }
  })
  await testInfo.attach('program-presentations', { body: JSON.stringify(diagnostics.records, null, 2), contentType: 'application/json' })
  await testInfo.attach('program-presentation-check', { body: JSON.stringify(diagnostics.check, null, 2), contentType: 'application/json' })
})

function snapshot(page: Page) {
  return page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts'
    const { project, doc, past, future } = (await import(d)).useDocumentStore.getState()
    const transport = (await import(t)).useTransportStore.getState()
    return { project, clip: doc.tracks[0].clips[0], past: past.length, future: future.length,
      preview: transport.effectDocumentPreview?.owner ?? null, frame: transport.playheadFrame }
  })
}
async function seek(page: Page, frame: number) {
  await presentedAction(page, frame, () => page.evaluate(async (value) => {
    const t = '/src/state/transportStore.ts', transport = (await import(t)).useTransportStore
    window.__issue198Presentation!.mark(); transport.getState().setPlayheadFrame(value)
  }, frame), { allowCurrent: true })
  await expect.poll(async () => (await snapshot(page)).frame).toBe(frame)
}
async function history(page: Page, operation: 'undo' | 'redo') {
  const frame = (await snapshot(page)).frame
  await presentedAction(page, frame, () => page.evaluate(async (key) => {
    const d = '/src/state/documentStore.ts', document = (await import(d)).useDocumentStore
    window.__issue198Presentation!.mark(); document.getState()[key]()
  }, operation))
}
async function visualAction(page: Page, action: () => Promise<unknown>, event: 'click' | 'change' = 'click') {
  await presentedAction(page, (await snapshot(page)).frame, action, { event })
}
async function pixel(page: Page) {
  return page.getByTestId('preview-canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement, sample = new OffscreenCanvas(1, 1), ctx = sample.getContext('2d')!
    try {
      // Inside the static mask, outside its translated frame-17 edge, and well
      // away from the AVC edge tolerance. Source is centered at native size.
      ctx.drawImage(canvas, 584 / 1280 * canvas.width, 350 / 720 * canvas.height, 1, 1, 0, 0, 1, 1)
      return [...ctx.getImageData(0, 0, 1, 1).data]
    } finally { sample.width = sample.height = 0 }
  })
}
async function resources(page: Page) {
  return page.evaluate(async () => {
    const runtime = '/src/app/motionAnalysisRuntime.ts', worker = '/src/app/motionAnalysisWorkerBridge.ts'
    return { scheduler: (await import(runtime)).getMotionAnalysisController()?.snapshot().scheduler ?? null,
      workers: (await import(worker)).getMotionAnalysisWorkerDiagnostics() }
  })
}
async function expectTrackingIdle(page: Page) {
  await expect.poll(async () => {
    const { scheduler, workers } = await resources(page)
    return [scheduler?.activeJobCount ?? 0, scheduler?.activeDecoderCount ?? 0, workers.activeWorkers]
  }).toEqual([0, 0, 0])
  const result = await resources(page)
  expect(result.scheduler?.maxActiveJobCount ?? 0).toBeLessThanOrEqual(1)
  expect(result.scheduler?.maxActiveDecoderCount ?? 0).toBeLessThanOrEqual(1)
  expect(result.workers.workersCreated).toBeGreaterThan(0)
  expect(result.workers.workersTerminated).toBe(result.workers.workersCreated)
  return result
}
async function setup(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) problems.push(message.text()) })
  // Explicitly qualify the portable download/file-input path, not native handles.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Mask tracking QA')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  await observePresentations(page)
  const bytes = await page.evaluate(async ({ name, id }) => {
    const fixture = '/src/dev/issue198/maskTrackingFixture.ts', importer = '/src/app/mediaImportController.ts'
    const media = '/src/state/mediaStore.ts', d = '/src/state/documentStore.ts'
    const o = '/src/domain/operations.ts', t = '/src/state/transportStore.ts'
    const blob = await (await import(fixture)).maskTrackingVideo()
    const file = new File([blob], name, { type: 'video/mp4', lastModified: 1_100 })
    const result = await (await import(importer)).importMedia(file)
    if (result.status !== 'imported') throw new Error(JSON.stringify(result))
    const asset = (await import(media)).useMediaStore.getState().assets.get(result.assetId)
    if (!asset || asset.width !== 160 || asset.height !== 90 || asset.hasAudio || asset.kind !== 'video') throw new Error('Unexpected source probe')
    const clip = (await import(o)).clipFromAssetRange(asset, 0, 0, 32)
    clip.id = id; clip.name = 'Tracking source'
    const store = (await import(d)).useDocumentStore
    store.getState().insertClips([{ trackId: store.getState().doc.tracks[0].id, clip }])
    const transport = (await import(t)).useTransportStore.getState()
    transport.setSelectedClip(id); transport.setPlayheadFrame(0)
    return [...new Uint8Array(await blob.arrayBuffer())]
  }, { name: filename, id: clipId })
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
  await page.getByRole('button', { name: 'Add rectangle mask', exact: true }).click()
  for (const [parameter, value] of Object.entries({ x: '45', y: '44', width: '8', height: '10' })) {
    const input = page.locator(`[data-testid^="inspector-effect-mask-${parameter}-"]`)
    await input.fill(value); await input.press('Enter')
  }
  await page.getByRole('tab', { name: 'Animation', exact: true }).click()
  const editor = page.locator('.motion-tracking-editor')
  await editor.getByRole('combobox', { name: 'Attach tracking to', exact: true }).selectOption('mask-effect')
  await expect(editor.getByLabel('Mask tracking target')).toHaveValue(JSON.stringify([clipId, (await snapshot(page)).clip.effects[0].id]))
  await expect(editor.getByText(/keys interpolate linearly between accepted samples/)).toBeVisible()
  await seek(page, 0)
  return { problems, sourceFile: { name: filename, mimeType: 'video/mp4', buffer: Buffer.from(bytes) }, editor }
}
async function pick(page: Page, box = false) {
  const editor = page.locator('.motion-tracking-editor')
  await editor.getByRole('button', { name: box ? 'Draw box' : 'Pick point', exact: true }).click()
  const surface = page.getByRole('button', { name: box ? 'Drag a box to track in the source clip' : 'Choose a point to track in the source clip', exact: true })
  await expect(surface).toBeVisible()
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!
  const position = (x: number, y: number) => ({ x: canvas.x + (560 + x) / 1280 * canvas.width, y: canvas.y + (315 + y) / 720 * canvas.height })
  if (box) {
    const start = position(67, 20), end = position(117, 70)
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
  } else {
    const center = position(80, 45); await page.mouse.click(center.x, center.y)
  }
}
async function analyze(page: Page, stop: string) {
  const editor = page.locator('.motion-tracking-editor')
  await editor.getByRole('button', { name: 'Analyze', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Apply mask tracking', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect(editor.locator('dt').filter({ hasText: /^Accepted samples$/ }).locator('..').locator('dd')).toHaveText('18')
  await expect(editor.locator('dt').filter({ hasText: /^Stop$/ }).locator('..').locator('dd')).toHaveText(stop)
  await expectTrackingIdle(page)
}

test('real point tracking previews, applies once, saves/reopens through UI and matches decoded export', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const { problems, sourceFile, editor } = await setup(page)
  await pick(page)
  await expect(editor.getByText('Selection pinned to project frame 0.')).toBeVisible()
  await analyze(page, 'Frame 18')
  const before = await snapshot(page)
  await seek(page, 17)
  await expect.poll(async () => luminance(await pixel(page))).toBeGreaterThan(30)
  const staticPixel = await pixel(page)
  await visualAction(page, () => editor.getByLabel(previewLabel).check())
  await expect.poll(async () => (await snapshot(page)).preview).toBe('mask-tracking')
  expect((await snapshot(page)).project).toEqual(before.project)
  expect((await snapshot(page)).past).toBe(before.past)
  await expect.poll(async () => luminance(await pixel(page))).toBeLessThan(8)
  await seek(page, 18); expect((await snapshot(page)).preview).toBeNull()
  await seek(page, 17); expect((await snapshot(page)).preview).toBe('mask-tracking')
  await visualAction(page, () => editor.getByLabel(previewLabel).uncheck())
  await expect.poll(() => pixel(page)).toEqual(staticPixel)
  await visualAction(page, () => editor.getByLabel(previewLabel).check())
  await visualAction(page, () => editor.getByRole('button', { name: 'Apply mask tracking', exact: true }).click())
  const after = await snapshot(page)
  expect(after.past).toBe(before.past + 1); expect(after.preview).toBeNull()
  const tracks = after.clip.animation.effectTracks
  expect(tracks.map((track: { parameter: string }) => track.parameter)).toEqual(['x', 'y'])
  for (const track of tracks) expect(track.keyframes.map((key: { frame: number; sourceTimeTicks: number }) => [key.frame, key.sourceTimeTicks])).toEqual(Array.from({ length: 18 }, (_, frame) => [frame, frame * 1_000_000]))
  expect((tracks[0].keyframes[17].value - tracks[0].keyframes[0].value) * 1280).toBeGreaterThan(13)
  expect((tracks[0].keyframes[17].value - tracks[0].keyframes[0].value) * 1280).toBeLessThan(21)
  await expect(editor.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  await history(page, 'undo'); expect((await snapshot(page)).project).toEqual(before.project)
  await expect.poll(() => pixel(page)).toEqual(staticPixel)
  await history(page, 'redo'); expect((await snapshot(page)).project).toEqual(after.project)
  await expect.poll(async () => luminance(await pixel(page))).toBeLessThan(8)
  await page.screenshot({ path: testInfo.outputPath('tracking-point-applied.png') })

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const download = await downloadPromise, downloadName = download.suggestedFilename()
  expect(downloadName).toMatch(/\.myrelith$/)
  // Playwright's internal download path has a UUID basename. Reopen the real
  // downloaded bytes under the portable filename offered by the Save action.
  const downloadPath = testInfo.outputPath(downloadName)
  await download.saveAs(downloadPath)
  const serialized = await readFile(downloadPath, 'utf8')
  expect(serialized).not.toMatch(/blob:|cacheKey|fingerprint|decodePolicy/)
  const downloadedTracks = await page.evaluate(async (text) => {
    const p = '/src/domain/projectFile.ts'
    const parsed = (await import(p)).parseProjectFile(text)
    return parsed.sequences[0].tracks[0].clips[0].animation.effectTracks
  }, serialized)
  expect(downloadedTracks).toEqual(tracks)
  page.on('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  await page.getByLabel('Choose a Myrelith project file', { exact: true }).setInputFiles(downloadPath)
  await presentedAction(page, 0, () => page.getByRole('button', { name: 'Open with 1 offline', exact: true }).click(), { event: 'click', connected: false })
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  expect((await snapshot(page)).clip.animation.effectTracks).toEqual(tracks)
  expect((await snapshot(page)).past).toBe(0)
  await presentedAction(page, 0, () => page.getByLabel(`Relink ${filename}`, { exact: true }).setInputFiles(sourceFile), { event: 'change' })
  await expect.poll(() => page.evaluate(async () => {
    const m = '/src/state/mediaStore.ts'
    return [...(await import(m)).useMediaStore.getState().assets.values()].some((asset: { objectUrl: string | null }) => !!asset.objectUrl)
  })).toBe(true)
  await seek(page, 17)
  await expect.poll(async () => luminance(await pixel(page))).toBeLessThan(8)
  await seek(page, 0)
  await expect.poll(async () => luminance(await pixel(page))).toBeGreaterThan(30)
  const program0 = await pixel(page)

  const exported = await page.evaluate(async () => {
    const e = '/src/app/exportController.ts', p = '/src/domain/exportProfile.ts', m = '/node_modules/.vite/deps/mediabunny.js'
    const { startExport, disposeExport } = await import(e), { DEFAULT_EXPORT_PROFILE } = await import(p)
    const { Input, BlobSource, ALL_FORMATS, VideoSampleSink } = await import(m)
    let input, canvas: OffscreenCanvas | undefined
    try {
      const result = await startExport({ ...DEFAULT_EXPORT_PROFILE, videoBitrate: 2_000_000, audioCodec: null, audioChannelLayout: 'off', audioBitrate: null, audioBitrateMode: null })
      if (!result || result.destination !== 'download') throw new Error('No buffered export')
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([result.buffer], { type: result.mimeType })) })
      const video = await input.getPrimaryVideoTrack()
      if (!video) throw new Error('No exported video')
      canvas = new OffscreenCanvas(video.displayWidth, video.displayHeight)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!, sink = new VideoSampleSink(video), pixels: number[][] = []
      for (const frame of [0, 17, 31]) {
        const sample = await sink.getSample(frame / 30)
        if (!sample) throw new Error(`No exported frame ${frame}`)
        try {
          const image = sample.toVideoFrame()
          try { ctx.drawImage(image, 0, 0) } finally { image.close() }
          pixels.push([...ctx.getImageData(584, 350, 1, 1).data])
        } finally { sample.close() }
      }
      return { bytes: result.buffer.byteLength, duration: await input.computeDuration(), width: video.displayWidth, height: video.displayHeight, hasAudio: !!await input.getPrimaryAudioTrack(), pixels }
    } finally { if (canvas) canvas.width = canvas.height = 0; input?.dispose(); await disposeExport() }
  })
  expect(exported.width).toBe(1280); expect(exported.height).toBe(720); expect(exported.hasAudio).toBe(false)
  expect(exported.bytes).toBeGreaterThan(1_000); expect(exported.duration).toBeCloseTo(32 / 30, 2)
  expect(luminance(exported.pixels[0]!)).toBeGreaterThan(30)
  expect(luminance(exported.pixels[1]!)).toBeLessThan(36)
  expect(luminance(exported.pixels[2]!)).toBeLessThan(36)
  const idle = await expectTrackingIdle(page)
  await page.screenshot({ path: testInfo.outputPath('tracking-reopened.png') })
  await testInfo.attach('tracking-export-and-resources', { body: JSON.stringify({ staticPixel, program0, exported, idle }, null, 2), contentType: 'application/json' })
  expect(problems).toEqual([])
})

test('real backward box tracking exposes size and exact replacement consent and disposes abandoned preview', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const { problems, editor } = await setup(page)
  await seek(page, 17)
  await editor.getByRole('combobox', { name: 'Direction', exact: true }).selectOption('backward')
  await pick(page, true)
  await expect(editor.getByText('Selection pinned to project frame 17.')).toBeVisible()
  await analyze(page, 'Clip boundary')
  await expect(editor.getByText('Box size uses project-axis bounds. The mask does not follow rotation.')).toBeVisible()
  const before = await snapshot(page)
  await visualAction(page, () => editor.getByLabel(previewLabel).check())
  expect((await snapshot(page)).project).toEqual(before.project)
  await visualAction(page, () => editor.getByRole('button', { name: 'Apply mask tracking' }).click())
  const after = await snapshot(page)
  expect(after.past).toBe(before.past + 1)
  const tracks = after.clip.animation.effectTracks
  expect(tracks.map((track: { parameter: string }) => track.parameter)).toEqual(['x', 'y', 'width', 'height'])
  for (const track of tracks) expect(track.keyframes.map((key: { frame: number; sourceTimeTicks: number }) => [key.frame, key.sourceTimeTicks])).toEqual(Array.from({ length: 18 }, (_, frame) => [frame, frame * 1_000_000]))
  expect(tracks[0].keyframes[17].value).toBeCloseTo(0.45, 6)
  expect(tracks[2].keyframes[17].value).toBeCloseTo(0.08, 6)
  await history(page, 'undo'); expect((await snapshot(page)).project).toEqual(before.project)
  await history(page, 'redo'); expect((await snapshot(page)).project).toEqual(after.project)

  // A fresh analysis is necessary after same-source Apply; the old UI session
  // cannot be reused. Existing ordinary tracks now require complete-lane consent.
  await editor.getByRole('button', { name: 'Analyze', exact: true }).click()
  const replacement = editor.getByLabel('Replace all Left, Top, Width and Height keys on Tracking source · Mask 1 (source clip), including keys outside the accepted range', { exact: true })
  await expect(replacement).toBeVisible({ timeout: 30_000 })
  await expect(editor.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  await replacement.check()
  await expect(editor.getByRole('button', { name: 'Apply mask tracking' })).toBeEnabled()
  await editor.getByLabel('Track mask size (Width and Height)', { exact: true }).uncheck()
  const positionConsent = editor.getByLabel('Replace all Left and Top keys on Tracking source · Mask 1 (source clip), including keys outside the accepted range', { exact: true })
  await expect(positionConsent).not.toBeChecked()
  await expect(editor.getByRole('button', { name: 'Apply mask tracking' })).toBeDisabled()
  await positionConsent.check(); await visualAction(page, () => editor.getByLabel(previewLabel).check())
  await seek(page, 18); expect((await snapshot(page)).preview).toBeNull()
  await seek(page, 17); expect((await snapshot(page)).preview).toBe('mask-tracking')
  await page.screenshot({ path: testInfo.outputPath('tracking-box-review.png') })
  await visualAction(page, () => editor.getByRole('combobox', { name: 'Attach tracking to', exact: true }).selectOption('clip-transform'), 'change')
  expect((await snapshot(page)).preview).toBeNull()
  expect((await snapshot(page)).project).toEqual(after.project)
  const idle = await expectTrackingIdle(page)
  await testInfo.attach('tracking-box-resources', { body: JSON.stringify(idle, null, 2), contentType: 'application/json' })
  expect(problems).toEqual([])
})
