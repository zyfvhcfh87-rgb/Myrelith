import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test.setTimeout(60_000)

// Canonical portable setup; all tested edits and downloads use visible controls.
async function enter(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Milestone captions')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Captions', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const f = '/src/test/titleOwnerFixtures.ts', c = '/src/domain/captions.ts'
    const p = '/src/domain/projectFile.ts', l = '/src/app/projectController.ts'
    const project = (await import(f)).expandedTitleProject(), captions = await import(c), files = await import(p), lifecycle = await import(l)
    project.sequences[0].captionTracks = [{ ...captions.createCaptionTrack('c', 'English', 'en'), items: [
      { id: 'c1', text: 'Hello world', range: { startFrame: 0, durationFrames: 30 } },
      { id: 'c2', text: 'Second caption', range: { startFrame: 30, durationFrames: 30 } },
    ] }]
    project.sequences[1].captionTracks = [{ ...captions.createCaptionTrack('future', 'Preserved future', 'und'),
      style: { version: 99, params: { futureAppearance: 'preserve me' } }, items: [] }]
    const wire = files.serializeProjectFile(files.createProjectFileSnapshot(project, [], []))
    if ((await lifecycle.leaveActiveProject()).status !== 'ready') throw new Error('Could not leave initial project')
    if ((await lifecycle.openProjectFile(new File([wire], 'captions.myrelith'))).status !== 'ready') throw new Error('Portable setup failed')
    if ((await lifecycle.activateResumedProject()).status !== 'activated') throw new Error('Activation failed')
  })
  await page.getByRole('button', { name: 'Captions', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Caption editor' })).toBeVisible()
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', s = (await import(d)).useDocumentStore.getState()
    return { project: s.project, tracks: s.doc.captionTracks, past: s.past.length, future: s.future.length, owners: s.retainedCaptionOwners }
  })
}
async function command(page: Page, name: string) {
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search commands' }).fill(name)
  await page.getByRole('button', { name, exact: true }).click()
}
test('caption batch and style review are atomic and survive actual Save/Open with title and future intent', async ({ page }, info) => {
  const problems: string[] = []
  page.on('pageerror', error => problems.push(error.message))
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()) })
  await enter(page)
  const before = await state(page)
  const cues = page.getByRole('listbox', { name: 'Caption cues' })
  await cues.focus(); await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByRole('option', { selected: true })).toHaveCount(2)
  await page.getByLabel('Shift frames', { exact: true }).fill('3')
  await page.getByRole('button', { name: 'Review shift', exact: true }).click()
  expect((await state(page)).project).toEqual(before.project)
  await page.keyboard.press('Escape')
  expect((await state(page)).owners).toEqual({})
  await expect(page.getByRole('button', { name: 'Review shift', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Review shift', exact: true }).click()
  await page.getByRole('button', { name: 'Apply caption edit', exact: true }).click()
  const shifted = await state(page)
  expect(shifted.past).toBe(before.past + 1)
  expect(shifted.tracks[0].items.map((cue: { range: { startFrame: number } }) => cue.range.startFrame)).toEqual([3, 33])
  await page.getByRole('button', { name: 'Review style change', exact: true }).click()
  expect((await state(page)).project).toEqual(shifted.project)
  await page.getByRole('button', { name: 'Apply caption edit', exact: true }).click()
  const styled = await state(page)
  expect(styled.past).toBe(shifted.past + 1)
  expect(styled.tracks[0].items.every((cue: { style?: { params: { italic?: boolean } } }) => cue.style?.params.italic === true)).toBe(true)
  await page.getByRole('button', { name: 'Check saved cue appearance', exact: true }).click()
  await expect(page.getByLabel('Caption appearance advisories')).toContainText('shared painter')
  await page.screenshot({ path: info.outputPath('caption-style-review-result.png') })
  await page.getByRole('button', { name: 'Close caption editor' }).click()
  expect((await state(page)).owners).toEqual({})
  await command(page, 'Undo'); expect((await state(page)).project).toEqual(shifted.project)
  await command(page, 'Redo'); expect((await state(page)).project).toEqual(styled.project)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.myrelith$/)
  const path = info.outputPath(download.suggestedFilename()); await download.saveAs(path)
  expect(await readFile(path, 'utf8')).not.toMatch(/blob:|retainedCaptionOwners|effectDocumentPreview/)
  page.on('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: 'Open a project', exact: true }).click()
  await page.getByLabel('Choose a Myrelith project file', { exact: true }).setInputFiles(path)
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Captions', exact: true })).toBeVisible()
  expect((await state(page)).project).toEqual(styled.project)
  expect((await state(page)).past).toBe(0)
  expect((await state(page)).owners).toEqual({})
  expect(problems).toEqual([])
})

test('ASS substitution and loss review download real caption files and stay keyboard accessible at narrow width', async ({ page }, info) => {
  const problems: string[] = []
  page.on('pageerror', error => problems.push(error.message))
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()) })
  await enter(page)
  const before = await state(page)
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 2000\nPlayResY: 1000\nWrapStyle: 1\nScaledBorderAndShadow: yes\nYCbCr Matrix: None\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Example Sans,50,&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,40,40,20,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Imported words`
  await page.locator('.caption-import-button input').setInputFiles({ name: 'review.ass', mimeType: 'text/x-ssa', buffer: Buffer.from(ass) })
  await expect(page.getByRole('button', { name: 'Review font substitutions' })).toBeDisabled()
  await page.getByRole('combobox', { name: 'Replace “Example Sans”' }).selectOption('serif')
  await page.getByRole('button', { name: 'Review font substitutions' }).click()
  expect((await state(page)).project).toEqual(before.project)
  await expect(page.getByRole('button', { name: 'Apply caption edit' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'I accept the disclosed caption losses' }).check()
  await page.getByRole('button', { name: 'Apply caption edit' }).click()
  const imported = await state(page)
  expect(imported.past).toBe(before.past + 1)
  expect(imported.tracks).toHaveLength(2)
  expect(imported.tracks[1].items[0].text).toBe('Imported words')
  expect(imported.tracks[1].style.params.fontFamily).toBe('serif')
  for (const format of ['SRT', 'VTT', 'ASS']) {
    await page.getByRole('button', { name: `Export ${format}`, exact: true }).click()
    await expect(page.getByRole('button', { name: 'Download caption file' })).toBeDisabled()
    await page.getByRole('checkbox', { name: 'I accept the disclosed download losses' }).check()
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download caption file' }).click()
    const download = await pending, path = info.outputPath(download.suggestedFilename())
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`))
    await download.saveAs(path)
    expect(await readFile(path, 'utf8')).toContain('Imported words')
    expect((await state(page)).project).toEqual(imported.project)
    expect((await state(page)).owners).toEqual({})
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Export ASS', exact: true }).click()
  const heading = page.getByRole('heading', { name: 'Review caption download' })
  await expect(heading).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('checkbox', { name: 'I accept the disclosed download losses' })).toBeFocused()
  await page.keyboard.press('Space'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
  await expect(page.getByRole('checkbox', { name: 'I accept the disclosed download losses' })).toBeFocused()
  const dialog = page.getByRole('dialog'), box = await dialog.boundingBox()
  expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: info.outputPath('caption-download-390.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Export ASS', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  expect((await state(page)).owners).toEqual({})
  expect(problems).toEqual([])
})
