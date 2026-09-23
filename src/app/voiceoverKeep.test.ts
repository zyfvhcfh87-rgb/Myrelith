import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import type { MediaAsset } from '../domain/schema'
import { voiceoverWavHeader } from '../pipeline/voiceoverWavDraft'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { resetDocumentStoreForTest, resetMediaStoreForTest } from '../test/storeFixtures'
import { placeImportedAsset } from './mediaPlacementController'
import { VoiceoverCaptureOwner, currentVoiceoverDestinationContext, type VoiceoverCaptureDeps } from './voiceoverCaptureOwner'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function importedAudio(durationFrames: number): MediaAsset {
  return {
    id: 'voiceover-asset', fileName: 'voiceover.wav', mimeType: 'audio/wav',
    size: 22_444, lastModified: 1, objectUrl: 'blob:voiceover', kind: 'audio',
    durationFrames, durationMicroseconds: Math.round(durationFrames * 1_000_000 / 30),
    sourceBounds: { video: null,
      audio: { status: 'exact', firstTimestampUs: 0,
        endTimestampUs: Math.round(durationFrames * 1_000_000 / 30) } },
    frameRate: null, width: null, height: null, hasAudio: true,
    audioSampleRate: 48_000, audioChannels: 1, decoderConfigB64: null,
  }
}

function harness(options: {
  importResult?: (file: File) => Promise<'imported' | 'unsupported' | 'cancelled'>
  rememberFailure?: boolean
  durationOffset?: number
  beforePlace?: () => void
  corruptFinalLength?: boolean
  durationReadFailure?: boolean
} = {}) {
  const clock = { sampleRate: 48_000, currentTime: 0, resume: async () => undefined }
  const context = clock as AudioContext
  const trackState = { readyState: 'live' as 'live' | 'ended' }
  const track = { label: 'Mic', get readyState() { return trackState.readyState },
    stop: () => { trackState.readyState = 'ended' }, addEventListener: () => {},
    removeEventListener: () => {} } as unknown as MediaStreamTrack
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as MediaStream
  const recorded = { endSample: 0, pcmBytes: 0 }
  const finalizedFile = () => new File([voiceoverWavHeader(recorded.pcmBytes).buffer as ArrayBuffer,
    new ArrayBuffer(recorded.pcmBytes)], 'voiceover.wav', { type: 'audio/wav' })
  const handle = { kind: 'file', name: 'voiceover.wav', getFile: finalizedFile } as unknown as FileSystemFileHandle
  const remember = vi.fn(async () => {
    if (options.rememberFailure) throw new Error('IndexedDB unavailable')
  })
  const importFinalized = vi.fn(async (file: File) => {
    const result = await options.importResult?.(file) ?? 'imported'
    if (result === 'cancelled') return { status: 'cancelled' as const }
    if (result === 'unsupported') return { status: 'unsupported' as const, itemId: 'voiceover-asset' }
    const frames = (recorded.endSample - 48_000) / 1_600 + (options.durationOffset ?? 0)
    expect(useMediaStore.getState().addAsset(importedAudio(frames))).toBe(true)
    return { status: 'imported' as const, assetId: 'voiceover-asset' }
  })
  const cancelImport = vi.fn()
  let projectOverride: string | null = null
  const owner = new VoiceoverCaptureOwner({
    destinationContext: () => {
      const current = currentVoiceoverDestinationContext()
      return projectOverride ? { ...current, projectId: projectOverride } : current
    },
    requestMicrophone: async () => stream,
    getContext: () => context,
    createWriter: () => ({
      create: async () => ({ pcmBytes: 0, committedBytes: 0 }) as never,
      append: async () => ({ pcmBytes: 0, committedBytes: 0 }) as never,
      stop: async () => ({ pcmBytes: recorded.pcmBytes,
        committedBytes: recorded.pcmBytes }) as never,
      release: async () => ({ pcmBytes: recorded.pcmBytes,
        committedBytes: recorded.pcmBytes }) as never,
      recover: async () => ({ pcmBytes: recorded.pcmBytes,
        committedBytes: recorded.pcmBytes }) as never,
      discard: async () => undefined,
      finalize: async () => ({ file: options.corruptFinalLength
        ? new File([new ArrayBuffer(44)], 'voiceover.wav') : finalizedFile(),
      handle, pcmBytes: recorded.pcmBytes }),
      close: () => undefined,
    }),
    connect: async (input) => {
      input.onStarted?.(input.startFrame)
      const finished = deferred<Awaited<ReturnType<Awaited<ReturnType<VoiceoverCaptureDeps['connect']>>['stop']>>>()
      return { outputNode: {} as AudioWorkletNode, finished: finished.promise,
        stop: async (atFrame?: number) => {
          recorded.endSample = atFrame ?? input.startFrame
          recorded.pcmBytes = (recorded.endSample - input.startFrame) * 2
          const progress = await input.writer.stop()
          input.onTerminal?.('stopped', recorded.endSample)
          const result = { reason: 'stopped' as const, startFrame: input.startFrame,
            endFrame: recorded.endSample, samples: recorded.pcmBytes / 2,
            batches: 1, peakInFlightBytes: 0, progress }
          finished.resolve(result)
          return result
        },
        abortForCleanup: () => undefined, dispose: () => undefined,
        snapshot: () => ({ nextFrame: input.startFrame, pendingBytes: 0,
          peakInFlightBytes: 0, batches: 0, reason: null, settled: false }),
      }
    },
    armTransport: async (_context, startFrame) => ({ context, anchorSample: 48_000,
      countInStartSample: 46_400, startFrame, release: () => undefined }),
    visibleAndFocused: () => true,
    planStartFrame: () => { throw new Error('Fallback anchor used') },
    publish: () => undefined,
    importFinalized,
    rememberOriginal: remember,
    importedDurationFrames: (id) => {
      if (options.durationReadFailure) throw new Error('Duration lookup failed')
      return useMediaStore.getState().assets.get(id)?.durationFrames ?? null
    },
    placeImported: (...args) => { options.beforePlace?.(); return placeImportedAsset(...args) },
    cancelImport,
    subscribeDocument: (onChange) => useDocumentStore.subscribe(onChange),
  })
  return { owner, clock, track, recorded, handle, remember, importFinalized, cancelImport,
    staleProject: () => { projectOverride = 'other-project' },
    async review() {
      expect(owner.start('A1', 20, 0).status).toBe('started')
      await owner.whenIdle()
      expect(owner.status.session?.phase).toBe('recording')
      clock.currentTime = 1.1
      await owner.stop()
      expect(owner.status.session?.phase).toBe('review')
      expect(owner.status.timing?.stopFrame).toBeGreaterThan(20)
    } }
}

beforeEach(() => {
  resetDocumentStoreForTest(createTimelineDoc('Keep test', DEFAULT_PROJECT_SETTINGS, 'voiceover-sequence'))
  resetMediaStoreForTest()
})

describe('voiceover Keep and placement', () => {
  test('keeps a verified WAV, remembers the OPFS handle, and places with one undo entry', async () => {
    const h = harness()
    await h.review()
    await h.owner.keep(true)

    expect(h.owner.status.session).toMatchObject({ phase: 'kept', location: 'timeline',
      assetId: 'voiceover-asset' })
    expect(h.importFinalized).toHaveBeenCalledWith(expect.any(File), h.handle)
    expect(h.remember).toHaveBeenCalledWith('voiceover-asset', h.handle)
    const document = useDocumentStore.getState()
    expect(document.past).toHaveLength(1)
    expect(document.doc.tracks.find((track) => track.id === 'A1')?.clips).toHaveLength(1)
    document.undo()
    expect(useDocumentStore.getState().doc.tracks.find((track) => track.id === 'A1')?.clips).toHaveLength(0)
    useDocumentStore.getState().redo()
    expect(useDocumentStore.getState().doc.tracks.find((track) => track.id === 'A1')?.clips).toHaveLength(1)
  })

  test('an overlapping edit keeps the imported take in the Pool without another history entry', async () => {
    const h = harness()
    await h.review()
    useDocumentStore.getState().insertClip('A1', {
      id: 'overlap', assetId: 'other', name: 'Other', sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 10 },
      timelineRange: { startFrame: 20, durationFrames: 10 },
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1, volume: 1, effects: [],
    })
    const history = useDocumentStore.getState().past.length
    await h.owner.keep(true)
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', location: 'pool' })
    expect(useMediaStore.getState().assets.has('voiceover-asset')).toBe(true)
    expect(useDocumentStore.getState().past).toHaveLength(history)
  })

  test('a collision introduced at the final placement check keeps the take in the Pool', async () => {
    const h = harness({ beforePlace: () => useDocumentStore.getState().insertClip('A1', {
      id: 'late-overlap', assetId: 'other', name: 'Other', sourceMode: 'timed',
      sourceRange: { startFrame: 0, durationFrames: 10 },
      timelineRange: { startFrame: 20, durationFrames: 10 },
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
      opacity: 1, volume: 1, effects: [],
    }) })
    await h.review()
    await h.owner.keep(true)
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', location: 'pool' })
    expect(h.owner.status.diagnostic).toContain('Media Pool')
    expect(useDocumentStore.getState().past).toHaveLength(1)
    expect(useDocumentStore.getState().doc.tracks.find((track) => track.id === 'A1')?.clips).toHaveLength(1)
  })

  test('a replaced project retains the draft and never starts import', async () => {
    const h = harness()
    await h.review()
    h.staleProject()
    await h.owner.keep(true)
    expect(h.owner.status.session?.phase).toBe('review')
    expect(h.owner.status.diagnostic).toContain('draft was retained')
    expect(h.importFinalized).not.toHaveBeenCalled()
  })

  test('failed import leaves a reviewable draft and can be retried', async () => {
    let attempts = 0
    const h = harness({ importResult: async () => ++attempts === 1 ? 'unsupported' : 'imported' })
    await h.review()
    await h.owner.keep(false)
    expect(h.owner.status.session?.phase).toBe('review')
    expect(h.owner.status.diagnostic).toContain('unsupported')
    await h.owner.keep(false)
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', location: 'pool' })
    expect(h.importFinalized).toHaveBeenCalledTimes(2)
  })

  test('a changed finalized length blocks import and retains review', async () => {
    const h = harness({ corruptFinalLength: true })
    await h.review()
    await h.owner.keep(true)
    expect(h.owner.status.session?.phase).toBe('review')
    expect(h.owner.status.diagnostic).toContain('does not match')
    expect(h.importFinalized).not.toHaveBeenCalled()
  })

  test('a decoded duration mismatch keeps the source in the Pool', async () => {
    const h = harness({ durationOffset: 1 })
    await h.review()
    await h.owner.keep(true)
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', location: 'pool' })
    expect(h.owner.status.diagnostic).toContain('duration differs')
    expect(useDocumentStore.getState().past).toHaveLength(0)
  })

  test('a failure after import reports a kept Pool asset instead of inviting duplicate import', async () => {
    const h = harness({ durationReadFailure: true })
    await h.review()
    await h.owner.keep(true)
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', location: 'pool' })
    expect(h.owner.status.diagnostic).toContain('Duration lookup failed')
    expect(h.importFinalized).toHaveBeenCalledOnce()
    expect(useMediaStore.getState().assets.size).toBe(1)
  })

  test('project teardown cancels a pending import and retains the draft', async () => {
    const pending = deferred<'cancelled'>()
    const h = harness({ importResult: () => pending.promise })
    await h.review()
    const keep = h.owner.keep(true)
    await vi.waitFor(() => expect(h.importFinalized).toHaveBeenCalledOnce())
    const teardown = h.owner.teardownForProjectChange()
    expect(h.cancelImport).toHaveBeenCalledOnce()
    pending.resolve('cancelled')
    await Promise.all([keep, teardown])
    expect(h.owner.status.session).toMatchObject({ phase: 'failed', failure: 'project-replaced' })
    expect(h.remember).not.toHaveBeenCalled()
  })

  test('remembering failure is reported after import without duplicating an asset', async () => {
    const h = harness({ rememberFailure: true })
    await h.review()
    await h.owner.keep(false)
    expect(h.owner.status.session).toMatchObject({ phase: 'kept', location: 'pool' })
    expect(h.owner.status.diagnostic).toContain('could not be remembered')
    expect(useMediaStore.getState().assets.size).toBe(1)
  })
})
