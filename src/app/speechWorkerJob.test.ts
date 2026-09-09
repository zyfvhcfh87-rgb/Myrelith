import { afterEach, expect, test, vi } from 'vitest'
import { SpeechWorkerJob, type SpeechWorkerPort } from './speechWorkerJob'
import type { SpeechRequest, SpeechWorkerReply } from '../pipeline/speechProtocol'
const request: SpeechRequest = { type: 'transcribe', requestId: 'request-1', modelCache: 'test', blob: new Blob(['test']), sourceId: 'source',
  budget: { fileBytes: 4, durationMicroseconds: 1_000_000 }, language: 'en', startMicroseconds: 0, endMicroseconds: 1_000_000 }
const ledger = { modelOwners: 0, inputOwners: 0, sampleOwners: 0, pcmBytes: 0, maxPcmBytes: 32000, windows: 1, acquiredSamples: 5, closedSamples: 5 }
function harness() {
  const worker: SpeechWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() }
  const failure = vi.fn(), phase = vi.fn()
  const job = new SpeechWorkerJob(request, phase, failure, () => worker)
  const output = job.result.catch(cause => cause as Error)
  const emit = (data: SpeechWorkerReply) => worker.onmessage?.call(worker as Worker, { data } as MessageEvent)
  return { job, worker, output, failure, emit }
}
afterEach(() => vi.useRealTimers())
test('cancel rejects output immediately and retains admission until matching zero acknowledgement', async () => {
  const { job, output, emit, worker } = harness()
  let retired = false; void job.retired.then(() => { retired = true })
  const cancel = job.cancel()
  expect((await output) instanceof Error).toBe(true); expect(retired).toBe(false)
  expect(worker.terminate).not.toHaveBeenCalled()
  emit({ type: 'disposed', requestId: request.requestId, cooperativeZero: true, ledger })
  await cancel; await job.retired
  expect(retired).toBe(true); expect(worker.terminate).toHaveBeenCalledOnce()
})
test('an unacknowledged deadline rejects essential waiting but does not release the scheduler owner', async () => {
  vi.useFakeTimers()
  const { job, output, failure, worker } = harness()
  let retired = false; void job.retired.then(() => { retired = true })
  const cancellation = job.cancel().catch(cause => cause as Error)
  await vi.advanceTimersByTimeAsync(120_101)
  expect(await output).toBeInstanceOf(Error); expect(await cancellation).toBeInstanceOf(Error)
  expect(retired).toBe(false); expect(failure).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce()
})
test('a late complete message while cancelling cannot become a review', async () => {
  const { job, output, emit } = harness()
  const cancel = job.cancel()
  emit({ type: 'complete', requestId: request.requestId, cooperativeZero: true, ledger,
    transcript: { sourceSampleRate: 16000, channels: 1, sourceStartSample: 0, sourceSampleCount: 16000,
      windows: [{ sourceStartSample: 0, sourceSampleCount: 16000, timing: 'unavailable', reason: 'timestamp-coverage', text: 'short words' }] } })
  await cancel; expect(await output).toBeInstanceOf(Error)
})

test.each([['setup', 10_000], ['load', 120_000], ['prepare', 10_000], ['infer', 120_000], ['close', 100]] as const)(
  '%s cancellation keeps only the remaining phase allowance plus 100 ms', async (category, budget) => {
    vi.useFakeTimers()
    const { job, emit, worker, output } = harness()
    emit({ type: 'phase', requestId: request.requestId, category, phase: 'A display label independent of policy', progress: 0 })
    await vi.advanceTimersByTimeAsync(Math.floor(budget / 2))
    const cancellation = job.cancel().catch(cause => cause as Error)
    await vi.advanceTimersByTimeAsync(budget - Math.floor(budget / 2) + 99)
    expect(worker.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(await cancellation).toBeInstanceOf(Error); expect(await output).toBeInstanceOf(Error)
  },
)
