/** Transactional buffered/direct-file Mediabunny export sink. */
import { hasVideoBusEffects, videoBusRenderBudgetError } from '../domain/videoBusStage'

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
import type { SequenceProject } from '../domain/projectSequences'
import type { TimelineAudioMixPlan } from '../domain/audioMixPlan'
import { docDurationFrames, projectReachableSequences } from '../domain/selectors'
import { framesToSeconds } from '../domain/time'
import { exportAudioEncoderSampleRate } from '../domain/exportProfile'
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
  resampleMixedAudioBlock,
  scaleExportSampleIndex,
  type ExportAudioResampleCarry,
  type MixedAudioBlock,
} from './export-audio'
import {
  AacInputAssembler,
  type AacInputChunk,
} from './export-aac-input'
import { createMediabunnyExportAudioSource } from './export-mediabunny-audio-source'
import type { ExportAssetResolver } from './export-mediabunny-common'
import {
  createMediabunnyOutputFormat,
  mediabunnyExportImplementationUnavailableReason,
} from './export-mediabunny-profile'
import type { Composite2D, TransitionSurfaces } from './render'
import {
  createDocumentLensRemapProvider,
  documentHasSupportedLensCorrection,
  documentHasUnsupportedLensCorrection,
  WebGl2LensRemapBackend,
} from './lensRemapWebgl'
import { LensRemapUnavailableError } from './lensRemap'

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
  projectMixPlan?: TimelineAudioMixPlan,
  projectTarget?: Readonly<{
    project: SequenceProject
    sequenceId: string
  }>,
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
  const hasTimelineAudio = projectMixPlan
    ? projectMixPlan.clips.length > 0 || projectMixPlan.mutedClips.length > 0
    : doc.tracks.some(
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
  const encoderSampleRate = audioSettings && audioSettings.audioCodec
    ? exportAudioEncoderSampleRate(doc.audioSampleRate, audioSettings.audioCodec)
    : doc.audioSampleRate
  const expectedAudioSamples = hasAudio
    ? scaleExportSampleIndex(
      audioSampleBoundary(expectedFrames, doc),
      doc.audioSampleRate,
      encoderSampleRate,
    )
    : 0

  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this browser')
  }

  const lensDocument = projectTarget
    ? {
        ...doc,
        masterVideoEffects: projectReachableSequences(projectTarget.project, projectTarget.sequenceId).flatMap((sequence) => sequence.masterVideoEffects ?? []),
        tracks: projectReachableSequences(
          projectTarget.project,
          projectTarget.sequenceId,
        ).flatMap((sequence) => sequence.tracks),
      }
    : doc

  if (hasVideoBusEffects(lensDocument)) {
    const error = videoBusRenderBudgetError(doc.width, doc.height)
    if (error) throw new RangeError(error)
  }
  if (documentHasUnsupportedLensCorrection(lensDocument)) {
    throw new LensRemapUnavailableError(
      'Export is blocked because this project contains a preserved future lens-correction version.',
    )
  }

  let lensBackend: WebGl2LensRemapBackend | null = null
  try {
    if (documentHasSupportedLensCorrection(lensDocument)) {
      lensBackend = new WebGl2LensRemapBackend()
    }
  } catch (cause) {
    throw new LensRemapUnavailableError(
      `Export lens correction is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      true,
      cause,
    )
  }
  let lensRemapProvider
  try {
    lensRemapProvider = createDocumentLensRemapProvider(
      lensDocument,
      lensBackend,
      doc.width,
      doc.height,
      true,
    )
  } catch (cause) {
    lensBackend?.dispose()
    throw cause
  }

  let canvas: OffscreenCanvas
  try {
    canvas = new OffscreenCanvas(doc.width, doc.height)
  } catch (cause) {
    lensBackend?.dispose()
    throw cause
  }
  const context = canvas.getContext('2d', SRGB_2D_CONTEXT)
  if (!context) {
    lensBackend?.dispose()
    canvas.width = 1
    canvas.height = 1
    throw new Error('Could not create the export 2D context')
  }

  const format = createMediabunnyOutputFormat(settings.container)
  let fileTarget: DirectFileExportTarget | null
  try {
    fileTarget = fileDestination
      ? await createDirectFileExportTarget(fileDestination)
      : null
  } catch (cause) {
    lensBackend?.dispose()
    canvas.width = 1
    canvas.height = 1
    throw cause
  }
  let bufferTarget: BufferTarget | null = null
  const target = fileTarget?.target ?? (bufferTarget = new BufferTarget())
  let output: Output
  try {
    output = new Output({ format, target })
  } catch (cause) {
    try {
      await fileTarget?.abort(cause)
    } finally {
      lensBackend?.dispose()
      canvas.width = 1
      canvas.height = 1
    }
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
          undefined,
          projectMixPlan,
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
                  encoderSampleRate,
                )
              },
            }
          : {}),
      })
      output.addAudioTrack(audioSource)
    }
    await output.start()
  } catch (cause) {
    try {
      return await cancelSetup(output, mixer, fileTarget, cause)
    } finally {
      lensBackend?.dispose()
      canvas.width = 1
      canvas.height = 1
    }
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
  let audioResampleCarry: ExportAudioResampleCarry | null = null
  const aacAssembler = audioSettings?.audioCodec === 'aac'
    && outputAudioChannels !== null
    ? new AacInputAssembler(outputAudioChannels)
    : null
  let transitionSurfaces: TransitionSurfaces | null = null
  let renderSurfacesReleased = false

  const releaseRenderSurfaces = (): void => {
    if (renderSurfacesReleased) return
    renderSurfacesReleased = true
    lensBackend?.dispose()
    lensBackend = null
    if (transitionSurfaces) {
      for (const surface of [transitionSurfaces.leg.canvas, transitionSurfaces.group.canvas]) {
        const owned = surface as OffscreenCanvas
        owned.width = 1
        owned.height = 1
      }
      transitionSurfaces = null
    }
    canvas.width = 1
    canvas.height = 1
  }

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
        releaseRenderSurfaces()
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

  const writeEncodedAudioChunk = async (
    chunk: AacInputChunk,
  ): Promise<void> => {
    if (!audioSource || outputAudioChannels === null) {
      throw new Error('Export audio source is unavailable')
    }
    const sample = new AudioSample({
      data: chunk.data,
      format: 'f32',
      numberOfChannels: outputAudioChannels,
      sampleRate: encoderSampleRate,
      timestamp: chunk.startSample / encoderSampleRate,
    })
    try {
      await audioSource.add(sample)
    } finally {
      sample.close()
    }
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
              const resampled = resampleMixedAudioBlock(
                block,
                doc.audioSampleRate,
                encoderSampleRate,
                audioResampleCarry,
              )
              audioResampleCarry = resampled.carry
              const encoded = resampled.encoded
              if (encoded.sampleCount <= 0) return
              const chunk = {
                startSample: encoded.startSample,
                sampleCount: encoded.sampleCount,
                data: interleaveAudioBlock(encoded, outputAudioChannels),
              }
              if (aacAssembler) {
                await aacAssembler.add(chunk, writeEncodedAudioChunk)
              } else {
                await writeEncodedAudioChunk(chunk)
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
      await aacAssembler?.flush(writeEncodedAudioChunk)
      source.close()
      audioSource?.close()
      await output.finalize()
      committedFile = fileTarget ? await fileTarget.commit() : null
    } catch (cause) {
      return failAfterCancel(cause)
    } finally {
      releaseRenderSurfaces()
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
        const legContext = legCanvas.getContext('2d', { ...SRGB_2D_CONTEXT, willReadFrequently: true })
        const groupCanvas = new OffscreenCanvas(doc.width, doc.height)
        const groupContext = groupCanvas.getContext('2d', { ...SRGB_2D_CONTEXT, willReadFrequently: true })
        if (!legContext || !groupContext) {
          legCanvas.width = 1
          legCanvas.height = 1
          groupCanvas.width = 1
          groupCanvas.height = 1
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
    lensRemapProvider,
    addFrame,
    finalize,
    cancel,
  }
}
