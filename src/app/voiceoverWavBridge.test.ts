import { describe, expect, it, vi } from 'vitest'
import { VoiceoverWavBridge, type VoiceoverWavWorkerLike } from './voiceoverWavBridge'
import { VOICEOVER_WAV_LIMITS as LIMITS } from '../pipeline/voiceoverWavDraft'
import type { VoiceoverWavReply, VoiceoverWavRequest, VoiceoverWavResult } from '../pipeline/voiceoverWavProtocol'

class FakeWorker implements VoiceoverWavWorkerLike {
  onmessage: ((event: MessageEvent<VoiceoverWavReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  sent: { request: VoiceoverWavRequest; transfer: Transferable[] }[] = []
  terminated = false

  postMessage(request: VoiceoverWavRequest, transfer: Transferable[] = []): void {
    this.sent.push({ request, transfer })
  }
  terminate(): void { this.terminated = true }
  reply(index: number, result: VoiceoverWavResult): void {
    this.onmessage?.({ data: { requestId: this.sent[index].request.requestId, result } } as MessageEvent<VoiceoverWavReply>)
  }
  error(index: number, name: string): void {
    this.onmessage?.({ data: { requestId: this.sent[index].request.requestId, error: { name, message: 'write failed' } } } as MessageEvent<VoiceoverWavReply>)
  }
}

const zero = { pcmBytes: 0, committedBytes: 0 }

async function opened() {
  const worker = new FakeWorker()
  const bridge = new VoiceoverWavBridge(() => worker)
  const created = bridge.create('take')
  worker.reply(0, { type: 'create', progress: zero })
  await created
  return { worker, bridge }
}

describe('voiceover WAV transfer bound', () => {
  it('releases an already stopped draft without issuing a second worker operation', async () => {
    const { worker, bridge } = await opened()
    const stopped = bridge.stop()
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2))
    worker.reply(1, { type: 'stop', progress: zero })
    await stopped
    await expect(bridge.release()).resolves.toEqual(zero)
    expect(worker.sent).toHaveLength(2)
    expect(bridge.isClosed).toBe(false)
    bridge.close()
    expect(bridge.isClosed).toBe(true)
  })

  it('transfers four full batches, rejects the fifth, and frees credit only on acknowledgement', async () => {
    const { worker, bridge } = await opened()
    const buffers = Array.from({ length: 4 }, () => new ArrayBuffer(LIMITS.batchBytes))
    const pending = buffers.map((buffer) => bridge.append(buffer))
    expect(bridge.inFlightBytes).toBe(LIMITS.inFlightBytes)
    expect(worker.sent.slice(1).map((entry) => entry.transfer[0])).toEqual(buffers)
    expect(() => bridge.append(new ArrayBuffer(LIMITS.batchBytes))).toThrow(/transfer limit/)
    expect(() => bridge.append(new ArrayBuffer(2))).toThrow(/not writable/)
    for (let index = 1; index <= 4; index++) worker.reply(index, { type: 'append', progress: zero })
    await Promise.all(pending)
    expect(bridge.inFlightBytes).toBe(0)
    const released = bridge.release()
    worker.reply(5, { type: 'release', progress: zero })
    await released
    bridge.close()
  })

  it('waits for the write acknowledgement before stop and preserves the worker error', async () => {
    const { worker, bridge } = await opened()
    const write = bridge.append(new ArrayBuffer(2))
    const stopped = bridge.stop()
    expect(worker.sent).toHaveLength(2)
    worker.error(1, 'QuotaExceededError')
    await expect(write).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await expect(stopped).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(worker.sent).toHaveLength(2)
    bridge.close()
  })

  it('releases every pending promise and transfer credit on worker termination', async () => {
    const { worker, bridge } = await opened()
    const write = bridge.append(new ArrayBuffer(LIMITS.batchBytes))
    bridge.close()
    await expect(write).rejects.toThrow(/may be recovered/)
    expect(bridge.inFlightBytes).toBe(0)
    expect(worker.terminated).toBe(true)
  })

  it('rejects a mismatched worker result instead of stranding its request', async () => {
    const { worker, bridge } = await opened()
    const write = bridge.append(new ArrayBuffer(2))
    worker.reply(1, { type: 'discard' })
    await expect(write).rejects.toThrow(/wrong result/)
    expect(bridge.inFlightBytes).toBe(0)
    expect(worker.terminated).toBe(true)
  })

  it('lists stored drafts in any non-closed phase without changing draft state', async () => {
    const { worker, bridge } = await opened()
    const drafts = [
      { id: 'voiceover_a', sizeBytes: 48, hasJournal: true },
      { id: 'voiceover_b', sizeBytes: 44, hasJournal: false },
    ]
    const listed = bridge.list()
    worker.reply(1, { type: 'list', drafts })
    await expect(listed).resolves.toEqual(drafts)
    expect(worker.sent[1].request).toEqual({ requestId: 2, type: 'list' })
    // The bridge's own draft session is untouched by a directory read.
    expect(bridge.isClosed).toBe(false)
    const stopped = bridge.stop()
    await vi.waitFor(() => expect(worker.sent).toHaveLength(3))
    worker.reply(2, { type: 'stop', progress: zero })
    await stopped
    bridge.close()
    await expect(bridge.list()).rejects.toThrow(/closed/)
    await expect(bridge.discardId('voiceover_a')).rejects.toThrow(/closed/)
  })

  it('discards a stored draft by id and fails on a mismatched reply', async () => {
    const { worker, bridge } = await opened()
    const discarded = bridge.discardId('voiceover_b')
    expect(worker.sent[1].request).toEqual({ requestId: 2, type: 'discard-id', id: 'voiceover_b' })
    worker.reply(1, { type: 'discard-id' })
    await expect(discarded).resolves.toBeUndefined()
    expect(bridge.isClosed).toBe(false)
    const mismatched = bridge.discardId('voiceover_b')
    worker.reply(2, { type: 'discard' })
    await expect(mismatched).rejects.toThrow(/wrong result/)
    expect(worker.terminated).toBe(true)
  })
})
