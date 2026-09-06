/** Finite native ownership for low-cadence previews; never a general renderer. */
import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input, type EncodedPacket } from 'mediabunny'
import { MULTICAM_MONITOR_LIMITS as LIMITS, monitorSourceReservation } from '../domain/multicamMonitor'
import type { MulticamMonitorLedger, MulticamMonitorReply, MulticamMonitorRequest, MulticamMonitorSource } from './multicamMonitorProtocol'

export type MonitorPacket = Pick<EncodedPacket, 'timestamp' | 'microsecondTimestamp' | 'sequenceNumber' | 'byteLength' | 'toEncodedVideoChunk'>
export interface MonitorPacketReader {
  getPacket(seconds: number, options: { metadataOnly?: boolean; verifyKeyPackets?: boolean }): Promise<MonitorPacket | null>
  getKeyPacket(seconds: number, options: { metadataOnly?: boolean; verifyKeyPackets?: boolean }): Promise<MonitorPacket | null>
  getNextPacket(packet: MonitorPacket, options: { metadataOnly?: boolean; verifyKeyPackets?: boolean }): Promise<MonitorPacket | null>
}
export interface MonitorDemux {
  readonly config: VideoDecoderConfig
  readonly packets: MonitorPacketReader
  readonly rotation: number
  readonly displayWidth: number
  readonly displayHeight: number
  beginRequest(): void
  dispose(): void
}

/** Bound individual reads and aggregate read work before Blob materialization. */
export function createMonitorReadBudget(blob: Blob) {
  let disposed = false, readBytes = 0, readCalls = 0
  return {
    beginRequest() { readBytes = 0; readCalls = 0 },
    dispose() { disposed = true },
    async read(start: number, end: number): Promise<Uint8Array> {
      const size = end - start
      if (disposed || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end > blob.size || size <= 0 || size > LIMITS.maxReadBytes
        || readBytes + size > LIMITS.maxReadWorkBytes || ++readCalls > LIMITS.maxReadCalls) {
        throw new Error('Source demux exceeds the bounded live-preview read limit. Use editing proxies.')
      }
      readBytes += size
      const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer())
      if (disposed) throw new Error('Source closed while reading')
      return bytes
    },
  }
}

export async function openMonitorDemux(source: MulticamMonitorSource): Promise<MonitorDemux> {
  const readBudget = createMonitorReadBudget(source.blob)
  const input = new Input({ formats: ALL_FORMATS, source: new CustomSource({
    getSize: () => source.blob.size, read: readBudget.read,
    dispose: readBudget.dispose, maxCacheSize: LIMITS.sourceCacheBytes, prefetchProfile: 'none',
  }) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('The angle has no video track.')
    const config = await track.getDecoderConfig()
    if (!config || !/^avc[13]\.(?:42|4d|58|64)[\da-f]{4}$/i.test(config.codec)) {
      throw new Error('Live previews currently support 8-bit AVC. Generate editing proxies for this source.')
    }
    const pixels = (config.codedWidth ?? 0) * (config.codedHeight ?? 0)
    const reservedPixels = monitorSourceReservation(source.width, source.height) / 8
    if (![config.codedWidth, config.codedHeight].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      || !Number.isSafeInteger(pixels) || pixels < 1 || pixels > reservedPixels
      || (config.description?.byteLength ?? 0) > LIMITS.sourceCacheBytes) throw new Error('Angle decoder dimensions/configuration exceed their reservation.')
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error('The native AVC decoder is unavailable.')
    const origin = Math.round(await track.getFirstTimestamp() * 1_000_000)
    if (origin !== source.firstTimestampUs) throw new Error('The angle source origin no longer matches its media provenance.')
    const rotation = await track.getRotation()
    const displayWidth = await track.getDisplayWidth(), displayHeight = await track.getDisplayHeight()
    if (![0, 90, 180, 270].includes(rotation) || ![displayWidth, displayHeight].every((value) => Number.isFinite(value) && value > 0 && value <= 16384)) throw new Error('Unsupported angle display geometry.')
    const packets = new EncodedPacketSink(track)
    return { config, rotation, displayWidth, displayHeight,
      packets: {
        getPacket: (seconds, options) => packets.getPacket(seconds, options),
        getKeyPacket: (seconds, options) => packets.getKeyPacket(seconds, options),
        getNextPacket: (packet, options) => packets.getNextPacket(packet as EncodedPacket, options),
      },
      beginRequest: readBudget.beginRequest,
      dispose: () => { readBudget.dispose(); input.dispose() },
    }
  } catch (cause) { readBudget.dispose(); input.dispose(); throw cause }
}

export interface MonitorDecodeDependencies {
  post(message: MulticamMonitorReply, transfer?: Transferable[]): void
  open(source: MulticamMonitorSource): Promise<MonitorDemux>
  createDecoder(init: VideoDecoderInit): VideoDecoder
  createCanvas(width: number, height: number): OffscreenCanvas
}

export function createMulticamMonitorRuntime(deps: MonitorDecodeDependencies) {
  const lanes = new Map<string, { source: MulticamMonitorSource; demux: MonitorDemux; busy: boolean }>()
  const decoders = new Set<VideoDecoder>(), frames = new Map<VideoFrame, number>()
  const pending = new Set<Promise<void>>()
  let canvas: OffscreenCanvas | null = null
  let closing = false, opened = false, closeTask: Promise<void> | null = null
  let createdDecoders = 0, closedDecoders = 0, peakDecoders = 0, peakFrames = 0, peakFrameBytes = 0
  function snapshot(): MulticamMonitorLedger {
    const frameBytes = [...frames.values()].reduce((sum, bytes) => sum + bytes, 0)
    peakDecoders = Math.max(peakDecoders, decoders.size); peakFrames = Math.max(peakFrames, frames.size); peakFrameBytes = Math.max(peakFrameBytes, frameBytes)
    return { inputs: lanes.size, nativeDecoders: decoders.size, nativeFrames: frames.size,
      createdDecoders, closedDecoders, frameBytes, peakDecoders, peakFrames, peakFrameBytes,
      scratchSurfaces: canvas ? 1 : 0, scratchBytes: canvas ? canvas.width * canvas.height * 4 : 0 }
  }
  function closeFrame(frame: VideoFrame | null) {
    if (frame && frames.delete(frame)) frame.close()
  }
  function closeDecoder(decoder: VideoDecoder) {
    if (!decoders.has(decoder)) return
    try { if (decoder.state !== 'closed') decoder.close() }
    finally { decoders.delete(decoder); closedDecoders++ }
  }
  function close(): Promise<void> {
    if (closeTask) return closeTask
    closing = true
    for (const decoder of decoders) closeDecoder(decoder)
    for (const frame of frames.keys()) closeFrame(frame)
    closeTask = (async () => {
      await Promise.allSettled([...pending])
      const failures: unknown[] = []
      try { for (const lane of lanes.values()) { try { lane.demux.dispose() } catch (cause) { failures.push(cause) } } }
      finally {
        lanes.clear()
        if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null }
      }
      if (failures.length) throw new AggregateError(failures, 'Angle source disposal failed')
      deps.post({ type: 'closed', ledger: snapshot() })
    })()
    return closeTask
  }
  async function open(request: Extract<MulticamMonitorRequest, { type: 'open' }>) {
    if (opened || closing) throw new Error('The monitor worker can only be opened once.')
    opened = true
    if (request.sources.length < 1 || request.sources.length > LIMITS.maxLanes
      || !((request.width === 320 && request.height === 180) || (request.width === 160 && request.height === 90))) throw new Error('Invalid monitor dimensions or lane count.')
    const ids = new Set<string>()
    let reserved = (request.sources.length * 2 + 1) * request.width * request.height * 4
    for (const source of request.sources) {
      if (!source.id || source.id.length > 256 || ids.has(source.id)
        || !(source.blob instanceof Blob) || source.blob.size === 0
        || !['original', 'proxy'].includes(source.representation)
        || !Number.isSafeInteger(source.firstTimestampUs) || !Number.isSafeInteger(source.endTimestampUs)
        || source.endTimestampUs <= source.firstTimestampUs) throw new Error('Invalid angle identity or source bounds.')
      ids.add(source.id)
      reserved += monitorSourceReservation(source.width, source.height)
      if (source.representation === 'proxy' && source.width * source.height > 1280 * 720) throw new Error('Editing proxy exceeds the live-preview profile.')
    }
    if (reserved > LIMITS.maxFrameBytes) throw new Error('The monitor frame/surface reservation was exceeded.')
    canvas = deps.createCanvas(request.width, request.height)
    for (const source of request.sources) {
      const demux = await deps.open(source)
      if (closing) { demux.dispose(); return }
      lanes.set(source.id, { source, demux, busy: false })
    }
    deps.post({ type: 'ready', ledger: snapshot() })
  }
  async function decode(request: Extract<MulticamMonitorRequest, { type: 'frame' }>) {
    const lane = lanes.get(request.id)
    if (!lane || closing || !canvas) throw new Error('Angle is not open.')
    if (lane.busy) throw new Error('Only one outstanding request is allowed per angle.')
    if (!Number.isSafeInteger(request.requestId) || request.requestId < 0
      || !Number.isSafeInteger(request.sourceTimeUs) || request.sourceTimeUs < 0) throw new Error('Invalid angle frame request.')
    const timestampUs = request.sourceTimeUs + lane.source.firstTimestampUs
    if (!Number.isSafeInteger(timestampUs) || timestampUs >= lane.source.endTimestampUs) throw new Error('Angle time is outside the exact source coverage.')
    lane.busy = true; lane.demux.beginRequest()
    let decoder: VideoDecoder | null = null, selected: VideoFrame | null = null, decodeError: unknown = null
    try {
      const packets = lane.demux.packets, seconds = timestampUs / 1_000_000
      const target = await packets.getPacket(seconds, { metadataOnly: true })
      const key = await packets.getKeyPacket(seconds, { metadataOnly: true })
      if (closing) return
      const validPacket = (packet: MonitorPacket | null): packet is MonitorPacket => Boolean(packet
        && Number.isSafeInteger(packet.sequenceNumber) && packet.sequenceNumber >= 0
        && Number.isSafeInteger(packet.microsecondTimestamp)
        && Number.isSafeInteger(packet.byteLength) && packet.byteLength > 0 && packet.byteLength <= LIMITS.maxPacketBytes)
      if (!validPacket(target) || !validPacket(key) || key.sequenceNumber > target.sequenceNumber) throw new Error('The angle packet/GOP is outside the supported finite-decode profile. Use editing proxies.')
      let packet = await packets.getKeyPacket(key.timestamp, { verifyKeyPackets: true })
      if (closing) return
      if (!validPacket(packet) || packet.sequenceNumber !== key.sequenceNumber || packet.byteLength !== key.byteLength) throw new Error('Verified keyframe does not match its bounded metadata.')
      decoder = deps.createDecoder({
        output: (frame) => {
          frames.set(frame, frame.codedWidth * frame.codedHeight * 4); snapshot()
          if (frame.codedWidth * frame.codedHeight * 8 > monitorSourceReservation(lane.source.width, lane.source.height)) decodeError = new Error('Decoded angle exceeded its frame reservation.')
          if (!closing && !decodeError && frame.timestamp <= timestampUs && (!selected || frame.timestamp >= selected.timestamp)) {
            closeFrame(selected); selected = frame
          } else closeFrame(frame)
        },
        error: (cause) => { decodeError = cause },
      })
      decoders.add(decoder); createdDecoders++; snapshot()
      decoder.configure({ ...lane.demux.config, optimizeForLatency: true })
      let count = 0, bytes = 0
      while (packet && !closing) {
        bytes += packet.byteLength
        if (++count > LIMITS.maxPackets || bytes > LIMITS.maxRequestBytes) throw new Error('Angle GOP exceeds the finite decode budget. Use editing proxies.')
        decoder.decode(packet.toEncodedVideoChunk())
        if (packet.sequenceNumber === target.sequenceNumber) break
        if (count === LIMITS.maxPackets) throw new Error('Angle GOP is too long for live previews. Use editing proxies.')
        const metadata = await packets.getNextPacket(packet, { metadataOnly: true })
        if (!validPacket(metadata) || metadata.sequenceNumber <= packet.sequenceNumber
          || metadata.sequenceNumber > target.sequenceNumber || bytes + metadata.byteLength > LIMITS.maxRequestBytes) throw new Error('The angle packet sequence exceeds its decode budget.')
        const next = await packets.getNextPacket(packet, { verifyKeyPackets: true })
        if (!validPacket(next) || next.sequenceNumber !== metadata.sequenceNumber || next.byteLength !== metadata.byteLength) throw new Error('Angle packet metadata changed during reading.')
        packet = next
      }
      if (closing) return
      await decoder.flush()
      if (decodeError) throw decodeError
      const frame = selected as VideoFrame | null
      if (closing) return
      if (!frame || frame.timestamp !== target.microsecondTimestamp) throw new Error('Decoded angle does not match the exact requested source sample.')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Angle preview canvas is unavailable.')
      const { displayWidth, displayHeight, rotation } = lane.demux
      const scale = Math.min(canvas.width / displayWidth, canvas.height / displayHeight)
      const rotated = rotation === 90 || rotation === 270
      context.fillStyle = '#101011'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.save()
      try {
        context.translate(canvas.width / 2, canvas.height / 2); context.rotate(rotation * Math.PI / 180)
        const width = (rotated ? displayHeight : displayWidth) * scale
        const height = (rotated ? displayWidth : displayHeight) * scale
        context.drawImage(frame, -width / 2, -height / 2, width, height)
      } finally { context.restore() }
      const bitmap = canvas.transferToImageBitmap()
      try { deps.post({ type: 'frame', id: request.id, requestId: request.requestId, timestampUs: frame.timestamp, bitmap, ledger: snapshot() }, [bitmap]) }
      finally { bitmap.close() }
    } finally {
      closeFrame(selected)
      if (decoder) closeDecoder(decoder)
      lane.busy = false
    }
  }
  return {
    snapshot,
    close,
    receive(request: MulticamMonitorRequest): void {
      const report = (cause: unknown) => deps.post({ type: 'failure', detail: cause instanceof Error ? cause.message.slice(0, 2048) : 'Angle preview failed.', ledger: snapshot() })
      if (request.type === 'close') { void close().catch(report); return }
      if (closing) return
      const task = request.type === 'open' ? open(request) : decode(request)
      pending.add(task)
      void task.catch((cause: unknown) => {
        if (!closing) {
          report(cause)
          void close().catch(report)
        }
      }).finally(() => pending.delete(task))
    },
  }
}
