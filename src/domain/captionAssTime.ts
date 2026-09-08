/** Pure ASS centisecond boundaries. Export proposals make grid loss explicit. */
import { CaptionFileError } from './captionFiles'
import { CAPTION_LIMITS } from './captions'
import type { FrameRate, TimeRange } from './schema'

const TIMESTAMP = /^([0-9]{1,23}):([0-5][0-9]):([0-5][0-9])\.([0-9]{2})$/u
const MAX_FRAME = BigInt(CAPTION_LIMITS.maxFrame)

function rateParts(rate: FrameRate): { numerator: bigint; denominator: bigint } {
  if (!Number.isSafeInteger(rate.num) || !Number.isSafeInteger(rate.den)
    || rate.num <= 0 || rate.den <= 0) {
    throw new CaptionFileError('timing', 'ASS requires a positive integer rational frame rate')
  }
  return { numerator: BigInt(rate.num), denominator: 100n * BigInt(rate.den) }
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor
}

function parseTimestamp(value: string): bigint {
  if (value.length > 32) throw new CaptionFileError('timing', 'ASS timestamp exceeds 32 characters')
  const match = TIMESTAMP.exec(value)
  if (!match) throw new CaptionFileError('timing', 'ASS timestamps must use nonnegative h:mm:ss.cc')
  return ((BigInt(match[1]!) * 60n + BigInt(match[2]!)) * 60n + BigInt(match[3]!)) * 100n + BigInt(match[4]!)
}

function formatTimestamp(value: bigint): string {
  const seconds = value / 100n
  const hours = seconds / 3_600n
  const minutes = seconds / 60n % 60n
  const result = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60n).padStart(2, '0')}.${String(value % 100n).padStart(2, '0')}`
  if (result.length > 32) throw new CaptionFileError('timing', 'ASS timestamp exceeds the supported field size')
  return result
}

function importedRange(start: bigint, end: bigint, rate: FrameRate): TimeRange {
  if (end <= start) throw new CaptionFileError('timing', 'ASS cue end must follow its start')
  const { numerator, denominator } = rateParts(rate)
  const from = start * numerator / denominator
  const to = ceilDivide(end * numerator, denominator)
  if (from < 0n || to > MAX_FRAME || to <= from) {
    throw new CaptionFileError('timing', `ASS cue must occupy positive frames within 0–${CAPTION_LIMITS.maxFrame}`)
  }
  return { startFrame: Number(from), durationFrames: Number(to - from) }
}

/** Floor starts and ceil exclusive ends so source coverage survives import. */
export function captionAssRangeToFrames(start: string, end: string, rate: FrameRate): TimeRange {
  return importedRange(parseTimestamp(start), parseTimestamp(end), rate)
}

interface AssExportBoundaries {
  start: string
  end: string
  originalRange: TimeRange
  importedRange: TimeRange
}

export type CaptionAssTimeExport =
  | ({ kind: 'exact' } & AssExportBoundaries)
  | ({ kind: 'coverage-expansion' } & AssExportBoundaries)
  | { kind: 'unrepresentable'; reason: string; originalRange: TimeRange }

/**
 * Propose exact timestamps, or report an outward-coverage alternative. Callers
 * must explicitly review coverage-expansion; this function never accepts loss.
 */
export function planCaptionAssTimeExport(range: TimeRange, rate: FrameRate): CaptionAssTimeExport {
  if (!Number.isSafeInteger(range.startFrame) || range.startFrame < 0
    || !Number.isSafeInteger(range.durationFrames) || range.durationFrames <= 0
    || range.startFrame > CAPTION_LIMITS.maxFrame
    || range.durationFrames > CAPTION_LIMITS.maxFrame - range.startFrame) {
    throw new CaptionFileError('timing', 'ASS export requires a valid bounded integer frame range')
  }
  const { numerator, denominator } = rateParts(rate)
  const from = BigInt(range.startFrame)
  const to = from + BigInt(range.durationFrames)
  const firstExact = ceilDivide(from * denominator, numerator)
  const lastExact = to * denominator / numerator
  const originalRange = { ...range }
  if (lastExact > firstExact) {
    const reconstructed = importedRange(firstExact, lastExact, rate)
    if (reconstructed.startFrame === range.startFrame && reconstructed.durationFrames === range.durationFrames) {
      return { kind: 'exact', start: formatTimestamp(firstExact), end: formatTimestamp(lastExact),
        originalRange, importedRange: reconstructed }
    }
  }
  try {
    const firstCovering = from * denominator / numerator
    const lastCovering = ceilDivide(to * denominator, numerator)
    const reconstructed = importedRange(firstCovering, lastCovering, rate)
    return { kind: 'coverage-expansion', start: formatTimestamp(firstCovering), end: formatTimestamp(lastCovering),
      originalRange, importedRange: reconstructed }
  } catch (error) {
    if (!(error instanceof CaptionFileError)) throw error
    return { kind: 'unrepresentable', reason: error.message, originalRange }
  }
}
