import { expect, test, type Page } from '@playwright/test'
import { gradingPixel, gradingProject, gradingSnapshot } from './issue-196-grading-fixtures.js'

async function libraryRaw(page: Page, write?: string): Promise<string | undefined> {
  return page.evaluate(async (raw) => new Promise<string | undefined>((resolve, reject) => {
    const open = indexedDB.open('myrelith-effect-presets', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('library')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('library', raw === undefined ? 'readonly' : 'readwrite')
      const store = tx.objectStore('library')
      if (raw !== undefined) store.put(raw, 'local')
      const get = store.get('local')
      tx.oncomplete = () => { const value = get.result; db.close(); resolve(value) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), write)
}

test('a LUT preset survives reload, applies to a fresh project in one edit and owns independent data', async ({ page }) => {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) problems.push(message.text()) })
  await gradingProject(page)
  await page.getByRole('button', { name: 'Add LUT…', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose LUT' })
  await picker.getByLabel('Local .cube file').setInputFiles({ name: 'Portable red inversion.cube', mimeType: 'text/plain', buffer: Buffer.from('LUT_1D_SIZE 2\n1 0 0\n0 1 1') })
  await picker.getByRole('button', { name: 'Apply imported LUT' }).click()
  await expect.poll(() => gradingPixel(page)).toEqual([191, 128, 192, 255])
  const beforeSave = await gradingSnapshot(page)
  await page.getByRole('button', { name: 'Save preset…', exact: true }).click()
  await page.getByLabel('Preset name', { exact: true }).fill('Portable inversion')
  await page.getByRole('button', { name: 'Save local preset', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Preset saved in this browser.')
  expect(await gradingSnapshot(page)).toEqual(beforeSave)
  const saved = JSON.parse((await libraryRaw(page))!)
  expect(saved.version).toBe(2)
  expect(saved.presets[0].colorLuts).toEqual(beforeSave.project.colorLuts)
  await page.keyboard.press('Escape')
  await page.reload()
  await gradingProject(page)
  const beforeApply = await gradingSnapshot(page)
  expect(beforeApply.project.colorLuts).toEqual([])
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  await page.getByLabel('Show', { exact: true }).selectOption('presets')
  await expect(page.getByRole('dialog')).not.toContainText('missing embedded LUT')
  await page.getByRole('button', { name: 'Apply preset Portable inversion', exact: true }).click()
  const applied = await gradingSnapshot(page)
  expect(applied.past).toBe(beforeApply.past + 1)
  expect(applied.project.colorLuts).toEqual(saved.presets[0].colorLuts)
  await expect.poll(() => gradingPixel(page)).toEqual([191, 128, 192, 255])
  await page.evaluate(async () => { const path = '/src/state/documentStore.ts'; (await import(path)).useDocumentStore.getState().undo() })
  expect((await gradingSnapshot(page)).project).toEqual(beforeApply.project)
  await page.evaluate(async () => { const path = '/src/state/documentStore.ts'; (await import(path)).useDocumentStore.getState().redo() })
  await page.getByRole('button', { name: 'Browse effects…', exact: true }).click()
  await page.getByRole('button', { name: 'Delete Portable inversion', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply preset Portable inversion', exact: true })).toHaveCount(0)
  expect((await gradingSnapshot(page)).project).toEqual(applied.project)
  await page.getByLabel('Search effects').fill('Gentle contrast')
  await expect(page.getByRole('button', { name: 'Apply Gentle contrast', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Apply Gentle contrast', exact: true }).click()
  expect((await gradingSnapshot(page)).project.sequences[0].tracks[0].clips[0].effects.at(-1).type).toBe('builtin.rgb-curves')
  expect(problems).toEqual([])
})

test('real IndexedDB migration aborts atomically on quota and preserves corrupt and future records', async ({ page }) => {
  await page.goto('/')
  const valid = { id: 'old', name: 'Legacy', effects: [{ id: 'future', type: 'future.effect', version: 9, enabled: false, params: { retained: 'intent' } }] }
  const corrupt = { id: 'bad', nested: { retained: [1, 2, 'opaque'] } }
  const original = JSON.stringify({ version: 1, presets: [valid, corrupt] })
  await libraryRaw(page, original)
  const quota = await page.evaluate(async () => {
    const path = '/src/app/localEffectPresetStorage.ts', { localEffectPresetStorage } = await import(path)
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'library') throw new DOMException('Injected migration quota', 'QuotaExceededError')
      return put.apply(this, args)
    }
    try { await localEffectPresetStorage.load(); return 'unexpected success' }
    catch (cause) { return (cause as Error).message }
    finally { IDBObjectStore.prototype.put = put }
  })
  expect(quota).toBe('Injected migration quota')
  expect(await libraryRaw(page)).toBe(original)
  const view = await page.evaluate(async () => { const path = '/src/app/localEffectPresetStorage.ts'; return (await import(path)).localEffectPresetStorage.load() })
  expect(view.presets[0].colorLuts).toEqual([])
  expect(view.unavailable).toHaveLength(1)
  expect(JSON.parse((await libraryRaw(page))!)).toEqual({ version: 2, presets: [{ ...valid, colorLuts: [] }, corrupt] })
  const future = JSON.stringify({ version: 42, presets: [valid, corrupt], unknown: { retained: true } })
  await libraryRaw(page, future)
  const readOnly = await page.evaluate(async () => { const path = '/src/app/localEffectPresetStorage.ts'; return (await import(path)).localEffectPresetStorage.load() })
  expect(readOnly.readOnlyReason).toContain('read-only')
  expect(await libraryRaw(page)).toBe(future)
})
