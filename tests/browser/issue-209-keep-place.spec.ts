import { expect, test } from '@playwright/test'

test('Chromium keeps an OPFS voiceover through normal import and one-history placement', async ({ page }) => {
  await page.goto('/')
  await page.mouse.click(10, 10)
  const result = await page.evaluate(async () => {
    const ownerPath = '/src/app/voiceoverCaptureOwner.ts'
    const writerPath = '/src/app/voiceoverWavBridge.ts'
    const microphonePath = '/src/app/voiceoverMicrophoneBridge.ts'
    const transportPath = '/src/app/transportController.ts'
    const importPath = '/src/app/mediaImportController.ts'
    const placementPath = '/src/app/mediaPlacementController.ts'
    const handlesPath = '/src/app/localMediaHandles.ts'
    const provenancePath = '/src/app/localProjectProvenance.ts'
    const settingsPath = '/src/domain/projectSettings.ts'
    const documentPath = '/src/state/documentStore.ts'
    const mediaPath = '/src/state/mediaStore.ts'
    const transportStorePath = '/src/state/transportStore.ts'
    const { VoiceoverCaptureOwner, currentVoiceoverDestinationContext } = await import(ownerPath)
    const { VoiceoverWavBridge } = await import(writerPath)
    const { connectVoiceoverMicrophone, prepareVoiceoverMicrophoneWorklet } = await import(microphonePath)
    const { armVoiceoverTransport, getPlaybackClockContext, disposeTransport } = await import(transportPath)
    const { importMediaFromHandle, cancelMediaImport } = await import(importPath)
    const { placeImportedAsset } = await import(placementPath)
    const { localMediaHandleRegistry } = await import(handlesPath)
    const { setActiveLocalProjectBindingId, clearActiveLocalProjectBindingId } = await import(provenancePath)
    const { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } = await import(settingsPath)
    const { useDocumentStore } = await import(documentPath)
    const { useMediaStore } = await import(mediaPath)
    const { useTransportStore } = await import(transportStorePath)
    const binding = `local-project:keep-${crypto.randomUUID()}`
    setActiveLocalProjectBindingId(binding)
    const doc = createTimelineDoc('Keep browser test', DEFAULT_PROJECT_SETTINGS, `keep-${crypto.randomUUID()}`)
    useDocumentStore.getState().setDoc(doc)
    useMediaStore.setState({ descriptors: new Map(), assets: new Map(),
      compatibility: new Map(), visuals: new Map() })
    useTransportStore.getState().setPlayheadFrame(0)
    const context = getPlaybackClockContext() as AudioContext
    const oscillator = context.createOscillator()
    oscillator.frequency.value = 331
    const microphone = context.createMediaStreamDestination()
    oscillator.connect(microphone)
    oscillator.start()
    const owner = new VoiceoverCaptureOwner({
      destinationContext: currentVoiceoverDestinationContext,
      requestMicrophone: () => Promise.resolve(microphone.stream),
      getContext: () => context,
      createWriter: () => new VoiceoverWavBridge(),
      prepareWorklet: prepareVoiceoverMicrophoneWorklet,
      connect: connectVoiceoverMicrophone,
      armTransport: (clock: AudioContext, startFrame: number, countInFrames: number,
        onInterrupted: (reason: 'transport-changed' | 'destination-changed') => void) =>
        armVoiceoverTransport({ context: clock, startFrame, countInFrames, onInterrupted }),
      importFinalized: importMediaFromHandle,
      rememberOriginal: async (assetId: string, handle: FileSystemFileHandle) =>
        localMediaHandleRegistry.remember(binding, assetId, handle),
      importedDurationFrames: (assetId: string) => useMediaStore.getState().assets.get(assetId)?.durationFrames ?? null,
      placeImported: placeImportedAsset,
      cancelImport: () => { cancelMediaImport() },
      visibleAndFocused: () => true,
      planStartFrame: () => { throw new Error('Provisional anchor used') },
      publish: () => {},
      subscribeDocument: (onChange: () => void) => useDocumentStore.subscribe(onChange),
    })
    try {
      const started = owner.start('A1', 20, { countInFrames: 30 })
      if (started.status !== 'started') throw new Error(started.reason)
      const deadline = performance.now() + 6_000
      while (owner.status.session?.phase !== 'recording' && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (owner.status.session?.phase !== 'recording') throw new Error(JSON.stringify(owner.status))
      await new Promise((resolve) => setTimeout(resolve, 120))
      await owner.stop()
      if (owner.status.session?.phase !== 'review') throw new Error(JSON.stringify(owner.status))
      const expectedFrames = owner.status.timing!.stopFrame! - 20
      await owner.keep(true)
      const status = owner.status
      const assetId = status.session?.phase === 'kept' ? status.session.assetId : null
      const asset = assetId ? useMediaStore.getState().assets.get(assetId) : null
      const descriptor = assetId ? useMediaStore.getState().descriptors.get(assetId) : null
      const remembered = assetId ? await localMediaHandleRegistry.load(binding, assetId) : null
      const rememberedFile = await remembered?.getFile()
      const clipsBeforeUndo = useDocumentStore.getState().doc.tracks.find((track: { id: string }) => track.id === 'A1')?.clips.length
      const historyCount = useDocumentStore.getState().past.length
      useDocumentStore.getState().undo()
      const clipsAfterUndo = useDocumentStore.getState().doc.tracks.find((track: { id: string }) => track.id === 'A1')?.clips.length
      useDocumentStore.getState().redo()
      const clipsAfterRedo = useDocumentStore.getState().doc.tracks.find((track: { id: string }) => track.id === 'A1')?.clips.length
      return { phase: status.session?.phase, location: status.session?.phase === 'kept' ? status.session.location : null,
        diagnostic: status.diagnostic, assetKind: asset?.kind, assetDuration: asset?.durationFrames,
        descriptor: Boolean(descriptor), expectedFrames, rememberedSize: rememberedFile?.size,
        assetSize: asset?.size, clipsBeforeUndo, clipsAfterUndo, clipsAfterRedo, historyCount }
    } finally {
      await owner.cancel().catch(() => {})
      oscillator.stop()
      oscillator.disconnect()
      for (const track of microphone.stream.getTracks()) track.stop()
      await disposeTransport()
      clearActiveLocalProjectBindingId()
    }
  })
  expect(result.phase, result.diagnostic ?? undefined).toBe('kept')
  expect(result.location, result.diagnostic ?? undefined).toBe('timeline')
  expect(result.assetKind).toBe('audio')
  expect(result.assetDuration).toBe(result.expectedFrames)
  expect(result.descriptor).toBe(true)
  expect(result.rememberedSize).toBe(result.assetSize)
  expect(result.clipsBeforeUndo).toBe(1)
  expect(result.clipsAfterUndo).toBe(0)
  expect(result.clipsAfterRedo).toBe(1)
  expect(result.historyCount).toBe(1)
})
