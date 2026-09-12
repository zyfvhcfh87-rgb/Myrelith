/**
 * Audio-only delivery. WAV/PCM keeps the document sample-rate and channel
 * contract and never opens a video encoder. Compressed AAC/Opus follow only
 * after an explicit profile that capability probing has allowed.
 */

import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  type EncodedPacket,
} from 'mediabunny'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import type { ExportRange } from '../domain/exportRange'
import { exportSampleBoundary, validateExportRange } from '../domain/exportRange'
import {
  assertDeliveryWorkBudget,
  deliveryProductLabel,
  validateDeliveryProfile,
  type AudioOnlyProfile,
} from '../domain/deliveryProduct'
import type { TimelineDoc } from '../domain/schema'
import type { TimelineAudioMixPlan } from '../domain/audioMixPlan'
import { exportAudioEncoderSampleRate } from '../domain/exportProfile'
import {
  createAlternativeBufferedExportResult,
  createAlternativeFileExportResult,
  type ExportResult,
} from './export'
import {
  TimelineAudioMixer,
  resampleMixedAudioBlock,
  type ExportAudioMediaSource,
  type ExportAudioResampleCarry,
  type MixedAudioBlock,
} from './export-audio'
import { AacInputAssembler, type AacInputChunk } from './export-aac-input'
import {
  DirectFileAbortError,
  type PreparedExportFileCapability,
} from './export-file-target'
import { encodePcmS16Wav } from './export-wav'
import { zipStore } from './zipStore'

export interface AudioOnlyExportDeps {
  readonly range?: ExportRange
  readonly sourceBounds?: SourceBoundsCatalog
  readonly projectMixPlan?: TimelineAudioMixPlan
  readonly fileDestination?: PreparedExportFileCapability
  readonly sidecarName?: string
  readonly sidecarBytes?: Uint8Array
}

function interleaveAudioBlock(block: MixedAudioBlock, channelCount: 1 | 2): Float32Array {
  const data = new Float32Array(block.sampleCount * channelCount)
  for (let frame = 0; frame < block.sampleCount; frame++) {
    if (channelCount === 1) {
      data[frame] = (block.channels[0][frame]! + block.channels[1][frame]!) / 2
    } else {
      data[frame * channelCount] = block.channels[0][frame]!
      data[frame * channelCount + 1] = block.channels[1][frame]!
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
  ;(packet as unknown as { duration: number }).duration = remaining / sampleRate
}

function finishBuffer(
  buffer: ArrayBuffer,
  profile: AudioOnlyProfile,
  sidecarName?: string,
  sidecarBytes?: Uint8Array,
): AlternativeDownload {
  if (sidecarName && sidecarBytes) {
    const mediaName = `audio.${profile.fileExtension}`
    const zip = zipStore([
      { name: mediaName, data: new Uint8Array(buffer) },
      { name: sidecarName, data: sidecarBytes },
    ])
    const copy = new Uint8Array(zip.byteLength)
    copy.set(zip)
    return {
      buffer: copy.buffer,
      mimeType: 'application/zip',
      fileExtension: 'zip',
      label: `${deliveryProductLabel(profile)} with chapter sidecar`,
      files: [mediaName, sidecarName],
    }
  }
  return {
    buffer,
    mimeType: profile.mimeType,
    fileExtension: profile.fileExtension,
    label: deliveryProductLabel(profile),
  }
}

interface AlternativeDownload {
  readonly buffer: ArrayBuffer
  readonly mimeType: string
  readonly fileExtension: string
  readonly label: string
  readonly files?: readonly string[]
}

async function publish(
  packaged: AlternativeDownload,
  profile: AudioOnlyProfile,
  fileDestination?: PreparedExportFileCapability,
): Promise<ExportResult> {
  if (profile.destination === 'download') {
    return createAlternativeBufferedExportResult({
      destination: 'download',
      kind: 'audio-only',
      buffer: packaged.buffer,
      mimeType: packaged.mimeType,
      fileExtension: packaged.fileExtension,
      label: packaged.label,
      completion: 'complete',
      files: packaged.files,
    })
  }
  if (!fileDestination) {
    throw new TypeError('Direct-file audio export requires a user-selected file destination')
  }
  const handle = fileDestination.takeFileHandle()
  const writable = await handle.createWritable({ keepExistingData: false })
  try {
    await writable.write(packaged.buffer)
    await writable.close()
  } catch (cause) {
    try {
      await writable.abort()
    } catch (abortCause) {
      throw new DirectFileAbortError(cause, abortCause)
    }
    throw cause
  }
  return createAlternativeFileExportResult({
    destination: 'file',
    kind: 'audio-only',
    fileName: fileDestination.fileName,
    byteLength: packaged.buffer.byteLength,
    mimeType: packaged.mimeType,
    fileExtension: packaged.fileExtension,
    label: packaged.label,
    completion: 'complete',
  })
}

async function discardFile(fileDestination?: PreparedExportFileCapability): Promise<void> {
  if (!fileDestination) return
  const handle = fileDestination.takeFileHandle()
  const writable = await handle.createWritable({ keepExistingData: false })
  try {
    await writable.abort()
  } catch (cause) {
    throw new DirectFileAbortError(undefined, cause)
  }
}

export async function* exportAudioOnly(
  doc: TimelineDoc,
  profile: AudioOnlyProfile,
  source: ExportAudioMediaSource,
  deps: AudioOnlyExportDeps = {},
): AsyncGenerator<number, ExportResult | undefined, void> {
  const validated = validateDeliveryProfile(profile)
  if (validated.kind !== 'audio-only') {
    throw new TypeError('Audio-only export requires an audio-only profile')
  }
  const window = validateExportRange(doc, deps.range)
  assertDeliveryWorkBudget(window.endFrame - window.startFrame, doc, validated)
  const channelCount: 1 | 2 = validated.audioChannelLayout === 'mono' ? 1 : 2
  const mixer = new TimelineAudioMixer(
    doc,
    source,
    deps.sourceBounds ?? new Map(),
    undefined,
    deps.projectMixPlan,
  )
  let nextFrame = 0
  let finalized = false
  try {
    yield 0
    for (let frame = 0; frame < window.startFrame; frame++) {
      await mixer.writeFrame(frame, async () => undefined)
      nextFrame++
      yield frame / (window.endFrame + 1)
    }
    if (validated.codec === 'pcm-s16') {
      const startSample = exportSampleBoundary(window.startFrame, doc, doc.audioSampleRate)
      const sampleCount = exportSampleBoundary(window.endFrame, doc, doc.audioSampleRate) - startSample
      const left = new Float32Array(sampleCount)
      const right = channelCount === 2 ? new Float32Array(sampleCount) : null
      let cursor = 0
      for (let frame = window.startFrame; frame < window.endFrame; frame++) {
        await mixer.writeFrame(frame, async (block) => {
          for (let sample = 0; sample < block.sampleCount; sample++) {
            if (channelCount === 1) {
              left[cursor] = (block.channels[0][sample]! + block.channels[1][sample]!) / 2
            } else {
              left[cursor] = block.channels[0][sample]!
              right![cursor] = block.channels[1][sample]!
            }
            cursor++
          }
        })
        nextFrame++
        yield (frame + 1) / (window.endFrame + 1)
      }
      await mixer.close()
      if (cursor !== sampleCount) {
        throw new Error(`WAV export expected ${sampleCount} samples, mixed ${cursor}`)
      }
      const planes = right ? [left, right] : [left]
      const buffer = encodePcmS16Wav(planes, doc.audioSampleRate)
      finalized = true
      return await publish(
        finishBuffer(buffer, validated, deps.sidecarName, deps.sidecarBytes),
        validated,
        deps.fileDestination,
      )
    }

    const encoderSampleRate = exportAudioEncoderSampleRate(doc.audioSampleRate, validated.codec)
    const format = validated.container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat()
    const target = new BufferTarget()
    const output = new Output({ format, target })
    const firstAudioSample = exportSampleBoundary(window.startFrame, doc, encoderSampleRate)
    const expectedAudioSamples = exportSampleBoundary(window.endFrame, doc, encoderSampleRate) - firstAudioSample
    const audioSource = new AudioSampleSource({
      codec: validated.codec,
      bitrate: validated.audioBitrate ?? 192_000,
      bitrateMode: validated.audioBitrateMode ?? 'variable',
      ...(validated.codec === 'aac'
        ? {
            onEncodedPacket: (packet: EncodedPacket) => {
              trimAacPaddingPacket(packet, expectedAudioSamples, encoderSampleRate)
            },
          }
        : {}),
    })
    output.addAudioTrack(audioSource)
    await output.start()
    let audioResampleCarry: ExportAudioResampleCarry | null = null
    const aacAssembler = validated.codec === 'aac' ? new AacInputAssembler(channelCount) : null
    const writeEncoded = async (chunk: AacInputChunk): Promise<void> => {
      const sample = new AudioSample({
        data: chunk.data,
        format: 'f32',
        numberOfChannels: channelCount,
        sampleRate: encoderSampleRate,
        timestamp: chunk.startSample / encoderSampleRate,
      })
      try {
        await audioSource.add(sample)
      } finally {
        sample.close()
      }
    }
    try {
      for (let frame = window.startFrame; frame < window.endFrame; frame++) {
        await mixer.writeFrame(frame, async (block) => {
          const resampled = resampleMixedAudioBlock(
            block,
            doc.audioSampleRate,
            encoderSampleRate,
            audioResampleCarry,
          )
          audioResampleCarry = resampled.carry
          if (resampled.encoded.sampleCount <= 0) return
          const chunk = {
            startSample: resampled.encoded.startSample - firstAudioSample,
            sampleCount: resampled.encoded.sampleCount,
            data: interleaveAudioBlock(resampled.encoded, channelCount),
          }
          if (aacAssembler) await aacAssembler.add(chunk, writeEncoded)
          else await writeEncoded(chunk)
        })
        nextFrame++
        yield (frame + 1) / (window.endFrame + 1)
      }
      await mixer.close()
      await aacAssembler?.flush(writeEncoded)
      audioSource.close()
      await output.finalize()
    } catch (cause) {
      try {
        await output.cancel()
      } catch {
        // Operational failure stays primary.
      }
      throw cause
    }
    if (target.buffer === null) throw new Error('Audio-only export finalized without a buffer')
    finalized = true
    return await publish(
      finishBuffer(target.buffer, validated, deps.sidecarName, deps.sidecarBytes),
      validated,
      deps.fileDestination,
    )
  } catch (cause) {
    try {
      await mixer.close()
    } catch {
      // Operational failure stays primary.
    }
    if (!finalized) {
      try {
        await discardFile(deps.fileDestination)
      } catch (cleanup) {
        if (cleanup instanceof DirectFileAbortError) throw cleanup
      }
    }
    throw cause
  }
}
