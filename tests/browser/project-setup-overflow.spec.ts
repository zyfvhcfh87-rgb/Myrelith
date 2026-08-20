import { expect, test, type Locator, type Page } from '@playwright/test'

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

async function openSetup(page: Page): Promise<Locator> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start a new project' }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await expect(page.getByRole('heading', { name: /set up your canvas/i }))
    .toBeVisible()
  return page.locator('.project-launch-frame-setup')
}

async function isFullyInViewport(
  locator: Locator,
  viewport: { width: number; height: number },
): Promise<boolean> {
  return locator.evaluate((element, view) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0
      && rect.height > 0
      && rect.top >= 0
      && rect.left >= 0
      && rect.bottom <= view.height
      && rect.right <= view.width
  }, viewport)
}

async function expectCreateReachable(page: Page, frame: Locator): Promise<void> {
  const create = page.getByRole('button', { name: 'Create project', exact: true })
  const audio = page.getByLabel('Audio quality')
  const heading = page.getByRole('heading', { name: /set up your canvas/i })
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Setup overflow tests require a viewport size')

  await expect(create).toBeAttached()
  await expect(audio).toBeAttached()

  const overflowY = await frame.evaluate((element) => {
    const view = element.ownerDocument.defaultView
    return view ? view.getComputedStyle(element).overflowY : ''
  })
  expect(['auto', 'scroll', 'overlay']).toContain(overflowY)

  const canScroll = await frame.evaluate((element) => (
    element.scrollHeight - element.clientHeight > 1
  ))

  if (canScroll) {
    await frame.evaluate((element) => {
      element.scrollTop = 0
    })
    await frame.hover()
    await page.mouse.wheel(0, 2400)
    expect(await frame.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  }

  await frame.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => isFullyInViewport(create, viewport)).toBe(true)
  await expect.poll(() => isFullyInViewport(audio, viewport)).toBe(true)

  await audio.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(create).toBeFocused()
  await expect.poll(() => isFullyInViewport(create, viewport)).toBe(true)

  await heading.evaluate((element) => {
    element.scrollIntoView({ block: 'start' })
  })
  await expect.poll(() => isFullyInViewport(heading, viewport)).toBe(true)
}

test('new-project setup can reach Create at 1440x900', async ({ page }) => {
  const problems: string[] = []
  collectPageProblems(page, problems)
  await page.setViewportSize({ width: 1440, height: 900 })
  const frame = await openSetup(page)
  await expectCreateReachable(page, frame)
  expect(problems).toEqual([])
})

test('new-project setup can reach Create at 390x720', async ({ page }) => {
  const problems: string[] = []
  collectPageProblems(page, problems)
  await page.setViewportSize({ width: 390, height: 720 })
  const frame = await openSetup(page)
  await expectCreateReachable(page, frame)
  expect(problems).toEqual([])
})
