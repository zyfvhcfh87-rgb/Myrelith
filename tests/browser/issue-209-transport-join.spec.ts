import { expect, test } from '@playwright/test'

for (const mode of ['normal', 'late', 'cancel'] as const) test(`Chromium voiceover transport ${
  mode === 'late' ? 'reports a missed anchor' : mode === 'cancel' ? 'cancels its count-in' :
    'aligns its take to a timeline frame'}`, async ({ page }) => {
  await page.goto('/')
  await page.mouse.click(10, 10)
  const result = await page.evaluate(async (mode) => {
    const ownerPath = '/src/app/voiceoverCaptureOwner.ts'
    const writerPath = '/src/app/voiceoverWavBridge.ts'
    const microphonePath = '/src/app/voiceoverMicrophoneBridge.ts'
    const transportPath = '/src/app/transportController.ts'
    const settingsPath = '/src/domain/projectSettings.ts'
    const documentPath = '/src/state/documentStore.ts'
    const transportStorePath = '/src/state/transportStore.ts'
    const clockPath = '/src/domain/voiceoverClock.ts'
    const { VoiceoverCaptureOwner } = await import(ownerPath)
    const { VoiceoverWavBridge } = await import(writerPath)
    const { connectVoiceoverMicrophone, prepareVoiceoverMicrophoneWorklet } = await import(microphonePath)
    const { armVoiceoverTransport, getPlaybackClockContext, disposeTransport } = await import(transportPath)
    const { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } = await import(settingsPath)
    const { useDocumentStore } = await import(documentPath)
    const { useTransportStore } = await import(transportStorePath)
    const { voiceoverSampleAtTimelineFrame, voiceoverTimelineFrameAtSample } = await import(clockPath)
    const doc = createTimelineDoc('Join test', DEFAULT_PROJECT_SETTINGS, `join-${crypto.randomUUID()}`)
    useDocumentStore.getState().setDoc(doc)
    useTransportStore.getState().setPlayheadFrame(0)
    const context = getPlaybackClockContext() as AudioContext
    const oscillator = context.createOscillator()
    oscillator.frequency.value = 331
    const microphone = context.createMediaStreamDestination()
    oscillator.connect(microphone)
    oscillator.start()
    const owner = new VoiceoverCaptureOwner({
      destinationContext: () => ({ projectId: useDocumentStore.getState().project.id,
        projectGeneration: useDocumentStore.getState().projectGeneration, editRevision: 1, doc }),
      requestMicrophone: () => Promise.resolve(microphone.stream),
      getContext: () => context,
      createWriter: () => new VoiceoverWavBridge(),
      prepareWorklet: prepareVoiceoverMicrophoneWorklet,
      connect: async (options: Parameters<typeof connectVoiceoverMicrophone>[0]) => {
        if (mode === 'late') await new Promise((resolve) => setTimeout(resolve, 1_700))
        return connectVoiceoverMicrophone(options)
      },
      armTransport: (clock: AudioContext, startFrame: number, countInFrames: number,
        onInterrupted: (reason: 'transport-changed' | 'destination-changed') => void) =>
        armVoiceoverTransport({ context: clock, startFrame, countInFrames, onInterrupted }),
      visibleAndFocused: () => true,
      planStartFrame: () => { throw new Error('Provisional anchor was used') },
      publish: () => {},
    })
    try {
      const started = owner.start('A1', 20, 30)
      if (started.status !== 'started') throw new Error(started.reason)
      const deadline = performance.now() + 6_000
      while (!(mode === 'cancel' ? ['counting-in', 'failed', 'cleanup-failed'] :
        ['recording', 'failed', 'cleanup-failed']).includes(owner.status.session?.phase ?? '') &&
        performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      const phase = owner.status.session?.phase
      if (mode === 'late') return { phase, diagnostic: owner.status.diagnostic,
        trackState: microphone.stream.getAudioTracks()[0].readyState,
        playing: useTransportStore.getState().isPlaying }
      if (mode === 'cancel') {
        if (phase !== 'counting-in') throw new Error(`Could not count in: ${JSON.stringify(owner.status)}`)
        const anchorSample = owner.status.timing!.anchorSample
        await owner.cancel()
        await owner.whenIdle()
        await new Promise((resolve) => setTimeout(resolve,
          Math.max(0, (anchorSample / context.sampleRate - context.currentTime) * 1_000) + 100))
        return { phase: owner.status.session?.phase,
          trackState: microphone.stream.getAudioTracks()[0].readyState,
          playing: useTransportStore.getState().isPlaying }
      }
      if (phase !== 'recording') throw new Error(`Could not start: ${JSON.stringify(owner.status)}`)
      const timing = owner.status.timing!
      const samplesBefore = Math.floor(context.currentTime * context.sampleRate)
      await new Promise((resolve) => setTimeout(resolve, 120))
      const expectedPlayhead = voiceoverTimelineFrameAtSample(
        Math.floor(context.currentTime * context.sampleRate), timing.anchorSample, 20, doc)
      const playhead = useTransportStore.getState().playheadFrame
      await owner.stop()
      const review = owner.status
      const exactBoundary = voiceoverSampleAtTimelineFrame(review.timing!.stopFrame!,
        review.timing!.anchorSample, 20, doc)
      return { phase: review.session?.phase, anchorSample: timing.anchorSample,
        countInStartSample: timing.countInStartSample, samplesBefore,
        stopSample: review.timing?.stopSample, stopFrame: review.timing?.stopFrame,
        exactBoundary, capturedSamples: review.capturedSamples, expectedPlayhead, playhead,
        trackState: microphone.stream.getAudioTracks()[0].readyState,
        playing: useTransportStore.getState().isPlaying,
        compensation: review.timing?.compensationSamples }
    } finally {
      await owner.cancel().catch(() => {})
      oscillator.stop()
      oscillator.disconnect()
      for (const track of microphone.stream.getTracks()) track.stop()
      await disposeTransport()
    }
  }, mode)
  if (mode === 'late') {
    expect(result.phase).toBe('failed')
    expect(result.diagnostic).toContain('missed its start sample frame')
    expect(result.trackState).toBe('ended')
    expect(result.playing).toBe(false)
  } else if (mode === 'cancel') {
    expect(result.phase).toBe('cancelled')
    expect(result.trackState).toBe('ended')
    expect(result.playing).toBe(false)
  } else {
    expect(result.phase).toBe('review')
    expect(result.anchorSample).toBeGreaterThan(result.countInStartSample!)
    expect(result.samplesBefore).toBeGreaterThanOrEqual(result.anchorSample!)
    expect(result.stopSample).toBe(result.exactBoundary)
    expect(result.capturedSamples).toBe(result.stopSample! - result.anchorSample!)
    expect(Math.abs(result.playhead! - result.expectedPlayhead!)).toBeLessThanOrEqual(2)
    expect(result.trackState).toBe('ended')
    expect(result.playing).toBe(false)
    expect(result.compensation).toBe(0)
  }
})
