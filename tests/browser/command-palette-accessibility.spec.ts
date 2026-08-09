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
  await page.getByRole('textbox', { name: 'Project name' }).fill('Command QA')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
}

test('discovers only real commands, contains focus, and keeps measured editor targets', async ({
  page,
}, testInfo) => {
  const problems: string[] = []
  collectProblems(page, problems)
  await createProject(page)

  const commandTrigger = page.getByRole('button', { name: 'Commands' })
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(commandTrigger).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K')
  await expect(page.getByRole('button', { name: /Select.*\(A\)/ }))
    .toHaveAttribute('aria-keyshortcuts', 'A')
  await expect(page.getByRole('button', { name: 'one frame back' }))
    .toHaveAttribute('aria-keyshortcuts', 'ArrowLeft')

  await commandTrigger.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Projects' })).toBeFocused()

  await save.focus()
  await page.keyboard.press('Control+K')
  const dialog = page.getByRole('dialog', { name: 'Find a command' })
  const search = page.getByRole('searchbox', { name: 'Search commands' })
  await expect(dialog).toBeVisible()
  await expect(search).toBeFocused()

  await page.keyboard.press('ArrowDown')
  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  await expect(undo).toBeFocused()
  await expect(undo).toHaveAttribute('aria-disabled', 'true')
  await expect(undo).toHaveAccessibleDescription(/There is no document edit to undo/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(save).toBeFocused()

  await commandTrigger.click()
  await search.fill('close gap')
  await expect(dialog.getByText('1 command', { exact: true })).toBeVisible()
  const rippleDelete = page.getByRole('button', {
    name: 'Ripple delete selected clip',
    exact: true,
  })
  await expect(rippleDelete).toHaveAttribute('aria-disabled', 'true')
  await expect(rippleDelete).toHaveAccessibleDescription(
    /Select a clip before ripple deleting/,
  )

  await testInfo.attach('command-palette-desktop', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 720, height: 800 })
  await commandTrigger.click()
  const paletteGeometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const view = element.ownerDocument.defaultView
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: view?.innerWidth ?? 0,
      viewportHeight: view?.innerHeight ?? 0,
      documentWidth: element.ownerDocument.documentElement.scrollWidth,
    }
  })
  expect(paletteGeometry.left).toBeGreaterThanOrEqual(0)
  expect(paletteGeometry.right).toBeLessThanOrEqual(paletteGeometry.viewportWidth)
  expect(paletteGeometry.bottom).toBeLessThanOrEqual(paletteGeometry.viewportHeight)
  expect(paletteGeometry.documentWidth).toBe(paletteGeometry.viewportWidth)
  await testInfo.attach('command-palette-720px', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: 'Add text', exact: true }).click()
  const textDialog = page.getByRole('dialog', { name: 'Add text overlay' })
  const longLabel = 'A deliberately long accessibility label that remains readable while the editor is narrow'
  await textDialog.getByRole('textbox', { name: 'Text', exact: true }).fill(longLabel)
  await textDialog.getByRole('button', { name: 'Add text', exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'Video inspector sections' })).toBeVisible()
  await expect(page.getByTestId('inspector-text-content')).toHaveValue(longLabel)

  const undersizedTargets = await page.locator(
    'button, input, select, a, [role="button"], [role="slider"]',
  ).evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect()
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    if (
      rect.width === 0
      || rect.height === 0
      || style?.display === 'none'
      || style?.visibility === 'hidden'
      || element.classList.contains('media-import-input')
      || (rect.width >= 24 && rect.height >= 24)
    ) return []
    const label = element.closest('label')
    if (label) {
      const labelRect = label.getBoundingClientRect()
      if (labelRect.width >= 24 && labelRect.height >= 24) return []
    }
    return [{
      name: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent,
      width: rect.width,
      height: rect.height,
    }]
  }))
  expect(undersizedTargets).toEqual([])

  await testInfo.attach('active-inspector-targets', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })

  expect(problems).toEqual([])
})
