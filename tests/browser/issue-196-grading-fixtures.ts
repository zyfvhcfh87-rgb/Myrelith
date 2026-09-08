import { expect, type Page } from '@playwright/test'

export async function gradingProject(page: Page, durationFrames = 60) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Grading controls QA')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  await page.evaluate(async (duration) => {
    const importer = '/src/app/mediaImportController.ts', media = '/src/state/mediaStore.ts', documentPath = '/src/state/documentStore.ts'
    const operations = '/src/domain/operations.ts', transportPath = '/src/state/transportStore.ts'
    const canvas = new OffscreenCanvas(1280, 720), ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#4080c0'; ctx.fillRect(0, 0, 1280, 720)
    const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'Color plate.png', { type: 'image/png' })
    canvas.width = canvas.height = 0
    const result = await (await import(importer)).importMedia(file)
    if (result.status !== 'imported') throw new Error(JSON.stringify(result))
    const asset = (await import(media)).useMediaStore.getState().assets.get(result.assetId)
    const clip = (await import(operations)).clipFromAssetRange(asset, 0, 0, duration)
    clip.id = 'grading-clip'; clip.name = 'Color plate'
    const store = (await import(documentPath)).useDocumentStore
    store.getState().insertClips([{ trackId: store.getState().doc.tracks[0].id, clip }])
    const transport = (await import(transportPath)).useTransportStore.getState()
    transport.setSelectedClip(clip.id); transport.setPlayheadFrame(1)
  }, durationFrames)
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
}
export function gradingSnapshot(page: Page) {
  return page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts'
    const { project, past, future } = (await import(d)).useDocumentStore.getState()
    return { project, past: past.length, future: future.length, preview: (await import(t)).useTransportStore.getState().colorGradingPreview }
  })
}
export function gradingPixel(page: Page) {
  return page.getByTestId('preview-canvas').evaluate((element) => {
    const sample = new OffscreenCanvas(1, 1), ctx = sample.getContext('2d')!
    try { ctx.drawImage(element as HTMLCanvasElement, 100, 100, 1, 1, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
    finally { sample.width = sample.height = 0 }
  })
}
