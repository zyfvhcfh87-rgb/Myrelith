/** Candidate v3: Mediabunny demux, explicitly owned finite native decoders. */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
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
  nativeFrames.set(frame, frame.codedWidth * frame.codedHeight * 4)
  const close = frame.close.bind(frame)
  frame.close = () => { try { close() } finally { nativeFrames.delete(frame) } }
  snapshot()
  return frame
}
function closeDecoder(decoder: VideoDecoder) {
  try { if (decoder.state !== 'closed') decoder.close() }
  finally { if (nativeDecoders.delete(decoder)) ledger.closedNativeDecoders++ }
}
function snapshot(): Ledger {
  ledger.nativeDecoders = nativeDecoders.size
  ledger.nativeFrames = nativeFrames.size
  ledger.estimatedFrameBytes = [...nativeFrames.values()].reduce((sum, n) => sum + n, 0)
  ledger.peakNativeDecoders = Math.max(ledger.peakNativeDecoders, ledger.nativeDecoders)
  ledger.peakNativeFrames = Math.max(ledger.peakNativeFrames, ledger.nativeFrames)
  ledger.peakEstimatedFrameBytes = Math.max(ledger.peakEstimatedFrameBytes, ledger.estimatedFrameBytes)
  return { ...ledger }
}
function send(message: Response, transfer: Transferable[] = []) {
  globalThis.postMessage(message, { transfer })
}
interface Lane {
  input: Input
  packets: EncodedPacketSink
  config: VideoDecoderConfig
  busy: boolean
}
const lanes = new Map<string, Lane>()
const pending = new Set<Promise<void>>()
let scratch: OffscreenCanvas | null = null
let closing = false
let closePromise: Promise<void> | null = null

async function close(): Promise<void> {
  if (closePromise) return closePromise
  closing = true
  // Explicit native closure aborts in-flight flushes before waiting for tasks.
  for (const decoder of [...nativeDecoders]) closeDecoder(decoder)
  for (const frame of [...nativeFrames.keys()]) frame.close()
  closePromise = (async () => {
    await Promise.allSettled([...pending])
    for (const lane of lanes.values()) lane.input.dispose()
    lanes.clear(); ledger.inputs = 0; ledger.lanes = 0
    if (scratch) { scratch.width = 0; scratch.height = 0; scratch = null }
    ledger.scratchSurfaces = 0; ledger.scratchBytes = 0
    send({ type: 'closed', ledger: snapshot() })
  })()
  return closePromise
}
async function open(request: Extract<Request, { type: 'open' }>) {
  if (lanes.size || closing || request.sources.length > 7) throw new Error('Invalid owner admission')
  scratch = new OffscreenCanvas(request.width, request.height)
  ledger.scratchSurfaces = 1; ledger.scratchBytes = request.width * request.height * 4
  for (const entry of request.sources) {
    const input = new Input({ source: new BlobSource(entry.blob), formats: ALL_FORMATS })
    let transferred = false
    try {
      const track = await input.getPrimaryVideoTrack()
      const config = await track?.getDecoderConfig()
      if (!track || !config || !(await VideoDecoder.isConfigSupported(config)).supported) throw new Error('Native video decoder unavailable')
      if (closing) return
      lanes.set(entry.id, { input, packets: new EncodedPacketSink(track), config, busy: false })
      transferred = true; ledger.inputs++; ledger.lanes++
    } finally { if (!transferred) input.dispose() }
  }
  send({ type: 'ready', ledger: snapshot() })
}
async function frame(request: Extract<Request, { type: 'frame' }>) {
  const lane = lanes.get(request.id)
  if (!lane || closing) return
  if (lane.busy) throw new Error('More than one outstanding request for a lane')
  lane.busy = true
  let decoder: VideoDecoder | null = null
  let selected: VideoFrame | null = null
  let decodeError: DOMException | null = null
  try {
    const seconds = request.targetUs / 1_000_000
    const options = { verifyKeyPackets: true }
    const target = await lane.packets.getPacket(seconds, options)
    let packet = await lane.packets.getKeyPacket(seconds, options)
    if (closing) return
    if (!target || !packet) throw new Error('Missing angle packet or keyframe')
    if (target.sequenceNumber < packet.sequenceNumber || target.sequenceNumber - packet.sequenceNumber >= 60) throw new Error('60-packet finite decode ceiling exceeded')
    decoder = new VideoDecoder({
      output: (output) => {
        const frame = recordFrame(output)
        if (!closing && frame.timestamp <= request.targetUs && (!selected || frame.timestamp >= selected.timestamp)) {
          selected?.close(); selected = frame
        } else frame.close()
      },
      error: (error) => { decodeError = error },
    })
    nativeDecoders.add(decoder); ledger.createdNativeDecoders++; snapshot()
    decoder.configure({ ...lane.config, optimizeForLatency: true })
    let bytes = 0, count = 0
    while (packet && !closing) {
      bytes += packet.data.byteLength; count++
      if (count > 60 || bytes > 8 * 1024 * 1024) throw new Error('Finite decode packet/byte ceiling exceeded')
      decoder.decode(packet.toEncodedVideoChunk())
      ledger.peakDecodeQueue = Math.max(ledger.peakDecodeQueue, decoder.decodeQueueSize)
      if (packet.sequenceNumber === target.sequenceNumber) break
      if (packet.sequenceNumber > target.sequenceNumber) throw new Error('Non-monotonic packet sequence')
      packet = await lane.packets.getNextPacket(packet, options)
    }
    if (closing) return
    await decoder.flush()
    if (decodeError) throw decodeError
    const output = selected as VideoFrame | null
    if (!output || closing) { if (!closing) throw new Error('No decoded angle frame'); return }
    if (output.timestamp !== target.microsecondTimestamp) throw new Error('Decoded sample does not match selected source packet')
    const context = scratch?.getContext('2d')
    if (!context || !scratch) throw new Error('Angle scratch context unavailable')
    context.drawImage(output, 0, 0, scratch.width, scratch.height)
    const bitmap = scratch.transferToImageBitmap()
    try { send({ type: 'frame', id: request.id, frame: request.frame, timestampUs: output.timestamp,
      requestedAt: request.requestedAt, bitmap, ledger: snapshot() }, [bitmap]) }
    finally { bitmap.close() }
  } finally {
    // A close message may have already closed either owner; both are idempotent.
    (selected as VideoFrame | null)?.close()
    if (decoder) closeDecoder(decoder)
    lane.busy = false
  }
}
globalThis.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  const task = request.type === 'open' ? open(request) : request.type === 'frame' ? frame(request) : close()
  if (request.type !== 'close') pending.add(task)
  void task.catch((cause: unknown) => {
    if (!closing) send({ type: 'error', detail: cause instanceof Error ? cause.message : String(cause), ledger: snapshot() })
  }).finally(() => pending.delete(task))
}
