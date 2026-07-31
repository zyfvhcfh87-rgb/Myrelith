/**
 * pipeline/demux.ts — Open a media file with Mediabunny and describe it as a
 * MediaAsset, without decoding anything. Phase 2.1.
 *
 * Layering: pipeline/ → domain/ only. No React, no state/, no ui/.
 *
 * Testing note (per plan): `loadAsset` needs a real container file, so it is
 * validated in the Phase 2.5 DecodeSandbox (and later with a fixture MP4);
 * the pure config-serialization helpers are unit-tested in demux.test.ts.
 */

import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import type { InputAudioTrack, InputVideoTrack } from 'mediabunny'
import type {
  FrameRate,
  MediaAsset,
  SourceTimestampBounds,
} from '../domain/schema'
import {
  microsecondsDurationToFrames,
  secondsToMicroseconds,
  snapToStandardRate,
  timestampSecondsToMicroseconds,
} from '../domain/time'

function exactSourceBounds(
  firstSeconds: number,
  endSeconds: number,
): SourceTimestampBounds {
  const firstTimestampUs = timestampSecondsToMicroseconds(firstSeconds)
  const endTimestampUs = secondsToMicroseconds(endSeconds)
  if (endTimestampUs <= firstTimestampUs) {
    throw new Error('Media track timestamp extent is empty')
  }
  return { status: 'exact', firstTimestampUs, endTimestampUs }
}

/**
 * A freshly demuxed file: the serializable asset description plus the live
 * Mediabunny objects the decode step consumes. `input` must be kept
 * reachable for as long as packets are still being read from the tracks.
 */
export interface LoadedAsset {
  asset: MediaAsset
  input: Input
  videoTrack: InputVideoTrack | null
  audioTrack: InputAudioTrack | null
}

/* ------------------------------------------------------------------ */
/* VideoDecoderConfig <-> string (MediaAsset.decoderConfigB64)          */
/* ------------------------------------------------------------------ */

/** Bytes -> base64, chunked so large buffers cannot blow the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Normalize BufferSource (ArrayBuffer or any view) to an exact Uint8Array.
 * Deliberately never references the SharedArrayBuffer global: it does not
 * exist on non-cross-origin-isolated pages, and touching the bare name
 * throws ReferenceError there (found by the Phase 2.5 browser smoke test).
 */
function toUint8(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  }
  return new Uint8Array(source as ArrayBuffer)
}

/**
 * Serialize a VideoDecoderConfig to a JSON string, base64-encoding the
 * binary `description` (e.g. H.264 avcC extradata) if present — the format
 * stored in MediaAsset.decoderConfigB64.
 */
export function serializeDecoderConfig(config: VideoDecoderConfig): string {
  const { description, ...rest } = config
  const payload: Record<string, unknown> = { ...rest }
  if (description !== undefined) {
    payload.descriptionB64 = bytesToBase64(toUint8(description))
  }
  return JSON.stringify(payload)
}

/** Inverse of serializeDecoderConfig; used to configure worker decoders. */
export function deserializeDecoderConfig(serialized: string): VideoDecoderConfig {
  const parsed = JSON.parse(serialized) as Record<string, unknown>
  const { descriptionB64, ...rest } = parsed
  const config = rest as unknown as VideoDecoderConfig
  if (typeof descriptionB64 === 'string') {
    config.description = base64ToBytes(descriptionB64)
  }
  return config
}

/* ------------------------------------------------------------------ */
/* loadAsset                                                            */
/* ------------------------------------------------------------------ */

/** Packets sampled to estimate fps; ~4s of video, cheap even on slow disks. */
const FPS_SAMPLE_PACKETS = 120

/**
 * Demux a file and build its MediaAsset.
 *
 * `docRate` is the document rate used to express durationFrames (schema MVP
 * rule: assets are conformed to the document rate). When omitted — e.g. in
 * the sandbox, or when the asset defines the project — the asset's own
 * detected rate is used, falling back to 30fps for audio-only files.
 *
 * Throws on files with no video AND no audio track. Failed analysis is never
 * committed to mediaStore; the import controller presents the error instead.
 */
export async function loadAsset(
  file: File,
  docRate?: FrameRate,
): Promise<LoadedAsset> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ])
    if (!videoTrack && !audioTrack) {
      throw new Error(`"${file.name}" contains no video or audio track`)
    }

    let frameRate: FrameRate | null = null
    let decoderConfigB64: string | null = null
    if (videoTrack) {
      const stats = await videoTrack.computePacketStats(FPS_SAMPLE_PACKETS)
      if (stats.averagePacketRate > 0) {
        frameRate = snapToStandardRate(stats.averagePacketRate)
      }
      const config = await videoTrack.getDecoderConfig()
      if (config) decoderConfigB64 = serializeDecoderConfig(config)
    }

    const [
      durationSec,
      videoFirstSec,
      videoEndSec,
      audioFirstSec,
      audioEndSec,
    ] = await Promise.all([
      input.computeDuration(),
      videoTrack ? videoTrack.getFirstTimestamp() : Promise.resolve(null),
      videoTrack ? videoTrack.computeDuration() : Promise.resolve(null),
      audioTrack ? audioTrack.getFirstTimestamp() : Promise.resolve(null),
      audioTrack ? audioTrack.computeDuration() : Promise.resolve(null),
    ])
    const durationMicroseconds = secondsToMicroseconds(durationSec)
    const effectiveRate = docRate ?? frameRate ?? { num: 30, den: 1 }

    const asset: MediaAsset = {
      id: `asset_${crypto.randomUUID()}`,
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
      lastModified: file.lastModified,
      objectUrl: URL.createObjectURL(file),
      kind: videoTrack ? 'video' : 'audio',
      durationFrames: microsecondsDurationToFrames(
        durationMicroseconds,
        effectiveRate,
      ),
      durationMicroseconds,
      sourceBounds: {
        video: videoFirstSec === null || videoEndSec === null
          ? null
          : exactSourceBounds(videoFirstSec, videoEndSec),
        audio: audioFirstSec === null || audioEndSec === null
          ? null
          : exactSourceBounds(audioFirstSec, audioEndSec),
      },
      frameRate,
      width: videoTrack ? videoTrack.displayWidth : null,
      height: videoTrack ? videoTrack.displayHeight : null,
      hasAudio: audioTrack !== null,
      audioSampleRate: audioTrack ? audioTrack.sampleRate : null,
      audioChannels: audioTrack ? audioTrack.numberOfChannels : null,
      decoderConfigB64,
    }

    return { asset, input, videoTrack, audioTrack }
  } catch (cause) {
    // loadAsset cannot hand the Input to a caller on failure, so it must close
    // the resource here. Cleanup errors never replace the primary demux error.
    try {
      input.dispose()
    } catch {
      // Preserve the original failure.
    }
    throw cause
  }
}
