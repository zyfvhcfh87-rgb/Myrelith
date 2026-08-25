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
  await page.getByRole('textbox', { name: 'Project name' }).fill('Three-point QA')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
}

test('exposes targeting, insert/overwrite, and focused-monitor In marks', async ({
  page,
}, testInfo) => {
  const problems: string[] = []
  collectProblems(page, problems)
  await createProject(page)

  const v1Target = page.getByRole('button', { name: 'target track V1' })
  const v2Target = page.getByRole('button', { name: 'target track V2' })
  await expect(v1Target).toHaveAttribute('aria-pressed', 'true')
  await expect(v2Target).toHaveAttribute('aria-pressed', 'false')
  await v2Target.click()
  await expect(v2Target).toHaveAttribute('aria-pressed', 'true')
  await expect(v1Target).toHaveAttribute('aria-pressed', 'false')

  const insert = page.getByRole('button', { name: 'Insert edit' })
  await expect(insert).toBeVisible()
  await expect(insert).toHaveAttribute('aria-disabled', 'true')
  await expect(insert).toHaveAttribute(
    'title',
    'Open a source in the Source Monitor first.',
  )
  await expect(page.getByRole('button', { name: 'Overwrite edit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lift' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Extract' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Replace edit' })).toBeVisible()

  await page.getByRole('button', { name: 'Commands' }).click()
  const dialog = page.getByRole('dialog', { name: 'Find a command' })
  const search = page.getByRole('searchbox', { name: 'Search commands' })
  await search.fill('insert edit')
  const insertCommand = dialog.getByRole('button', { name: 'Insert edit', exact: true })
  await expect(insertCommand).toHaveAttribute('aria-disabled', 'true')
  await expect(insertCommand).toHaveAccessibleDescription(
    /Open a source in the Source Monitor first/,
  )
  await page.keyboard.press('Escape')

  await page.keyboard.press('i')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('o')
  await expect(page.getByTestId('timeline-in-out')).toBeVisible()
  await page.getByRole('button', { name: 'Commands' }).click()
  await search.fill('Clear In')
  await expect(dialog.getByRole('button', { name: 'Clear In', exact: true }))
    .toBeVisible()
  await page.keyboard.press('Escape')

  await testInfo.attach('three-point-desktop', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })

  await page.setViewportSize({ width: 720, height: 800 })
  await expect(page.getByRole('button', { name: 'target track V2' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Insert edit' })).toBeVisible()

  expect(problems, problems.join('\n')).toEqual([])
})
