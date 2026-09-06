import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test('explicit groups and sequential buses preserve scoped order and release every borrowed surface', async ({ page }, info) => {
  await page.goto('/')
  const evidence = await page.evaluate(async () => {
    const path = '/src/test/videoBusProof.ts'
    const { proveVideoBusSchedule } = await import(path)
    const rows = []
    for (const depth of [0, 1, 8]) {
      const explicit = await proveVideoBusSchedule(64, 36, depth, 'explicit')
      const sequential = await proveVideoBusSchedule(64, 36, depth, 'sequential')
      rows.push({ depth, samePixels: JSON.stringify(explicit.result) === JSON.stringify(sequential.result), sameTrace: JSON.stringify(explicit.trace) === JSON.stringify(sequential.trace),
        explicit: { ...explicit, result: undefined }, sequential: { ...sequential, result: undefined } })
    }
    const failures = await Promise.all(['explicit', 'sequential'].map((mode) => proveVideoBusSchedule(64, 36, 8, mode, true)))
    return { rows, failures: failures.map(({ result: _, ...row }) => row) }
  })
  for (const row of evidence.rows) {
    expect(row.samePixels).toBe(true); expect(row.sameTrace).toBe(true)
    expect(row.sequential.peakSurfaces).toBe(3)
    for (const owner of [row.explicit, row.sequential]) { expect(owner.error).toBeNull(); expect(owner.liveSurfaces).toBe(0); expect(owner.liveArrays).toBe(0) }
    const trace: string[] = row.sequential.trace
    for (let i = 0; i < trace.length; i++) if (trace[i].startsWith('caption:')) expect(trace[i + 1]).toBe(trace[i].replace('caption:', 'master:'))
    expect(trace.filter((item) => item.startsWith('begin:'))).toHaveLength(trace.filter((item) => item.startsWith('master:')).length)
    expect(trace.filter((item) => item.includes('below-adjustment') && item.startsWith('track:'))).toEqual([])
  }
  for (const owner of evidence.failures) { expect(owner.error).toContain('injected'); expect(owner.liveSurfaces).toBe(0); expect(owner.liveArrays).toBe(0) }
  await writeFile(info.outputPath('video-bus-order-proof.json'), JSON.stringify(evidence, null, 2))
  await info.attach('video-bus-order-proof', { path: info.outputPath('video-bus-order-proof.json'), contentType: 'application/json' })
})

test('sequential scoped buses keep the same three compositor canvases through 4K and repeated owners', async ({ page, browser }, info) => {
  test.setTimeout(180_000)
  await page.goto('/')
  const rows = await page.evaluate(async () => {
    const path = '/src/test/videoBusProof.ts'
    const { proveVideoBusSchedule } = await import(path)
    const rows = []
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      const start = performance.now(), result = await proveVideoBusSchedule(width, height, 8, 'sequential')
      rows.push({ width, height, elapsedMs: performance.now() - start, ...result, result: undefined, trace: undefined })
    }
    // Independent finite owners return to zero after both success and rejection.
    for (let run = 0; run < 3; run++) for (const fail of [false, true]) {
      const result = await proveVideoBusSchedule(1280, 720, 1, 'sequential', fail)
      rows.push({ width: 1280, height: 720, run, fail, ...result, result: undefined, trace: undefined })
    }
    return rows
  })
  for (const row of rows) {
    expect(row.peakSurfaces).toBe(3); expect(row.liveSurfaces).toBe(0); expect(row.liveArrays).toBe(0)
    expect(row.scratchPeak).toBeLessThanOrEqual(1024 * 1024)
    expect(row.peakArrays).toBeLessThanOrEqual(row.width * row.height * 4 * 2)
  }
  const path = info.outputPath('video-bus-resource-proof.json')
  await writeFile(path, JSON.stringify({ browser: browser.version(), platform: process.platform, arch: process.arch, rows }, null, 2))
  await info.attach('video-bus-resource-proof', { path, contentType: 'application/json' })
})
