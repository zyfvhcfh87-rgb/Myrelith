import { expect, test, type Page } from '@playwright/test'

// Chromium's fake capture device stands in for a microphone; output stays muted
// and the microphone is never routed to speakers, so this test is silent.
test.use({
  launchOptions: { args: ['--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
})

function collectProblems(page: Page, problems: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
}

async function createProject(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Voiceover QA')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
}

async function recordingFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    try {
      const directory = await root.getDirectoryHandle('myrelith-recordings-v1')
      const names: string[] = []
      for await (const entry of (directory as unknown as { values(): AsyncIterable<{ name: string }> }).values()) {
        names.push(entry.name)
      }
      return names.sort()
    } catch { return [] }
  })
}

test('records, keeps on the timeline, stops with Pause, and discards through the voiceover panel', async ({ page }) => {
  const problems: string[] = []
  collectProblems(page, problems)
  await createProject(page)

  const entry = page.getByRole('button', { name: /^Voiceover$/ })
  await entry.click()
  const panel = page.getByRole('dialog', { name: 'Voiceover' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Voiceover' })).toBeFocused()
  await panel.getByLabel('Count-in').selectOption('0')
  await panel.getByRole('button', { name: 'Record at playhead' }).click()

  // The active-capture indicator is visible in the toolbar while recording.
  await expect(page.getByRole('button', { name: /^REC \d+:\d\d\.\d$/ })).toBeVisible({ timeout: 10_000 })
  await expect(panel.getByRole('status')).toContainText('Recording')
  // Let at least 1.2 s of audio reach storage before stopping.
  await page.waitForFunction(() =>
    Number(document.querySelector('.voiceover-elapsed')?.textContent?.replace(/[^\d]/g, '') ?? 0) >= 12)
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByRole('status')).toContainText('Take ready to review', { timeout: 10_000 })
  await expect(page.getByRole('button', { name: /^REC/ })).toHaveCount(0)

  await panel.getByRole('button', { name: 'Keep on timeline' }).click()
  await expect(panel.getByRole('status')).toContainText('Take placed on the timeline', { timeout: 15_000 })

  const kept = await page.evaluate(() => {
    const stores = (window as unknown as { __stores: Record<string, { getState(): Record<string, unknown> }> }).__stores
    const documentState = stores.document.getState() as unknown as {
      doc: { tracks: { id: string; kind: string; clips: { assetId: string; timelineRange: { startFrame: number; durationFrames: number } }[] }[] }
      undo(): void; redo(): void
    }
    const clips = documentState.doc.tracks.filter((track) => track.kind === 'audio').flatMap((track) =>
      track.clips.map((clip) => ({ track: track.id, ...clip.timelineRange, assetId: clip.assetId })))
    const media = stores.media.getState() as unknown as { assets: Map<string, { fileName: string; durationFrames: number }> }
    const asset = clips[0] ? media.assets.get(clips[0].assetId) : undefined
    documentState.undo()
    const afterUndo = (stores.document.getState() as unknown as typeof documentState).doc.tracks
      .flatMap((track) => track.clips).length
    ;(stores.document.getState() as unknown as typeof documentState).redo()
    return { clips, fileName: asset?.fileName ?? null, durationFrames: asset?.durationFrames ?? null, afterUndo }
  })
  expect(kept.clips).toHaveLength(1)
  expect(kept.clips[0]).toMatchObject({ startFrame: 0 })
  expect(kept.clips[0]!.durationFrames).toBe(kept.durationFrames)
  expect(kept.fileName).toMatch(/^voiceover_[0-9a-f-]+\.wav$/)
  expect(kept.afterUndo).toBe(0)
  expect(await recordingFiles(page)).toContain(kept.fileName)

  // Second take: the transport Pause button is an ordinary stop, not an interruption.
  await page.evaluate(() => {
    const stores = (window as unknown as { __stores: Record<string, { getState(): { setPlayheadFrame?(frame: number): void } }> }).__stores
    stores.transport.getState().setPlayheadFrame?.(300)
  })
  await panel.getByRole('button', { name: 'Record at playhead' }).click()
  await expect(panel.getByRole('status')).toContainText('Recording', { timeout: 10_000 })
  await page.waitForTimeout(600)
  // During a take the transport shows Pause; pressing it ends the take normally.
  await page.getByRole('button', { name: 'pause', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('Take ready to review', { timeout: 10_000 })
  await expect(panel.getByRole('button', { name: 'Keep on timeline' })).toBeEnabled()
  const reviewFiles = await recordingFiles(page)
  expect(reviewFiles.filter((name) => name.endsWith('.wav'))).toHaveLength(2)
  await panel.getByRole('button', { name: 'Discard' }).click()
  await expect(panel.getByRole('status')).toContainText('Take discarded')
  const afterDiscard = await recordingFiles(page)
  expect(afterDiscard.filter((name) => name.endsWith('.wav'))).toEqual([kept.fileName])

  // Escape closes the idle panel and returns focus to its toolbar entry.
  await panel.getByRole('heading', { name: 'Voiceover' }).focus()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(entry).toBeFocused()

  expect(problems).toEqual([])
})

test('the voiceover panel and toolbar fit a 720px-wide editor', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 800 })
  await createProject(page)
  await page.getByRole('button', { name: /Voiceover|Record a voiceover/ }).first().click()
  const panel = page.getByRole('dialog', { name: 'Voiceover' })
  await expect(panel).toBeVisible()
  const layout = await page.evaluate(() => {
    const box = document.querySelector('.voiceover-panel')!.getBoundingClientRect()
    const record = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Record at playhead'))!
      .getBoundingClientRect()
    return { left: box.left, right: box.right, width: window.innerWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      recordVisible: record.bottom <= window.innerHeight && record.right <= window.innerWidth }
  })
  expect(layout.left).toBeGreaterThanOrEqual(0)
  expect(layout.right).toBeLessThanOrEqual(layout.width)
  expect(layout.pageOverflow).toBeLessThanOrEqual(0)
  expect(layout.recordVisible).toBe(true)
})

test('a take cut off by a reload is offered for explicit recovery, never imported silently', async ({ page }) => {
  const problems: string[] = []
  collectProblems(page, problems)
  await createProject(page)
  await page.getByRole('button', { name: /^Voiceover$/ }).click()
  const panel = page.getByRole('dialog', { name: 'Voiceover' })
  await panel.getByLabel('Count-in').selectOption('0')
  await panel.getByRole('button', { name: 'Record at playhead' }).click()
  // Past the first 256 KiB checkpoint (about 2.7 s at 48 kHz mono PCM16).
  await page.waitForFunction(() =>
    Number(document.querySelector('.voiceover-elapsed')?.textContent?.replace(/[^\d]/g, '') ?? 0) >= 35,
  undefined, { timeout: 15_000 })
  await page.reload()

  // Reloading lands on the launcher; open a fresh project in the same origin.
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill('Recovery QA')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  const entry = page.getByRole('button', { name: 'Voiceover, 1 recording drafts to recover' })
  await expect(entry).toBeVisible({ timeout: 10_000 })
  const mediaBefore = await page.evaluate(() =>
    (window as unknown as { __stores: { media: { getState(): { assets: Map<string, unknown> } } } })
      .__stores.media.getState().assets.size)
  expect(mediaBefore).toBe(0)

  await entry.click()
  const recoveryPanel = page.getByRole('dialog', { name: 'Voiceover' })
  await expect(recoveryPanel.getByText('Unsaved draft', { exact: true })).toBeVisible()
  await recoveryPanel.getByRole('button', { name: 'Recover' }).click()
  await expect(recoveryPanel.getByText('Draft recovered into the Media Pool.')).toBeVisible({ timeout: 15_000 })
  await expect(recoveryPanel.getByText('Kept recording', { exact: true })).toBeVisible()
  const recovered = await page.evaluate(() => {
    const assets = (window as unknown as { __stores: { media: { getState(): { assets: Map<string, { fileName: string; durationFrames: number }> } } } })
      .__stores.media.getState().assets
    return [...assets.values()].map((asset) => ({ fileName: asset.fileName, durationFrames: asset.durationFrames }))
  })
  expect(recovered).toHaveLength(1)
  expect(recovered[0]!.fileName).toMatch(/^voiceover_.*\.wav$/)
  // At least one 256 KiB checkpoint (~2.7 s) survived; 30 fps projects have 1,600 samples per frame.
  expect(recovered[0]!.durationFrames).toBeGreaterThanOrEqual(80)
  expect(problems.filter((problem) => !problem.includes('Recording capture interrupted'))).toEqual([])
})
