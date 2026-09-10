import { audioSampleBoundary, framesToSeconds } from './time'
import type { TimelineDoc } from './schema'
import { docDurationFrames } from './selectors'
import { MAX_EXPORT_DURATION_SECONDS, MAX_EXPORT_FRAME_COUNT } from './exportWorkBudget'

/** End is exclusive. Absolute project frames never become output timestamps. */
export interface ExportRange { readonly startFrame: number; readonly endFrame: number }
export function validateExportRange(doc: TimelineDoc, input?: ExportRange): Readonly<ExportRange> {
  framesToSeconds(0, doc.frameRate)
  const duration = docDurationFrames(doc)
  const startFrame = input?.startFrame ?? 0
  const endFrame = input?.endFrame ?? duration
  if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
    || startFrame < 0 || endFrame <= startFrame || endFrame > duration) throw new RangeError('Choose a non-empty range inside the sequence; End is exclusive.')
  // Audio effects need sequential pre-roll. Charge actual work, not just output.
  const work = BigInt(endFrame)
  if (work > BigInt(MAX_EXPORT_FRAME_COUNT) || work * BigInt(doc.frameRate.den) > BigInt(MAX_EXPORT_DURATION_SECONDS) * BigInt(doc.frameRate.num)) {
    throw new RangeError(work > BigInt(MAX_EXPORT_FRAME_COUNT) ? `Export work exceeds the ${MAX_EXPORT_FRAME_COUNT}-frame limit.` : 'Export including pre-roll exceeds the duration limit.')
  }
  return Object.freeze({ startFrame, endFrame })
}
/** Canonical rounded document grid, then floor-scale onto the encoder grid. */
export function exportSampleBoundary(frame: number, doc: Pick<TimelineDoc, 'frameRate' | 'audioSampleRate'>, outputRate = doc.audioSampleRate): number {
  const source = BigInt(audioSampleBoundary(frame, doc))
  const result = source * BigInt(outputRate) / BigInt(doc.audioSampleRate)
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Export sample boundary is too large.')
  return Number(result)
}
