import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

function problems(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  return errors
}
type Comparison = { differingBytes: number; maximumDelta: number; sameLines: boolean }
function exact(value: Comparison | null, label: string) {
  if (value) expect(value, label).toEqual({ differingBytes: 0, maximumDelta: 0, sameLines: true })
}

test('unchanged baseline, compact text, actual Upgrade, worker and finite export have exact pixels and line breaks', async ({ page, browser }, info) => {
  test.setTimeout(240_000)
  const errors = problems(page); await page.goto('/')
  const rows = await page.evaluate(async () => {
    const client = '/src/test/titleRenderProofClient.ts', renderer = '/.tmp/issue200-baseline/src/pipeline/render.ts', planner = '/.tmp/issue200-baseline/src/domain/videoCompositionPlan.ts'
    const { proveTitleLegacyMatrix } = await import(client)
    return proveTitleLegacyMatrix({ compositeFrame: (await import(renderer)).compositeFrame, createVideoCompositionPlanner: (await import(planner)).createVideoCompositionPlanner })
  })
  await writeFile(info.outputPath('legacy-pixel-matrix.json'), JSON.stringify({ baseline: 'ce91074c276ca6892a74addb7dd673b9a19c7eeb', browser: browser.version(), platform: process.platform, arch: process.arch, rows, errors }, null, 2))
  for (const row of rows) {
    const label = `${row.family}/${row.case}/${row.quality}`
    for (const field of ['baseline', 'upgrade', 'worker', 'export'] as const) exact(row[field], `${label}/${field}`)
    expect(row.clean, label).toBe(true); expect(row.exportClosed, label).toBe(true)
  }
  expect(rows).toHaveLength(6 * 22 * 3)
  expect(errors).toEqual([])
})

test('all thirteen scalar properties share exact seek, worker and raw export output through nested buses', async ({ page, browser }, info) => {
  test.setTimeout(240_000)
  const errors = problems(page); await page.goto('/')
  const rows = await page.evaluate(async () => { const path = '/src/test/titleRenderProofClient.ts'; return (await import(path)).proveTitleAnimationFrames() })
  await writeFile(info.outputPath('animated-pixel-matrix.json'), JSON.stringify({ browser: browser.version(), rows, errors }, null, 2))
  for (const row of rows) {
    for (const field of ['seek', 'worker', 'export'] as const) exact(row[field], `${row.easing}/${row.nested}/${row.frame}/${row.quality}/${field}`)
    expect(row.clean).toBe(true); expect(row.exportClosed).toBe(true)
  }
  expect(rows).toHaveLength(3 * 2 * 3 * 13)
  expect(errors).toEqual([])
})

test('production render bridge presents title pixels through replacement, resize, seeks and acknowledged disposal', async ({ page, browser }, info) => {
  const errors = problems(page); await page.goto('/')
  const result = await page.evaluate(async () => { const path = '/src/test/titleRenderProofClient.ts'; return (await import(path)).proveProductionTitleWorker() })
  await writeFile(info.outputPath('production-worker-pixels.json'), JSON.stringify({ browser: browser.version(), ...result, errors }, null, 2))
  for (const row of result.rows) { expect(row.differingBytes, JSON.stringify(row)).toBe(0); expect(row.maximumDelta).toBe(0) }
  expect(result.rows).toHaveLength(18)
  expect(result.failures).toEqual([]); expect(errors).toEqual([])
})

test('compact imported mask animation keeps baseline pixels and refuses a destructive Upgrade', async ({ page }, info) => {
  const errors = problems(page); await page.goto('/')
  const rows = await page.evaluate(async () => {
    const client = '/src/test/titleRenderProofClient.ts', renderer = '/.tmp/issue200-baseline/src/pipeline/render.ts', planner = '/.tmp/issue200-baseline/src/domain/videoCompositionPlan.ts'
    return (await import(client)).proveLegacyMaskAnimation({ compositeFrame: (await import(renderer)).compositeFrame, createVideoCompositionPlanner: (await import(planner)).createVideoCompositionPlanner })
  })
  await writeFile(info.outputPath('legacy-mask-pixels.json'), JSON.stringify({ rows, errors }, null, 2))
  for (const row of rows) { exact(row.baseline, `${row.family}/${row.quality}/${row.frame}`); expect(row.preserved).toBe(true); expect(row.reason).toMatch(/could change stored source-effect animation/) }
  expect(rows).toHaveLength(54); expect(errors).toEqual([])
})

test('explicit generic fallback retains named intent and reproduces actual main, worker and export pixels after reopen', async ({ page }, info) => {
  const errors = problems(page); await page.goto('/')
  const rows = await page.evaluate(async () => { const path = '/src/test/titleRenderProofClient.ts'; return (await import(path)).proveTitleFallbackParity() })
  await writeFile(info.outputPath('fallback-pixel-matrix.json'), JSON.stringify({ rows, errors }, null, 2))
  for (const row of rows) {
    for (const field of ['fallback', 'worker', 'export'] as const) exact(row[field], `${row.family}/${row.quality}/${field}`)
    expect(row.retainedIntent).toBe(true); expect(row.clean).toBe(true)
  }
  expect(rows).toHaveLength(18); expect(errors).toEqual([])
})
