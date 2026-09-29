/**
 * Shared helpers for the Issue #209 Step 12 real-microphone voiceover acceptance.
 * Prints one JSON line per scenario (prefixed `ISSUE209_RESULT`) and deletes
 * every recording it made. Microphone/speaker labels are matched with the
 * ISSUE209_MICROPHONE / ISSUE209_SPEAKER environment variables.
 */
import { expect, type Page } from '@playwright/test'

export const MICROPHONE = process.env.ISSUE209_MICROPHONE ?? 'HyperX QuadCast'
export const SPEAKER = process.env.ISSUE209_SPEAKER ?? 'MacBook Pro Speakers'

export function report(name: string, value: unknown): void {
  process.stdout.write(`ISSUE209_RESULT ${JSON.stringify({ scenario: name, ...value as object })}\n`)
}

export async function createProject(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a new project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill(name)
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commands' })).toBeVisible()
}

export async function openPanel(page: Page) {
  await page.getByRole('button', { name: /^Record/ }).click()
  const panel = page.getByRole('dialog', { name: 'Record' })
  await expect(panel).toBeVisible()
  return panel
}

/** Microphone labels only appear after a grant; the panel re-enumerates then. */
export async function chooseMicrophone(page: Page, panel: ReturnType<Page['getByRole']>): Promise<string> {
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
  })
  // Reopen so the device list is refreshed with labels.
  await panel.getByRole('button', { name: 'Close record panel' }).click()
  const reopened = await openPanel(page)
  const select = reopened.getByLabel('Microphone')
  // The device list loads asynchronously after the panel opens.
  let options: string[] = []
  await expect.poll(async () => {
    options = await select.locator('option').allTextContents()
    return options.some((label) => label.includes(MICROPHONE))
  }, { timeout: 5_000 }).toBe(true).catch(() => {})
  const match = options.find((label) => label.includes(MICROPHONE))
  if (!match) throw new Error(`Microphone "${MICROPHONE}" not found among: ${options.join(', ')}`)
  await select.selectOption({ label: match })
  return match
}

export async function elapsedAtLeast(page: Page, tenths: number, timeout = 60_000): Promise<void> {
  // The label is m:ss.t; convert it to tenths of a second.
  await page.waitForFunction((min) => {
    const match = /(\d+):(\d\d)\.(\d)/.exec(document.querySelector('.voiceover-elapsed')?.textContent ?? '')
    return match ? Number(match[1]) * 600 + Number(match[2]) * 10 + Number(match[3]) >= min : false
  }, tenths, { timeout })
}

/** Reads a kept or draft WAV straight from OPFS and summarizes it (no bytes leave the page). */
export async function wavStats(page: Page, fileName: string, clickTimesSeconds: number[] = []) {
  return page.evaluate(async ({ fileName, clickTimesSeconds }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('myrelith-recordings-v1')
    const file = await (await directory.getFileHandle(fileName)).getFile()
    const bytes = new DataView(await file.arrayBuffer())
    const dataBytes = bytes.getUint32(40, true)
    const samples = new Int16Array(dataBytes / 2)
    for (let index = 0; index < samples.length; index++) samples[index] = bytes.getInt16(44 + index * 2, true)
    let sumSquares = 0
    let peak = 0
    for (const sample of samples) { sumSquares += sample * sample; peak = Math.max(peak, Math.abs(sample)) }
    const rms = Math.sqrt(sumSquares / Math.max(1, samples.length)) / 32768
    // Click onsets: first sample above an adaptive threshold after 250 ms of quiet.
    const noiseWindow = samples.subarray(0, Math.min(samples.length, 14_400))
    let noise = 0
    for (const sample of noiseWindow) noise = Math.max(noise, Math.abs(sample))
    const threshold = Math.max(noise * 3, 900)
    const onsets: number[] = []
    let last = -Infinity
    for (let index = 0; index < samples.length; index++) {
      if (Math.abs(samples[index]!) >= threshold && index - last > 12_000) { onsets.push(index); last = index }
      else if (Math.abs(samples[index]!) >= threshold) last = index
    }
    const latencies = clickTimesSeconds.map((seconds) => {
      const expected = Math.round(seconds * 48_000)
      const onset = onsets.find((value) => value >= expected - 2_400 && value < expected + 12_000)
      return onset === undefined ? null : (onset - expected) / 48
    })
    // Matched filter: correlate each expected click window with the exact 2 kHz
    // burst, and a stack of all windows for a robust single estimate.
    const template = Array.from({ length: 960 }, (_, index) =>
      Math.sin(2 * Math.PI * 2_000 * index / 48_000) * Math.min(1, index / 96, (960 - index) / 96))
    const before = 2_400
    const span = 14_400
    const correlate = (signal: Float64Array) => {
      const scores = new Float64Array(signal.length - template.length)
      for (let lag = 0; lag < scores.length; lag++) {
        let sum = 0
        for (let tap = 0; tap < template.length; tap++) sum += signal[lag + tap]! * template[tap]!
        scores[lag] = Math.abs(sum)
      }
      let best = 0
      for (let lag = 1; lag < scores.length; lag++) if (scores[lag]! > scores[best]!) best = lag
      const sorted = [...scores].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]! || 1e-9
      return { lagMs: (best - before) / 48, snr: scores[best]! / median }
    }
    const stack = new Float64Array(span + before)
    const matched = clickTimesSeconds.map((seconds) => {
      const expected = Math.round(seconds * 48_000)
      const window = new Float64Array(span + before)
      for (let index = 0; index < window.length; index++) {
        const value = samples[expected - before + index] ?? 0
        window[index] = value
        stack[index] = stack[index]! + value
      }
      const { lagMs, snr } = correlate(window)
      return { lagMs: Number(lagMs.toFixed(2)), snr: Number(snr.toFixed(1)) }
    })
    const stacked = clickTimesSeconds.length ? correlate(stack) : null
    return { matched, stacked: stacked && { lagMs: Number(stacked.lagMs.toFixed(2)), snr: Number(stacked.snr.toFixed(1)) },
      fileBytes: file.size, headerDataBytes: dataBytes, samples: samples.length,
      rms: Number(rms.toFixed(5)), peak: peak / 32768, noiseFloor: noise / 32768, threshold: threshold / 32768,
      onsetCount: onsets.length, latenciesMs: latencies.map((value) => value === null ? null : Number(value.toFixed(2))) }
  }, { fileName, clickTimesSeconds })
}

export async function removeAllRecordings(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    let removed = 0
    try {
      const directory = await root.getDirectoryHandle('myrelith-recordings-v1')
      const names: string[] = []
      for await (const entry of (directory as unknown as { values(): AsyncIterable<{ name: string }> }).values()) names.push(entry.name)
      for (const name of names) { await directory.removeEntry(name); removed++ }
    } catch { /* nothing recorded */ }
    return removed
  })
}

export function keptFileName(page: Page) {
  return page.evaluate(() => {
    const stores = (window as unknown as { __stores: Record<string, { getState(): unknown }> }).__stores
    const media = stores.media.getState() as { assets: Map<string, { fileName: string; durationFrames: number }> }
    return [...media.assets.values()].filter((asset) => asset.fileName.startsWith('voiceover_'))
      .map((asset) => ({ fileName: asset.fileName, durationFrames: asset.durationFrames }))
  })
}

export function captureStatus(page: Page) {
  return page.evaluate(async () => {
    const { useVoiceoverCaptureStore } = await import('/src/state/voiceoverCaptureStore.ts')
    const status = useVoiceoverCaptureStore.getState()
    return { phase: status.session?.phase ?? null, interruption: status.session?.interruption ?? null,
      failure: status.session?.failure ?? null, capturedSamples: status.capturedSamples,
      diagnostic: status.diagnostic, timing: status.timing, sourceLabel: status.sourceLabel,
      renderGapSamples: status.renderGapSamples }
  })
}

