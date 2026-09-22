import { expect, test } from '@playwright/test'

test('Chromium records exact worklet sample frames with silent digital output', async ({ page }) => {
  await page.goto('/')
  await page.mouse.click(10, 10)
  const result = await page.evaluate(async () => {
    const writerPath = '/src/app/voiceoverWavBridge.ts'
    const microphonePath = '/src/app/voiceoverMicrophoneBridge.ts'
    const { VoiceoverWavBridge } = await import(writerPath)
    const { connectVoiceoverMicrophone } = await import(microphonePath)
    const context = new AudioContext({ sampleRate: 48_000 })
    await context.suspend()
    const oscillator = context.createOscillator()
    oscillator.frequency.value = 523.25
    const microphone = context.createMediaStreamDestination()
    oscillator.connect(microphone)
    const writer = new VoiceoverWavBridge()
    const id = `issue209-step6-${crypto.randomUUID()}`
    let capture: Awaited<ReturnType<typeof connectVoiceoverMicrophone>> | null = null
    let analyser: AnalyserNode | null = null
    let meterTimer: ReturnType<typeof setInterval> | null = null
    let oscillatorStarted = false
    try {
      await writer.create(id)
      const startFrame = Math.ceil(context.currentTime * context.sampleRate) + 4_800
      const stopFrame = startFrame + 12_000
      const batches: { startFrame: number; frames: number }[] = []
      capture = await connectVoiceoverMicrophone({
        context, stream: microphone.stream, writer, startFrame,
        onBatch: ({ startFrame, frames }: { startFrame: number; frames: number }) => batches.push({ startFrame, frames }),
      })
      const activeAnalyser = context.createAnalyser()
      analyser = activeAnalyser
      activeAnalyser.fftSize = 2048
      capture.outputNode.connect(activeAnalyser)
      activeAnalyser.connect(context.destination)
      const samples = new Float32Array(activeAnalyser.fftSize)
      let peakOutput = 0
      meterTimer = setInterval(() => {
        activeAnalyser.getFloatTimeDomainData(samples)
        for (const sample of samples) peakOutput = Math.max(peakOutput, Math.abs(sample))
      }, 5)
      oscillator.start()
      oscillatorStarted = true
      const stopped = capture.stop(stopFrame)
      await context.resume()
      const completed = await stopped
      const { file } = await writer.finalize()
      const wav = await file.arrayBuffer()
      const pcm = new Int16Array(wav.slice(44))
      const peakInput = pcm.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
      const decoded = await context.decodeAudioData(wav)
      return { startFrame, stopFrame, completed, batches, fileBytes: file.size,
        decodedSamples: decoded.length, decodedChannels: decoded.numberOfChannels,
        peakInput, peakOutput }
    } finally {
      if (meterTimer) clearInterval(meterTimer)
      capture?.dispose()
      if (oscillatorStarted) oscillator.stop()
      oscillator.disconnect()
      analyser?.disconnect()
      for (const track of microphone.stream.getTracks()) track.stop()
      await writer.discard().catch(() => {})
      writer.close()
      await context.close()
    }
  })
  expect(result.completed).toMatchObject({ reason: 'stopped', startFrame: result.startFrame,
    endFrame: result.stopFrame, samples: 12_000, batches: 2 })
  expect(result.batches).toEqual([
    { startFrame: result.startFrame, frames: 8192 },
    { startFrame: result.startFrame + 8192, frames: 3808 },
  ])
  expect(result.fileBytes).toBe(44 + 12_000 * 2)
  expect(result.decodedSamples).toBe(12_000)
  expect(result.decodedChannels).toBe(1)
  expect(result.peakInput).toBeGreaterThan(1000)
  expect(result.peakOutput).toBe(0)
})

test('Chromium worklet stops at four unacknowledged batches', async ({ page }) => {
  await page.goto('/')
  await page.mouse.click(10, 10)
  const result = await page.evaluate(async () => {
    const microphonePath = '/src/app/voiceoverMicrophoneBridge.ts'
    const { connectVoiceoverMicrophone } = await import(microphonePath)
    const context = new AudioContext({ sampleRate: 48_000 })
    await context.suspend()
    const oscillator = context.createOscillator()
    const microphone = context.createMediaStreamDestination()
    oscillator.connect(microphone)
    const startFrame = Math.ceil(context.currentTime * context.sampleRate) + 4_800
    const releases: (() => void)[] = []
    let writtenBytes = 0
    let stopCalls = 0
    let closed = false
    const writer = {
      append(buffer: ArrayBuffer) {
        return new Promise<{ pcmBytes: number; committedBytes: number }>((resolve) => {
          releases.push(() => { writtenBytes += buffer.byteLength; resolve({ pcmBytes: writtenBytes, committedBytes: 0 }) })
        })
      },
      async stop() { stopCalls++; return { pcmBytes: writtenBytes, committedBytes: writtenBytes } },
      close() { closed = true },
    }
    let signalOverrun!: (frame: number) => void
    const overrun = new Promise<number>((resolve) => { signalOverrun = resolve })
    let capture: Awaited<ReturnType<typeof connectVoiceoverMicrophone>> | null = null
    let oscillatorStarted = false
    try {
      capture = await connectVoiceoverMicrophone({
        context, stream: microphone.stream, writer, startFrame, onOverrun: signalOverrun,
      })
      oscillator.start()
      oscillatorStarted = true
      await context.resume()
      const overrunAt = await overrun
      const beforeAck = capture.snapshot()
      for (const release of releases) release()
      const completed = await capture.finished
      return { startFrame, overrunAt, beforeAck, completed, sent: releases.length,
        writtenBytes, stopCalls, closed }
    } finally {
      capture?.dispose()
      if (oscillatorStarted) oscillator.stop()
      oscillator.disconnect()
      for (const track of microphone.stream.getTracks()) track.stop()
      await context.close()
    }
  })
  expect(result.sent).toBe(4)
  expect(result.overrunAt).toBe(result.startFrame + 32_768)
  expect(result.beforeAck.pendingBytes).toBe(65_536)
  expect(result.completed).toMatchObject({ reason: 'overrun', samples: 32_768,
    peakInFlightBytes: 65_536, batches: 4 })
  expect(result.writtenBytes).toBe(65_536)
  expect(result.stopCalls).toBe(1)
  expect(result.closed).toBe(false)
})
