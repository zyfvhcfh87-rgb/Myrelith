/** G3 observable protocol: actual UI mutations; imports are fixture setup and read-only evidence. */
import { expect, test, type Page } from '@playwright/test'
async function enter(page: Page, expanded = true) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Title G3 authoring')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  await page.evaluate(async (expanded) => {
    const f = '/src/test/titleOwnerFixtures.ts', d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts', s = '/src/state/titleEditorStore.ts'
    const fixture = await import(f), store = (await import(d)).useDocumentStore, transport = (await import(t)).useTransportStore
    store.getState().setProject(expanded ? fixture.expandedTitleProject() : fixture.legacyTitleProject())
    transport.getState().setSelectedClip('root-text'); transport.getState().setPlayheadFrame(0)
    ;(await import(s)).useTitleEditorStore.getState().select('root-text', ['root-element'])
  }, expanded)
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts', f = '/src/domain/projectFile.ts'
    const state = (await import(d)).useDocumentStore.getState(), transport = (await import(t)).useTransportStore.getState(), files = await import(f)
    const clip = state.doc.tracks[0].clips[0]
    return { clip, past: state.past.length, future: state.future.length, previewOwner: transport.effectDocumentPreview?.owner ?? null,
      history: JSON.stringify({ past: state.past, future: state.future }),
      wire: files.serializeProjectFile(files.createProjectFileSnapshot(state.project, [], [])) }
  })
}
test('compact upgrade, elements, static editing and real project undo/redo', async ({ page }, info) => {
  await enter(page, false)
  const before = await snapshot(page)
  await page.getByRole('button', { name: 'Upgrade to title', exact: true }).click()
  await page.getByLabel('Text content', { exact: true }).fill('G3 title 世界')
  await page.getByLabel('Text content', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click()
  await page.getByRole('checkbox', { name: /Rectangle rectangle/ }).check()
  await page.getByTestId('title-opacity').fill('0.5'); await page.getByTestId('title-opacity').press('Tab')
  await page.getByRole('button', { name: 'Move Rectangle backward' }).click()
  const after = await snapshot(page)
  expect(after.past - before.past).toBe(5)
  expect(after.clip.text).toBeUndefined()
  expect(after.clip.title.elements.map((e: { kind: string; opacity: number }) => [e.kind, e.opacity])).toEqual([['rectangle', .5], ['text', .5]])
  await page.screenshot({ path: info.outputPath('elements-1280.png') })
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search commands' }).fill('Undo')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  expect((await snapshot(page)).clip.title.elements[0].kind).toBe('text')
  await page.getByRole('button', { name: 'Commands', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search commands' }).fill('Redo')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  expect((await snapshot(page)).wire).toBe(after.wire)
})
test('direct manipulation, Escape cancellation and editor-only safe guides', async ({ page }, info) => {
  await enter(page)
  const handle = page.getByRole('button', { name: 'Move title element Text', exact: true })
  await expect(handle).toBeVisible()
  const before = await snapshot(page), bounds = await handle.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width / 2 + 20, bounds!.y + bounds!.height / 2 + 10, { steps: 4 }); await page.mouse.up()
  const moved = await snapshot(page)
  expect(moved.past).toBe(before.past + 1); expect(moved.clip.title.elements[0].transform.x).toBeGreaterThan(0)
  const next = await handle.boundingBox()
  await page.mouse.move(next!.x + next!.width / 2, next!.y + next!.height / 2); await page.mouse.down(); await page.mouse.move(next!.x + next!.width / 2 + 20, next!.y + next!.height / 2)
  await page.keyboard.press('Escape'); await page.mouse.up()
  expect((await snapshot(page)).wire).toBe(moved.wire)
  await page.getByRole('checkbox', { name: /Safe guides/ }).check()
  expect((await snapshot(page)).wire).toBe(moved.wire)
  await expect(page.getByTestId('title-safe-0.9')).toBeVisible(); await expect(page.getByTestId('title-safe-0.95')).toBeVisible()
  await page.screenshot({ path: info.outputPath('guides-and-handles.png') })
  await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', t = '/src/state/transportStore.ts'
    const store = (await import(d)).useDocumentStore, project = structuredClone(store.getState().project)
    const clip = project.sequences[0].tracks[0].clips[0], element = clip.title.elements[0]
    const values = { 'position-x': element.transform.x, 'position-y': element.transform.y, 'box-width': element.text.boxWidthPx, 'box-height': element.text.boxHeightPx }
    clip.animation = { ...clip.animation, titleTracks: Object.entries(values).map(([property, value]) => ({ elementId: element.id, propertyVersion: 1, property,
      keyframes: [{ frame: 0, value, easing: { type: 'linear' } }, { frame: 99, value: Number(value) + 100, easing: { type: 'linear' } }] })) }
    store.getState().setProject(project); (await import(t)).useTransportStore.getState().setPlayheadFrame(50)
  })
  const observations: unknown[] = []
  for (const mode of ['Move', 'Resize']) {
    const control = page.getByRole('button', { name: `${mode} title element Text`, exact: true })
    await expect(control).toBeVisible()
    await control.evaluate((element) => {
      const data: { down: { pointerId: number; trusted: boolean } | null; loss: { pointerId: number; trusted: boolean } | null; moves: { pointerId: number; trusted: boolean; buttons: number }[]; clickTrusted: boolean | null } = { down: null, loss: null, moves: [], clickTrusted: null }
      const down = (event: Event) => { const e = event as PointerEvent; data.down = { pointerId: e.pointerId, trusted: e.isTrusted } }
      const lost = (event: Event) => { const e = event as PointerEvent; data.loss = { pointerId: e.pointerId, trusted: e.isTrusted } }
      const move = (event: PointerEvent) => { if (data.moves.length < 32) data.moves.push({ pointerId: event.pointerId, trusted: event.isTrusted, buttons: event.buttons }) }
      const click = (event: Event) => { data.clickTrusted = event.isTrusted }
      element.addEventListener('pointerdown', down); element.addEventListener('lostpointercapture', lost); element.addEventListener('click', click)
      window.addEventListener('pointermove', move)
      Object.assign(element, { g3CaptureProbe: { data, dispose: () => { element.removeEventListener('pointerdown', down); element.removeEventListener('lostpointercapture', lost); element.removeEventListener('click', click); window.removeEventListener('pointermove', move) } } })
    })
    const probe = () => control.evaluate((element) => (element as HTMLElement & { g3CaptureProbe: { data: { down: { pointerId: number; trusted: boolean } | null; loss: { pointerId: number; trusted: boolean } | null; moves: { pointerId: number; trusted: boolean; buttons: number }[]; clickTrusted: boolean | null } } }).g3CaptureProbe.data)
    const observation: Record<string, unknown> = { mode }
    observations.push(observation)
    try {
      const clickBefore = await snapshot(page)
      await control.click()
      expect((await probe()).clickTrusted).toBe(true)
      const clicked = await snapshot(page)
      expect({ wire: clicked.wire, past: clicked.past, future: clicked.future, history: clicked.history }).toEqual({ wire: clickBefore.wire, past: clickBefore.past, future: clickBefore.future, history: clickBefore.history })
      expect(clicked.previewOwner).toBeNull()
      observation.clickPreservedProjectAndHistory = true
      observation.click = await probe()
      await control.evaluate((element) => { const probe = (element as HTMLElement & { g3CaptureProbe: { data: { down: unknown; loss: unknown; moves: unknown[] } } }).g3CaptureProbe; probe.data.down = null; probe.data.loss = null; probe.data.moves = [] })
      const beforeLoss = await snapshot(page), box = await control.boundingBox()
      expect(box).not.toBeNull()
      const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 8, y + 4, { steps: 2 })
      await expect.poll(async () => (await snapshot(page)).previewOwner).toBe('title-authoring')
      const releasedPointer = await control.evaluate((element) => {
        const probe = (element as HTMLElement & { g3CaptureProbe: { data: { down: { pointerId: number; trusted: boolean } | null; moves: unknown[] } } }).g3CaptureProbe
        const down = probe.data.down
        if (!down?.trusted || !element.hasPointerCapture(down.pointerId)) throw new Error('The actual pointer never acquired capture.')
        probe.data.moves = [] // Evidence below can only come from the next native held move.
        element.releasePointerCapture(down.pointerId)
        return down.pointerId
      })
      observation.releasedPointer = releasedPointer
      // A release request is not event proof: the next real move still holds the same mouse button.
      await page.mouse.move(x + 16, y + 8)
      await expect.poll(async () => (await probe()).loss?.trusted).toBe(true)
      const captured = await probe()
      observation.beforeMouseUp = captured
      expect(captured.loss?.pointerId).toBe(releasedPointer)
      expect(captured.moves.some((event) => event.trusted && event.pointerId === releasedPointer && (event.buttons & 1) === 1)).toBe(true)
      expect((await snapshot(page)).previewOwner).toBeNull()
      await page.mouse.up()
      const afterLoss = await snapshot(page)
      expect({ wire: afterLoss.wire, past: afterLoss.past, future: afterLoss.future, history: afterLoss.history }).toEqual({ wire: beforeLoss.wire, past: beforeLoss.past, future: beforeLoss.future, history: beforeLoss.history })
      observation.lossAndLateUpPreservedProjectAndHistory = true
    } finally {
      observation.finalProbe = await probe().catch((error: unknown) => ({ unavailable: String(error) }))
      await info.attach(`trusted-title-${mode.toLowerCase()}-capture-and-click`, { body: JSON.stringify(observation, null, 2), contentType: 'application/json' })
      await control.evaluate((element) => (element as HTMLElement & { g3CaptureProbe: { dispose(): void } }).g3CaptureProbe.dispose()).catch(() => {})
    }
  }
  await info.attach('trusted-title-capture-and-clicks', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
})
test('motion preview, cancellation, Apply and explicit Reapply', async ({ page }, info) => {
  await enter(page)
  await page.getByRole('button', { name: 'Roll / crawl…' }).click()
  const before = await snapshot(page)
  await page.getByRole('button', { name: 'Preview motion', exact: true }).click()
  expect((await snapshot(page)).previewOwner).toBe('title-authoring')
  expect((await snapshot(page)).wire).toBe(before.wire)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await snapshot(page)).previewOwner).toBeNull()
  await page.getByRole('button', { name: 'Roll / crawl…' }).click()
  await page.getByRole('button', { name: 'Apply motion', exact: true }).click()
  const applied = await snapshot(page)
  expect(applied.past).toBe(before.past + 1)
  expect(applied.clip.animation.titleTracks[0].keyframes.map((key: { frame: number }) => key.frame)).toEqual([0, 99])
  await page.getByRole('button', { name: 'Roll / crawl…' }).click()
  await expect(page.getByRole('button', { name: 'Reapply motion', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Replace all listed movement tracks' }).check()
  await page.getByLabel('End frame', { exact: true }).fill('90')
  await page.screenshot({ path: info.outputPath('reapply-review.png') })
  await page.getByRole('button', { name: 'Reapply motion', exact: true }).click()
  expect((await snapshot(page)).clip.animation.titleTracks[0].keyframes.map((key: { frame: number }) => key.frame)).toEqual([0, 90])
})
test('unknown font gets an explicit persisted fallback through real controls', async ({ page }, info) => {
  await enter(page)
  await page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', store = (await import(d)).useDocumentStore, project = structuredClone(store.getState().project)
    project.sequences[0].tracks[0].clips[0].title.elements[0].font = { family: 'Missing G3 Face', fallbackFamily: null }
    store.getState().setProject(project)
  })
  await expect(page.locator('.preview-title-status')).toContainText('Title unavailable')
  await page.getByLabel('Explicit font fallback', { exact: true }).selectOption('serif')
  await expect(page.locator('.preview-title-status')).toContainText('explicit serif fallback')
  const saved = await snapshot(page)
  expect(saved.clip.title.elements[0].font).toEqual({ family: 'Missing G3 Face', fallbackFamily: 'serif' })
  await page.evaluate(async (wire) => {
    const d = '/src/state/documentStore.ts', f = '/src/domain/projectFile.ts', p = '/src/test/titleFileBoundaryFixtures.ts'
    ;(await import(d)).useDocumentStore.getState().setProject((await import(p)).titleProjectFromFile((await import(f)).parseProjectFile(wire)))
  }, saved.wire)
  expect((await snapshot(page)).wire).toBe(saved.wire)
  await page.screenshot({ path: info.outputPath('font-fallback-reopened.png') })
})
test('local template save/use/delete retains independent project copies and real IndexedDB data', async ({ page }, info) => {
  await enter(page)
  await page.getByRole('button', { name: 'Save title template…' }).click()
  await page.getByLabel('Template name', { exact: true }).fill('My G3 title')
  await page.getByRole('button', { name: 'Save template', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Save title template' })).not.toBeVisible()
  expect((await snapshot(page)).past).toBe(0)
  await page.evaluate(async () => { const t = '/src/state/transportStore.ts'; (await import(t)).useTransportStore.getState().setPlayheadFrame(200) })
  await page.getByRole('button', { name: 'Title templates', exact: true }).click()
  await page.getByRole('button', { name: 'My G3 title', exact: true }).click()
  await expect(page.locator('.title-template-review')).toContainText('My G3 title')
  await page.screenshot({ path: info.outputPath('template-review.png') })
  await page.getByRole('button', { name: 'Apply template', exact: true }).click()
  const inserted = await snapshot(page)
  expect(inserted.past).toBe(1)
  const ids = await page.evaluate(async () => { const d = '/src/state/documentStore.ts'; return (await import(d)).useDocumentStore.getState().doc.tracks[0].clips.map((clip: { title: { elements: { id: string }[] } }) => clip.title.elements[0].id) })
  expect(new Set(ids).size).toBe(2)
  await page.getByRole('button', { name: 'Title templates', exact: true }).click()
  await page.getByRole('button', { name: 'Delete template My G3 title', exact: true }).click()
  await expect(page.getByRole('button', { name: 'My G3 title', exact: true })).not.toBeVisible()
  expect((await snapshot(page)).wire).toBe(inserted.wire)
})
test('narrow dialog controls stay reachable and project changes invalidate open reviews', async ({ page }, info) => {
  await enter(page)
  await page.getByRole('button', { name: 'Roll / crawl…' }).click()
  // Qualify the modal after resizing; workspace-wide narrow layout remains separately qualified.
  await page.setViewportSize({ width: 720, height: 800 })
  const dialog = page.getByRole('dialog', { name: 'Roll / crawl', exact: true })
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720)
  await expect(page.getByRole('button', { name: 'Apply motion', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('motion-dialog-720.png') })
  await page.evaluate(async () => { const t = '/src/state/transportStore.ts'; (await import(t)).useTransportStore.getState().setPlayheadFrame(10) })
  await expect(page.getByRole('button', { name: 'Apply motion', exact: true })).toBeDisabled()
  expect((await snapshot(page)).past).toBe(0)
})
