import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

// Preregistered codec tolerance: VP9 at 5 Mbps, flat patch at least 16 pixels
// from edges, <= 6 RGB code values and alpha exactly 255. This does not replace
// the byte-exact same-raster compositor tests before encoding.
for (const trustedPlugin of [false, true]) test(`real grading worker and VP9 export: ${trustedPlugin ? 'trusted plugin' : 'built-ins'}, cancellation and missing LUTs`, async ({ page }, info) => {
  test.setTimeout(120_000)
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) problems.push(message.text()) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Grading export')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  await page.evaluate(async () => {
    const importer = '/src/app/mediaImportController.ts', media = '/src/state/mediaStore.ts', documentPath = '/src/state/documentStore.ts'
    const operations = '/src/domain/operations.ts', transport = '/src/state/transportStore.ts'
    const lutPath = '/src/domain/colorLut.ts', curvePath = '/src/domain/colorCurves.ts', wheelPath = '/src/domain/colorWheels.ts'
    const { parseCube, portableColorLut } = await import(lutPath)
    const { DEFAULT_COLOR_CURVES } = await import(curvePath), { DEFAULT_COLOR_WHEELS } = await import(wheelPath)
    const canvas = new OffscreenCanvas(1280, 720), ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#4080c0'; ctx.fillRect(0, 0, 1280, 720)
    const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'Original plate.png', { type: 'image/png' })
    canvas.width = canvas.height = 0
    const result = await (await import(importer)).importMedia(file)
    if (result.status !== 'imported') throw new Error(JSON.stringify(result))
    const asset = (await import(media)).useMediaStore.getState().assets.get(result.assetId)
    const clip = (await import(operations)).clipFromAssetRange(asset, 0, 0, 8)
    const store = (await import(documentPath)).useDocumentStore
    store.getState().insertClips([{ trackId: store.getState().doc.tracks[0].id, clip }])
    const project = structuredClone(store.getState().project), doc = project.sequences[0]
    project.colorLuts = [portableColorLut('red-invert', 'Red invert', parseCube('LUT_1D_SIZE 2\n1 0 0\n0 1 1'))]
    const effect = (id: string, type: string, params: unknown) => ({ id, type, version: 1, enabled: true, params })
    doc.tracks[0].clips[0].effects = [effect('lut', 'builtin.cube-lut', { lutId: 'red-invert', strength: 1 })]
    doc.tracks[0].videoEffects = [effect('curve', 'builtin.rgb-curves', { ...DEFAULT_COLOR_CURVES, green: '[[0,0],[1,0.5]]' })]
    doc.masterVideoEffects = [effect('wheel', 'builtin.lift-gamma-gain', { ...DEFAULT_COLOR_WHEELS, gainB: 0.5 })]
    store.getState().setProject(project)
    const state = (await import(transport)).useTransportStore.getState()
    state.setSelectedClip(clip.id); state.setPlayheadFrame(1)
  })
  const pixel = () => page.getByTestId('preview-canvas').evaluate((canvas) => {
    const sample = new OffscreenCanvas(1, 1), ctx = sample.getContext('2d')!
    try { ctx.drawImage(canvas as HTMLCanvasElement, 100, 100, 1, 1, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
    finally { sample.width = sample.height = 0 }
  })
  if (trustedPlugin) {
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Manage plugins' })
    await manager.getByLabel('Choose a plugin package').setInputFiles('samples/plugins/audited-invert-v1/audited-invert-v1.myrelith-plugin')
    const review = page.getByRole('dialog', { name: 'Review Audited Invert' })
    await review.getByRole('checkbox', { name: /^Trust this signer/ }).check()
    await review.getByRole('checkbox', { name: /^Video frame pixels/ }).check()
    await review.getByRole('button', { name: 'Install plugin', exact: true }).click()
    await expect(manager.getByRole('heading', { name: 'Audited Invert', exact: true })).toBeVisible()
    await manager.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tab', { name: 'Effects', exact: true }).click()
    await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
    const browser = page.getByRole('dialog', { name: 'Effect browser' })
    await browser.getByLabel('Show', { exact: true }).selectOption('plugins')
    await browser.getByRole('button', { name: 'Add plugin Audited Invert' }).click()
  }
  const expected = trustedPlugin ? [64, 64, 32, 255] : [191, 64, 96, 255]
  await expect.poll(pixel).toEqual(expected)
  const timings = await page.evaluate(async () => {
    const lutPath = '/src/domain/colorLut.ts', previewPath = '/src/app/previewController.ts', transportPath = '/src/state/transportStore.ts'
    const { parseCube } = await import(lutPath), { subscribePreviewRenderDiagnostics } = await import(previewPath)
    const transport = (await import(transportPath)).useTransportStore
    const lines = ['LUT_3D_SIZE 33']
    for (let b = 0; b < 33; b++) for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) lines.push(`${r / 32} ${g / 32} ${b / 32}`)
    const source = lines.join('\n'), parseMs: number[] = [], frameMs: number[] = [], readback: Array<{ size: string; samplesMs: number[] }> = []
    for (let i = 0; i < 12; i++) { const start = performance.now(); parseCube(source); const elapsed = performance.now() - start; if (i >= 2) parseMs.push(elapsed) }
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true })!, samplesMs: number[] = []
      ctx.fillStyle = '#4080c0'; ctx.fillRect(0, 0, width, height)
      try { for (let i = 0; i < 12; i++) { const start = performance.now(); ctx.getImageData(0, 0, width, height); const elapsed = performance.now() - start; if (i >= 2) samplesMs.push(elapsed) } }
      finally { canvas.width = canvas.height = 0 }
      readback.push({ size: `${width}x${height}`, samplesMs })
    }
    for (let i = 0; i < 12; i++) {
      const frame = (i + 2) % 8
      const renderMs = await new Promise<number>((resolve, reject) => {
        const start = performance.now()
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('Program timing frame did not present')) }, 10000)
        const unsubscribe = subscribePreviewRenderDiagnostics((event: { frame: number; requestedAt: number; result: { status: string; renderMs: number } }) => {
          if (event.frame === frame && event.requestedAt >= start && event.result.status === 'drawn') { clearTimeout(timer); unsubscribe(); resolve(event.result.renderMs) }
        })
        transport.getState().setPlayheadFrame(frame)
      })
      if (i >= 2) frameMs.push(renderMs)
    }
    return { parseMs, readback, programRenderMs: frameMs }
  })
  const exported = await page.evaluate(async (trustedPlugin) => {
    const path = '/src/app/exportController.ts', profilePath = '/src/domain/exportProfile.ts', mediaPath = '/node_modules/.vite/deps/mediabunny.js'
    const documentPath = '/src/state/documentStore.ts', admissionPath = '/src/app/mediaResourceAdmission.ts'
    const { startExport: rawStart, cancelExport: rawCancel, disposeExport } = await import(path), { exportPresetById } = await import(profilePath)
    const preparedPath = '/src/app/pluginPreparedExportOwner.ts'
    const { getPluginPreparedExportPort, disposePluginPreparedExportOwner } = await import(preparedPath)
    const port = getPluginPreparedExportPort()
    const startExport = async (settings: unknown, callbacks?: { onProgress: (progress: number) => void }) => {
      if (!trustedPlugin) return rawStart(settings, callbacks)
      const prepared = await port.prepare(settings)
      if (prepared.status !== 'ready') throw new Error(JSON.stringify(prepared))
      return port.start(prepared.token, callbacks)
    }
    const cancelExport = () => trustedPlugin ? port.cancel('grading-acceptance') : rawCancel()
    const profile = { ...exportPresetById('web').profile, videoBitrate: 5_000_000, audioCodec: null, audioChannelLayout: 'off', audioBitrate: null, audioBitrateMode: null }
    const store = (await import(documentPath)).useDocumentStore, before = store.getState().project
    const admission = (await import(admissionPath)).mediaResourceAdmission
    const initialAdmission = admission.snapshot()
    const { Input, BlobSource, ALL_FORMATS, VideoSampleSink } = await import(mediaPath)
    let input, cancel: Promise<void> | undefined
    const canvas = new OffscreenCanvas(1280, 720), ctx = canvas.getContext('2d', { willReadFrequently: true })!
    try {
      const result = await startExport(profile)
      if (!result || result.destination !== 'download') throw new Error('Missing buffered export')
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([result.buffer])) })
      const track = await input.getPrimaryVideoTrack(), sample = await new VideoSampleSink(track).getSample(0)
      if (!sample) throw new Error('No encoded frame')
      try { sample.draw(ctx, 0, 0, 1280, 720) } finally { sample.close() }
      const pixel = [...ctx.getImageData(100, 100, 1, 1).data]
      const cancelled = await startExport(profile, { onProgress: (progress: number) => { if (progress > 0 && !cancel) cancel = cancelExport() } })
      await cancel; await disposeExport()
      const finalAdmission = admission.snapshot()
      const unchanged = store.getState().project === before
      const missing = structuredClone(before); missing.colorLuts = []
      store.getState().setProject(missing)
      let missingError = ''
      try { await startExport(profile) } catch (error) { missingError = String(error) }
      return { pixel, bytes: result.buffer.byteLength, cancelled: !!cancel && cancelled === undefined, unchanged, missingError, initialAdmission, finalAdmission }
    } finally { input?.dispose(); canvas.width = canvas.height = 0; await disposeExport(); await disposePluginPreparedExportOwner('grading-acceptance') }
  }, trustedPlugin)
  expect(exported.bytes).toBeGreaterThan(1000)
  exported.pixel.slice(0, 3).forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(6))
  expect(exported.pixel[3]).toBe(255)
  expect(exported.cancelled).toBe(true)
  expect(exported.unchanged).toBe(true)
  expect(exported.missingError).toContain('LUT')
  const evidence = info.outputPath('grading-export.json')
  await writeFile(evidence, JSON.stringify({ ...exported, timings, problems }, null, 2))
  await info.attach('grading-export', { path: evidence, contentType: 'application/json' })
  expect(problems).toEqual([])
})
