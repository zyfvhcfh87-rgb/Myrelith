import { expect, test } from '@playwright/test'
import { captureStatus, chooseMicrophone, createProject, elapsedAtLeast, keptFileName, openPanel,
  removeAllRecordings, report, SPEAKER, wavStats } from './voiceoverHelpers'

/** Step 12 audible loopback: an explicit exception to quiet QA; clicks go to the built-in speakers. */
test.use({ launchOptions: { args: [] } })

test.describe('Issue #209 Step 12 — audible loopback (explicit exception to quiet QA)', () => {
  // Output is not muted here: short clicks go to the built-in speakers, not the default headphones.

  test('measures product-path round-trip latency from timeline clicks to the microphone', async ({ page }) => {
    await createProject(page, 'Step 12 loopback')
    const clickTimes = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]
    const placed = await page.evaluate(async ({ clickTimes, speaker }) => {
      const rate = 48_000
      const CLICK_SAMPLES = 960
      const samples = new Int16Array(rate * 7)
      for (const time of clickTimes) {
        const start = Math.round(time * rate)
        // 20 ms 2 kHz beep with 2 ms fades: short, but enough energy to cross the room.
        for (let index = 0; index < CLICK_SAMPLES; index++) {
          const envelope = Math.min(1, index / 96, (CLICK_SAMPLES - index) / 96)
          samples[start + index] = Math.round(Math.sin(2 * Math.PI * 2_000 * index / rate) * 0.8 * envelope * 32767)
        }
      }
      const header = new DataView(new ArrayBuffer(44))
      const write = (at: number, text: string) => { for (let i = 0; i < text.length; i++) header.setUint8(at + i, text.charCodeAt(i)) }
      write(0, 'RIFF'); header.setUint32(4, 36 + samples.byteLength, true); write(8, 'WAVE'); write(12, 'fmt ')
      header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true)
      header.setUint32(24, rate, true); header.setUint32(28, rate * 2, true); header.setUint16(32, 2, true)
      header.setUint16(34, 16, true); write(36, 'data'); header.setUint32(40, samples.byteLength, true)
      const file = new File([header.buffer, samples.buffer], 'loopback-clicks.wav', { type: 'audio/wav' })
      const { importMedia } = await import('/src/app/mediaImportController.ts')
      const { placeImportedAsset } = await import('/src/app/mediaPlacementController.ts')
      const { useDocumentStore } = await import('/src/state/documentStore.ts')
      const imported = await importMedia(file)
      if (imported.status !== 'imported') return { error: `import ${imported.status}` }
      const doc = useDocumentStore.getState().doc
      const placement = placeImportedAsset(doc.id, imported.assetId, 'A1', 0)
      // Route Program output to the built-in speakers so the microphone can hear it.
      const devices = await navigator.mediaDevices.enumerateDevices()
      const output = devices.find((device) => device.kind === 'audiooutput' && device.label.includes(speaker))
      const { getPlaybackClockContext } = await import('/src/app/transportController.ts')
      const context = getPlaybackClockContext() as AudioContext & { setSinkId?(id: string): Promise<void> }
      if (output && context.setSinkId) await context.setSinkId(output.deviceId)
      return { placement: placement.status, sink: output?.label ?? 'default', baseLatencyMs: context.baseLatency * 1000 }
    }, { clickTimes, speaker: SPEAKER }).catch(async () => {
      // Labels need a grant first.
      await page.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()) })
      return null
    })
    expect(placed).not.toBeNull()
    const panel = await openPanel(page)
    const microphone = await chooseMicrophone(page, panel)
    // Re-route after the grant (labels were possibly empty on the first attempt).
    const sink = await page.evaluate(async (speaker) => {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const output = devices.find((device) => device.kind === 'audiooutput' && device.label.includes(speaker))
      const { getPlaybackClockContext } = await import('/src/app/transportController.ts')
      const context = getPlaybackClockContext() as AudioContext & { setSinkId?(id: string): Promise<void>; sinkId?: string }
      if (output && context.setSinkId) await context.setSinkId(output.deviceId)
      return { label: output?.label ?? null, outputLatencyMs: context.outputLatency * 1000 }
    }, SPEAKER)
    const active = page.getByRole('dialog', { name: 'Record' })
    await active.getByLabel('Audio track').selectOption({ label: 'A2' })
    await active.getByLabel('Count-in').selectOption('0')
    await active.getByRole('button', { name: 'Record at playhead' }).click()
    await elapsedAtLeast(page, 62, 20_000).catch(async (cause) => {
    report('loopback-failure', { ...(await captureStatus(page)), sink })
    throw cause
  })
    await active.getByRole('button', { name: 'Stop' }).click()
    await expect(active.getByRole('status')).toContainText('Take ready to review', { timeout: 10_000 })
    const status = await captureStatus(page)
    await active.getByRole('button', { name: 'Keep in Media Pool' }).click()
    await expect(active.getByRole('status')).toContainText('Take saved to the Media Pool', { timeout: 15_000 })
    const [kept] = await keptFileName(page)
    const stats = await wavStats(page, kept!.fileName, clickTimes)
    const measured = stats.latenciesMs.filter((value): value is number => value !== null).sort((a, b) => a - b)
    report('loopback', { microphone, sink, placed, matched: stats.matched, stacked: stats.stacked,
      renderGapSamples: status.renderGapSamples, onsetCount: stats.onsetCount, noiseFloor: stats.noiseFloor,
      threshold: stats.threshold, latenciesMs: stats.latenciesMs,
      medianMs: measured.length ? measured[Math.floor(measured.length / 2)] : null,
      spreadMs: measured.length ? Number((measured.at(-1)! - measured[0]!).toFixed(2)) : null,
      trackLatencyMs: status.timing?.trackLatencySeconds == null ? null : status.timing.trackLatencySeconds * 1000,
      outputLatencyMs: status.timing?.outputLatencySeconds == null ? null : status.timing.outputLatencySeconds * 1000 })
    report('loopback-cleanup', { removed: await removeAllRecordings(page) })
  })
})
