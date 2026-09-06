import { expect, test, type Page } from '@playwright/test'

test.setTimeout(90_000)

async function seedProject(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Effect workflows QA')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  await page.evaluate(async () => {
    const importerPath = '/src/app/mediaImportController.ts', mediaPath = '/src/state/mediaStore.ts'
    const documentPath = '/src/state/documentStore.ts', transportPath = '/src/state/transportStore.ts'
    const operationsPath = '/src/domain/operations.ts', effectsPath = '/src/domain/effectStack.ts'
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#4080c0'; ctx.fillRect(0, 0, 1280, 720)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    canvas.width = canvas.height = 0
    const result = await (await import(importerPath)).importMedia(new File([blob], 'Color plate.png', { type: 'image/png' }))
    if (result.status !== 'imported') throw new Error(JSON.stringify(result))
    const asset = (await import(mediaPath)).useMediaStore.getState().assets.get(result.assetId)
    const { clipFromAssetRange } = await import(operationsPath)
    const { createColorAdjustEffect } = await import(effectsPath)
    const store = (await import(documentPath)).useDocumentStore
    const clips = ['Source', 'First', 'Second'].map((name, index) => {
      const clip = clipFromAssetRange(asset, index * 60, 0, 60)
      clip.id = name; clip.name = name
      if (index === 0) {
        clip.effects = [createColorAdjustEffect('original-effect'), { id: 'unknown-effect', type: 'future.test', version: 9, enabled: false, params: { note: 'preserve' } }]
        clip.effects[0].params.exposure = -1
        clip.animation.effectTracks = [{ effectId: 'original-effect', parameter: 'exposure', keyframes: [
          { frame: 0, sourceTimeTicks: 0, value: -1, easing: { type: 'linear' } },
          { frame: 30, sourceTimeTicks: 30_000_000, value: 0, easing: { type: 'hold' } },
        ] }]
      }
      return { trackId: store.getState().doc.tracks[0].id, clip }
    })
    store.getState().insertClips(clips)
    const transport = (await import(transportPath)).useTransportStore
    transport.getState().setSelectedClip('Source'); transport.getState().setPlayheadFrame(15)
  })
  await expect(page.getByRole('button', { name: 'Copy attributes', exact: true })).toBeVisible()
}

async function select(page: Page, ids: string[], frame: number) {
  await page.evaluate(async ({ ids, frame }) => {
    const path = '/src/state/transportStore.ts'
    const store = (await import(path)).useTransportStore
    store.setState({ selectedClipIds: ids, selectedClipId: ids.at(-1) })
    store.getState().setPlayheadFrame(frame)
  }, { ids, frame })
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/state/documentStore.ts'
    const { project, past } = (await import(path)).useDocumentStore.getState()
    return { project, history: past.length }
  })
}
async function pixel(page: Page) {
  return page.getByTestId('preview-canvas').evaluate((element) => {
    const scratch = document.createElement('canvas'); scratch.width = scratch.height = 1
    try {
      const ctx = scratch.getContext('2d')!
      ctx.drawImage(element as HTMLCanvasElement, 0, 0, 1, 1)
      return [...ctx.getImageData(0, 0, 1, 1).data]
    } finally { scratch.width = scratch.height = 0 }
  })
}
function problems(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (['warning', 'error'].includes(m.type())) errors.push(m.text()) })
  return errors
}

test('copy/paste preserves animated appearance, fresh ids, unknown intent and one-step undo/redo', async ({ page }, info) => {
  const errors = problems(page)
  await seedProject(page)
  await expect(page).toHaveTitle(/Myrelith/)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await expect.poll(async () => (await pixel(page))[2]).toBeGreaterThan(80)
  const sourcePixel = await pixel(page)
  await page.getByRole('button', { name: 'Copy attributes', exact: true }).click()
  await select(page, ['First', 'Second'], 75)
  await expect.poll(async () => (await pixel(page))[2]).toBeGreaterThan(180)
  const before = await snapshot(page)
  await page.getByRole('button', { name: 'Paste attributes…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Paste attributes' })
  await expect(dialog).toContainText('First, Second')
  await dialog.getByLabel('Effect stack').selectOption('replace')
  await page.screenshot({ path: '/private/tmp/issue197-paste-desktop.png' })
  await dialog.getByRole('button', { name: 'Apply paste' }).click()
  await expect(dialog).toHaveCount(0)
  const after = await snapshot(page)
  expect(after.history).toBe(before.history + 1)
  const clips = after.project.sequences[0].tracks[0].clips
  expect(new Set(clips.flatMap((clip: { effects: { id: string }[] }) => clip.effects.map((e) => e.id))).size).toBe(6)
  expect(clips[1].animation.effectTracks[0].effectId).toBe(clips[1].effects[0].id)
  expect(clips[1].effects[1]).toMatchObject({ type: 'future.test', version: 9, params: { note: 'preserve' } })
  await expect.poll(() => pixel(page)).toEqual(sourcePixel)
  await page.evaluate(async () => { const p = '/src/state/documentStore.ts'; (await import(p)).useDocumentStore.getState().undo() })
  expect((await snapshot(page)).project).toEqual(before.project)
  await page.evaluate(async () => { const p = '/src/state/documentStore.ts'; (await import(p)).useDocumentStore.getState().redo() })
  expect((await snapshot(page)).project).toEqual(after.project)
  const portable = await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', m = '/src/state/mediaStore.ts', f = '/src/domain/projectFile.ts'
    const { createProjectFileSnapshot, serializeProjectFile, parseProjectFile } = await import(f)
    const project = (await import(d)).useDocumentStore.getState().project
    const media = (await import(m)).useMediaStore.getState()
    const serialized = serializeProjectFile(createProjectFileSnapshot(project, media.descriptors.values(), media.collections))
    const parsed = parseProjectFile(serialized)
    return { serialized, parsed: !!parsed }
  })
  expect(portable.parsed).toBe(true)
  expect(portable.serialized).toContain('future.test')
  expect(portable.serialized).not.toContain('projectGeneration')
  await info.attach('gate1-pixel-and-history', { body: JSON.stringify({ sourcePixel, historyBefore: before.history, historyAfter: after.history }), contentType: 'application/json' })
  expect(errors).toEqual([])
})

test('checked effects copy, keyboard dialog, narrow layout, reset and stale replacement', async ({ page }) => {
  const errors = problems(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await seedProject(page)
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
  await page.getByLabel('Select effect 1: Color adjustment').check()
  await page.getByRole('button', { name: 'Copy selected effects' }).click()
  await select(page, ['First'], 75)
  const paste = page.getByRole('button', { name: 'Paste attributes…', exact: true })
  await paste.focus(); await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Paste attributes' })
  await expect(dialog.getByLabel('Video effects', { exact: true })).toBeFocused()
  await page.screenshot({ path: '/private/tmp/issue197-paste-720.png' })
  await dialog.getByRole('button', { name: 'Apply paste' }).click()
  expect((await snapshot(page)).project.sequences[0].tracks[0].clips[1].effects).toHaveLength(1)
  await page.getByRole('button', { name: 'Reset attributes…' }).click()
  await page.getByRole('button', { name: 'Apply reset' }).click()
  const clip = (await snapshot(page)).project.sequences[0].tracks[0].clips[1]
  expect(clip.effects[0].params.exposure).toBe(0)
  expect(clip.animation.effectTracks).toEqual([])
  await paste.click()
  await page.evaluate(async () => { const p = '/src/state/documentStore.ts'; const s = (await import(p)).useDocumentStore; s.getState().setProject(s.getState().project) })
  await page.getByRole('button', { name: 'Apply paste' }).click()
  await expect(page.getByRole('alert')).toContainText('project or selection changed')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(paste).toBeDisabled()
  expect(errors).toEqual([])
})

async function writePresetLibrary(page: Page, raw: string) {
  await page.evaluate(async (value) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('myrelith-effect-presets', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('library')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('library', 'readwrite')
        tx.objectStore('library').put(value, 'local')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
  }, raw)
}

test('local presets capture static rendered values, persist across reload, rename and apply atomically', async ({ page }) => {
  const errors = problems(page)
  await seedProject(page)
  await expect.poll(async () => (await pixel(page))[2]).toBeGreaterThan(80)
  const sourcePixel = await pixel(page)
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
  const beforeSave = await snapshot(page)
  await page.getByRole('button', { name: 'Save preset…', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Save effect preset' })
  await expect(dialog.getByLabel('Preset name', { exact: true })).toBeFocused()
  await dialog.getByLabel('Preset name', { exact: true }).fill('Half-stop look')
  await dialog.getByRole('button', { name: 'Save local preset' }).click()
  await expect(dialog).toContainText('Preset saved in this browser.')
  expect(await snapshot(page)).toEqual(beforeSave)
  await page.keyboard.press('Escape')
  await page.reload()
  await seedProject(page)
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Effect browser' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Show', { exact: true }).selectOption('presets')
  await expect(dialog.getByRole('button', { name: 'Apply preset Half-stop look' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Rename Half-stop look' }).click()
  await dialog.getByLabel('New preset name').fill('Reusable look')
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Apply preset Reusable look' })).toBeVisible()
  await dialog.getByLabel('Search effects').fill('missing-word')
  await expect(dialog).toContainText('No matching effects.')
  await dialog.getByLabel('Search effects').fill('future.test')
  await expect(dialog).toContainText('unavailable; preserved and bypassed')
  await page.keyboard.press('Escape')
  await select(page, ['First', 'Second'], 75)
  const before = await snapshot(page)
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Effect browser' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Show', { exact: true }).selectOption('presets')
  await page.screenshot({ path: '/private/tmp/issue197-presets-desktop.png' })
  await dialog.getByRole('button', { name: 'Apply preset Reusable look' }).click()
  const after = await snapshot(page)
  expect(after.history).toBe(before.history + 1)
  const targets = after.project.sequences[0].tracks[0].clips.slice(1)
  expect(targets[0].effects[0].params.exposure).toBe(-0.5)
  expect(targets[0].effects[0].id).not.toBe(targets[1].effects[0].id)
  expect(targets[0].animation.effectTracks).toEqual([])
  await expect.poll(() => pixel(page)).toEqual(sourcePixel)
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  await page.getByRole('button', { name: 'Delete Reusable look' }).click()
  await expect(page.getByRole('button', { name: 'Apply preset Reusable look' })).toHaveCount(0)
  expect(await snapshot(page)).toEqual(after)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: '/private/tmp/issue197-inspector-effects.png' })
  expect(errors).toEqual([])
})

test('preset corruption, quota abort and future envelopes stay honest and preserve existing data', async ({ page }) => {
  const errors = problems(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await seedProject(page)
  await writePresetLibrary(page, JSON.stringify({ version: 1, presets: [
    { id: 'valid', name: 'Valid sibling', effects: [{ id: 'future', type: 'plugin:com.example.missing/effect', version: 99, enabled: true, params: {} }] },
    { id: 'broken', name: 'Corrupt', media: 'file:/secret' },
  ] }))
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
  await page.getByRole('button', { name: 'Save preset…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Save effect preset' })
  await expect(dialog).toContainText('Unavailable preset 2')
  await expect(dialog.getByRole('button', { name: 'Apply preset Valid sibling' })).toBeVisible()
  await expect(dialog).toContainText('Plugin is missing; the effect stays preserved and unavailable.')
  await dialog.getByLabel('Preset name', { exact: true }).fill('Should fail')
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'library') { IDBObjectStore.prototype.put = original; throw new DOMException('Injected quota failure', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await dialog.getByRole('button', { name: 'Save local preset' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Injected quota failure')
  await expect(dialog).not.toContainText('Preset saved in this browser.')
  await page.screenshot({ path: '/private/tmp/issue197-presets-720.png' })
  await page.keyboard.press('Escape')
  const future = JSON.stringify({ version: 42, presets: [{ keep: 'future data' }] })
  await writePresetLibrary(page, future)
  await page.getByRole('button', { name: 'Save preset…', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('read-only')
  await dialog.getByLabel('Preset name', { exact: true }).fill('Future')
  await expect(dialog.getByRole('button', { name: 'Save local preset' })).toBeDisabled()
  const raw = await page.evaluate(async () => new Promise((resolve, reject) => {
    const open = indexedDB.open('myrelith-effect-presets', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => { const db = open.result, tx = db.transaction('library'), get = tx.objectStore('library').get('local'); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close() }
  }))
  expect(raw).toBe(future)
  expect(errors).toEqual([])
})

test('new effect controls coexist with an installed trusted plugin, local presets and original-media export', async ({ page }, info) => {
  test.setTimeout(150_000)
  const errors = problems(page)
  await seedProject(page)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const manager = page.getByRole('dialog', { name: 'Manage plugins' })
  await manager.getByLabel('Choose a plugin package').setInputFiles('samples/plugins/audited-invert-v1/audited-invert-v1.myrelith-plugin')
  const review = page.getByRole('dialog', { name: 'Review Audited Invert' })
  for (const decision of await review.getByRole('checkbox').all()) if (await decision.isEnabled() && !await decision.isChecked()) await decision.check()
  await review.getByRole('button', { name: 'Install plugin', exact: true }).click()
  await expect(manager.getByRole('heading', { name: 'Audited Invert', exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Effect browser' })
  await dialog.getByLabel('Show', { exact: true }).selectOption('plugins')
  await expect(dialog.getByRole('button', { name: 'Add plugin Audited Invert' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Add plugin Audited Invert' }).click()
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Effect browser' })
  await dialog.getByLabel('Search effects').fill('vignette')
  await dialog.getByRole('button', { name: 'Apply Vignette', exact: true }).click()
  const strength = page.locator('[data-testid^="inspector-effect-vignette-strength-"]')
  await strength.fill('0.7'); await strength.press('Enter')
  await expect.poll(async () => (await snapshot(page)).project.sequences[0].tracks[0].clips[0].effects.at(-1).params.strength).toBe(0.7)
  await page.getByRole('button', { name: 'Save preset…', exact: true }).click()
  const save = page.getByRole('dialog', { name: 'Save effect preset' })
  await save.getByLabel('Preset name', { exact: true }).fill('Plugin and vignette')
  await save.getByRole('button', { name: 'Save local preset' }).click()
  await expect(save).toContainText('Preset saved in this browser.')
  await page.keyboard.press('Escape')
  await select(page, ['First'], 75)
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  await page.getByRole('button', { name: 'Apply preset Plugin and vignette' }).click()
  await expect.poll(async () => (await pixel(page))[0]).toBeGreaterThan(100)
  // Stable paused preview after plugin completion, with the copied preset's
  // static exposure matching the original playhead capture.
  await expect.poll(async () => page.evaluate(async () => {
    const p = '/src/state/previewStatusStore.ts'
    return [...(await import(p)).usePreviewStatusStore.getState().effectStatuses.values()].some((status: { status: string }) => status.status === 'ready')
  })).toBe(true)
  const previewPixel = await pixel(page)
  const width = await page.getByRole('region', { name: 'Effect stack', exact: true }).evaluate((element) => ({ content: element.scrollWidth, visible: element.clientWidth, right: element.getBoundingClientRect().right, areaRight: element.closest('.area-inspector')!.getBoundingClientRect().right }))
  expect(width.content).toBeLessThanOrEqual(width.visible + 1)
  expect(width.right).toBeLessThanOrEqual(width.areaRight + 1)
  await strength.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/issue197-plugin-vignette.png' })
  const exported = await page.evaluate(async () => {
    const e = '/src/app/exportController.ts', p = '/src/domain/exportProfile.ts', m = '/node_modules/.vite/deps/mediabunny.js'
    const d = '/src/state/documentStore.ts', a = '/src/app/mediaResourceAdmission.ts'
    const { disposeExport } = await import(e), { DEFAULT_EXPORT_PROFILE } = await import(p)
    const preparedPath = '/src/app/pluginPreparedExportOwner.ts'
    const { getPluginPreparedExportPort, disposePluginPreparedExportOwner } = await import(preparedPath)
    const port = getPluginPreparedExportPort()
    const before = JSON.stringify((await import(d)).useDocumentStore.getState().project)
    let input
    const scratch = new OffscreenCanvas(1280, 720), ctx = scratch.getContext('2d')!
    const average = new OffscreenCanvas(1, 1), averageContext = average.getContext('2d')!
    try {
      const prepared = await port.prepare({ ...DEFAULT_EXPORT_PROFILE, videoBitrate: 5_000_000 })
      if (prepared.status !== 'ready') throw new Error(`Plugin export preflight: ${JSON.stringify(prepared)}`)
      const result = await port.start(prepared.token)
      if (!result || result.destination !== 'download') throw new Error('Expected buffered export')
      const { Input, BlobSource, ALL_FORMATS, VideoSampleSink } = await import(m)
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([result.buffer])) })
      const video = await input.getPrimaryVideoTrack()
      const sample = await new VideoSampleSink(video).getSample(2.5)
      if (!sample) throw new Error('Export frame missing')
      try { sample.draw(ctx, 0, 0, 1280, 720) } finally { sample.close() }
      averageContext.drawImage(scratch, 0, 0, 1, 1)
      return { bytes: result.buffer.byteLength, pixel: [...averageContext.getImageData(0, 0, 1, 1).data], duration: await input.computeDuration(),
        unchanged: before === JSON.stringify((await import(d)).useDocumentStore.getState().project), admission: (await import(a)).mediaResourceAdmission.snapshot() }
    } finally { input?.dispose(); scratch.width = scratch.height = average.width = average.height = 0; await disposeExport(); await disposePluginPreparedExportOwner('issue197-acceptance-complete') }
  })
  expect(exported.bytes).toBeGreaterThan(1000)
  expect(exported.unchanged).toBe(true)
  expect(exported.duration).toBeGreaterThanOrEqual(6)
  for (let channel = 0; channel < 4; channel++) expect(Math.abs(exported.pixel[channel] - previewPixel[channel]), `decoded channel ${channel}`).toBeLessThanOrEqual(8)
  await info.attach('plugin-preset-export', { body: JSON.stringify({ previewPixel, exported }), contentType: 'application/json' })
  expect(errors).toEqual([])
})

test('Chromium compositor matches spatial reference pixels and all blend modes across alpha and transitions', async ({ page }, info) => {
  const errors = problems(page)
  await page.goto('/')
  const evidence = await page.evaluate(async () => {
    const r = '/src/pipeline/render.ts', f = '/src/test/clipAttributeFixtures.ts', v = '/src/domain/videoCompositionPlan.ts'
    const defs = '/src/domain/spatialEffectDefinitions.ts', pix = '/src/domain/effectPixels.ts', b = '/src/domain/blendModes.ts'
    const { compositeFrame } = await import(r), { attributeProject, attributeClip } = await import(f)
    const { videoCompositionPlanAtFrame } = await import(v), { spatialEffectParams } = await import(defs)
    const { applyOrderedPixelEffectsToRgba } = await import(pix), { BLEND_MODE_NAMES, compositeReferencePixel } = await import(b)
    const w = 32, h = 24
    const canvases: OffscreenCanvas[] = [], bitmaps: ImageBitmap[] = []
    const make = (width = w, height = h) => { const canvas = new OffscreenCanvas(width, height); canvases.push(canvas); return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! } }
    const source = make(), output = make(), leg = make(), group = make(), expected = make(), filtered = make()
    const raw = Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => i % 4 === 3 ? [0, 64, 128, 255][Math.floor(i / 4) % 4] : i * 71 % 256)
    source.ctx.putImageData(new ImageData(raw, w, h), 0, 0)
    const bitmap = await createImageBitmap(source.canvas); bitmaps.push(bitmap)
    source.ctx.clearRect(0, 0, w, h); source.ctx.drawImage(bitmap, 0, 0)
    const canonical = source.ctx.getImageData(0, 0, w, h).data
    const doc = attributeProject().sequences[0]; doc.width = w; doc.height = h
    doc.tracks.forEach((track: { clips: unknown[] }) => { track.clips = [] })
    const clip = attributeClip('rendered'); clip.animation = { tracks: [], effectTracks: [] }; doc.tracks[0].clips = [clip]
    const params = [
      ['box-blur', { radius: 3 }], ['sharpen', { amount: 1.5 }], ['vignette', { strength: 0.7, radius: 0.2, softness: 0.6 }],
      ['drop-shadow', { radius: 2, offsetX: -3, offsetY: 4, opacity: 0.6, color: '#204080' }], ['outline', { width: 3, opacity: 0.7, color: '#204080' }],
    ] as const
    const deltas: { kind: string; maxDelta: number }[] = []
    try {
      for (const [kind, values] of params) {
        const effect = { kind, params: spatialEffectParams(kind, values) }
        clip.effects = [{ id: 'tested', type: `builtin.${kind}`, version: 1, enabled: true, params: effect.params }]
        await compositeFrame(doc, videoCompositionPlanAtFrame(doc, 0), output.ctx, { getFrame: async () => bitmap }, { get: () => ({ leg, group }) })
        const desired = canonical.slice(); applyOrderedPixelEffectsToRgba(desired, [effect], { surfaceWidth: w, surfaceHeight: h, projectWidth: w, projectHeight: h })
        filtered.ctx.putImageData(new ImageData(desired, w, h), 0, 0)
        expected.ctx.fillStyle = '#000'; expected.ctx.fillRect(0, 0, w, h); expected.ctx.drawImage(filtered.canvas, 0, 0)
        const actual = output.ctx.getImageData(0, 0, w, h).data, reference = expected.ctx.getImageData(0, 0, w, h).data
        deltas.push({ kind, maxDelta: actual.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - reference[index])), 0) })
      }
      const blendResults: { mode: string; maximum: number }[] = []
      const native = make(1, 1)
      for (const mode of BLEND_MODE_NAMES) {
        let maximum = 0
        for (const ab of [0, 128, 255]) for (const as of [0, 128, 255]) for (const opacity of [0, 0.5, 1]) {
          native.ctx.clearRect(0, 0, 1, 1); native.ctx.globalAlpha = 1; native.ctx.globalCompositeOperation = 'source-over'
          native.ctx.fillStyle = `rgba(64,128,192,${ab / 255})`; native.ctx.fillRect(0, 0, 1, 1)
          native.ctx.globalCompositeOperation = mode === 'normal' ? 'source-over' : mode
          native.ctx.globalAlpha = opacity; native.ctx.fillStyle = `rgba(192,96,32,${as / 255})`; native.ctx.fillRect(0, 0, 1, 1)
          const actual = native.ctx.getImageData(0, 0, 1, 1).data
          const reference = compositeReferencePixel({ r: 64, g: 128, b: 192, a: ab }, { r: 192, g: 96, b: 32, a: as }, mode, opacity)
          for (const [channel, value] of [reference.r, reference.g, reference.b, reference.a].entries()) maximum = Math.max(maximum, Math.abs(actual[channel] - value))
        }
        blendResults.push({ mode, maximum })
      }
      const images = new Map<string, ImageBitmap>()
      for (const [id, color] of [['backdrop', '#4080c0'], ['red', '#ff0000'], ['blue', '#0000ff']]) {
        const solid = make(); solid.ctx.fillStyle = color; solid.ctx.fillRect(0, 0, w, h)
        const image = await createImageBitmap(solid.canvas); bitmaps.push(image); images.set(id, image)
      }
      const lower = attributeClip('lower'), from = attributeClip('from'), to = attributeClip('to', 2)
      lower.assetId = 'backdrop'; from.assetId = 'red'; to.assetId = 'blue'
      from.timelineRange.durationFrames = to.timelineRange.durationFrames = 2
      doc.tracks[0].clips = [lower]; doc.tracks[1].clips = [from, to]
      doc.tracks[1].transitions = [{ id: 'crossfade', type: 'crossfade', fromClipId: 'from', toClipId: 'to', durationFrames: 1, audio: { enabled: false, curve: 'equal-power' } }]
      const transitions: { mode: string; mixed: boolean; delta: number }[] = []
      for (const mode of ['darken', 'lighten', 'difference', 'exclusion']) for (const mixed of [false, true]) {
        from.blendMode = mode; to.blendMode = mixed ? 'normal' : mode
        await compositeFrame(doc, videoCompositionPlanAtFrame(doc, 2, new Map([...images.keys()].map((id) => [id, { video: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 1_000_000_000 }, audio: null }]))), output.ctx, { getFrame: async (id: string) => images.get(id) }, { get: () => ({ leg, group }) })
        const actual = output.ctx.getImageData(16, 12, 1, 1).data
        const reference = compositeReferencePixel({ r: 64, g: 128, b: 192, a: 255 }, { r: 128, g: 0, b: 128, a: 255 }, mixed ? 'normal' : mode)
        transitions.push({ mode, mixed, delta: Math.max(...[reference.r, reference.g, reference.b, reference.a].map((value, i) => Math.abs(value - actual[i]))) })
      }
      const textPath = '/src/domain/textOverlay.ts'
      const { defaultTextProps } = await import(textPath)
      const title = attributeClip('title'); title.text = { ...defaultTextProps(w, h, 'X'), boxWidthPx: w, boxHeightPx: h, paddingPx: 0, fontSizePx: 8, color: '#c06020', backgroundEnabled: true, backgroundColor: '#c06020', outlineEnabled: false, shadowEnabled: false }
      doc.tracks[1].clips = [title]; doc.tracks[1].transitions = []
      const text: { mode: string; delta: number }[] = []
      for (const mode of ['darken', 'lighten', 'difference', 'exclusion']) {
        title.blendMode = mode; title.opacity = 0.5
        await compositeFrame(doc, videoCompositionPlanAtFrame(doc, 0), output.ctx, { getFrame: async (id: string) => images.get(id) }, { get: () => ({ leg, group }) })
        const actual = output.ctx.getImageData(16, 12, 1, 1).data
        const reference = compositeReferencePixel({ r: 64, g: 128, b: 192, a: 255 }, { r: 192, g: 96, b: 32, a: 255 }, mode, 0.5)
        text.push({ mode, delta: Math.max(...[reference.r, reference.g, reference.b, reference.a].map((value, i) => Math.abs(value - actual[i]))) })
      }
      return { deltas, blendResults, transitions, text, closedBitmaps: bitmaps.length, releasedCanvases: canvases.length }
    } finally { bitmaps.forEach((value) => value.close()); canvases.forEach((value) => { value.width = value.height = 0 }) }
  })
  expect(evidence.deltas.every((entry) => entry.maxDelta <= 2), JSON.stringify(evidence.deltas)).toBe(true)
  expect(evidence.blendResults.every((entry) => entry.maximum <= 2), JSON.stringify(evidence.blendResults)).toBe(true)
  expect(evidence.transitions.every((entry) => entry.delta <= 2), JSON.stringify(evidence.transitions)).toBe(true)
  expect(evidence.text.every((entry) => entry.delta <= 2), JSON.stringify(evidence.text)).toBe(true)
  await info.attach('spatial-compositor-and-blend-pixels', { body: JSON.stringify(evidence), contentType: 'application/json' })
  expect(errors).toEqual([])
})
