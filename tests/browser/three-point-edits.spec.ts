import { expect, test, type Locator, type Page } from '@playwright/test'

type ControlBox = {
  label: string
  x: number
  y: number
  width: number
  height: number
}

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

async function expectTransportGroupsNotToOverlap(page: Page): Promise<void> {
  const controlBoxes = (group: Locator): Promise<ControlBox[]> => (
    group.locator('button, input').evaluateAll((controls) => controls.map((control) => {
      const box = control.getBoundingClientRect()
      return {
        label: control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '',
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      }
    }))
  )
  const [tools, transport, zoom] = await Promise.all([
    controlBoxes(page.getByRole('group', { name: 'timeline tools' })),
    controlBoxes(page.getByTestId('transport-bar')),
    controlBoxes(page.getByRole('group', { name: 'Timeline zoom controls' })),
  ])
  expect(tools.length).toBeGreaterThan(0)
  expect(transport.length).toBeGreaterThan(0)
  expect(zoom.length).toBeGreaterThan(0)

  const overlapArea = (left: ControlBox, right: ControlBox): number => (
    Math.max(
      0,
      Math.min(left.x + left.width, right.x + right.width)
        - Math.max(left.x, right.x),
    )
    * Math.max(
      0,
      Math.min(left.y + left.height, right.y + right.height)
        - Math.max(left.y, right.y),
    )
  )
  const expectDisjoint = (left: ControlBox[], right: ControlBox[]): void => {
    for (const leftControl of left) {
      for (const rightControl of right) {
        expect(
          overlapArea(leftControl, rightControl),
          `${leftControl.label} overlaps ${rightControl.label}`,
        ).toBe(0)
      }
    }
  }

  expectDisjoint(tools, transport)
  expectDisjoint(transport, zoom)
  expectDisjoint(tools, zoom)
}

test('exposes targeting, insert/overwrite, and focused-monitor In marks', async ({
  page,
}, testInfo) => {
  const problems: string[] = []
  collectProblems(page, problems)
  await page.setViewportSize({ width: 1285, height: 1248 })
  await createProject(page)
  await expectTransportGroupsNotToOverlap(page)

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
  await expectTransportGroupsNotToOverlap(page)

  expect(problems, problems.join('\n')).toEqual([])
})
