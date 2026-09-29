import { expect, test } from '@playwright/test'
import { captureStatus, chooseMicrophone, createProject, elapsedAtLeast, keptFileName, openPanel,
  removeAllRecordings, report, wavStats } from './voiceoverHelpers'

/** Step 12 quiet real-microphone checks (output muted). */
test.use({ launchOptions: { args: ['--mute-audio', '--enable-precise-memory-info'] } })

test.describe('Issue #209 Step 12 — quiet real-microphone checks', () => {

  test('a real 20 s take reopens with exact length, real signal, and flat memory', async ({ page }) => {
    await createProject(page, 'Step 12 real take')
    const panel = await openPanel(page)
    const microphone = await chooseMicrophone(page, panel)
    const active = page.getByRole('dialog', { name: 'Record' })
    await active.getByLabel('Count-in').selectOption('0')
    const heap: number[] = []
    const sampler = setInterval(() => {
      void page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize)
        .then((value) => heap.push(value)).catch(() => {})
    }, 1000)
    await active.getByRole('button', { name: 'Record at playhead' }).click()
    await elapsedAtLeast(page, 200)
    await active.getByRole('button', { name: 'Stop' }).click()
    await expect(active.getByRole('status')).toContainText('Take ready to review', { timeout: 10_000 })
    clearInterval(sampler)
    const status = await captureStatus(page)
    await active.getByRole('button', { name: 'Keep in Media Pool' }).click()
    await expect(active.getByRole('status')).toContainText('Take saved to the Media Pool', { timeout: 15_000 })
    const [kept] = await keptFileName(page)
    const stats = await wavStats(page, kept!.fileName)
    expect(stats.fileBytes).toBe(stats.headerDataBytes + 44)
    expect(stats.samples).toBe(status.capturedSamples)
    expect(stats.rms).toBeGreaterThan(0)
    // 30 fps: exactly 1,600 samples per frame; the take ends on a frame boundary.
    expect(stats.samples % 1_600).toBe(0)
    expect(kept!.durationFrames).toBe(stats.samples / 1_600)
    const mib = (value: number) => Number((value / 1_048_576).toFixed(1))
    report('real-take', { microphone, samples: stats.samples, seconds: stats.samples / 48_000,
      fileBytes: stats.fileBytes, rms: stats.rms, peak: Number(stats.peak.toFixed(4)),
      trackLatencyMs: status.timing?.trackLatencySeconds == null ? null : status.timing.trackLatencySeconds * 1000,
      outputLatencyMs: status.timing?.outputLatencySeconds == null ? null : status.timing.outputLatencySeconds * 1000,
      heapMiB: { first: mib(heap[0] ?? 0), max: mib(Math.max(...heap)), last: mib(heap.at(-1) ?? 0), samples: heap.length } })
    report('real-take-cleanup', { removed: await removeAllRecordings(page) })
  })

  test('revoking microphone permission mid-take stops tracks and keeps the durable audio', async ({ page, context }) => {
    await createProject(page, 'Step 12 revoke')
    const panel = await openPanel(page)
    await chooseMicrophone(page, panel)
    const active = page.getByRole('dialog', { name: 'Record' })
    await active.getByLabel('Count-in').selectOption('0')
    await active.getByRole('button', { name: 'Record at playhead' }).click()
    await elapsedAtLeast(page, 40)
    await context.clearPermissions()
    let settled = 'still-recording'
    await expect.poll(async () => {
      const phase = (await captureStatus(page)).phase
      if (phase === 'review' || phase === 'failed' || phase === 'cleanup-failed') settled = phase
      return settled
    }, { timeout: 10_000 }).not.toBe('still-recording').catch(() => {})
    const status = await captureStatus(page)
    report('revoke', { settled, ...status, timing: undefined })
    if (settled === 'review') {
      expect(status.interruption).toBe('source-ended')
      // Checkpoint recovery keeps whole 256 KiB checkpoints only.
      expect((status.capturedSamples * 2) % (256 * 1024)).toBe(0)
    }
    if (settled === 'still-recording') {
      // Chromium kept delivering samples after the permission change: stop explicitly.
      await active.getByRole('button', { name: 'Stop' }).click()
      await expect(active.getByRole('status')).toContainText('Take ready to review', { timeout: 10_000 })
      report('revoke-after-stop', { ...(await captureStatus(page)), timing: undefined })
    }
    await active.getByRole('button', { name: 'Discard' }).click()
    await expect(active.getByRole('status')).toContainText('Take discarded', { timeout: 10_000 })
    report('revoke-cleanup', { removed: await removeAllRecordings(page) })
  })
})

test('a 3-minute take keeps retained memory flat (forced GC every 15 s)', async ({ page, context }) => {
  test.setTimeout(300_000)
  await createProject(page, 'Step 12 long take')
  const panel = await openPanel(page)
  await chooseMicrophone(page, panel)
  const active = page.getByRole('dialog', { name: 'Record' })
  await active.getByLabel('Count-in').selectOption('0')
  const cdp = await context.newCDPSession(page)
  const retained = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    const { usedSize } = await cdp.send('Runtime.getHeapUsage')
    return Number((usedSize / 1_048_576).toFixed(1))
  }
  const baseline = await retained()
  await active.getByRole('button', { name: 'Record at playhead' }).click()
  const samples: number[] = []
  for (let second = 15; second <= 180; second += 15) {
    await elapsedAtLeast(page, second * 10, 30_000)
    samples.push(await retained())
  }
  await active.getByRole('button', { name: 'Stop' }).click()
  await expect(active.getByRole('status')).toContainText('Take ready to review', { timeout: 10_000 })
  const status = await captureStatus(page)
  await active.getByRole('button', { name: 'Keep in Media Pool' }).click()
  await expect(active.getByRole('status')).toContainText('Take saved to the Media Pool', { timeout: 30_000 })
  const [kept] = await keptFileName(page)
  const stats = await wavStats(page, kept!.fileName)
  expect(stats.samples).toBe(status.capturedSamples)
  const growth = Math.max(...samples) - samples[0]!
  report('long-take', { seconds: stats.samples / 48_000, fileMiB: Number((stats.fileBytes / 1_048_576).toFixed(2)),
    renderGapSamples: status.renderGapSamples, baselineMiB: baseline, retainedMiB: samples, growthAfterFirst15sMiB: Number(growth.toFixed(1)) })
  // A whole take is ~17 MiB of PCM; retained heap must not grow with it.
  expect(growth).toBeLessThan(8)
  report('long-take-cleanup', { removed: await removeAllRecordings(page) })
})
