/** Record all six G3 flows through final screenshots; no warning/error omission. */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

type Observation = { warnings: unknown[]; errors: unknown[]; pageErrors: string[]; screenshots: unknown[] }
const runs = new Map<string, Observation>()
async function identity(page: Page) {
  const text = await page.locator('body').innerText({ timeout: 3000 })
  const session = await page.evaluate(async () => {
    const path = '/src/state/projectSessionStore.ts', state = (await import(path)).useProjectSessionStore.getState()
    return { screen: state.screen, phase: state.phase, error: state.error, savePhase: state.savePhase, saveError: state.saveError,
      recoveryPhase: state.recoveryPhase, recoveryError: state.recoveryError, lastRecoveryAt: state.lastRecoveryAt }
  })
  return { url: page.url(), title: await page.title(), viewport: page.viewportSize(), bodyTextLength: text.trim().length,
    bodyExcerpt: text.slice(0, 1800), viteErrorOverlays: await page.locator('vite-error-overlay').count(),
    bodyBounds: await page.locator('body').boundingBox(), session }
}
async function persist(info: TestInfo, value: Observation) {
  await writeFile(info.outputPath('browser-observations.json'), JSON.stringify(value, null, 2))
}
test.beforeEach(async ({ page }, info) => {
  const observation: Observation = { warnings: [], errors: [], pageErrors: [], screenshots: [] }
  runs.set(info.testId, observation)
  page.on('console', (message) => {
    const record = { text: message.text(), location: message.location() }
    if (message.type() === 'warning') observation.warnings.push(record)
    if (message.type() === 'error') observation.errors.push(record)
  })
  page.on('pageerror', (error) => observation.pageErrors.push(error.message))
  const screenshot = page.screenshot.bind(page)
  page.screenshot = async (options) => {
    let observed: unknown
    try { observed = await identity(page) } catch (error) { observed = { unavailable: String(error), url: page.url() } }
    const bytes = await screenshot(options)
    observation.screenshots.push({ path: options?.path ?? null, identity: observed })
    await persist(info, observation)
    return bytes
  }
})
test.afterEach(async ({ page }, info) => {
  const observation = runs.get(info.testId)!
  try {
    if (!page.isClosed()) {
      await page.screenshot({ path: info.outputPath('observed-end.png') })
      if (info.status === 'passed') {
        const observed = await identity(page)
        expect(observed.url).toBe('http://127.0.0.1:5200/')
        expect(observed.title).toMatch(/Myrelith/i)
        expect(observed.bodyTextLength).toBeGreaterThan(50)
        expect(observed.bodyBounds?.height).toBeGreaterThan(0)
        expect(observed.viteErrorOverlays).toBe(0)
        expect(observed.session).toMatchObject({ screen: 'editor', phase: 'idle', error: null, saveError: null, recoveryError: null })
        expect(observed.session.savePhase).not.toBe('error')
        expect(observed.session.recoveryPhase).not.toBe('error')
        expect(observation.errors).toEqual([])
        expect(observation.pageErrors).toEqual([])
        expect(observation.warnings).toEqual([])
      }
    }
  } finally { await persist(info, observation); runs.delete(info.testId) }
})

await import('../../browser/issue-200-title-authoring.spec.ts')
