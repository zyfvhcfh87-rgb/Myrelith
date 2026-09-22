import { expect, test } from '@playwright/test'

for (const mode of ['stop', 'hidden'] as const) test(`Chromium app owner retires a ${mode} take and its tracks`, async ({ page }) => {
  await page.goto('/')
  await page.mouse.click(10, 10)
  const result = await page.evaluate(async (mode) => {
    const ownerPath = '/src/app/voiceoverCaptureOwner.ts'
    const writerPath = '/src/app/voiceoverWavBridge.ts'
    const microphonePath = '/src/app/voiceoverMicrophoneBridge.ts'
    const settingsPath = '/src/domain/projectSettings.ts'
    const { VoiceoverCaptureOwner } = await import(ownerPath)
    const { VoiceoverWavBridge } = await import(writerPath)
    const { connectVoiceoverMicrophone } = await import(microphonePath)
    const { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } = await import(settingsPath)
    const context = new AudioContext({ sampleRate: 48_000 })
    await context.suspend()
    const oscillator = context.createOscillator()
    const microphone = context.createMediaStreamDestination()
    oscillator.connect(microphone)
    oscillator.start()
    let writer: InstanceType<typeof VoiceoverWavBridge> | null = null
    const phases: string[] = []
    const owner = new VoiceoverCaptureOwner({
      destinationContext: () => ({ projectId: 'browser-test', projectGeneration: 1, editRevision: 1,
        doc: createTimelineDoc('Browser capture', DEFAULT_PROJECT_SETTINGS, 'sequence') }),
      requestMicrophone: () => Promise.resolve(microphone.stream),
      getContext: () => context,
      createWriter: () => { writer = new VoiceoverWavBridge(); return writer },
      connect: connectVoiceoverMicrophone,
      visibleAndFocused: () => true,
      planStartFrame: (clock: AudioContext) => Math.ceil(clock.currentTime * 48_000) + 4_800,
      publish: (status: { session: { phase: string } | null }) => { if (status.session) phases.push(status.session.phase) },
    })
    try {
      const started = owner.start('A1', 20)
      if (started.status !== 'started') throw new Error(started.reason)
      const deadline = performance.now() + 5_000
      while (owner.status.session?.phase !== 'recording' && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (owner.status.session?.phase !== 'recording') throw new Error(`Never recorded: ${JSON.stringify(owner.status)}`)
      await new Promise((resolve) => setTimeout(resolve, mode === 'hidden' ? 220 : 70))
      if (mode === 'hidden') { owner.onHidden(); await owner.whenIdle() }
      else await owner.stop()
      const review = owner.status
      const stopped = microphone.stream.getAudioTracks()[0]?.readyState
      await owner.cancel()
      return { phases, reviewPhase: review.session?.phase, samples: review.capturedSamples,
        diagnostic: review.diagnostic, stopped, cancelled: owner.status.session?.phase,
        writerClosed: writer?.inFlightBytes }
    } finally {
      await owner.cancel().catch(() => {})
      for (const track of microphone.stream.getTracks()) track.stop()
      oscillator.stop()
      oscillator.disconnect()
      await context.close()
    }
  }, mode)
  expect(result.phases).toContain('recording')
  expect(result.reviewPhase).toBe('review')
  if (mode === 'stop') expect(result.samples).toBeGreaterThan(0)
  else {
    expect(result.samples).toBeGreaterThanOrEqual(0)
    expect(result.diagnostic).toContain('last durable checkpoint')
  }
  expect(result.stopped).toBe('ended')
  expect(result.cancelled).toBe('cancelled')
  expect(result.writerClosed).toBe(0)
})
