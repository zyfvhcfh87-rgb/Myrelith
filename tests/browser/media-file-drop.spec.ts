import { mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const fixtureDirectory = resolve('.tmp/issue-171-fixtures')
const avcAacPath = resolve(fixtureDirectory, 'avc-aac.mp4')
const aacOnlyPath = resolve(fixtureDirectory, 'aac-only.m4a')
const dropX = 240

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
  await page.getByRole('textbox', { name: 'Project name' }).fill('File drop QA')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible()
}

function pngFile(name: string): {
  name: string
  mimeType: string
  buffer: Buffer
} {
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  }
}

function fixtureFile(
  name: string,
  mimeType: string,
  path: string,
): {
  name: string
  mimeType: string
  buffer: Buffer
} {
  return { name, mimeType, buffer: readFileSync(path) }
}

function runFfmpeg(outputPath: string, args: string[]): void {
  const result = spawnSync('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...args,
    outputPath,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new Error(`ffmpeg could not start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed (${result.status ?? 'no status'}):\n${result.stderr}`,
    )
  }
}

function generateSourceBoundFixtures(): void {
  mkdirSync(fixtureDirectory, { recursive: true })
  runFfmpeg(avcAacPath, [
    '-f', 'lavfi', '-i', 'color=c=0x315b7d:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
  ])
  runFfmpeg(aacOnlyPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:a', 'aac',
    '-b:a', '96k',
  ])
}

function parseTranslateX(transform: string): number {
  const match = /translateX\(([-\d.]+)px\)/.exec(transform)
  if (!match) throw new Error(`missing translateX in ${transform}`)
  return Number(match[1])
}

async function clipGeometry(page: Page, name: string): Promise<{
  transform: string
  width: number
}> {
  const clip = page.getByRole('button', { name })
  await expect(clip).toBeVisible({ timeout: 60_000 })
  return clip.evaluate((element) => ({
    transform: (element as HTMLElement).style.transform,
    width: Number.parseFloat((element as HTMLElement).style.width),
  }))
}

async function assertIntegerDropFrame(
  page: Page,
  trackId: string,
  clipName: string,
): Promise<void> {
  const laneBox = await page.getByTestId(`track-${trackId}`).boundingBox()
  const clipBox = await page.getByRole('button', { name: clipName }).boundingBox()
  if (!laneBox || !clipBox) {
    throw new Error(`missing geometry for ${clipName} on ${trackId}`)
  }
  expect(Math.abs(clipBox.x - laneBox.x - dropX)).toBeLessThan(2)
}

type DropFile = {
  name: string
  mimeType: string
  buffer: Buffer
}

async function dropFilesAt(
  page: Page,
  testId: string,
  files: DropFile[],
  x = dropX,
): Promise<void> {
  await page.getByTestId(testId).evaluate((element, payload) => {
    const dataTransfer = new DataTransfer()
    for (const file of payload.files) {
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))
      dataTransfer.items.add(new File([bytes], file.name, { type: file.mimeType }))
    }
    const rect = element.getBoundingClientRect()
    const clientX = rect.left + payload.x
    const clientY = rect.top + 10
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX,
        clientY,
      }))
    }
  }, {
    x,
    files: files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      base64: file.buffer.toString('base64'),
    })),
  })
}

async function expectPoolItem(page: Page, fileName: string): Promise<void> {
  const search = page.getByPlaceholder('Name, codec, or format')
  await search.fill(fileName)
  await expect(page.getByTitle(fileName)).toBeVisible({ timeout: 10_000 })
  await search.fill('')
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

async function showOsInsertionMarker(page: Page, trackId: string): Promise<void> {
  await page.getByTestId(`track-${trackId}`).evaluate((element, x) => {
    const rect = element.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['x'], 'take.mp4', { type: 'video/mp4' }))
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: rect.left + x,
      clientY: rect.top + 10,
    }))
  }, dropX)
  await expect(page.getByTestId('media-placement-ghost')).toBeVisible()
}

test.beforeAll(() => {
  generateSourceBoundFixtures()
})

test('OS file drops stay in the editor and finish Media Pool and timeline import', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const problems: string[] = []
  collectProblems(page, problems)
  await createProject(page)
  const editorUrl = page.url()

  await page.locator('.area-preview').drop({
    files: [pngFile('away.png')],
  })
  await expect(page).toHaveURL(editorUrl)
  await expect(page.getByText('away.png')).toHaveCount(0)

  const pool = page.locator('.media-pool')
  await pool.drop({
    files: [pngFile('pool-a.png'), pngFile('pool-b.png')],
  })
  await expect(page).toHaveURL(editorUrl)
  await expect(page.getByTestId('media-drop-status')).toHaveText(
    'Imported 2 files.',
    { timeout: 60_000 },
  )
  await expect(page.getByTitle('pool-a.png')).toBeVisible()
  await expect(page.getByTitle('pool-b.png')).toBeVisible()

  await showOsInsertionMarker(page, 'V1')
  await dropFilesAt(page, 'track-V1', [pngFile('still.png')])
  await expect(page).toHaveURL(editorUrl)
  await expect(page.getByTestId('media-drop-status')).toHaveText(
    'Placed still.png on the timeline.',
    { timeout: 60_000 },
  )
  await expect(page.getByTestId('media-placement-ghost')).toHaveCount(0)
  await expectPoolItem(page, 'still.png')
  await assertIntegerDropFrame(page, 'V1', 'still.png, still image clip')
  await expect(page.getByRole('button', { name: 'still.png, still image clip' }))
    .toHaveAttribute('data-source-mode', 'still')

  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: 'still.png, still image clip' }))
    .toHaveCount(0)
  await expectPoolItem(page, 'still.png')

  await dropFilesAt(page, 'track-V1', [
    fixtureFile('avc-aac.mp4', 'video/mp4', avcAacPath),
  ])
  await expect(page.getByTestId('media-drop-status')).toHaveText(
    'Placed avc-aac.mp4 on the timeline.',
    { timeout: 60_000 },
  )
  await expect(page.getByTestId('media-placement-ghost')).toHaveCount(0)
  const video = await clipGeometry(page, 'avc-aac.mp4, video clip')
  const audio = await clipGeometry(page, 'avc-aac.mp4, audio clip')
  await assertIntegerDropFrame(page, 'V1', 'avc-aac.mp4, video clip')
  expect(parseTranslateX(audio.transform)).toBe(parseTranslateX(video.transform))
  expect(audio.width).toBe(video.width)
  await expect(page.locator('[data-testid$="-link"]')).toHaveCount(2)
  await expectPoolItem(page, 'avc-aac.mp4')

  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: 'avc-aac.mp4, video clip' }))
    .toHaveCount(0)
  await expect(page.getByRole('button', { name: 'avc-aac.mp4, audio clip' }))
    .toHaveCount(0)
  await expectPoolItem(page, 'avc-aac.mp4')

  await dropFilesAt(page, 'track-A1', [
    fixtureFile('aac-only.m4a', 'audio/mp4', aacOnlyPath),
  ])
  await expect(page.getByTestId('media-drop-status')).toHaveText(
    'Placed aac-only.m4a on the timeline.',
    { timeout: 60_000 },
  )
  await expect(page.getByRole('button', { name: 'aac-only.m4a, audio clip' }))
    .toBeVisible()
  await assertIntegerDropFrame(page, 'A1', 'aac-only.m4a, audio clip')
  await expectPoolItem(page, 'aac-only.m4a')

  await page.getByTestId('track-V2').drop({
    files: [pngFile('one.png'), pngFile('two.png')],
  })
  await expect(page).toHaveURL(editorUrl)
  await expect(page.getByTestId('media-drop-status')).toHaveText(
    'Drop one file on the timeline; drop multiple files into Media.',
  )
  await expect(page.getByTestId('media-placement-ghost')).toHaveCount(0)

  await testInfo.attach('media-file-drop', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  expect(problems, problems.join('\n')).toEqual([])
})
