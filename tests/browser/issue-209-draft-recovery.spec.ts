import { expect, test } from '@playwright/test'

test('Chromium protects cross-project recordings and verifies an OPFS original before removal', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const bridgePath = '/src/app/voiceoverWavBridge.ts'
    const recoveryPath = '/src/app/voiceoverDraftRecovery.ts'
    const handlesPath = '/src/app/localMediaHandles.ts'
    const provenancePath = '/src/app/localProjectProvenance.ts'
    const { VoiceoverWavBridge } = await import(bridgePath)
    const { VoiceoverDraftRecovery } = await import(recoveryPath)
    const { localMediaHandleRegistry } = await import(handlesPath)
    const { setActiveLocalProjectBindingId, clearActiveLocalProjectBindingId } = await import(provenancePath)
    const binding = `local-project:recovery-${crypto.randomUUID()}`
    const otherBinding = `local-project:recovery-${crypto.randomUUID()}`
    const draftId = `voiceover_${crypto.randomUUID()}`
    const snapshot = {}
    const disconnects: string[] = []
    const writer = new VoiceoverWavBridge()
    let recovery: InstanceType<typeof VoiceoverDraftRecovery> | null = null
    setActiveLocalProjectBindingId(binding)
    try {
      await writer.create(draftId)
      await writer.stop()
      const finalized = await writer.finalize()
      await localMediaHandleRegistry.remember(binding, 'asset-current', finalized.handle)
      await localMediaHandleRegistry.remember(otherBinding, 'asset-other', finalized.handle)

      const deps = {
        createWriter: () => new VoiceoverWavBridge(),
        projectBindingId: () => binding,
        projectGeneration: () => 0,
        documentSnapshot: () => snapshot,
        projectAssetIds: () => ['asset-current'],
        loadHandle: (owner: string, assetId: string) => localMediaHandleRegistry.load(owner, assetId),
        forgetHandle: (owner: string, assetId: string) => localMediaHandleRegistry.forget(owner, assetId),
        allRememberedHandles: () => localMediaHandleRegistry.list(),
        retainedAssetIds: () => [],
        isRecordingOriginal: async (id: string, handle: FileSystemFileHandle) => {
          const root = await navigator.storage.getDirectory()
          const recordings = await root.getDirectoryHandle('myrelith-recordings-v1')
          return handle.isSameEntry(await recordings.getFileHandle(`${id}.wav`))
        },
        importMedia: async () => ({ status: 'failed' as const, message: 'not used' }),
        liveSession: () => null,
        disconnectAsset: (assetId: string) => { disconnects.push(assetId) },
      }
      recovery = new VoiceoverDraftRecovery(deps)
      const survey = await recovery.survey()
      const protectedRemoval = await recovery.removeKeptOriginal('asset-current')
      await localMediaHandleRegistry.forget(otherBinding, 'asset-other')
      const removal = await recovery.removeKeptOriginal('asset-current')
      return {
        sizeBytes: finalized.file.size,
        classification: survey.drafts.find((draft: { id: string }) => draft.id === draftId)?.state,
        projectCount: survey.drafts.find((draft: { id: string }) => draft.id === draftId)?.references.length,
        protectedRemoval,
        removal,
        disconnects,
        registryAfter: await localMediaHandleRegistry.load(binding, 'asset-current'),
      }
    } finally {
      recovery?.dispose()
      writer.close()
      await localMediaHandleRegistry.forget(binding, 'asset-current').catch(() => {})
      await localMediaHandleRegistry.forget(otherBinding, 'asset-other').catch(() => {})
      const root = await navigator.storage.getDirectory()
      const recordings = await root.getDirectoryHandle('myrelith-recordings-v1').catch(() => null)
      await recordings?.removeEntry(`${draftId}.wav`).catch(() => {})
      await recordings?.removeEntry(`${draftId}.checkpoint`).catch(() => {})
      clearActiveLocalProjectBindingId()
    }
  })

  expect(result.sizeBytes).toBe(44)
  expect(result.classification).toBe('kept')
  expect(result.projectCount).toBe(2)
  expect(result.protectedRemoval).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/Another project/) })
  expect(result.removal).toEqual({ status: 'removed', sizeBytes: 44 })
  expect(result.disconnects).toEqual(['asset-current'])
  expect(result.registryAfter).toBeNull()
})
