import { expect, test } from '@playwright/test'

test('local 1D and native 33-cube workers produce portable, undoable tables without source-file ownership', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()) })
  await page.goto('/')
  await expect(page).toHaveTitle(/Myrelith/)
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Portable LUT ownership')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  const result = await page.evaluate(async () => {
    const controllerPath = '/src/app/colorLutController.ts', importPath = '/src/state/colorLutImportStore.ts'
    const documentPath = '/src/state/documentStore.ts', filePath = '/src/domain/projectFile.ts'
    const { colorLutController } = await import(controllerPath)
    const { useColorLutImportStore } = await import(importPath)
    const { useDocumentStore } = await import(documentPath)
    const { createProjectFileSnapshot, serializeProjectFile, parseProjectFile } = await import(filePath)
    async function imported(content: string) {
      const state = useDocumentStore.getState(), history = state.past.length
      colorLutController.begin(new File([content], 'local.cube'), { sequenceId: state.activeSequenceId, kind: 'master' })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error('No terminal LUT result')) }, 6000)
        const unsubscribe = useColorLutImportStore.subscribe((state: { phase: string; detail: string }) => {
          if (state.phase === 'reading') return
          clearTimeout(timeout); unsubscribe()
          if (state.phase === 'ready') resolve(); else reject(new Error(state.detail))
        })
      })
      if (useDocumentStore.getState().past.length !== history) throw new Error('Import mutated history before Apply')
      const error = colorLutController.apply()
      if (error) throw new Error(error)
      if (useDocumentStore.getState().past.length !== history + 1) throw new Error('Apply did not produce exactly one edit')
    }
    await imported('LUT_1D_SIZE 2\n0.1 0.2 0.3\n0.8 0.7 0.6')
    const lines = ['TITLE "Native 33"', 'LUT_3D_SIZE 33']
    for (let b = 0; b < 33; b++) for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) lines.push(`${r / 32} ${g / 32} ${b / 32}`)
    await imported(lines.join('\n'))
    const state = useDocumentStore.getState(), expected = state.project.colorLuts
    const serialized = serializeProjectFile(createProjectFileSnapshot(state.project, []))
    state.undo()
    if (useDocumentStore.getState().project.colorLuts.length !== 1) throw new Error('Undo lost catalog ownership')
    state.redo()
    if (useDocumentStore.getState().project.colorLuts !== expected) throw new Error('Redo copied immutable table records')
    // The only input to reopening is the portable text; no source File is retained.
    const loaded = parseProjectFile(serialized)
    state.setProject(loaded)
    return { format: loaded.formatVersion, schema: loaded.sequences[0].schemaVersion,
      sizes: loaded.colorLuts.map((entry: { size: number }) => entry.size),
      sameData: serializeProjectFile(createProjectFileSnapshot(loaded, [])) === serialized,
      history: useDocumentStore.getState().past.length, serializedCharacters: serialized.length,
      digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].join(',') }
  })
  expect(result).toMatchObject({ format: 8, schema: 21, sizes: [2, 33], sameData: true, history: 0 })
  expect(result.serializedCharacters).toBeLessThan(2_000_000)
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  expect(await page.locator('vite-error-overlay').count()).toBe(0)
  await page.screenshot({ path: '/tmp/myrelith-196-gate2-browser.png' })
  await page.waitForTimeout(750)
  await expect(page.getByText('Recovery copy updated', { exact: true })).toBeVisible()
  await page.close()
  const recovery = await context.newPage()
  recovery.on('pageerror', (error) => errors.push(error.message))
  recovery.on('console', (message) => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()) })
  await recovery.goto('/')
  await recovery.getByRole('button', { name: 'Recover Portable LUT ownership', exact: true }).click()
  await recovery.getByRole('button', { name: 'Recover project', exact: true }).click()
  await expect(recovery.getByRole('button', { name: 'Commands' })).toBeVisible()
  const recoveredDigest = await recovery.evaluate(async () => {
    const d = '/src/state/documentStore.ts', f = '/src/domain/projectFile.ts'
    const project = (await import(d)).useDocumentStore.getState().project
    const { serializeProjectFile, createProjectFileSnapshot } = await import(f)
    const serialized = serializeProjectFile(createProjectFileSnapshot(project, []))
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].join(',')
  })
  expect(recoveredDigest).toBe(result.digest)
  expect(errors).toEqual([])
})
