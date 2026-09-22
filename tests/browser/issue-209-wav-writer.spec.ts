import { expect, test } from '@playwright/test'

test('production OPFS writer recovers a worker-lost tail and reopens a decodable WAV', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    type Bridge = {
      create(id: string): Promise<unknown>
      append(buffer: ArrayBuffer): Promise<unknown>
      close(): void
      recover(id: string): Promise<{ pcmBytes: number; committedBytes: number; discardedTailBytes: number }>
      finalize(): Promise<{ file: File; pcmBytes: number }>
      discard(): Promise<void>
    }
    const modulePath = '/src/app/voiceoverWavBridge.ts'
    const { VoiceoverWavBridge } = await import(modulePath) as { VoiceoverWavBridge: new () => Bridge }
    const id = `issue209-step5-${crypto.randomUUID()}`
    const first = new VoiceoverWavBridge()
    let recovered: Bridge | null = null
    try {
      await first.create(id)
      const batch = () => {
        const samples = new Int16Array(8192)
        for (let index = 0; index < samples.length; index++) samples[index] = Math.round(9000 * Math.sin(index * 2 * Math.PI / 96))
        return samples.buffer
      }
      for (let index = 0; index < 16; index++) await first.append(batch())
      await first.append(batch()) // Deliberately leave one uncommitted batch.
      first.close()

      recovered = new VoiceoverWavBridge()
      const progress = await recovered.recover(id)
      const { file, pcmBytes } = await recovered.finalize()
      const context = new AudioContext({ sampleRate: 48_000 })
      try {
        const decoded = await context.decodeAudioData(await file.arrayBuffer())
        return { progress, size: file.size, pcmBytes, channels: decoded.numberOfChannels,
          sampleRate: decoded.sampleRate, samples: decoded.length }
      } finally { await context.close() }
    } finally {
      first.close()
      if (recovered) {
        await recovered.discard().catch(() => {})
        recovered.close()
      }
    }
  })
  expect(result.progress).toEqual({ pcmBytes: 262_144, committedBytes: 262_144, discardedTailBytes: 16_384 })
  expect(result).toMatchObject({ size: 262_188, pcmBytes: 262_144, channels: 1, sampleRate: 48_000, samples: 131_072 })
})
