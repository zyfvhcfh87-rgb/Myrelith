import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CaptionTranscriptionController, type SpeechControllerPort } from './captionTranscriptionController'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useTransportStore } from '../state/transportStore'
import { useSourceMonitorStore } from '../state/sourceMonitorStore'
import { captionIntentProject } from '../test/captionIntentFixtures'
import { mediaResourceAdmission } from './mediaResourceAdmission'
import { beginSpeechRetirement } from './speechRetirement'
import type { SpeechWorkerPort } from './speechWorkerJob'
import type { SpeechRequest, SpeechWorkerReply } from '../pipeline/speechProtocol'
import type { MediaAsset } from '../domain/schema'
const source: MediaAsset = { id: 'audio', fileName: 'speech.wav', mimeType: 'audio/wav', size: 16, lastModified: 1,
  objectUrl: 'blob:source', kind: 'audio', durationFrames: 60, durationMicroseconds: 2_000_000,
  sourceBounds: { audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: 2_000_000 }, video: null },
  frameRate: null, width: null, height: null, hasAudio: true, audioSampleRate: 48000, audioChannels: 2, decoderConfigB64: null }
const installed = { name: 'model-cache', bytes: 43537433, manifestDigest: 'a'.repeat(64), bundleId: 'bundle', revision: 'b'.repeat(40) }
const ledger = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, pcmBytes: 0, maxPcmBytes: 128000, windows: 1, acquiredSamples: 3, closedSamples: 3 }
const selection = { assetId: 'audio', language: 'en', startMicroseconds: 0, endMicroseconds: 2_000_000, targetFrame: 100 } as const
const disposals: Array<() => Promise<void>> = []
function harness(overrides: Partial<SpeechControllerPort> = {}) {
  let request: SpeechRequest | null = null
  const worker: SpeechWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, terminate: vi.fn(),
    postMessage: vi.fn(data => { if (data.type === 'transcribe') request = data }) }
  const port: SpeechControllerPort = { installed: vi.fn(async () => installed), install: vi.fn(async () => installed), remove: vi.fn(async () => {}),
    fetchBlob: vi.fn(async () => new Blob(['source'])), fingerprint: vi.fn(async () => ({ algorithm: 'sha256-sampled-v1' as const, digest: 'c'.repeat(64), fileName: source.fileName, size: source.size, lastModified: source.lastModified })),
    createWorker: vi.fn(() => worker), ...overrides }
  const controller = new CaptionTranscriptionController(port)
  const stop = controller.subscribe(() => {})
  const emit = (data: Omit<Extract<SpeechWorkerReply, { type: 'complete' }>, 'requestId'> | Omit<Extract<SpeechWorkerReply, { type: 'disposed' }>, 'requestId'>) => {
    if (!request) throw new Error('No job request')
    worker.onmessage?.call(worker as Worker, { data: { ...data, requestId: request.requestId } } as MessageEvent)
  }
  disposals.push(async () => {
    const drain = controller.cancel()
    if (request && worker.onmessage) emit({ type: 'disposed', cooperativeZero: true, ledger })
    await drain; stop(); await Promise.resolve(); await Promise.resolve()
  })
  const complete = (untimed = false) => emit({ type: 'complete', cooperativeZero: true, ledger, transcript: {
    sourceSampleRate: 48000, channels: 2, sourceStartSample: 0, sourceSampleCount: 96000,
    windows: [untimed ? { sourceStartSample: 0, sourceSampleCount: 96000, timing: 'unavailable', reason: 'timestamp-coverage', text: 'Manual speech words' }
      : { sourceStartSample: 0, sourceSampleCount: 96000, timing: 'model', segments: [{ text: 'Hello from speech', fromCentiseconds: 0, toCentiseconds: 100 }] }],
  } })
  const started = async () => { controller.start(selection); await vi.waitFor(() => expect(port.createWorker).toHaveBeenCalledOnce()) }
  return { controller, port, worker, emit, complete, started, stop }
}
beforeEach(() => {
  useDocumentStore.setState({ retainedCaptionOwners: {} })
  useDocumentStore.getState().setProject(captionIntentProject())
  useMediaStore.setState({ assets: new Map([['audio', source]]), descriptors: new Map(), compatibility: new Map() })
  useTransportStore.setState({ isPlaying: false })
  useSourceMonitorStore.setState({ playbackOwner: 'none' })
})
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })
test('review is resource-free, survives Play, and applies the complete portable edit with one Undo', async () => {
  const { controller, complete, started } = harness()
  const before = useDocumentStore.getState()
  await started(); expect(mediaResourceAdmission.snapshot().blockers).toContain('analysis')
  complete()
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('review'))
  expect(mediaResourceAdmission.snapshot().blockers).not.toContain('analysis')
  expect(beginSpeechRetirement('Program playback')).toBeNull()
  expect(controller.getSnapshot().rows).toHaveLength(1)
  expect(useDocumentStore.getState().project).toBe(before.project)
  expect(controller.apply()).toBe(true)
  expect(useDocumentStore.getState().past.length).toBe(before.past.length + 1)
  const cue = useDocumentStore.getState().doc.captionTracks!.at(-1)!.items[0]!
  expect(cue.range).toEqual({ startFrame: 100, durationFrames: 30 })
  expect(cue.origin?.params.sourceSampleCount).toBe(48000)
  useDocumentStore.getState().undo()
  expect(useDocumentStore.getState().project).toBe(before.project)
})
test('untimed text has no automatic endpoints and requires manual timing or exclusion', async () => {
  const { controller, started, complete } = harness()
  await started(); complete(true)
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('review'))
  const row = controller.getSnapshot().rows[0]!
  expect(row.startFrame).toBeNull(); expect(row.endFrame).toBeNull()
  expect(controller.apply()).toBe(false)
  controller.updateRow(row.id, { startFrame: 100, endFrame: 145, text: 'Reviewed speech' })
  expect(controller.apply()).toBe(true)
})
test.each(['project', 'source'] as const)('%s replacement cancels and retains admission through late native acknowledgement', async reason => {
  const { controller, started, worker, complete } = harness()
  await started()
  if (reason === 'project') useDocumentStore.getState().setProject(captionIntentProject())
  else useMediaStore.setState({ assets: new Map([['audio', { ...source, objectUrl: 'blob:replacement' }]]) })
  expect(controller.getSnapshot().phase).toBe('stopping')
  expect(mediaResourceAdmission.snapshot().blockers).toContain('analysis')
  expect(worker.terminate).not.toHaveBeenCalled()
  complete()
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('idle'))
  expect(controller.getSnapshot().rows).toHaveLength(0)
  expect(mediaResourceAdmission.snapshot().blockers).not.toContain('analysis')
})
test('project replacement aborts model acquisition and blocks a new worker during cleanup', async () => {
  let signal: AbortSignal | null = null, finish!: () => void
  const { controller, port } = harness({ install: (_file, abort) => { signal = abort; return new Promise(resolve => { finish = () => resolve(installed) }) } })
  controller.install(null)
  await vi.waitFor(() => expect(signal).not.toBeNull())
  useDocumentStore.getState().setProject(captionIntentProject())
  expect(signal!.aborted).toBe(true)
  controller.start(selection)
  expect(port.createWorker).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(controller.getSnapshot().installed).toBeNull())
})
test('closing the panel keeps the retirement hook until its native owner acknowledges', async () => {
  const { started, stop, controller, emit } = harness()
  await started(); stop()
  const pending = beginSpeechRetirement('Export')
  expect(pending).toBeInstanceOf(Promise)
  emit({ type: 'disposed', cooperativeZero: true, ledger })
  await pending
  expect(controller.getSnapshot().rows).toHaveLength(0)
  await Promise.resolve(); await Promise.resolve()
  expect(beginSpeechRetirement('Export')).toBeNull()
})

test('worker constructor failure is visible and releases known-unused scheduler ownership', async () => {
  const createWorker = vi.fn(() => { throw new Error('Worker construction denied') })
  const { controller } = harness({ createWorker })
  controller.start(selection)
  await vi.waitFor(() => expect(controller.getSnapshot().error).toContain('Worker construction denied'))
  expect(mediaResourceAdmission.snapshot().blockers).not.toContain('analysis')
})
