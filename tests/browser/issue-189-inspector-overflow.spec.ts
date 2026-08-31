import { expect, test } from '@playwright/test'

test('master audio effect controls remain reachable at 1280x720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('button', { name: 'Create project', exact: true }).click()

  await page.getByRole('button', { name: 'Add noise gate' }).click()

  const addLimiter = page.getByRole('button', { name: 'Add limiter' })
  await addLimiter.scrollIntoViewIfNeeded()

  const geometry = await addLimiter.evaluate((button) => {
    const inspector = button.closest('.area-inspector')
    if (!inspector) throw new Error('Audio effect controls must live in the Inspector')
    const buttonRect = button.getBoundingClientRect()
    const inspectorRect = inspector.getBoundingClientRect()
    return {
      buttonTop: buttonRect.top,
      buttonBottom: buttonRect.bottom,
      inspectorTop: inspectorRect.top,
      inspectorBottom: inspectorRect.bottom,
    }
  })

  expect(geometry.buttonTop).toBeGreaterThanOrEqual(geometry.inspectorTop - 0.5)
  expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.inspectorBottom + 0.5)

  await addLimiter.click()
  const stack = page.getByRole('list', { name: 'Ordered master audio effects' })
  await expect(stack).toContainText('Noise gate')
  await expect(stack).toContainText('Limiter')
})
