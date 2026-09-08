/** Separate six-checkpoint observation; accepted G3 flows remain frozen. */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import type { currentProbe } from './first-paint-client'
import type { Checkpoint } from './first-paint-model'

type Probe = ReturnType<typeof currentProbe>
type Observation = { warnings: unknown[]; errors: unknown[]; pageErrors: string[]; screenshots: unknown[]; cleanupErrors: string[]; encoded: string[] }
const observations = new Map<string, Observation>()
async function call<K extends keyof Probe>(page: Page, method: K, ...args: Parameters<Probe[K]>): Promise<Awaited<ReturnType<Probe[K]>>> {
  return page.evaluate(async ({ method, args }) => {
    const path = '/tests/diagnostics/issue200/first-paint-client.ts'
    return (await import(path)).currentProbe()[method](...args)
  }, { method, args })
}
async function json(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(name)
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
  await info.attach(name, { path, contentType: 'application/json' })
}
async function binary(info: TestInfo, name: string, bytes: Buffer, contentType: string) {
  const path = info.outputPath(name)
  await writeFile(path, bytes)
  await info.attach(name, { path, contentType })
}
async function retainEncoded(info: TestInfo, name: string, encoded: { metadata: unknown; rgbaBase64: string; pngBase64: string }) {
  await json(info, `${name}.json`, encoded.metadata)
  await binary(info, `${name}.rgba.gz`, gzipSync(Buffer.from(encoded.rgbaBase64, 'base64')), 'application/gzip')
  await binary(info, `${name}.canvas.png`, Buffer.from(encoded.pngBase64, 'base64'), 'image/png')
}
async function retainCapture(page: Page, info: TestInfo, name: string) {
  await retainEncoded(info, name, await call(page, 'encoded', name))
  observations.get(info.testId)!.encoded.push(name)
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const startedAt = Date.now(), path = info.outputPath(`${name}.page.png`)
  await page.screenshot({ path })
  const completedAt = Date.now()
  await info.attach(`${name}.page.png`, { path, contentType: 'image/png' })
  const identity = await page.evaluate(() => ({ url: location.href, title: document.title, bodyTextLength: document.body.innerText.trim().length,
    viteOverlays: document.querySelectorAll('vite-error-overlay').length,
    canvasBounds: document.querySelector('[data-testid="preview-canvas"]')?.getBoundingClientRect().toJSON() ?? null }))
  observations.get(info.testId)!.screenshots.push({ name, path, startedAt, completedAt, identity, clock: 'Node Date.now wall time; distinct from browser performance clock' })
  expect(identity.url).toBe('http://127.0.0.1:5200/'); expect(identity.title).toMatch(/Myrelith/i)
  expect(identity.bodyTextLength).toBeGreaterThan(50); expect(identity.viteOverlays).toBe(0)
}
async function checkpoint(page: Page, info: TestInfo, name: Checkpoint, pin: ReturnType<Probe['pin']>, requirePresentation: boolean) {
  // Readback is synchronous in this evaluation. PNG encoding/reference work runs
  // after the page screenshot, never as a wait before the original G3 boundary.
  const captured = await call(page, 'capture', name, pin, requirePresentation)
  await screenshot(page, info, name)
  await retainCapture(page, info, name)
  await json(info, `${name}.boundary.json`, captured)
  await json(info, 'live-ledger.json', await call(page, 'summary'))
}

/** Verbatim canonical G3 lifecycle and selectors; no intervening launcher wait. */
async function openPortableTitle(page: Page, wire: string, frame = 0) {
  const evidence = await page.evaluate(async ({ wire, frame }) => {
    const p = '/src/app/projectController.ts', d = '/src/state/documentStore.ts', f = '/src/domain/projectFile.ts'
    const t = '/src/state/transportStore.ts', s = '/src/state/titleEditorStore.ts', session = '/src/state/projectSessionStore.ts'
    const lifecycle = await import(p), files = await import(f), store = (await import(d)).useDocumentStore
    const left = await lifecycle.leaveActiveProject()
    if (left.status !== 'ready') throw new Error(JSON.stringify(left))
    const opened = await lifecycle.openProjectFile(new File([wire], 'title-g3.myrelith', { type: 'application/json' }))
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
  await test.info().attach(`portable-title-open-${test.info().attachments.length}`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  expect(evidence).toEqual({ left: 'ready', opened: 'ready', activated: 'activated', past: 0, future: 0, wire,
    session: { screen: 'editor', phase: 'idle', error: null, saveError: null, recoveryError: null } })
  await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeVisible()
}
async function wire(page: Page) {
  return page.evaluate(async () => {
    const d = '/src/state/documentStore.ts', f = '/src/domain/projectFile.ts'
    const files = await import(f)
    return files.serializeProjectFile(files.createProjectFileSnapshot((await import(d)).useDocumentStore.getState().project, [], []))
  })
}

test.beforeEach(async ({ page }, info) => {
  const observation: Observation = { warnings: [], errors: [], pageErrors: [], screenshots: [], cleanupErrors: [], encoded: [] }
  observations.set(info.testId, observation)
  page.on('console', (message) => {
    const record = { text: message.text(), location: message.location() }
    if (message.type() === 'warning') observation.warnings.push(record)
    if (message.type() === 'error') observation.errors.push(record)
  })
  page.on('pageerror', (error) => observation.pageErrors.push(error.message))
})

test('fallback reopen records the original boundary and six actual canvas checkpoints', async ({ page }, info) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByLabel('Project name').fill('Title G3 authoring')
  await page.getByLabel('Resolution').selectOption('720')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
  const fixtures = await page.evaluate(async () => {
    const observer = '/tests/diagnostics/issue200/first-paint-client.ts', model = '/tests/diagnostics/issue200/first-paint-model.ts'
    ;(await import(observer)).install()
    const m = await import(model), f = m.firstPaintFixtures()
    return { initial: m.wireOf(f.initial), unavailable: m.wireOf(f.unavailable), fallback: m.wireOf(f.fallback) }
  })
  let mark = await call(page, 'mark', 'initial')
  await openPortableTitle(page, fixtures.initial)
  let pin = await call(page, 'pin', mark)
  await call(page, 'wait', pin)
  await checkpoint(page, info, 'initial-generic', pin, true)

  mark = await call(page, 'mark', 'unavailable')
  await openPortableTitle(page, fixtures.unavailable)
  await expect(page.locator('.preview-title-status')).toContainText('Title unavailable')
  pin = await call(page, 'pin', mark)
  await call(page, 'wait', pin)
  await checkpoint(page, info, 'unavailable', pin, true)

  mark = await call(page, 'mark', 'fallback-ui', false)
  await page.getByRole('combobox', { name: 'Explicit font fallback', exact: true }).selectOption('serif')
  await expect(page.locator('.preview-title-status')).toContainText('explicit serif fallback')
  const saved = await wire(page)
  expect(saved).toBe(fixtures.fallback)
  pin = await call(page, 'pin', mark)
  await call(page, 'wait', pin)
  await checkpoint(page, info, 'fallback-before-reopen', pin, true)

  mark = await call(page, 'mark', 'fallback-reopen')
  await openPortableTitle(page, saved)
  await expect(page.locator('.preview-title-status')).toContainText('explicit serif fallback')
  expect(await wire(page)).toBe(saved)
  pin = await call(page, 'pin', mark)
  await checkpoint(page, info, 'reopened-at-notice', pin, false)
  await call(page, 'wait', pin)
  await checkpoint(page, info, 'reopened-presented', pin, true)
  await call(page, 'stable', pin)
  await checkpoint(page, info, 'reopened-stable', pin, true)

  const result = await call(page, 'compare')
  for (const item of result.references) {
    await retainEncoded(info, `${item.name}.reference`, item.reference)
    await retainEncoded(info, `${item.name}.empty`, item.empty)
  }
  for (const control of result.controls) await binary(info, `${control.name}.glyph-mask.u8.gz`, gzipSync(Buffer.from(control.glyphMaskBase64, 'base64')), 'application/gzip')
  await json(info, 'pixel-comparisons.json', { ...result, references: result.references.map(({ name }) => name), controls: result.controls.map(({ glyphMaskBase64: _mask, ...control }) => control) })
  expect(result.rows).toHaveLength(6)
  expect(result.failures).toEqual([])
  expect(await wire(page)).toBe(saved)
})

test.afterEach(async ({ page }, info) => {
  const observation = observations.get(info.testId)!
  try {
    if (!page.isClosed()) {
      try {
        const summary = await call(page, 'summary')
        await json(info, 'final-ledger.json', summary)
        for (const name of summary.captureNames) if (!observation.encoded.includes(name)) await retainCapture(page, info, name)
        await screenshot(page, info, 'observed-end')
        if (info.status === 'passed') {
          expect(summary.dropped).toBe(0); expect(summary.issues).toEqual([])
          expect(summary.captureNames).toHaveLength(6)
          expect(summary.current.session).toMatchObject({ screen: 'editor', phase: 'idle', error: null, saveError: null, recoveryError: null })
          expect(await page.locator('vite-error-overlay').count()).toBe(0)
        }
      } catch (error) { observation.cleanupErrors.push(`Final evidence: ${String(error)}`) }
      try {
        const release = await call(page, 'dispose')
        await json(info, 'observer-release.json', release)
        expect(release).toMatchObject({ disposed: true, subscriptions: 0, waiters: 0, liveBuffers: 0, issues: [], dropped: 0 })
      } catch (error) { observation.cleanupErrors.push(`Observer release: ${String(error)}`) }
      try {
        const left = await page.evaluate(async () => {
          const p = '/src/app/projectController.ts', s = '/src/state/projectSessionStore.ts'
          const result = await (await import(p)).leaveActiveProject()
          return { result, session: (await import(s)).useProjectSessionStore.getState() }
        })
        await json(info, 'project-release.json', left)
        expect(left.result.status).toBe('ready')
        expect(left.session).toMatchObject({ screen: 'home', phase: 'idle', error: null, saveError: null, recoveryError: null })
      } catch (error) { observation.cleanupErrors.push(`Project release: ${String(error)}`) }
      try { await page.close() }
      catch (error) { observation.cleanupErrors.push(`Page close: ${String(error)}`) }
    } else observation.cleanupErrors.push('Page closed before evidence and lifecycle cleanup')
  } finally {
    await json(info, 'browser-observations.json', observation)
    observations.delete(info.testId)
  }
  expect(observation.warnings).toEqual([]); expect(observation.errors).toEqual([])
  expect(observation.pageErrors).toEqual([]); expect(observation.cleanupErrors).toEqual([])
})
