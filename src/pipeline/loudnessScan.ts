/** Cancellable mixed-program loudness scan. Does not mutate the document. */

import type { TimelineDoc } from '../domain/schema'
import type { SourceBoundsCatalog } from '../domain/crossfadePlan'
import { LoudnessMeter, type LoudnessMeasurement } from '../domain/audioLoudness'
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
    readonly catalog?: SourceBoundsCatalog
    readonly signal?: AbortSignal
    readonly onProgress?: (progress: LoudnessScanProgress) => void
  } = {},
): Promise<LoudnessMeasurement> {
  const frameCount = docDurationFrames(doc)
  const expectedSamples = audioSampleBoundary(frameCount, doc)
  const meter = new LoudnessMeter(doc.audioSampleRate, expectedSamples)
  if (frameCount <= 0) return meter.result()
  const mixer = new TimelineAudioMixer(doc, source, options.catalog ?? new Map())
  try {
    for (let frame = 0; frame < frameCount; frame++) {
      if (options.signal?.aborted) {
        throw new DOMException('Loudness scan cancelled', 'AbortError')
      }
      await mixer.writeFrame(frame, async (block) => {
        meter.process(block.channels[0], block.channels[1])
      })
      options.onProgress?.({ framesDone: frame + 1, frameCount })
    }
  } finally {
    await mixer.close()
  }
  return meter.result()
}
