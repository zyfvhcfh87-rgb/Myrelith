import { afterEach, expect, test, vi } from 'vitest'
import { createAudioAlignmentWorker, type AudioAlignmentWorkerLike } from './audioAlignmentWorkerBridge'
import type { AudioAlignmentSourceFacts } from '../pipeline/audioAlignmentProtocol'
const facts: AudioAlignmentSourceFacts = { audioStreamIndex: 0, audioTrackId: '2', inputSampleRate: 48_000,
  channels: 1, firstTimestamp: 0, endTimestamp: 30, decodePolicy: 'test' }
function setup() {
  const worker: AudioAlignmentWorkerLike = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null }
  const abort = new AbortController()
  const counts: number[] = []
  const bridge = createAudioAlignmentWorker(abort.signal, (count) => counts.push(count), vi.fn(), () => worker)
  const open = () => bridge.open(new Blob(['x']), 'asset', { fileBytes: 1, durationMicroseconds: 30_000_000 })
  return { worker, abort, bridge, counts, open }
}
afterEach(() => vi.useRealTimers())
test('cache-hit close owns no decoder and terminates once', async () => {
  const f = setup()
  const pending = f.open()
  f.worker.onmessage!({ data: { type: 'opened', facts } } as MessageEvent)
  expect(await pending).toEqual(facts)
  f.bridge.close(); f.bridge.close()
  expect(f.worker.terminate).toHaveBeenCalledOnce()
  expect(f.counts).toEqual([0])
})
test('abort terminates an active decoder before rejection and ignores late replies', async () => {
  const f = setup()
  const opened = f.open()
  f.worker.onmessage!({ data: { type: 'opened', facts } } as MessageEvent)
  await opened
  const pending = f.bridge.decode({ inputSampleRate: 48000, channels: 1, startSample: 0, binCount: 2000 })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  f.abort.abort()
  await rejected
  expect(f.counts).toEqual([1, 0])
  expect(f.worker.terminate).toHaveBeenCalledOnce()
  expect(f.worker.onmessage).toBeNull()
})
test('an unresponsive opener or failed postMessage releases the worker', async () => {
  vi.useFakeTimers()
  const f = setup()
  const pending = expect(f.open()).rejects.toThrow(/deadline/)
  await vi.advanceTimersByTimeAsync(30_000)
  await pending
  expect(f.worker.terminate).toHaveBeenCalledOnce()
  const second = setup()
  vi.mocked(second.worker.postMessage).mockImplementation(() => { throw new Error('post failed') })
  await expect(second.open()).rejects.toThrow('post failed')
  expect(second.worker.terminate).toHaveBeenCalledOnce()
})
