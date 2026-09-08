import { expect, test } from '@playwright/test'
import { gradingPixel, gradingProject } from './issue-196-grading-fixtures.js'

test('portable grading survives offline reopen and exact original-media relink without LUT files', async ({ page }) => {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) problems.push(message.text()) })
  await gradingProject(page)
  const evidence = await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', m = '/src/state/mediaStore.ts', f = '/src/domain/projectFile.ts'
    const p = '/src/app/projectController.ts', g = '/src/app/colorGradingController.ts', lut = '/src/domain/colorLut.ts'
    const edits = '/src/domain/colorGradingEdits.ts', commitPath = '/src/app/colorLutController.ts', t = '/src/state/transportStore.ts'
    const { useDocumentStore } = await import(d), { useMediaStore } = await import(m)
    const { createProjectFileSnapshot, serializeProjectFile } = await import(f)
    const { leaveActiveProject, openProjectFile, activateResumedProject, connectActiveAssetMedia } = await import(p)
    const { addGradingEffect, commitColorGradingParams } = await import(g)
    const state = useDocumentStore.getState(), target = { kind: 'clip', sequenceId: state.activeSequenceId, clipId: 'grading-clip' }
    const { portableColorLut, parseCube } = await import(lut)
    const table = portableColorLut('portable', 'Embedded red inversion', parseCube('LUT_1D_SIZE 2\n1 0 0\n0 1 1'))
    const candidate = (await import(edits)).applyColorLutToProject(state.project, target, table, () => crypto.randomUUID())
    const applied = (await import(commitPath)).commitPortableColorEdit(state.project, state.projectGeneration, candidate)
    if (applied) throw new Error(applied)
    for (const [type, patch] of [['builtin.rgb-curves', { green: '[[0,0],[1,0.5]]' }], ['builtin.lift-gamma-gain', { gainB: 0.5 }]] as const) {
      const addError = addGradingEffect(target, type)
      if (addError) throw new Error(addError)
      const effectId = useDocumentStore.getState().doc.tracks[0].clips[0].effects.at(-1).id
      const editError = commitColorGradingParams(target, effectId, patch)
      if (editError) throw new Error(editError)
    }
    const media = useMediaStore.getState(), asset = [...media.assets.values()][0]
    const descriptor = media.descriptors.get(asset.id)
    const original = new File([await (await fetch(asset.objectUrl)).blob()], descriptor.fileName, { type: descriptor.mimeType, lastModified: descriptor.lastModified })
    const snapshot = () => serializeProjectFile(createProjectFileSnapshot(useDocumentStore.getState().project, useMediaStore.getState().descriptors.values(), useMediaStore.getState().collections))
    const serialized = snapshot()
    const left = await leaveActiveProject()
    if (left.status !== 'ready') throw new Error(JSON.stringify(left))
    const opened = await openProjectFile(new File([serialized], 'graded.myrelith', { type: 'application/json' }))
    if (opened.status !== 'ready') throw new Error(JSON.stringify(opened))
    const activated = await activateResumedProject()
    if (activated.status !== 'activated') throw new Error(JSON.stringify(activated))
    const offline = { media: useMediaStore.getState().assets.size, exact: snapshot() === serialized, tables: useDocumentStore.getState().project.colorLuts.length }
    const history = useDocumentStore.getState().past.length
    const connected = await connectActiveAssetMedia(asset.id, original)
    const transport = (await import(t)).useTransportStore.getState()
    transport.setSelectedClip('grading-clip'); transport.setPlayheadFrame(1)
    return { offline, connected, online: useMediaStore.getState().assets.size, exact: snapshot() === serialized, historyUnchanged: useDocumentStore.getState().past.length === history }
  })
  expect(evidence).toMatchObject({ offline: { media: 0, exact: true, tables: 1 }, connected: { status: 'ready' }, online: 1, exact: true, historyUnchanged: true })
  await expect.poll(() => gradingPixel(page)).toEqual([191, 64, 96, 255])
  await page.getByRole('tab', { name: 'Effects', exact: true }).click()
  await expect(page.getByText('Embedded red inversion', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/myrelith-196-reopened.png' })
  expect(problems).toEqual([])
})
