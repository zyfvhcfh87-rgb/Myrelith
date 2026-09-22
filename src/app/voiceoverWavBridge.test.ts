import { describe, expect, it } from 'vitest'
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
})
