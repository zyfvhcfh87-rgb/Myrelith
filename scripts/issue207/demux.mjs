/** Node Mediabunny demux probe. Matches production ALL_FORMATS + local bytes. */

import { readFileSync } from 'node:fs'
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
  UnsupportedInputFormatError,
} from 'mediabunny'
import { errorMessage } from './protocol.mjs'

function copyBytes(filePath) {
  const disk = readFileSync(filePath)
  const bytes = new Uint8Array(bytesLength(disk))
  bytes.set(disk)
  return bytes
}

function bytesLength(disk) {
  return disk.byteLength
}

async function describeTrack(track) {
  const kind = track.isVideoTrack() ? 'video' : track.isAudioTrack() ? 'audio' : track.type
  const codec = await track.getCodec()
  const decoderConfig = await track.getDecoderConfig().catch(() => null)
  const canDecode = await track.canDecode()
  const packetSink = new EncodedPacketSink(track)
  const first = await packetSink.getFirstPacket({ metadataOnly: true }).catch((error) => ({
    error: errorMessage(error),
  }))
  const mid = await packetSink.getPacket(0.5, { metadataOnly: true }).catch((error) => ({
    error: errorMessage(error),
  }))
  const durationSec = await track.computeDuration().catch(() => null)
  return {
    kind,
    codec,
    codecParameter: decoderConfig?.codec ?? null,
    canDecode,
    durationSec,
    codedWidth: decoderConfig?.codedWidth ?? null,
    codedHeight: decoderConfig?.codedHeight ?? null,
    sampleRate: decoderConfig?.sampleRate ?? null,
    numberOfChannels: decoderConfig?.numberOfChannels ?? null,
    firstPacket: packetSummary(first),
    packetAt500ms: packetSummary(mid),
  }
}

function packetSummary(packet) {
  if (!packet || packet.error) return packet ?? null
  return {
    timestamp: packet.timestamp,
    duration: packet.duration,
    type: packet.type,
    isKey: packet.type === 'key',
    byteLength: packet.byteLength,
  }
}

export async function probeDemuxFile(filePath) {
  const bytes = copyBytes(filePath)
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(bytes),
  })
  const started = Date.now()
  try {
    let canRead
    try {
      canRead = await input.canRead()
    } catch (error) {
      return {
        filePath,
        canRead: false,
        failClosed: true,
        error: errorMessage(error),
        tracks: [],
        durationMs: Date.now() - started,
      }
    }
    if (!canRead) {
      return {
        filePath,
        canRead: false,
        format: null,
        tracks: [],
        durationMs: Date.now() - started,
      }
    }
    const format = await input.getFormat()
    const tracks = await input.getTracks()
    const described = []
    for (const track of tracks) {
      described.push(await describeTrack(track))
    }
    return {
      filePath,
      canRead: true,
      format: { name: format.name, mimeType: format.mimeType },
      trackCount: tracks.length,
      tracks: described,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    const failClosed = error instanceof UnsupportedInputFormatError
      || /PathedSource|UnsupportedInputFormat/i.test(errorMessage(error))
    return {
      filePath,
      canRead: false,
      failClosed,
      error: errorMessage(error),
      tracks: [],
      durationMs: Date.now() - started,
    }
  } finally {
    input.dispose()
  }
}
