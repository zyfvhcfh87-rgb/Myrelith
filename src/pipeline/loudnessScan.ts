/** Cancellable mixed-program loudness scan. Does not mutate the document. */

import type { TimelineDoc } from '../domain/schema'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import {
  LoudnessMeter,
  type LoudnessMeasurement,
  type LoudnessMeasurementRange,
} from '../domain/audioLoudness'
import { docDurationFrames } from '../domain/selectors'
import { audioSampleBoundary } from '../domain/time'
import {
  TimelineAudioMixer,
  type ExportAudioMediaSource,
} from './export-audio'

export interface LoudnessScanProgress {
  readonly framesDone: number
  readonly frameCount: number
}

export async function scanTimelineLoudness(
  doc: TimelineDoc,
  source: ExportAudioMediaSource,
  options: {
    readonly range: LoudnessMeasurementRange
    readonly catalog?: SourceBoundsCatalog
    readonly signal?: AbortSignal
    readonly onProgress?: (progress: LoudnessScanProgress) => void
  },
): Promise<LoudnessMeasurement> {
  let mixer: TimelineAudioMixer | null = null
  let measurement: LoudnessMeasurement | undefined
  let failure: unknown
  try {
    const durationFrames = docDurationFrames(doc)
    const { startFrame, endFrame } = options.range
    if (
      !Number.isSafeInteger(startFrame)
      || !Number.isSafeInteger(endFrame)
      || startFrame < 0
      || endFrame < startFrame
      || endFrame > durationFrames
    ) {
      throw new RangeError(
        `loudness range must be integer document frames within 0..${durationFrames}`,
      )
    }
    const frameCount = endFrame - startFrame
    const expectedSamples = audioSampleBoundary(endFrame, doc)
      - audioSampleBoundary(startFrame, doc)
    const meter = new LoudnessMeter(doc.audioSampleRate, expectedSamples)
    if (frameCount > 0) {
      mixer = new TimelineAudioMixer(
        doc,
        source,
        options.catalog ?? new Map(),
        options.signal,
      )
      // Prime the same stateful mixer from frame zero, but meter only the
      // explicitly selected range. This keeps range measurements faithful to
      // compressor, limiter, and gate history at the range boundary.
      for (let frame = 0; frame < endFrame; frame++) {
        if (options.signal?.aborted) {
          throw new DOMException('Loudness scan cancelled', 'AbortError')
        }
        await mixer.writeFrame(frame, async (block) => {
          if (frame >= startFrame) {
            meter.process(block.channels[0], block.channels[1])
          }
        })
        if (frame >= startFrame) {
          options.onProgress?.({
            framesDone: frame - startFrame + 1,
            frameCount,
          })
        }
      }
    }
    measurement = meter.result()
  } catch (cause) {
    failure = cause
  }
  try {
    if (mixer) await mixer.close()
    else await source.close()
  } catch (cause) {
    failure ??= cause
  }
  if (failure !== undefined) throw failure
  if (!measurement) throw new Error('Loudness scan completed without a measurement')
  return measurement
}
