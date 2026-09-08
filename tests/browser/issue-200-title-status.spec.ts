import { expect, test } from '@playwright/test'

test('title availability and explicit fallback survive real preview, reopen and responsive layout', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Title G2 preview')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  await page.evaluate(async () => {
    const h = '/src/test/titleRenderProof.ts', d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts', parser = '/src/domain/titleElements.ts'
    const helpers = await import(h), project = helpers.upgradeProofProject(helpers.titleProofProject('sans-serif', { name: 'Font check' }))
    const clip = project.sequences[0].tracks[0].clips[0], parsed = (await import(parser)).readTitleDefinition(clip.title)
    if (parsed.status !== 'supported') throw new Error('Expected supported title')
    clip.title = { version: 1, elements: parsed.title.elements.map((element: object) => ({ ...element, font: { family: 'Missing Title Font', fallbackFamily: null } })) }
    ;(await import(d)).useDocumentStore.getState().setProject(project)
    ;(await import(t)).useTransportStore.getState().setPlayheadFrame(0)
  })
  const status = page.locator('.preview-title-status')
  await expect(status).toContainText('Title unavailable')
  await expect(status).toContainText('explicit fallback')
  await page.screenshot({ path: info.outputPath('title-unavailable-1280.png') })
  const result = await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', f = '/src/domain/projectFile.ts', p = '/src/test/titleFileBoundaryFixtures.ts', edit = '/src/app/portableProjectEdit.ts', read = '/src/domain/titleElements.ts', e = '/src/domain/titleExport.ts'
    const store = (await import(d)).useDocumentStore, before = store.getState(), project = structuredClone(before.project), clip = project.sequences[0].tracks[0].clips[0]
    const blocked = (await import(e)).projectTitleExportError(project, project.rootSequenceId)
    const parsed = (await import(read)).readTitleDefinition(clip.title)
    if (parsed.status !== 'supported') throw new Error('Expected title')
    clip.title = { version: 1, elements: parsed.title.elements.map((element: object) => ({ ...element, font: { family: 'Missing Title Font', fallbackFamily: 'serif' } })) }
    const error = (await import(edit)).commitPortableProjectEdit(before.project, before.projectGeneration, project)
    if (error) throw new Error(error)
    const after = store.getState(), files = await import(f)
    const wire = files.serializeProjectFile(files.createProjectFileSnapshot(after.project, [], []))
    const reopened = (await import(p)).titleProjectFromFile(files.parseProjectFile(wire))
    store.getState().setProject(reopened)
    return { blocked, allowed: (await import(e)).projectTitleExportError(reopened, reopened.rootSequenceId), historyAdded: after.past.length - before.past.length,
      keepsRequestedName: wire.includes('Missing Title Font'), keepsFallback: wire.includes('"fallbackFamily":"serif"') }
  })
  expect(result).toMatchObject({ blocked: expect.any(String), allowed: null, historyAdded: 1, keepsRequestedName: true, keepsFallback: true })
  await expect(status).toContainText('explicit serif fallback')
  for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 800 }]) {
    await page.setViewportSize(viewport)
    await expect(status).toBeVisible()
    const bounds = await status.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.height).toBeGreaterThan(20)
    await page.screenshot({ path: info.outputPath(`title-fallback-${viewport.width}.png`) })
  }
  expect(errors).toEqual([])
})
