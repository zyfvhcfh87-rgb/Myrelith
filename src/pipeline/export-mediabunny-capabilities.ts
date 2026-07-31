/** Real Mediabunny capability adapter for Issue #16 export profiles. */

import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  NullTarget,
  Output,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'
import type { ExportProfile } from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  audioSampleBoundary,
  EXPORT_AUDIO_BLOCK_SAMPLES,
} from './export-audio'
import {
  createMediabunnyOutputFormat,
  mediabunnyExportImplementationUnavailableReason,
} from './export-mediabunny-profile'
import {
  exportAudioChannelCount,
  type ExportCapabilityProbe,
} from './export-capabilities'

export { createMediabunnyOutputFormat } from './export-mediabunny-profile'

const SRGB_2D_CONTEXT: CanvasRenderingContext2DSettings = {
  alpha: false,
  colorSpace: 'srgb',
}

const REPRESENTATIVE_AUDIO_PROBE_SAMPLES = EXPORT_AUDIO_BLOCK_SAMPLES * 2

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Export capability check was canceled')
  error.name = 'AbortError'
  throw error
}

function audioProbeFrameCount(doc: TimelineDoc, totalFrames: number): number {
  if (
    audioSampleBoundary(totalFrames, doc) <
    REPRESENTATIVE_AUDIO_PROBE_SAMPLES
  ) {
    return totalFrames
  }

  let low = 1
  let high = totalFrames
  while (low < high) {
    const midpoint = low + Math.floor((high - low) / 2)
    if (
      audioSampleBoundary(midpoint, doc) >=
      REPRESENTATIVE_AUDIO_PROBE_SAMPLES
    ) {
      high = midpoint
    } else {
      low = midpoint + 1
    }
  }
  return low
}

/**
 * Configure and encode one real-size video frame plus exact mixer-sized audio
 * blocks. Short timelines use their complete sample count; longer timelines
 * use enough whole frames to cross two blocks so Chromium must produce and
 * flush a representative packet with the writer's real per-frame chunking.
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
  if (includeAudio && profile.audioChannelLayout === 'off') {
    throw new TypeError(
      'An audio-off profile cannot run an audio capability probe',
    )
  }
  const audioProfile =
    includeAudio && profile.audioChannelLayout !== 'off' ? profile : null

  const totalFrames = docDurationFrames(doc)
  if (includeAudio && totalFrames === 0) {
    throw new RangeError('Cannot probe audio for an empty export timeline')
  }
  const probeFrameCount = includeAudio
    ? audioProbeFrameCount(doc, totalFrames)
    : 1

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
  if (audioProfile) {
    audioSource = new AudioSampleSource({
      codec: audioProfile.audioCodec,
      bitrate: audioProfile.audioBitrate,
      bitrateMode: audioProfile.audioBitrateMode,
    })
    output.addAudioTrack(audioSource)
  }

  try {
    await output.start()
    throwIfAborted(signal)

    for (let frame = 0; frame < probeFrameCount; frame++) {
      throwIfAborted(signal)
      const audioWrite = async (): Promise<void> => {
        if (!audioSource || !audioProfile) return
        const channels = exportAudioChannelCount(audioProfile)
        const frameEndSample = audioSampleBoundary(frame + 1, doc)
        for (
          let startSample = audioSampleBoundary(frame, doc);
          startSample < frameEndSample;
          startSample += EXPORT_AUDIO_BLOCK_SAMPLES
        ) {
          throwIfAborted(signal)
          const numberOfFrames = Math.min(
            EXPORT_AUDIO_BLOCK_SAMPLES,
            frameEndSample - startSample,
          )
          const audioSample = new AudioSample({
            data: new Float32Array(numberOfFrames * channels),
            format: 'f32',
            numberOfChannels: channels,
            sampleRate: doc.audioSampleRate,
            timestamp: startSample / doc.audioSampleRate,
          })
          try {
            await audioSource.add(audioSample)
          } finally {
            audioSample.close()
          }
        }
      }

      const settled = await Promise.allSettled([
        videoSource.add(framesToSeconds(frame, doc.frameRate), frameDuration),
        audioWrite(),
      ])
      const failure = settled.find(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      )
      if (failure) throw failure.reason
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
