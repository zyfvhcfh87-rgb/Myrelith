import { expect, test, type Page } from '@playwright/test'

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

test('OS file drops stay in the editor and reach Media Pool or the timeline', async ({
  page,
}, testInfo) => {
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
  await expect(page.getByTestId('media-drop-status'))
    .toHaveText('Importing 2 files.')

  await page.getByTestId('track-V1').drop({
    files: [pngFile('one.png'), pngFile('two.png')],
  })
  await expect(page).toHaveURL(editorUrl)
  await expect(page.getByTestId('media-drop-status')).toHaveText(
    'Drop one file on the timeline; drop multiple files into Media.',
  )

  await testInfo.attach('media-file-drop', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  expect(problems, problems.join('\n')).toEqual([])
})
