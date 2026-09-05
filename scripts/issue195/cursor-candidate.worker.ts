/** Disposable research host. No production entry imports this module. */
import { openWorkerVideoSource, type VideoFrameCursor, type WorkerVideoSource } from '../../src/workers/video-source'
import type { Ledger, Request, Response } from './protocol'

const nativeDecoders = new Set<VideoDecoder>()
const nativeFrames = new Map<VideoFrame, number>()
const ledger: Ledger = {
  inputs: 0, lanes: 0, nativeDecoders: 0, nativeFrames: 0, estimatedFrameBytes: 0,
  createdNativeDecoders: 0, closedNativeDecoders: 0,
  peakNativeDecoders: 0, peakNativeFrames: 0, peakEstimatedFrameBytes: 0,
  peakDecodeQueue: 0, scratchSurfaces: 0, scratchBytes: 0,
}
function recordFrame(frame: VideoFrame): VideoFrame {
  if (nativeFrames.has(frame)) return frame
  nativeFrames.set(frame, frame.codedWidth * frame.codedHeight * 4)
  const close = frame.close.bind(frame), clone = frame.clone.bind(frame)
  frame.close = () => { try { close() } finally { nativeFrames.delete(frame) } }
  frame.clone = () => recordFrame(clone())
  snapshot()
  return frame
}
// Instrument actual native handles and output/clone lifetimes in this isolated
// worker only. Unknown browser-internal buffers are never called measured RAM.
const NativeDecoder = globalThis.VideoDecoder
globalThis.VideoDecoder = class extends NativeDecoder {
  constructor(init: VideoDecoderInit) {
    super({ ...init, output: (frame) => init.output(recordFrame(frame)) })
    nativeDecoders.add(this)
    ledger.createdNativeDecoders++
    snapshot()
  }
  override decode(chunk: EncodedVideoChunk): void {
    super.decode(chunk)
    ledger.peakDecodeQueue = Math.max(ledger.peakDecodeQueue, this.decodeQueueSize)
  }
}
function snapshot(): Ledger {
  for (const decoder of nativeDecoders) if (decoder.state === 'closed') { nativeDecoders.delete(decoder); ledger.closedNativeDecoders++ }
  ledger.nativeDecoders = nativeDecoders.size
  ledger.nativeFrames = nativeFrames.size
  ledger.estimatedFrameBytes = [...nativeFrames.values()].reduce((sum, n) => sum + n, 0)
  ledger.peakNativeDecoders = Math.max(ledger.peakNativeDecoders, ledger.nativeDecoders)
  ledger.peakNativeFrames = Math.max(ledger.peakNativeFrames, ledger.nativeFrames)
  ledger.peakEstimatedFrameBytes = Math.max(ledger.peakEstimatedFrameBytes, ledger.estimatedFrameBytes)
  return { ...ledger }
}
function send(message: Response, transfer: Transferable[] = []): void {
  globalThis.postMessage(message, { transfer })
}
const lanes = new Map<string, { source: WorkerVideoSource; cursor: VideoFrameCursor | null; busy: boolean }>()
const pending = new Set<Promise<void>>()
let scratch: OffscreenCanvas | null = null
let closing = false
let closePromise: Promise<void> | null = null

async function close(): Promise<void> {
  if (closePromise) return closePromise
  closing = true
  closePromise = (async () => {
    const results = await Promise.allSettled([...lanes.values()].map((lane) => lane.source.close()))
    await Promise.allSettled([...pending])
    // Remove ownership only after source closure has actually settled.
    if (results.some((r) => r.status === 'rejected')) throw new Error('Source closure failed')
    lanes.clear(); ledger.inputs = 0; ledger.lanes = 0
    if (scratch) { scratch.width = 0; scratch.height = 0; scratch = null }
    ledger.scratchSurfaces = 0; ledger.scratchBytes = 0
    send({ type: 'closed', ledger: snapshot() })
  })()
  return closePromise
}
async function open(request: Extract<Request, { type: 'open' }>): Promise<void> {
  if (lanes.size || closing || request.sources.length > 7) throw new Error('Invalid owner admission')
  scratch = new OffscreenCanvas(request.width, request.height)
  ledger.scratchSurfaces = 1; ledger.scratchBytes = request.width * request.height * 4
  for (const entry of request.sources) {
    const source = await openWorkerVideoSource(entry.blob, { sourceId: entry.id, budget: entry.budget })
    if (closing) { await source.close(); return }
    lanes.set(entry.id, { source, cursor: null, busy: false })
    ledger.inputs++; ledger.lanes++
  }
  send({ type: 'ready', ledger: snapshot() })
}
async function frame(request: Extract<Request, { type: 'frame' }>): Promise<void> {
  const lane = lanes.get(request.id)
  if (!lane || closing) return
  if (lane.busy) throw new Error('More than one outstanding request for a lane')
  lane.busy = true
  // Candidate v2 uses a finite one-target cursor. The forward cursor's fixed
  // prefetch retained forty native outputs even at a low thumbnail cadence.
  const cursor = lane.source.openSeekLane(request.targetUs)
  lane.cursor = cursor
  try {
    if (!closing) {
      const decoded = await cursor.next()
      if (!decoded) throw new Error('Unexpected end of angle coverage')
      try {
        if (closing) return
        if (decoded.timestampUs + decoded.durationUs <= request.targetUs) throw new Error('Angle sample precedes target')
        if (decoded.timestampUs > request.targetUs + 1) throw new Error('Angle target precedes source sample')
        const context = scratch?.getContext('2d')
        if (!context || !scratch) throw new Error('Angle scratch context unavailable')
        context.drawImage(decoded.frame as VideoFrame, 0, 0, scratch.width, scratch.height)
        const bitmap = scratch.transferToImageBitmap()
        try {
          send({ type: 'frame', id: request.id, frame: request.frame,
            timestampUs: decoded.timestampUs, requestedAt: request.requestedAt,
            bitmap, ledger: snapshot() }, [bitmap])
        } finally { bitmap.close() }
        return
      } finally { decoded.frame.close() }
    }
  } finally {
    await cursor.close()
    lane.cursor = null
    lane.busy = false
  }
}
globalThis.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  const task = request.type === 'open' ? open(request)
    : request.type === 'frame' ? frame(request) : close()
  if (request.type !== 'close') pending.add(task)
  void task.catch((cause: unknown) => {
    send({ type: 'error', detail: cause instanceof Error ? cause.message : String(cause), ledger: snapshot() })
  }).finally(() => pending.delete(task))
}
