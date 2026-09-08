import { expect, test, type Page } from '@playwright/test'
import { gradingProject } from './issue-196-grading-fixtures.js'

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts'
    const { project, past } = (await import(d)).useDocumentStore.getState()
    const { maskPreview, maskEditorTarget } = (await import(t)).useTransportStore.getState()
    return { project, past: past.length, preview: maskPreview, target: maskEditorTarget }
  })
}
async function numeric(page: Page, parameter: string, value: string) {
  const input = page.locator(`[data-testid^="inspector-effect-mask-${parameter}-"]`)
  await input.fill(value); await input.press('Enter')
}
async function setup(page: Page, shape = 'rectangle') {
  await gradingProject(page)
  await expect(page).toHaveURL('http://127.0.0.1:5198/')
  await expect(page).toHaveTitle(/Myrelith/i)
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await page.getByRole('button', { name: `Add ${shape === 'bezier' ? 'Bezier' : shape} mask`, exact: true }).click()
  for (const [parameter, value] of Object.entries({ x: '20', y: '20', width: '50', height: '50' })) await numeric(page, parameter, value)
  await page.getByRole('button', { name: 'Edit mask in Program', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move mask', exact: true })).toBeVisible()
}
function errors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) problems.push(message.text()) })
  return problems
}
async function pixel(page: Page, x: number, y: number) {
  return page.getByTestId('preview-canvas').evaluate((element, point) => {
    const canvas = element as HTMLCanvasElement, sample = new OffscreenCanvas(1, 1), ctx = sample.getContext('2d')!
    try { ctx.drawImage(canvas, point.x * canvas.width, point.y * canvas.height, 1, 1, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
    finally { sample.width = sample.height = 0 }
  }, { x, y })
}

test('Program rectangle drag updates real pixels temporarily and commits once, with undo/redo and safe Escape', async ({ page }) => {
  const problems = errors(page); await setup(page)
  await expect.poll(() => pixel(page, 0.22, 0.45)).toEqual([64, 128, 192, 255])
  const before = await snapshot(page), canvas = (await page.getByTestId('preview-canvas').boundingBox())!
  const move = page.getByRole('button', { name: 'Move mask', exact: true }), handle = (await move.boundingBox())!
  const center = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }
  await page.mouse.move(center.x, center.y); await page.mouse.down()
  await page.mouse.move(center.x + canvas.width * 0.1, center.y, { steps: 5 })
  await expect.poll(async () => (await snapshot(page)).preview !== null).toBe(true)
  expect((await snapshot(page)).project).toEqual(before.project)
  await expect.poll(() => pixel(page, 0.22, 0.45)).toEqual([0, 0, 0, 255])
  await page.mouse.up()
  const after = await snapshot(page)
  expect(after.past).toBe(before.past + 1)
  expect(after.preview).toBeNull()
  expect(after.project.sequences[0].tracks[0].clips[0].effects[0].params.x).toBeCloseTo(0.3, 2)
  await page.evaluate(async () => { const d = '/src/state/documentStore.ts'; (await import(d)).useDocumentStore.getState().undo() })
  expect((await snapshot(page)).project).toEqual(before.project)
  await page.evaluate(async () => { const d = '/src/state/documentStore.ts'; (await import(d)).useDocumentStore.getState().redo() })
  expect((await snapshot(page)).project).toEqual(after.project)
  const next = (await move.boundingBox())!
  await move.focus(); await page.mouse.move(next.x + 12, next.y + 12); await page.mouse.down(); await page.mouse.move(next.x + 40, next.y + 12)
  await expect.poll(async () => (await snapshot(page)).preview !== null).toBe(true)
  await page.keyboard.press('Escape'); await page.mouse.up()
  expect((await snapshot(page)).project).toEqual(after.project)
  expect((await snapshot(page)).preview).toBeNull()
  await page.screenshot({ path: '.tmp/issue198-rectangle.png' })
  expect(problems).toEqual([])
})

test('Bezier points offer pointer, numeric and keyboard edits plus bounded insertion/deletion', async ({ page }) => {
  const problems = errors(page); await setup(page, 'bezier')
  const select = page.getByRole('combobox', { name: 'Mask point', exact: true })
  await select.selectOption('control:0:1')
  await page.getByLabel('Point X (%)', { exact: true }).fill('25')
  await page.getByLabel('Point Y (%)', { exact: true }).fill('30')
  const before = await snapshot(page)
  await page.getByRole('button', { name: 'Set point', exact: true }).click()
  expect((await snapshot(page)).past).toBe(before.past + 1)
  const control = page.getByRole('button', { name: 'Mask control 1.1', exact: true })
  await control.focus(); await control.press('ArrowDown')
  await expect(page.getByLabel('Point Y (%)', { exact: true })).not.toHaveValue('30')
  const fractionalY = await page.getByLabel('Point Y (%)', { exact: true }).inputValue()
  expect(Number(fractionalY) * 1000 % 1).not.toBe(0)
  const beforeNumeric = await snapshot(page)
  await page.getByLabel('Point X (%)', { exact: true }).fill('26')
  await page.getByRole('button', { name: 'Set point', exact: true }).click()
  expect((await snapshot(page)).past).toBe(beforeNumeric.past + 1)
  await expect(page.getByLabel('Point Y (%)', { exact: true })).toHaveValue(fractionalY)
  const box = (await control.boundingBox())!, preDrag = await snapshot(page)
  await page.mouse.move(box.x + 12, box.y + 12); await page.mouse.down(); await page.mouse.move(box.x + 22, box.y + 20); await page.mouse.up()
  expect((await snapshot(page)).past).toBe(preDrag.past + 1)
  const count = await select.locator('option').count()
  await page.getByRole('button', { name: 'Add point', exact: true }).click()
  await expect(select.locator('option')).toHaveCount(count + 3)
  await page.getByRole('button', { name: 'Delete point', exact: true }).click()
  await expect(select.locator('option')).toHaveCount(count)
  await numeric(page, 'feather', '5')
  await page.getByLabel('Invert mask', { exact: true }).check()
  await expect.poll(() => pixel(page, 0.05, 0.05)).toEqual([64, 128, 192, 255])
  await page.screenshot({ path: '.tmp/issue198-bezier.png' })
  await page.getByRole('button', { name: 'Close mask editor', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit mask in Program', exact: true })).toBeFocused()
  expect(problems).toEqual([])
})

test('ellipse editor cancels on resize and stays usable across desktop and smaller letterboxed monitors', async ({ page }) => {
  const problems = errors(page); await setup(page, 'ellipse')
  const before = await snapshot(page), move = page.getByRole('button', { name: 'Move mask', exact: true })
  const box = (await move.boundingBox())!
  await page.mouse.move(box.x + 12, box.y + 12); await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 12)
  await expect.poll(async () => (await snapshot(page)).preview !== null).toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 }); await page.mouse.up()
  expect((await snapshot(page)).project).toEqual(before.project)
  expect((await snapshot(page)).preview).toBeNull()
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 720 })
    await expect(move).toBeVisible()
    const canvas = (await page.getByTestId('preview-canvas').boundingBox())!, handle = (await move.boundingBox())!
    expect(handle.x + handle.width / 2).toBeCloseTo(canvas.x + canvas.width * 0.45, 0)
    expect(handle.y + handle.height / 2).toBeCloseTo(canvas.y + canvas.height * 0.45, 0)
    const toolbar = page.locator('.mask-editor-toolbar')
    expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await move.focus(); await move.press('ArrowRight')
    await move.press('ArrowLeft')
  }
  const beforeResize = await snapshot(page)
  const lowerCorner = page.getByRole('button', { name: 'Resize mask bottom-right', exact: true })
  await expect(lowerCorner).toBeVisible()
  const lower = (await lowerCorner.boundingBox())!, toolbar = (await page.locator('.mask-editor-toolbar').boundingBox())!
  expect(lower.y + lower.height).toBeLessThan(toolbar.y)
  // A trial click proves native hit testing reaches the formerly covered handle.
  await lowerCorner.click({ trial: true })
  await page.mouse.move(lower.x + lower.width / 2, lower.y + lower.height / 2)
  await page.mouse.down(); await page.mouse.move(lower.x + lower.width / 2 + 8, lower.y + lower.height / 2 + 5, { steps: 3 }); await page.mouse.up()
  const afterResize = await snapshot(page)
  expect(afterResize.past).toBe(beforeResize.past + 1)
  expect(afterResize.project.sequences[0].tracks[0].clips[0].effects[0].params.width).toBeGreaterThan(0.5)
  expect(afterResize.project.sequences[0].tracks[0].clips[0].effects[0].params.height).toBeGreaterThan(0.5)
  await page.evaluate(async () => { const d = '/src/state/documentStore.ts'; (await import(d)).useDocumentStore.getState().undo() })
  expect((await snapshot(page)).project).toEqual(beforeResize.project)
  await page.screenshot({ path: '.tmp/issue198-small.png' })
  expect(problems).toEqual([])
})

test('open path points stay temporary until explicit closure and cancel safely across resize', async ({ page }) => {
  const problems = errors(page); await setup(page)
  const before = await snapshot(page)
  await expect.poll(() => pixel(page, 0.6, 0.6)).toEqual([64, 128, 192, 255])
  await page.getByRole('button', { name: 'Draw new path', exact: true }).click()
  const surface = page.getByRole('button', { name: 'Add mask path point in Program', exact: true })
  await surface.click({ trial: true })
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!
  for (const [x, y] of [[0.1, 0.1], [0.9, 0.1]]) await page.mouse.click(canvas.x + (0.2 + 0.5 * x) * canvas.width, canvas.y + (0.2 + 0.5 * y) * canvas.height)
  await expect(page.getByRole('button', { name: 'Close path', exact: true })).toBeDisabled()
  await page.getByLabel('Next point X (%)', { exact: true }).fill('10')
  await page.getByLabel('Next point Y (%)', { exact: true }).fill('90')
  await page.getByRole('button', { name: 'Add draft point', exact: true }).click()
  await expect(page.getByText(/New path · 3\/8 points/)).toBeVisible()
  expect((await snapshot(page)).project).toEqual(before.project)
  expect((await snapshot(page)).preview).toBeNull()
  await expect.poll(() => pixel(page, 0.6, 0.6)).toEqual([64, 128, 192, 255])
  await page.screenshot({ path: '.tmp/issue198-open-draft.png' })
  await page.getByRole('button', { name: 'Close path', exact: true }).click()
  const closed = await snapshot(page)
  expect(closed.past).toBe(before.past + 1)
  expect(closed.project.sequences[0].tracks[0].clips[0].effects[0].params.shape).toBe('bezier')
  await expect.poll(() => pixel(page, 0.6, 0.6)).toEqual([0, 0, 0, 255])
  await expect(page.getByRole('button', { name: 'Draw new path', exact: true })).toBeFocused()
  await page.evaluate(async () => { const d = '/src/state/documentStore.ts'; (await import(d)).useDocumentStore.getState().undo() })
  expect((await snapshot(page)).project).toEqual(before.project)
  await page.evaluate(async () => { const d = '/src/state/documentStore.ts'; (await import(d)).useDocumentStore.getState().redo() })
  expect((await snapshot(page)).project).toEqual(closed.project)
  await page.getByRole('button', { name: 'Draw new path', exact: true }).click()
  await page.getByRole('button', { name: 'Add draft point', exact: true }).click()
  await page.getByLabel('Next point X (%)', { exact: true }).press('Escape')
  expect((await snapshot(page)).project).toEqual(closed.project)
  await page.getByRole('button', { name: 'Draw new path', exact: true }).click()
  await page.getByRole('button', { name: 'Add draft point', exact: true }).click()
  await page.setViewportSize({ width: 768, height: 720 })
  await expect(page.getByRole('button', { name: 'Draw new path', exact: true })).toBeVisible()
  expect((await snapshot(page)).project).toEqual(closed.project)
  expect((await snapshot(page)).past).toBe(closed.past)
  await page.screenshot({ path: '.tmp/issue198-open-closed-small.png' })
  expect(problems).toEqual([])
})
