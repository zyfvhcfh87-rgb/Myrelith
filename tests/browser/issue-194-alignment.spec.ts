import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { encodeAlignmentMedia } from './fixtures/alignment-media.js'

test.setTimeout(120_000)
test.use({ actionTimeout: 10_000 })
async function createProject(page: Page, kind: 'noise' | 'repeated' | 'speech' = 'noise', speechBase64?: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Multicam alignment QA')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  const first = await page.evaluate(encodeAlignmentMedia, { kind, offset: 0, seconds: 14, timecode: 108000, speechBase64 })
  const second = await page.evaluate(encodeAlignmentMedia, { kind, offset: 0.75, seconds: 12, timecode: 108023, speechBase64 })
  // Use the actual import facade, including descriptor/source-bound probing.
  await page.evaluate(async ({ first, second }) => {
    const importerPath = '/src/app/mediaImportController.ts'
    const { importMedia } = await import(importerPath)
    for (const [index, data] of [first, second].entries()) {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
      const result = await importMedia(new File([bytes], `Camera ${index + 1}.mp4`, { type: 'video/mp4', lastModified: 194 }))
      if (result.status !== 'imported') throw new Error(JSON.stringify(result))
    }
  }, { first, second })
  await page.getByRole('button', { name: 'New multicam' }).click()
  await page.getByRole('button', { name: 'Create multicam' }).click()
  await page.getByText('Align by audio or timecode', { exact: true }).click()
  return { first, second }
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/state/documentStore.ts'
    const { useDocumentStore } = await import(path)
    const { project, past } = useDocumentStore.getState()
    return { project, history: past.length }
  })
}
function problems(page: Page) {
  const all: string[] = []
  page.on('pageerror', (error) => all.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) all.push(message.text()) })
  return all
}
async function analyze(page: Page) {
  await page.getByRole('button', { name: 'Analyze alignment', exact: true }).click()
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/state/multicamAlignmentStore.ts'
    return ['ready', 'error', 'stale', 'cancelled'].includes((await import(path)).useMulticamAlignmentStore.getState().phase)
  }), { timeout: 45_000 }).toBe(true)
  const state = await page.evaluate(async () => {
    const path = '/src/state/multicamAlignmentStore.ts'
    return (await import(path)).useMulticamAlignmentStore.getState()
  })
  expect(state.phase, state.detail).toBe('ready')
  await expect(page.getByText('Review offsets in frames. Analysis has not changed the project.', { exact: true })).toBeVisible({ timeout: 45_000 })
}
test('real AAC audio and encoded timecode propose ordinary offsets with cache, correction and atomic history', async ({ page }, testInfo) => {
  const errors = problems(page)
  await createProject(page)
  expect(page.url()).toContain('127.0.0.1:41732')
  await expect(page).toHaveTitle(/Myrelith/)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  const before = await snapshot(page)
  await analyze(page)
  expect(await snapshot(page)).toEqual(before)
  const offset = page.getByLabel('Proposed offset for Camera 2.mp4 (frames)')
  await expect(offset).toHaveValue('23')
  await offset.fill('24')
  const undersized = await page.locator('.multicam-alignment').locator('button, input, select, summary')
    .evaluateAll((elements) => elements.filter((element) => {
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height || (rect.width >= 24 && rect.height >= 24)) return false
      const label = element.closest('label')?.getBoundingClientRect()
      return !label || label.width < 24 || label.height < 24
    }).map((element) => element.getAttribute('aria-label') ?? element.textContent))
  expect(undersized).toEqual([])
  await page.getByRole('button', { name: 'Apply reviewed offsets' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/issue194-review-desktop.png' })
  await page.getByRole('button', { name: 'Apply reviewed offsets' }).click()
  const after = await snapshot(page)
  expect(after.history).toBe(before.history + 1)
  expect(after.project.multicams[0].angles[1].coverage.startFrame).toBe(24)
  await page.evaluate(async () => { const p = '/src/state/documentStore.ts'; (await import(p)).useDocumentStore.getState().undo() })
  expect((await snapshot(page)).project).toEqual(before.project)
  await page.evaluate(async () => { const p = '/src/state/documentStore.ts'; (await import(p)).useDocumentStore.getState().redo() })
  expect((await snapshot(page)).project).toEqual(after.project)
  await analyze(page)
  await expect(page.getByText('2 source windows reused from local cache.')).toBeVisible()
  await page.getByLabel('Window start for Camera 2.mp4 (seconds)').fill('1.005')
  await analyze(page)
  await expect(page.getByText('1 source window reused from local cache.')).toBeVisible()
  await page.getByRole('combobox', { name: 'Alignment method', exact: true }).selectOption('timecode')
  await expect(page.getByRole('button', { name: 'Analyze alignment', exact: true })).toBeDisabled()
  await page.getByLabel('These recordings share a timecode clock and calendar day, with no midnight crossing.').check()
  await analyze(page)
  await expect(offset).toHaveValue('23')
  await expect(page.getByText('Non-drop timecode 01:00:00:23')).toBeVisible()
  await page.setViewportSize({ width: 720, height: 800 })
  await offset.scrollIntoViewIfNeeded()
  const overflow = await page.locator('.multicam-alignment').evaluate((element) => element.scrollWidth > element.clientWidth + 1)
  expect(overflow).toBe(false)
  await page.screenshot({ path: '/private/tmp/issue194-review-720.png' })
  await page.getByRole('button', { name: 'Apply reviewed offsets' }).click()
  const diagnostics = await page.evaluate(async () => {
    const path = '/src/app/multicamAlignmentController.ts'
    return (await import(path)).multicamAlignmentDiagnostics()
  })
  expect(diagnostics.maxActiveDecoderCount).toBe(1)
  expect(diagnostics.activeDecoderCount).toBe(0)
  expect(diagnostics.activeJobCount).toBe(0)
  await testInfo.attach('alignment-diagnostics', { body: JSON.stringify(diagnostics), contentType: 'application/json' })
  expect(errors).toEqual([])
})
test('repeated decoded audio stays in review without applicable offsets; cancel and clear preserve the project', async ({ page }) => {
  const errors = problems(page)
  await createProject(page, 'repeated')
  const before = await snapshot(page)
  await analyze(page)
  await expect(page.getByText('Repeated events produce more than one plausible match')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply reviewed offsets' })).toBeDisabled()
  expect(await snapshot(page)).toEqual(before)
  await page.getByRole('button', { name: 'Cancel alignment' }).click()
  await page.getByRole('button', { name: 'Analyze alignment', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel alignment' }).click()
  await expect(page.getByText('Alignment cancelled. Manual offsets remain available.')).toBeVisible()
  const cleared = await page.evaluate(async () => {
    const registryPath = '/src/app/localDerivedStorage.ts', storagePath = '/src/app/analysisStorage.ts'
    await (await import(registryPath)).localDerivedStorage.clear()
    return (await (await import(storagePath)).analysisStorage.readManifest()).entries.length
  })
  expect(cleared).toBe(0)
  expect(await snapshot(page)).toEqual(before)
  const target = page.locator('.multicam-angle-card').filter({ has: page.getByRole('button', { name: 'Cut to Camera 2.mp4', exact: true }) })
  await target.getByText('Edit', { exact: true }).click()
  await target.getByLabel('Start offset (frames)').fill('12')
  await target.getByRole('button', { name: 'Apply angle', exact: true }).click()
  expect((await snapshot(page)).project.multicams[0].angles[1].coverage.startFrame).toBe(12)
  expect(errors).toEqual([])
})
test('recorded LibriSpeech AAC windows resolve within one project frame', async ({ page }) => {
  test.skip(!process.env.ISSUE194_SPEECH_WAV, 'Set ISSUE194_SPEECH_WAV to the documented recorded fixture')
  const errors = problems(page)
  await createProject(page, 'speech', readFileSync(process.env.ISSUE194_SPEECH_WAV!).toString('base64'))
  await analyze(page)
  const value = Number(await page.getByLabel('Proposed offset for Camera 2.mp4 (frames)').inputValue())
  expect(Math.abs(value - 23)).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})

test('applied offsets survive portable save, real export and IndexedDB recovery', async ({ page }, testInfo) => {
  const errors = problems(page)
  await createProject(page)
  await analyze(page)
  await page.getByRole('button', { name: 'Apply reviewed offsets' }).click()
  const saved = await page.evaluate(async () => {
    const documentPath = '/src/state/documentStore.ts', mediaPath = '/src/state/mediaStore.ts'
    const filePath = '/src/domain/projectFile.ts', planPath = '/src/domain/projectVideoCompositionPlan.ts', boundsPath = '/src/domain/crossfadePlan.ts'
    const { useDocumentStore } = await import(documentPath)
    const { useMediaStore } = await import(mediaPath)
    const { createProjectFileSnapshot, serializeProjectFile, parseProjectFile } = await import(filePath)
    const state = useDocumentStore.getState(), definition = state.project.multicams[0]
    const instance = state.doc.tracks.filter((track: { kind: string }) => track.kind === 'video')
      .flatMap((track: { multicamInstances?: { id: string }[] }) => track.multicamInstances ?? [])[0]
    if (!instance || !state.editMulticamInstance({ kind: 'trim', instanceId: instance.id,
      timelineRange: { startFrame: 0, durationFrames: 60 }, sourceStartFrame: 0 })) throw new Error('Fixture trim failed')
    if (!useDocumentStore.getState().editMulticamDefinition({ kind: 'cut', definitionId: definition.id,
      frame: 30, angleId: definition.angles[1].id })) throw new Error('Fixture cut failed')
    const media = useMediaStore.getState(), project = useDocumentStore.getState().project
    const serialized = serializeProjectFile(createProjectFileSnapshot(project, media.descriptors.values(), media.collections))
    const parsed = parseProjectFile(serialized)
    const { createProjectVideoCompositionPlanner } = await import(planPath)
    const { createSourceBoundsCatalog } = await import(boundsPath)
    const plannedFrames = (value: typeof project) => createProjectVideoCompositionPlanner(value, value.rootSequenceId,
      createSourceBoundsCatalog(media.descriptors.values())).planFrame(45).items
      .filter((item: { kind: string }) => item.kind === 'clip')
      .map((item: { request: { sourceFrame: number } }) => item.request.sourceFrame)
    return { id: project.id, serialized, multicams: project.multicams, roundTrip: parsed.multicams,
      stable: serializeProjectFile(parsed) === serialized, plannedFrames: plannedFrames(project), restoredFrames: plannedFrames(parsed) }
  })
  expect(saved.stable).toBe(true)
  expect(saved.roundTrip).toEqual(saved.multicams)
  expect(saved.plannedFrames).toEqual([22])
  expect(saved.restoredFrames).toEqual([22])
  expect(saved.serialized).not.toMatch(/blob:|cacheKey|fingerprint|decodePolicy|audio-feature/)
  const exported = await page.evaluate(async () => {
    const controllerPath = '/src/app/exportController.ts', profilePath = '/src/domain/exportProfile.ts'
    const mediabunnyPath = '/node_modules/.vite/deps/mediabunny.js'
    const { startExport, disposeExport } = await import(controllerPath)
    const { DEFAULT_EXPORT_PROFILE } = await import(profilePath)
    const { Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioSampleSink } = await import(mediabunnyPath)
    let input
    try {
      const result = await startExport({ ...DEFAULT_EXPORT_PROFILE, videoBitrate: 1_000_000 })
      if (!result || result.destination !== 'download') throw new Error('No buffered export')
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([result.buffer], { type: result.mimeType })) })
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack()
      if (!video || !audio) throw new Error('Export lost an audio/video track')
      const canvas = new OffscreenCanvas(video.displayWidth, video.displayHeight)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const sink = new VideoSampleSink(video), pixels: number[][] = []
      for (const frame of [15, 45]) {
        const sample = await sink.getSample(frame / 30)
        if (!sample) throw new Error('No exported video frame')
        try {
          const image = sample.toVideoFrame()
          try { ctx.drawImage(image, 0, 0) } finally { image.close() }
          pixels.push(Array.from(ctx.getImageData(canvas.width / 2 + 40, canvas.height / 2 - 25, 1, 1).data))
        } finally { sample.close() }
      }
      const sample = await new AudioSampleSink(audio).getSample(0.5)
      if (!sample) throw new Error('No exported audio sample')
      let rms = 0
      try {
        const pcm = new Float32Array(sample.numberOfFrames)
        sample.copyTo(pcm, { format: 'f32-planar', planeIndex: 0 })
        rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length)
      } finally { sample.close() }
      return { bytes: result.buffer.byteLength, duration: await input.computeDuration(), pixels, rms }
    } finally { input?.dispose(); await disposeExport() }
  })
  expect(exported.bytes).toBeGreaterThan(10_000)
  expect(exported.duration).toBeCloseTo(2, 1)
  expect(exported.pixels[0][0]).toBeGreaterThan(exported.pixels[0][2] + 40)
  expect(exported.pixels[1][2]).toBeGreaterThan(exported.pixels[1][0] + 60)
  expect(exported.rms).toBeGreaterThan(0.001)
  await testInfo.attach('aligned-export', { body: JSON.stringify(exported), contentType: 'application/json' })
  await expect.poll(async () => page.evaluate(async (id) => {
    const path = '/src/app/localProjectStorage.ts'
    const records = await (await import(path)).localProjectStorage.listRecoveryJournals()
    return records.filter((record: { documentId: string }) => record.documentId === id)
      .some((record: { generations: { serializedProject: string }[] }) => {
        const project = JSON.parse(record.generations.at(-1)!.serializedProject)
        return project.multicams[0]?.angles[1].coverage.startFrame === 23 && project.multicams[0]?.switches.length === 2
      })
  }, saved.id), { timeout: 10_000 }).toBe(true)
  // A reload drops all source connections and presentation state, then the normal recovery UI restores authored offsets.
  await page.reload()
  await page.getByRole('tab', { name: /^Recovery copies,/ }).click()
  await page.getByRole('button', { name: 'Recover Multicam alignment QA', exact: true }).click()
  await page.getByRole('button', { name: 'Recover with 2 offline', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  expect((await snapshot(page)).project.multicams).toEqual(saved.multicams)
  const resources = await page.evaluate(async () => {
    const mediaPath = '/src/state/mediaStore.ts', alignmentPath = '/src/state/multicamAlignmentStore.ts'
    return { sources: (await import(mediaPath)).useMediaStore.getState().assets.size,
      rows: (await import(alignmentPath)).useMulticamAlignmentStore.getState().rows.length }
  })
  expect(resources).toEqual({ sources: 0, rows: 0 })
  expect(errors).toEqual([])
})

test('disconnect/reconnect invalidates review and clearing an active analysis drains its owners', async ({ page }) => {
  const errors = problems(page)
  const { second } = await createProject(page)
  const before = await snapshot(page)
  await analyze(page)
  await page.evaluate(async (data) => {
    const mediaPath = '/src/state/mediaStore.ts', controllerPath = '/src/app/projectController.ts'
    const { useMediaStore } = await import(mediaPath)
    const asset = [...useMediaStore.getState().assets.values()].find((item: { fileName: string }) => item.fileName === 'Camera 2.mp4')
    useMediaStore.getState().disconnectAsset(asset.id)
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const result = await (await import(controllerPath)).connectActiveAssetMedia(asset.id,
      new File([bytes], 'Camera 2.mp4', { type: 'video/mp4', lastModified: 194 }))
    if (result.status !== 'ready') throw new Error(JSON.stringify(result))
  }, second)
  await expect(page.getByText('The project or a connected source changed. Analyze again.')).toBeVisible()
  expect(await snapshot(page)).toEqual(before)
  await analyze(page)
  await expect(page.getByText('2 source windows reused from local cache.')).toBeVisible()
  await page.getByLabel('Window start for Camera 2.mp4 (seconds)').fill('1.005')
  await page.getByRole('button', { name: 'Analyze alignment', exact: true }).click()
  const cleared = await page.evaluate(async () => {
    const registryPath = '/src/app/localDerivedStorage.ts', storagePath = '/src/app/analysisStorage.ts'
    const controllerPath = '/src/app/multicamAlignmentController.ts'
    await (await import(registryPath)).localDerivedStorage.clear()
    return { entries: (await (await import(storagePath)).analysisStorage.readManifest()).entries.length,
      diagnostics: (await import(controllerPath)).multicamAlignmentDiagnostics() }
  })
  expect(cleared.entries).toBe(0)
  expect(cleared.diagnostics.activeJobCount).toBe(0)
  expect(cleared.diagnostics.activeDecoderCount).toBe(0)
  expect(await snapshot(page)).toEqual(before)
  expect(errors).toEqual([])
})
