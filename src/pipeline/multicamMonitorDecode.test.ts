import { describe, expect, test, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { createMonitorReadBudget, createMulticamMonitorRuntime, type MonitorDemux, type MonitorPacket } from './multicamMonitorDecode'
import { multicamMonitorLedgerIsZero, type MulticamMonitorReply, type MulticamMonitorSource } from './multicamMonitorProtocol'
import { MULTICAM_MONITOR_LIMITS as LIMITS } from '../domain/multicamMonitor'

const source: MulticamMonitorSource = { id: 'angle', blob: new Blob(['fixture']), representation: 'proxy', width: 1280, height: 720, firstTimestampUs: 0, endTimestampUs: 2_000_000 }
function packet(sequenceNumber: number, timestamp: number, byteLength = 100): MonitorPacket {
  return { sequenceNumber, timestamp: timestamp / 1_000_000, microsecondTimestamp: timestamp, byteLength,
    toEncodedVideoChunk: () => ({ timestamp } as EncodedVideoChunk) }
}
function harness(packets = [packet(0, 0), packet(10, 33_333), packet(90, 66_667)], options: { hangFlush?: boolean; failDispose?: boolean; rotation?: number } = {}) {
  const messages: MulticamMonitorReply[] = [], nativeFrames: { close: ReturnType<typeof vi.fn> }[] = []
  const nativeDecoders: { close: ReturnType<typeof vi.fn> }[] = []
  let flushEntered = false
  const drawImage = vi.fn(), rotate = vi.fn(), bitmapClose = vi.fn()
  const canvas = { width: 320, height: 180, getContext: () => ({ fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate, drawImage }), transferToImageBitmap: () => ({ close: bitmapClose }) }
  const dispose = vi.fn(() => { if (options.failDispose) throw new Error('dispose failed') })
  const demux: MonitorDemux = {
    config: { codec: 'avc1.640028', codedWidth: 1280, codedHeight: 720 },
    packets: {
      getPacket: vi.fn(async (seconds) => packets.filter((p) => p.timestamp <= seconds).sort((a, b) => b.timestamp - a.timestamp)[0] ?? null),
      getKeyPacket: vi.fn(async () => packets[0] ?? null),
      getNextPacket: vi.fn(async (previous) => packets.find((p) => p.sequenceNumber > previous.sequenceNumber) ?? null),
    },
    rotation: options.rotation ?? 0, displayWidth: options.rotation ? 720 : 1280, displayHeight: options.rotation ? 1280 : 720,
    beginRequest: vi.fn(), dispose,
  }
  const open = vi.fn(async () => demux)
  const runtime = createMulticamMonitorRuntime({
    post: (message) => messages.push(message), open,
    createCanvas: () => canvas as unknown as OffscreenCanvas,
    createDecoder: (init) => {
      const queued: EncodedVideoChunk[] = []
      let rejectFlush: ((error: Error) => void) | null = null
      const decoder = {
        state: 'unconfigured', configure: () => { decoder.state = 'configured' },
        decode: (chunk: EncodedVideoChunk) => { queued.push(chunk) },
        flush: async () => {
          flushEntered = true
          if (options.hangFlush) return new Promise<void>((_, reject) => { rejectFlush = reject })
          // Deliver in presentation order, including a future P frame decoded
          // before an earlier B frame. Only the exact target survives.
          for (const chunk of [...queued].sort((a, b) => a.timestamp - b.timestamp)) {
            const frame = { timestamp: chunk.timestamp, codedWidth: 1280, codedHeight: 720, close: vi.fn() }
            nativeFrames.push(frame); init.output(frame as unknown as VideoFrame)
          }
        },
        close: vi.fn(() => { decoder.state = 'closed'; rejectFlush?.(new Error('decoder closed')) }),
      }
      nativeDecoders.push(decoder)
      return decoder as unknown as VideoDecoder
    },
  })
  return { runtime, messages, nativeFrames, nativeDecoders, dispose, open, demux, drawImage, rotate, bitmapClose, canvas, isFlushing: () => flushEntered }
}
async function ready(h: ReturnType<typeof harness>, sources = [source]) {
  h.runtime.receive({ type: 'open', sources, width: 320, height: 180 })
  await vi.waitFor(() => expect(h.messages.some((m) => m.type === 'ready')).toBe(true))
}

describe('finite multicam decoder ownership', () => {
  test('uses decode ordering rather than assuming contiguous packet numbers, and closes every native owner', async () => {
    const h = harness(); await ready(h)
    h.runtime.receive({ type: 'frame', id: source.id, requestId: 1, sourceTimeUs: 66_667 })
    await vi.waitFor(() => expect(h.messages.some((m) => m.type === 'frame')).toBe(true))
    expect(h.nativeFrames).toHaveLength(3)
    expect(h.nativeFrames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true)
    expect(h.nativeDecoders[0]!.close).toHaveBeenCalledOnce()
    expect(h.bitmapClose).toHaveBeenCalledOnce()
    await h.runtime.close()
    expect(multicamMonitorLedgerIsZero(h.runtime.snapshot())).toBe(true)
    expect(h.canvas.width).toBe(0)
  })

  test('supports reordered frames, VFR targets and a signed nonzero source origin', async () => {
    const h = harness([packet(0, -100_000), packet(1, 80_000), packet(2, -10_000)])
    await ready(h, [{ ...source, firstTimestampUs: -100_000 }])
    h.runtime.receive({ type: 'frame', id: source.id, requestId: 1, sourceTimeUs: 90_000 })
    await vi.waitFor(() => expect(h.messages.find((m) => m.type === 'frame')).toMatchObject({ timestampUs: -10_000 }))
    await h.runtime.close()
    expect(multicamMonitorLedgerIsZero(h.runtime.snapshot())).toBe(true)
  })

  test('letterboxes rotated display geometry without changing source timestamps', async () => {
    const h = harness(undefined, { rotation: 90 }); await ready(h)
    h.runtime.receive({ type: 'frame', id: source.id, requestId: 2, sourceTimeUs: 0 })
    await vi.waitFor(() => expect(h.drawImage).toHaveBeenCalledOnce())
    expect(h.rotate).toHaveBeenCalledWith(Math.PI / 2)
    expect(h.drawImage.mock.calls[0]!.slice(1)).toEqual([-90, -50.625, 180, 101.25])
    await h.runtime.close()
  })

  test('native close aborts an in-flight flush before awaiting request settlement', async () => {
    const h = harness(undefined, { hangFlush: true }); await ready(h)
    h.runtime.receive({ type: 'frame', id: source.id, requestId: 1, sourceTimeUs: 0 })
    await vi.waitFor(() => expect(h.isFlushing()).toBe(true))
    await h.runtime.close()
    expect(h.nativeDecoders[0]!.close).toHaveBeenCalledOnce()
    expect(multicamMonitorLedgerIsZero(h.runtime.snapshot())).toBe(true)
  })

  test('late opening cannot retain an Input after cancellation', async () => {
    const h = harness()
    let resolve!: (demux: MonitorDemux) => void
    h.open.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    h.runtime.receive({ type: 'open', sources: [source], width: 320, height: 180 })
    const close = h.runtime.close()
    resolve(h.demux); await close
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.nativeDecoders).toHaveLength(0)
    expect(multicamMonitorLedgerIsZero(h.runtime.snapshot())).toBe(true)
  })

  test('checks oversized packet metadata before requesting bytes or creating a decoder', async () => {
    const h = harness([packet(0, 0, LIMITS.maxPacketBytes + 1)]); await ready(h)
    h.runtime.receive({ type: 'frame', id: source.id, requestId: 1, sourceTimeUs: 0 })
    await vi.waitFor(() => expect(h.messages.some((m) => m.type === 'failure')).toBe(true))
    expect(h.nativeDecoders).toHaveLength(0)
    expect(h.demux.packets.getKeyPacket).toHaveBeenCalledTimes(1)
    await h.runtime.close()
  })

  test('long GOPs fail within 60 packets and concurrent lane requests cannot multiply native owners', async () => {
    const h = harness(Array.from({ length: 61 }, (_, i) => packet(i, i * 1000))); await ready(h)
    h.runtime.receive({ type: 'frame', id: source.id, requestId: 1, sourceTimeUs: 60_000 })
    await vi.waitFor(() => expect(h.messages.some((m) => m.type === 'failure')).toBe(true))
    await h.runtime.close()
    expect(h.runtime.snapshot().peakDecoders).toBe(1)
    expect(multicamMonitorLedgerIsZero(h.runtime.snapshot())).toBe(true)
    const busy = harness(undefined, { hangFlush: true }); await ready(busy)
    busy.runtime.receive({ type: 'frame', id: source.id, requestId: 1, sourceTimeUs: 0 })
    busy.runtime.receive({ type: 'frame', id: source.id, requestId: 2, sourceTimeUs: 0 })
    await vi.waitFor(() => expect(busy.messages.some((m) => m.type === 'failure')).toBe(true))
    await busy.runtime.close()
    expect(busy.runtime.snapshot().peakDecoders).toBeLessThanOrEqual(1)
  })

  test('still disposes all Inputs when one disposer throws and does not acknowledge a clean close', async () => {
    const h = harness(undefined, { failDispose: true }); await ready(h, [source, { ...source, id: 'second' }])
    await expect(h.runtime.close()).rejects.toThrow('disposal failed')
    expect(h.dispose).toHaveBeenCalledTimes(2)
    expect(h.messages.some((m) => m.type === 'closed')).toBe(false)
  })
})

test('bounds read work before Blob allocation and rejects reads that settle after disposal', async () => {
  const blob = new NodeBlob([new Uint8Array(LIMITS.maxReadBytes + 1)])
  const slice = vi.spyOn(blob, 'slice')
  const budget = createMonitorReadBudget(blob as unknown as Blob)
  await expect(budget.read(0, LIMITS.maxReadBytes + 1)).rejects.toThrow('read limit')
  expect(slice).not.toHaveBeenCalled()
  await budget.read(0, 2)
  budget.dispose()
  await expect(budget.read(0, 2)).rejects.toThrow('read limit')
  expect(slice).toHaveBeenCalledOnce()
})
