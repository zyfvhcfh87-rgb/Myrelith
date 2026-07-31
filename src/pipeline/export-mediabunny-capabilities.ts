/** Real Mediabunny capability adapter for Issue #16 export profiles. */

import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  Mp4OutputFormat,
  NullTarget,
  Output,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'
import type {
  ExportContainer,
  ExportProfile,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import { framesToSeconds } from '../domain/time'
import {
  exportAudioChannelCount,
  type ExportCapabilityProbe,
  type ExportFormatCapabilities,
} from './export-capabilities'
import { mediabunnyExportImplementationUnavailableReason } from './export-mediabunny-profile'

const SRGB_2D_CONTEXT: CanvasRenderingContext2DSettings = {
  alpha: false,
  colorSpace: 'srgb',
}

export function createMediabunnyOutputFormat(
  container: ExportContainer,
): ExportFormatCapabilities & (Mp4OutputFormat | WebMOutputFormat) {
  if (container === 'mp4') return new Mp4OutputFormat()
  return new WebMOutputFormat()
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Export capability check was canceled')
  error.name = 'AbortError'
  throw error
}

/**
 * Configure and encode one real-size video frame plus one exact audio quantum.
 * Unlike canEncode*, each call creates new sources and therefore performs a
 * fresh native WebCodecs support check and actual encode.
 */
export async function runFreshMediabunnyExportProbe(
  doc: TimelineDoc,
  profile: Readonly<ExportProfile>,
  includeAudio: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }

  const frameDuration = framesToSeconds(1, doc.frameRate)
  const frameRate = doc.frameRate.num / doc.frameRate.den
  const canvas = new OffscreenCanvas(doc.width, doc.height)
  const context = canvas.getContext('2d', SRGB_2D_CONTEXT)
  if (!context) throw new Error('Could not create the export capability canvas')
  context.fillStyle = '#000000'
  context.fillRect(0, 0, doc.width, doc.height)

  const output = new Output({
    format: createMediabunnyOutputFormat(profile.container),
    target: new NullTarget(),
  })
  const videoSource = new CanvasSource(canvas, {
    codec: profile.videoCodec,
    bitrate: profile.videoBitrate,
    bitrateMode: profile.videoBitrateMode,
    keyFrameInterval: profile.keyFrameIntervalMicroseconds / 1_000_000,
  })
  output.addVideoTrack(videoSource, { frameRate })

  let audioSource: AudioSampleSource | null = null
  if (includeAudio) {
    if (profile.audioChannelLayout === 'off') {
      throw new TypeError('An audio-off profile cannot run an audio capability probe')
    }
    audioSource = new AudioSampleSource({
      codec: profile.audioCodec,
      bitrate: profile.audioBitrate,
      bitrateMode: profile.audioBitrateMode,
    })
    output.addAudioTrack(audioSource)
  }

  try {
    await output.start()
    throwIfAborted(signal)

    let audioSample: AudioSample | null = null
    try {
      const writes: Promise<void>[] = [videoSource.add(0, frameDuration)]
      if (audioSource && profile.audioChannelLayout !== 'off') {
        const channels = exportAudioChannelCount(profile)
        const numberOfFrames = 1_024
        audioSample = new AudioSample({
          data: new Float32Array(numberOfFrames * channels),
          format: 'f32',
          numberOfChannels: channels,
          sampleRate: doc.audioSampleRate,
          timestamp: 0,
        })
        writes.push(audioSource.add(audioSample))
      }
      const settled = await Promise.allSettled(writes)
      const failure = settled.find(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      )
      if (failure) throw failure.reason
    } finally {
      audioSample?.close()
    }

    throwIfAborted(signal)
    videoSource.close()
    audioSource?.close()
    await output.finalize()
  } catch (cause) {
    try {
      await output.cancel()
    } catch {
      // The fresh encode failure remains the actionable primary cause.
    }
    throw cause
  }
}

export const mediabunnyExportCapabilityProbe: ExportCapabilityProbe = {
  createFormat: createMediabunnyOutputFormat,
  getImplementationUnavailableReason:
    mediabunnyExportImplementationUnavailableReason,
  canEncodeVideo: (codec, options) => canEncodeVideo(codec, options),
  canEncodeAudio: (codec, options) => canEncodeAudio(codec, options),
  freshEncode: runFreshMediabunnyExportProbe,
}
