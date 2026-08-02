import { expect, test, type Page } from '@playwright/test'

const PROJECT_NAME = 'Stage 1 Recovery Smoke'

function collectPageProblems(page: Page, problems: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`)
  })
}

async function expectHome(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'WebCut', exact: true }))
    .toBeVisible()
  await expect(page.getByRole('region', { name: 'Your projects' }))
    .toBeVisible()
}

test('recovers an unsaved project after a fresh page and clears it on exit', async ({
  context,
  page,
}) => {
  const pageProblems: string[] = []
  collectPageProblems(page, pageProblems)

  await page.goto('/')
  await expectHome(page)
  await page.getByRole('button', { name: /Create a new project/ }).click()
  await page.getByLabel('Project name').fill(PROJECT_NAME)
  await page.getByRole('button', { name: 'Create project', exact: true }).click()

  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'add video track', exact: true }).click()
  await expect(page.getByText('V5', { exact: true })).toBeVisible()
  await expect(page.getByText('Recovery copy updated', { exact: true }))
    .toBeVisible()

  // Closing without running beforeunload models a crashed tab. A new page in
  // the same browser context keeps the real origin-scoped IndexedDB contents.
  await page.close()
  const recoveryPage = await context.newPage()
  collectPageProblems(recoveryPage, pageProblems)
  await recoveryPage.goto('/')
  await expectHome(recoveryPage)

  const recoveryButton = recoveryPage.getByRole('button', {
    name: `Recover ${PROJECT_NAME}`,
    exact: true,
  })
  await expect(recoveryButton).toBeVisible()
  await recoveryButton.click()
  await expect(recoveryPage.getByRole('heading', {
    name: 'Review recovered work',
    exact: true,
  })).toBeVisible()
  await recoveryPage.getByRole('button', {
    name: 'Recover project',
    exact: true,
  }).click()

  await expect(recoveryPage.getByRole('banner').getByText(PROJECT_NAME, {
    exact: true,
  })).toBeVisible()
  await expect(recoveryPage.getByText('Unsaved changes', { exact: true }))
    .toBeVisible()
  await expect(recoveryPage.getByText('V5', { exact: true })).toBeVisible()

  const dialogPromise = recoveryPage.waitForEvent('dialog')
  const leavePromise = recoveryPage.getByRole('button', {
    name: 'Projects',
    exact: true,
  }).click()
  const dialog = await dialogPromise
  expect(dialog.type()).toBe('confirm')
  expect(dialog.message()).toContain('unsaved changes')
  await dialog.accept()
  await leavePromise
  await expectHome(recoveryPage)
  await expect(recoveryButton).toHaveCount(0)

  // A second fresh page proves the journal deletion reached IndexedDB rather
  // than only disappearing from the current in-memory project-library state.
  await recoveryPage.close()
  const cleanPage = await context.newPage()
  collectPageProblems(cleanPage, pageProblems)
  await cleanPage.goto('/')
  await expectHome(cleanPage)
  await expect(cleanPage.getByRole('button', {
    name: `Recover ${PROJECT_NAME}`,
    exact: true,
  })).toHaveCount(0)
  await expect(cleanPage.getByText('No recent projects or recovery copies yet.'))
    .toBeVisible()

  expect(pageProblems).toEqual([])
})
