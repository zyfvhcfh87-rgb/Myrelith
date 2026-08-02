/** Transactional buffered/direct-file Mediabunny export sink. */

import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  type EncodedPacket,
  Output,
} from 'mediabunny'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type { TimelineDoc } from '../domain/schema'
import { docDurationFrames } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import {
  createBufferedExportResult,
  createDirectFileExportResult,
  type ExportResult,
  type ExportSettings,
  type ExportVideoSink,
} from './export'
import {
  DirectFileAbortError,
  createDirectFileExportTarget,
  type DirectFileExportTarget,
  type PreparedExportFileCapability,
} from './export-file-target'
import {
  TimelineAudioMixer,
  audioSampleBoundary,
  type MixedAudioBlock,
} from './export-audio'
import { createMediabunnyExportAudioSource } from './export-mediabunny-audio-source'
import type { ExportAssetResolver } from './export-mediabunny-common'
import {
  createMediabunnyOutputFormat,
  mediabunnyExportImplementationUnavailableReason,
} from './export-mediabunny-profile'
import type { Composite2D, TransitionSurfaces } from './render'

const SRGB_2D_CONTEXT: CanvasRenderingContext2DSettings = {
  colorSpace: 'srgb',
}

function assertVideoSinkInputs(
  doc: TimelineDoc,
  settings: ExportSettings,
  includeAudio: boolean,
): number {
  const implementationReason = mediabunnyExportImplementationUnavailableReason(
    settings,
    includeAudio,
  )
  if (implementationReason !== null) throw new TypeError(implementationReason)
  if (
    !Number.isSafeInteger(settings.videoBitrate) ||
    settings.videoBitrate <= 0
  ) {
    throw new TypeError('videoBitrate must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.width) || doc.width <= 0) {
    throw new RangeError('Export width must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.height) || doc.height <= 0) {
    throw new RangeError('Export height must be a positive safe integer')
  }
  if (!Number.isSafeInteger(doc.audioSampleRate) || doc.audioSampleRate <= 0) {
    throw new RangeError('Export audio sample rate must be a positive safe integer')
  }
  framesToSeconds(1, doc.frameRate)
  return doc.frameRate.num / doc.frameRate.den
}

async function cancelSetup(
  output: Output,
  mixer: TimelineAudioMixer | null,
  fileTarget: DirectFileExportTarget | null,
  primary: unknown,
): Promise<never> {
  let integrityFailure: unknown
  try {
    await output.cancel()
  } catch {
    // The setup failure remains primary; Output owns its own cancel promise.
  }
  try {
    await fileTarget?.abort(primary)
  } catch (cause) {
    // Losing the ability to discard staged bytes is the integrity-critical
    // result and must remain visible to the user.
    integrityFailure = cause
  }
  try {
    await mixer?.close()
  } catch {
    // The setup failure remains primary over decoder cleanup.
  }
  if (integrityFailure !== undefined) throw integrityFailure
  throw primary
}

function interleaveAudioBlock(
  block: MixedAudioBlock,
  channelCount: 1 | 2,
): Float32Array {
  const data = new Float32Array(block.sampleCount * channelCount)
  for (let frame = 0; frame < block.sampleCount; frame++) {
    if (channelCount === 1) {
      // The internal mix bus stays stereo. An arithmetic mean preserves a
      // duplicated mono source's level and cannot clip two bounded channels.
      data[frame] = (block.channels[0][frame] + block.channels[1][frame]) / 2
    } else {
      data[frame * channelCount] = block.channels[0][frame]
      data[frame * channelCount + 1] = block.channels[1][frame]
    }
  }
  return data
}

function trimAacPaddingPacket(
  packet: EncodedPacket,
  targetSamples: number,
  sampleRate: number,
): void {
  const packetStart = Math.round(packet.timestamp * sampleRate)
  const packetSamples = Math.round(packet.duration * sampleRate)
  const remaining = Math.max(0, targetSamples - packetStart)
  if (packetSamples <= remaining) return

  // Mediabunny 1.50.9 invokes onEncodedPacket synchronously immediately
  // before handing this same object to the muxer. AAC encodes whole 1024-
  // sample packets; narrowing the final packet's container duration removes
  // codec padding without changing the exact PCM samples submitted.
  ;(packet as unknown as { duration: number }).duration =
    remaining / sampleRate
}

/** Creates and starts the selected buffered or direct-file Mediabunny sink. */
export async function createMediabunnyExportSink(
  doc: TimelineDoc,
  settings: ExportSettings,
  resolveAsset: ExportAssetResolver,
  sourceBounds: SourceBoundsCatalog = new Map(),
  fileDestination?: PreparedExportFileCapability,
): Promise<ExportVideoSink> {
  if (typeof resolveAsset !== 'function') {
    throw new TypeError('resolveAsset must be a function')
  }
  if (settings.destination === 'file' && !fileDestination) {
    throw new TypeError(
      'Direct file export requires a user-selected file destination',
    )
  }
  if (settings.destination === 'download' && fileDestination) {
    throw new TypeError(
      'Browser download export cannot use a direct file destination',
    )
  }
  const hasTimelineAudio = doc.tracks.some(
    (track) => track.kind === 'audio' && track.clips.length > 0,
  )
  const audioSettings = settings.audioChannelLayout === 'off' || !hasTimelineAudio
    ? null
    : settings
  const includeAudio = audioSettings !== null
  const frameRate = assertVideoSinkInputs(doc, settings, includeAudio)
  const outputAudioChannels = audioSettings
    ? (audioSettings.audioChannelLayout === 'mono' ? 1 : 2)
    : null
  const hasAudio = audioSettings !== null
  const expectedFrames = docDurationFrames(doc)
  const expectedAudioSamples = hasAudio
    ? audioSampleBoundary(expectedFrames, doc)
    : 0

  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }

  const canvas = new OffscreenCanvas(doc.width, doc.height)
  const context = canvas.getContext('2d', SRGB_2D_CONTEXT)
  if (!context) {
    throw new Error('Could not create the export 2D context')
  }

  const format = createMediabunnyOutputFormat(settings.container)
  const fileTarget = fileDestination
    ? await createDirectFileExportTarget(fileDestination)
    : null
  let bufferTarget: BufferTarget | null = null
  const target = fileTarget?.target ?? (bufferTarget = new BufferTarget())
  let output: Output
  try {
    output = new Output({ format, target })
  } catch (cause) {
    await fileTarget?.abort(cause)
    throw cause
  }
  let source: CanvasSource
  let audioSource: AudioSampleSource | null = null
  let mixer: TimelineAudioMixer | null = null
  try {
    mixer = hasAudio
      ? new TimelineAudioMixer(
          doc,
          createMediabunnyExportAudioSource(resolveAsset),
          sourceBounds,
        )
      : null
    source = new CanvasSource(canvas, {
      codec: settings.videoCodec,
      bitrate: settings.videoBitrate,
      bitrateMode: settings.videoBitrateMode,
      keyFrameInterval: settings.keyFrameIntervalMicroseconds / 1_000_000,
    })
    output.addVideoTrack(source, { frameRate })
    if (audioSettings) {
      audioSource = new AudioSampleSource({
        codec: audioSettings.audioCodec,
        bitrate: audioSettings.audioBitrate,
        bitrateMode: audioSettings.audioBitrateMode,
        ...(audioSettings.audioCodec === 'aac'
          ? {
              onEncodedPacket: (packet: EncodedPacket) => {
                trimAacPaddingPacket(
                  packet,
                  expectedAudioSamples,
                  doc.audioSampleRate,
                )
              },
            }
          : {}),
      })
      output.addAudioTrack(audioSource)
    }
    await output.start()
  } catch (cause) {
    return cancelSetup(output, mixer, fileTarget, cause)
  }

  type SinkState =
    | 'open'
    | 'finalizing'
    | 'finalized'
    | 'canceling'
    | 'canceled'
  let state: SinkState = 'open'
  let cancelPromise: Promise<void> | null = null
  let nextFrame = 0
  let transitionSurfaces: TransitionSurfaces | null = null

  const cancelWithReason = (reason?: unknown): Promise<void> => {
    if (state === 'finalized' || state === 'canceled') {
      return Promise.resolve()
    }
    if (cancelPromise) return cancelPromise
    state = 'canceling'
    cancelPromise = (async () => {
      let failure: unknown
      try {
        await output.cancel()
      } catch (cause) {
        failure = cause
      }
      try {
        await fileTarget?.abort(reason ?? failure)
      } catch (cause) {
        // An abort failure means staged bytes may remain and outranks the
        // ordinary operation/decoder cleanup error.
        failure = cause
      }
      try {
        await mixer?.close()
      } catch (cause) {
        failure ??= cause
      } finally {
        state = 'canceled'
      }
      if (failure !== undefined) throw failure
    })()
    return cancelPromise
  }

  const cancel = (reason?: unknown): Promise<void> => cancelWithReason(reason)

  const failAfterCancel = async (primary: unknown): Promise<never> => {
    try {
      await cancelWithReason(primary)
    } catch (cleanupCause) {
      if (cleanupCause instanceof DirectFileAbortError) {
        throw cleanupCause
      }
      // Preserve the encode/finalize failure over cleanup failure.
    }
    throw primary
  }

  const addFrame = async (
    timestampSec: number,
    durationSec: number,
  ): Promise<void> => {
    if (state !== 'open') throw new Error('Export sink is closed')
    try {
      const videoWrite = source.add(timestampSec, durationSec)
      const audioWrite =
        mixer && audioSource && outputAudioChannels !== null
          ? mixer.writeFrame(nextFrame, async (block) => {
              const sample = new AudioSample({
                data: interleaveAudioBlock(block, outputAudioChannels),
                format: 'f32',
                numberOfChannels: outputAudioChannels,
                sampleRate: doc.audioSampleRate,
                timestamp: block.startSample / doc.audioSampleRate,
              })
              try {
                await audioSource.add(sample)
              } finally {
                sample.close()
              }
            })
          : Promise.resolve()
      const writes = await Promise.allSettled([videoWrite, audioWrite])
      const failure = writes.find(
        (entry): entry is PromiseRejectedResult =>
          entry.status === 'rejected',
      )
      if (failure) throw failure.reason
      nextFrame++
    } catch (cause) {
      return failAfterCancel(cause)
    }
  }

  const finalize = async (): Promise<ExportResult> => {
    if (state !== 'open') throw new Error('Export sink is closed')
    if (nextFrame !== expectedFrames) {
      return failAfterCancel(
        new Error(
          `Export sink expected ${expectedFrames} frames, got ${nextFrame}`,
        ),
      )
    }
    state = 'finalizing'
    let committedFile: Awaited<ReturnType<DirectFileExportTarget['commit']>>
      | null = null
    try {
      await mixer?.close()
      source.close()
      audioSource?.close()
      await output.finalize()
      committedFile = fileTarget ? await fileTarget.commit() : null
    } catch (cause) {
      return failAfterCancel(cause)
    }

    state = 'finalized'
    if (committedFile) {
      return createDirectFileExportResult(
        committedFile.fileName,
        committedFile.byteLength,
        settings,
      )
    }
    if (bufferTarget === null || bufferTarget.buffer === null) {
      throw new Error('Mediabunny finalized without an output buffer')
    }
    return createBufferedExportResult(bufferTarget.buffer, settings)
  }

  return {
    ctx: context as Composite2D,
    transitionSurfaceProvider: {
      get: () => {
        if (transitionSurfaces) return transitionSurfaces
        const legCanvas = new OffscreenCanvas(doc.width, doc.height)
        const legContext = legCanvas.getContext('2d', SRGB_2D_CONTEXT)
        const groupCanvas = new OffscreenCanvas(doc.width, doc.height)
        const groupContext = groupCanvas.getContext('2d', SRGB_2D_CONTEXT)
        if (!legContext || !groupContext) {
          throw new Error('Could not create export transition 2D contexts')
        }
        transitionSurfaces = {
          leg: {
            canvas: legCanvas,
            ctx: legContext as Composite2D,
          },
          group: {
            canvas: groupCanvas,
            ctx: groupContext as Composite2D,
          },
        }
        return transitionSurfaces
      },
    },
    addFrame,
    finalize,
    cancel,
  }
}
