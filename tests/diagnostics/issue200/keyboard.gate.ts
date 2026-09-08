/** Four independent native-keyboard cases. No corrective focus/scroll/store writes. */
import { test, expect, type Page, type TestInfo, type Locator } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type * as Client from './keyboard-client'
import { inside, requireSessionLedger, requireTabBudget } from './keyboard-model'

type State = ReturnType<typeof Client.snapshot>
type Run = { warnings: unknown[]; errors: unknown[]; pageErrors: string[]; cleanupErrors: string[]; events: unknown[]; tabs: number; images: string[]; probe: boolean }
const runs = new Map<string, Run>()
function run() { const value = runs.get(test.info().testId); if (!value) throw new Error('Run missing'); return value }
async function call<K extends keyof typeof Client>(page: Page, method: K, ...args: Parameters<typeof Client[K]>): Promise<Awaited<ReturnType<typeof Client[K]>>> {
  return page.evaluate(async ({ method, args }) => {
    const path = '/tests/diagnostics/issue200/keyboard-client.ts'
    return (await import(path))[method](...args)
  }, { method, args })
}
async function json(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(name)
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
  if (!info.attachments.some((item) => item.path === path)) await info.attach(name, { path, contentType: 'application/json' })
}
async function state(page: Page, label: string) {
  const value = await call(page, 'snapshot')
  run().events.push({ kind: 'state', label, value })
  await call(page, 'checkSession')
  return value
}
function unchanged(before: State, after: State) {
  expect({ wire: after.wire, history: after.history, frame: after.frame, generation: after.generation, sequenceId: after.sequenceId })
    .toEqual({ wire: before.wire, history: before.history, frame: before.frame, generation: before.generation, sequenceId: before.sequenceId })
}
function oneEdit(before: State, after: State) {
  expect(after.wire).not.toBe(before.wire)
  expect(after.past).toBe(before.past + 1); expect(after.future).toBe(0)
  const a = JSON.parse(after.history), b = JSON.parse(before.history)
  expect(a.past.slice(0, -1)).toEqual(b.past)
  expect(after.frame).toBe(before.frame); expect(after.generation).toBe(before.generation)
}
function elements(value: State) {
  const title = value.clip.title
  if (!title || title.version !== 1 || !Array.isArray(title.elements)) throw new Error('Expected bounded title')
  return title.elements
}
function textElement(value: State) {
  const e = elements(value).find((element) => element.id === 'root-element')
  if (!e || e.version !== 1 || e.kind !== 'text') throw new Error('Original text element missing')
  return e
}
async function recordFocus(page: Page, label: string) {
  const focus = await call(page, 'active')
  run().events.push({ kind: 'focus', label, focus })
  return focus
}
async function tab(page: Page, targetSteps: number, backwards = false) {
  requireTabBudget(targetSteps, ++run().tabs)
  await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab')
  return recordFocus(page, backwards ? 'Shift+Tab' : 'Tab')
}
async function seek(page: Page, target: Locator, name: string, backwards = false) {
  await expect(target).toHaveCount(1)
  for (let steps = 0; steps <= 128; steps++) {
    if (await target.evaluate((node) => node === document.activeElement)) return recordFocus(page, name)
    if (steps === 128) throw new Error(`Could not keyboard-reach ${name}`)
    await tab(page, steps + 1, backwards)
  }
  throw new Error(`Unreachable traversal: ${name}`)
}
async function screenshot(page: Page, label: string) {
  const info = test.info(), path = info.outputPath(`${run().images.length.toString().padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path }); run().images.push(path)
  await info.attach(label, { path, contentType: 'image/png' })
}
async function focused(page: Page, target: Locator, label: string, backwards = false) {
  await seek(page, target, label, backwards)
  const evidence = await call(page, 'inspectFocused'), layout = await call(page, 'titleLayout')
  run().events.push({ kind: 'control', label, evidence, layout, accessibility: await target.ariaSnapshot() })
  await screenshot(page, label)
  expect(evidence.fullyVisible, `${label} clipped`).toBe(true)
  expect(evidence.focusVisible, `${label} lacks focus-visible`).toBe(true)
  expect(evidence.outline.width).toBeGreaterThan(0); expect(evidence.outline.style).not.toBe('none')
  expect(evidence.outline.measured.ratio, `${label} focus contrast`).toBeGreaterThanOrEqual(3)
  if (evidence.text.trim() || evidence.value) expect(evidence.paint.measured.ratio, `${label} text contrast`).toBeGreaterThanOrEqual(4.5)
  for (const item of evidence.labels) {
    expect(item.fullyVisible, `${label} label clipped`).toBe(true)
    expect(item.paint.measured.ratio, `${label} label contrast`).toBeGreaterThanOrEqual(4.5)
  }
  for (const item of layout.containers) expect(item.scrollWidth, `${item.className} horizontal overflow`).toBeLessThanOrEqual(item.width + 1)
  return evidence
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
async function activate(page: Page, name: string, backwards = false) { await focused(page, button(page, name), name.replaceAll(/[^a-z0-9]+/gi, '-'), backwards); await page.keyboard.press('Enter') }
async function type(page: Page, value: string) { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(value) }

/** Canonical G3 portable leave/open/activate and selection, with fixed frame 12. */
async function openPortableTitle(page: Page, wire: string, frame: number) {
  const evidence = await page.evaluate(async ({ wire, frame }) => {
    const p = '/src/app/projectController.ts', d = '/src/state/documentStore.ts', f = '/src/domain/projectFile.ts'
    const t = '/src/state/transportStore.ts', s = '/src/state/titleEditorStore.ts', session = '/src/state/projectSessionStore.ts'
    const lifecycle = await import(p), files = await import(f), store = (await import(d)).useDocumentStore
    const left = await lifecycle.leaveActiveProject()
    if (left.status !== 'ready') throw new Error(JSON.stringify(left))
    const opened = await lifecycle.openProjectFile(new File([wire], 'title-keyboard.myrelith', { type: 'application/json' }))
    if (opened.status !== 'ready') throw new Error(JSON.stringify(opened))
    const activated = await lifecycle.activateResumedProject()
    if (activated.status !== 'activated') throw new Error(JSON.stringify(activated))
    const state = store.getState(), transport = (await import(t)).useTransportStore
    const clip = state.doc.tracks[0].clips[0]
    transport.getState().setSelectedClip(clip.id); transport.getState().setPlayheadFrame(frame)
    ;(await import(s)).useTitleEditorStore.getState().select(clip.id, clip.title?.elements.slice(0, 1).map((element: { id: string }) => element.id) ?? [])
    const active = (await import(session)).useProjectSessionStore.getState()
    return { left: left.status, opened: opened.status, activated: activated.status, past: state.past.length, future: state.future.length,
      wire: files.serializeProjectFile(files.createProjectFileSnapshot(state.project, [], [])),
      session: { screen: active.screen, phase: active.phase, error: active.error, saveError: active.saveError, recoveryError: active.recoveryError } }
  }, { wire, frame })
  run().events.push({ kind: 'canonical-entry', evidence })
  expect(evidence).toEqual({ left: 'ready', opened: 'ready', activated: 'activated', past: 0, future: 0, wire,
    session: { screen: 'editor', phase: 'idle', error: null, saveError: null, recoveryError: null } })
}
async function enter(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Title keyboard evidence')
  await page.getByLabel('Resolution').selectOption('720')
  await button(page, 'Create project').click()
  await expect(button(page, 'Commands')).toBeVisible()
  await call(page, 'observe'); run().probe = true
  const fixture = await call(page, 'fixture')
  run().events.push({ kind: 'fixed-fixture', fixture })
  await openPortableTitle(page, fixture.wire, fixture.frame)
  const before = await state(page, 'before-declared-layout-setup')
  await button(page, 'Focus Inspector').click()
  await expect(button(page, 'Focus Inspector')).toHaveAttribute('aria-pressed', 'true')
  unchanged(before, await state(page, 'after-declared-layout-setup'))
  run().events.push({ kind: 'keyboard-boundary', layout: await call(page, 'titleLayout') })
}
async function status(page: Page, expected: string, label: string) {
  await expect(page.getByRole('region', { name: 'Title authoring' }).getByRole('status')).toContainText(expected)
  const evidence = await call(page, 'statuses')
  run().events.push({ kind: 'status', label, evidence, accessibility: await page.getByRole('region', { name: 'Title authoring' }).ariaSnapshot() })
  await screenshot(page, label)
  expect(evidence.length).toBeGreaterThan(0)
  for (const item of evidence) { expect(item.fullyVisible).toBe(true); expect(item.paint.measured.ratio).toBeGreaterThanOrEqual(4.5) }
}

async function controls(page: Page) {
  await enter(page)
  const initial = await state(page, 'initial'), textChoice = page.getByRole('checkbox', { name: 'Text text', exact: true })
  await focused(page, textChoice, 'text-selection')
  expect(initial.selectedElements).toEqual(['root-element'])
  await activate(page, 'Add rectangle')
  const added = await state(page, 'added'); oneEdit(initial, added)
  const addedElements = elements(added), rectId = addedElements[1].id
  expect(addedElements.map((e) => e.kind)).toEqual(['text', 'rectangle']); expect(rectId).not.toBe('root-element')
  await focused(page, page.getByRole('checkbox', { name: 'Rectangle rectangle', exact: true }), 'rectangle-selection', true)
  await page.keyboard.press('Space')
  const multi = await state(page, 'selected-both'); unchanged(added, multi); expect(multi.selectedElements).toEqual(['root-element', rectId])
  await focused(page, textChoice, 'text-deselection', true); await page.keyboard.press('Space')
  const selected = await state(page, 'selected-rectangle'); unchanged(multi, selected); expect(selected.selectedElements).toEqual([rectId])
  await activate(page, 'Move Rectangle backward')
  const ordered = await state(page, 'ordered'); oneEdit(selected, ordered); expect(elements(ordered).map((e) => e.id)).toEqual([rectId, 'root-element'])
  await activate(page, 'Delete elements')
  const deleted = await state(page, 'deleted'); oneEdit(ordered, deleted); expect(elements(deleted)).toEqual(elements(initial))
  await focused(page, page.getByRole('spinbutton', { name: 'Position X', exact: true }), 'position-x')
  await type(page, '20'); await page.keyboard.press('Enter')
  const entered = await state(page, 'number-enter'); oneEdit(deleted, entered); expect(textElement(entered).transform.x).toBe(20)
  await tab(page, 1); unchanged(entered, await state(page, 'number-blur'))
  await focused(page, page.getByRole('spinbutton', { name: 'Position X', exact: true }), 'position-x-cancel', true)
  await type(page, '45'); await page.keyboard.press('Escape'); await tab(page, 1)
  unchanged(entered, await state(page, 'number-escape'))
  await focused(page, button(page, 'Move title element Text'), 'move-title', true)
  await page.keyboard.press('ArrowRight'); const right = await state(page, 'move-right'); oneEdit(entered, right); expect(textElement(right).transform.x).toBe(21)
  await page.keyboard.press('Shift+ArrowUp'); const up = await state(page, 'move-up'); oneEdit(right, up); expect(textElement(up).transform.y).toBe(-10)
  await focused(page, button(page, 'Resize title element Text'), 'resize-title')
  await page.keyboard.press('ArrowRight'); const resized = await state(page, 'resize-right'); oneEdit(up, resized); expect(textElement(resized).text.boxWidthPx).toBe(802)
  await activate(page, 'Commands', true)
  await expect(page.getByRole('searchbox', { name: 'Search commands' })).toBeFocused()
  await page.keyboard.type('Undo'); await page.keyboard.press('ArrowDown')
  await expect(button(page, 'Undo')).toBeFocused(); await page.keyboard.press('Enter')
  const undone = await state(page, 'undo-resize'); expect(undone.wire).toBe(up.wire); expect(undone.past).toBe(up.past); expect(undone.future).toBe(1); expect(undone.frame).toBe(12)
  await focused(page, page.getByRole('checkbox', { name: 'Safe guides · title 90% / action 95%', exact: true }), 'safe-guides')
  expect(undone.guides).toBe(false); await page.keyboard.press('Space')
  const guided = await state(page, 'guides-on'); unchanged(undone, guided); expect(guided.guides).toBe(true)
  const g = await call(page, 'guides'); run().events.push({ kind: 'safe-guide-geometry', evidence: g })
  for (const guide of g.guides) {
    expect(guide.ariaHidden).toBe('true'); expect(guide.stroke).toBe('dashed')
    expect(guide.bounds.x).toBeCloseTo(g.canvas.x + g.canvas.width * (1 - guide.ratio) / 2, 1)
    expect(guide.bounds.y).toBeCloseTo(g.canvas.y + g.canvas.height * (1 - guide.ratio) / 2, 1)
    expect(guide.bounds.width).toBeCloseTo(g.canvas.width * guide.ratio, 1); expect(guide.bounds.height).toBeCloseTo(g.canvas.height * guide.ratio, 1)
  }
  await screenshot(page, 'guides-on')
  const fallback = page.getByRole('combobox', { name: 'Explicit font fallback', exact: true })
  await focused(page, fallback, 'fallback', true)
  await page.keyboard.press('Home')
  const missing = await state(page, 'no-fallback'); oneEdit(guided, missing); expect(textElement(missing).font).toEqual({ family: 'Missing Keyboard Face', fallbackFamily: null })
  await status(page, 'Missing Keyboard Face is unavailable', 'font-unavailable')
  // Open the native select popup; intermediate navigation must not create edits.
  await page.keyboard.press('Space'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  const restored = await state(page, 'serif-restored'); oneEdit(missing, restored); expect(restored.wire).toBe(guided.wire)
  await status(page, 'serif · platform-dependent fallback for Missing Keyboard Face', 'font-fallback')
}

async function dialogCycle(page: Page, label: string) {
  const modal = await call(page, 'modal'); run().events.push({ kind: 'dialog', label, modal, accessibility: await page.getByRole('dialog').ariaSnapshot() })
  const v = page.viewportSize()!
  expect(modal.modal).toBe(true); expect(modal.focusInside).toBe(true)
  expect(inside(modal.rect, { x: 16, y: 16, width: v.width - 32, height: v.height - 32 })).toBe(true)
  expect(modal.scrollWidth).toBeLessThanOrEqual(modal.clientWidth + 1)
  expect(modal.controls.length).toBeGreaterThan(1)
  const first = await recordFocus(page, `${label}-initial`), seen: number[] = []
  for (let i = 1; i <= modal.controls.length; i++) {
    const next = await tab(page, i); if (!next) throw new Error('Focus disappeared')
    expect((await call(page, 'modal')).focusInside).toBe(true); seen.push(next.id)
  }
  expect(seen.at(-1)).toBe(first?.id)
  expect(new Set(seen)).toEqual(new Set(modal.controls.map((c) => c.id)))
  for (let i = 1; i <= modal.controls.length; i++) {
    await tab(page, i, true); expect((await call(page, 'modal')).focusInside).toBe(true)
  }
  expect((await call(page, 'active'))?.id).toBe(first?.id)
  await screenshot(page, `${label}-focus-wrap`)
}
async function dialogs(page: Page) {
  await enter(page)
  const before = await state(page, 'before-dialogs'), motion = button(page, 'Roll / crawl…')
  await activate(page, 'Roll / crawl…'); await expect(page.getByRole('dialog', { name: 'Roll / crawl', exact: true })).toBeVisible()
  await dialogCycle(page, 'motion')
  await focused(page, page.getByRole('combobox', { name: 'Direction', exact: true }), 'motion-direction')
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('combobox', { name: 'Direction', exact: true })).toHaveValue('down')
  await focused(page, page.getByRole('spinbutton', { name: 'Preview local frame', exact: true }), 'motion-frame')
  await type(page, '48'); await tab(page, 1)
  await activate(page, 'Preview motion'); expect((await state(page, 'motion-preview')).previewOwner).toBe('title-authoring')
  await page.keyboard.press('Escape'); await expect(motion).toBeFocused()
  const cancelled = await state(page, 'motion-escape'); unchanged(before, cancelled); expect(cancelled.previewOwner).toBeNull()
  await page.keyboard.press('Enter'); await expect(page.getByRole('dialog', { name: 'Roll / crawl', exact: true })).toBeVisible()
  await activate(page, 'Cancel'); await expect(motion).toBeFocused(); unchanged(before, await state(page, 'motion-cancel'))
  const save = button(page, 'Save title template…')
  await activate(page, 'Save title template…'); await expect(page.getByRole('dialog', { name: 'Save title template', exact: true })).toBeVisible()
  await expect.poll(async () => (await call(page, 'snapshot')).library.loaded).toBe(true)
  const library = (await state(page, 'library-loaded')).library.entries
  await dialogCycle(page, 'save-template')
  await focused(page, page.getByRole('textbox', { name: 'Template name', exact: true }), 'template-name')
  await type(page, 'Cancelled keyboard title'); await page.keyboard.press('Escape'); await expect(save).toBeFocused()
  const saveCancelled = await state(page, 'save-cancelled'); unchanged(before, saveCancelled); expect(saveCancelled.library.entries).toEqual(library)
  const templates = button(page, 'Title templates')
  await activate(page, 'Title templates', true); await expect(page.getByRole('dialog', { name: 'Title templates', exact: true })).toBeVisible()
  await dialogCycle(page, 'template-library')
  const builtins = page.getByRole('dialog').locator('.title-actions button')
  expect(await builtins.count()).toBe(3)
  const second = builtins.nth(1)
  await focused(page, second, 'second-builtin'); await page.keyboard.press('Enter'); await expect(second).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('dialog').locator('.title-template-review strong')).toHaveText((await second.innerText()).trim())
  await focused(page, page.getByRole('combobox', { name: 'Destination track', exact: true }), 'destination-track')
  await focused(page, button(page, 'Apply template'), 'apply-template'); await focused(page, button(page, 'Cancel'), 'template-cancel')
  await page.keyboard.press('Escape'); await expect(templates).toBeFocused()
  const final = await state(page, 'all-dialogs-cancelled'); unchanged(before, final); expect(final.library.entries).toEqual(library); expect(final.previewOwner).toBeNull()
}

test.beforeEach(async ({ page }, info) => {
  const value: Run = { warnings: [], errors: [], pageErrors: [], cleanupErrors: [], events: [], tabs: 0, images: [], probe: false }
  runs.set(info.testId, value)
  page.on('console', (message) => { const record = { text: message.text(), location: message.location() }; if (message.type() === 'warning') value.warnings.push(record); if (message.type() === 'error') value.errors.push(record) })
  page.on('pageerror', (error) => value.pageErrors.push(error.message))
})
test.afterEach(async ({ page }, info) => {
  const value = runs.get(info.testId)!
  try {
    if (!page.isClosed()) {
      try { await screenshot(page, 'end'); if (value.probe) value.events.push({ kind: 'final', state: await call(page, 'snapshot'), layout: await call(page, 'titleLayout') }) }
      catch (cause) { value.cleanupErrors.push(`Final evidence: ${String(cause)}`) }
      if (value.probe) {
        try {
          const left = await page.evaluate(async () => { const p = '/src/app/projectController.ts'; return (await import(p)).leaveActiveProject() })
          value.events.push({ kind: 'project-leave', left }); expect(left).toMatchObject({ status: 'ready' })
          const released = await call(page, 'snapshot'); value.events.push({ kind: 'released-state', released })
          expect(released.previewOwner).toBeNull(); expect(released.session).toMatchObject({ screen: 'home', phase: 'idle' })
        } catch (cause) { value.cleanupErrors.push(`Project cleanup: ${String(cause)}`) }
        try {
          const released = await call(page, 'sessionEvidence', true); value.events.push({ kind: 'observer-release', released })
          requireSessionLedger(released.events, released.dropped, released.issues); expect(released.subscriptions).toBe(0); expect(released.disposed).toBe(true)
        } catch (cause) { value.cleanupErrors.push(`Observer cleanup: ${String(cause)}`) }
      }
      try { await page.close() } catch (cause) { value.cleanupErrors.push(`Page cleanup: ${String(cause)}`) }
    }
  } finally {
    await json(info, 'keyboard-evidence.json', value)
    runs.delete(info.testId)
  }
  expect(value.warnings).toEqual([]); expect(value.errors).toEqual([]); expect(value.pageErrors).toEqual([]); expect(value.cleanupErrors).toEqual([])
})
for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 800 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport })
    test('keyboard title controls and status', async ({ page }) => controls(page))
    test('title dialogs, focus and cancellation', async ({ page }) => dialogs(page))
  })
}
