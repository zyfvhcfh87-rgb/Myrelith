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
