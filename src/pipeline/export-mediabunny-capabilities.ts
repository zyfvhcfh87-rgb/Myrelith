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
import {
  exportAudioEncoderSampleRate,
  type ExportProfile,
} from '../domain/exportProfile'
import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  audioSampleBoundary,
  EXPORT_AUDIO_BLOCK_SAMPLES,
} from './export-audio'
import { AacInputAssembler, type AacInputChunk } from './export-aac-input'
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
 * Configure and encode one real-size video frame plus exact mixer-produced
 * audio. AAC input passes through the same bounded startup assembler as the
 * real sink, including zero-padding only when a very short timeline cannot
 * supply Chromium's two-frame startup minimum. Longer timelines use enough
 * whole frames to cross that minimum and flush representative packets.
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
  const encoderSampleRate = audioProfile && audioProfile.audioCodec
    ? exportAudioEncoderSampleRate(doc.audioSampleRate, audioProfile.audioCodec)
    : doc.audioSampleRate
  const encoderDoc = encoderSampleRate === doc.audioSampleRate
    ? doc
    : { ...doc, audioSampleRate: encoderSampleRate }

  const totalFrames = docDurationFrames(doc)
  if (includeAudio && totalFrames === 0) {
    throw new RangeError('Cannot probe audio for an empty export timeline')
  }
  const probeFrameCount = includeAudio
    ? audioProbeFrameCount(encoderDoc, totalFrames)
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

  const audioChannelCount = audioProfile
    ? exportAudioChannelCount(audioProfile)
    : 0
  const aacAssembler = audioProfile?.audioCodec === 'aac'
    && audioChannelCount !== 0
    ? new AacInputAssembler(audioChannelCount)
    : null
  const writeAudioProbeChunk = async (chunk: AacInputChunk): Promise<void> => {
    if (!audioSource || !audioProfile) return
    const channels = audioChannelCount
    const audioSample = new AudioSample({
      data: chunk.data,
      format: 'f32',
      numberOfChannels: channels,
      sampleRate: encoderSampleRate,
      timestamp: chunk.startSample / encoderSampleRate,
    })
    try {
      await audioSource.add(audioSample)
    } finally {
      audioSample.close()
    }
  }

  try {
    await output.start()
    throwIfAborted(signal)

    for (let frame = 0; frame < probeFrameCount; frame++) {
      throwIfAborted(signal)
      const audioWrite = async (): Promise<void> => {
        if (!audioSource || !audioProfile) return
        const channels = audioChannelCount
        const frameEndSample = audioSampleBoundary(frame + 1, encoderDoc)
        for (
          let startSample = audioSampleBoundary(frame, encoderDoc);
          startSample < frameEndSample;
          startSample += EXPORT_AUDIO_BLOCK_SAMPLES
        ) {
          throwIfAborted(signal)
          const sampleCount = Math.min(
            EXPORT_AUDIO_BLOCK_SAMPLES,
            frameEndSample - startSample,
          )
          const chunk = {
            startSample,
            sampleCount,
            data: new Float32Array(sampleCount * channels),
          }
          if (aacAssembler) {
            await aacAssembler.add(chunk, writeAudioProbeChunk)
          } else {
            await writeAudioProbeChunk(chunk)
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

    if (aacAssembler) {
      throwIfAborted(signal)
      await aacAssembler.flush(writeAudioProbeChunk)
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
