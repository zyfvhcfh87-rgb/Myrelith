import { expect, test, type Page } from '@playwright/test'

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

test('export dialog opens on a 96 kHz project and stays blocked only for empty content', async ({
  page,
}) => {
  const problems: string[] = []
  collectPageProblems(page, problems)
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await expect(page.getByRole('heading', { name: /set up your canvas/i })).toBeVisible()
  await page.getByLabel('Audio quality').selectOption('96000')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export' })).toBeVisible()

  await page.getByRole('button', { name: 'Export' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export video' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Auto/ })).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Compatibility/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start export' })).toBeDisabled()
  await expect(dialog).not.toContainText(/No export profile supports this project/)

  await page.getByRole('button', { name: 'Close export dialog' }).click()
  await expect(dialog).toHaveCount(0)
  expect(problems).toEqual([])
})
