import type { ExportProfile } from './exportProfile'
import type { FrameRate } from './schema'

export const MAX_EXPORT_DURATION_SECONDS = 24 * 60 * 60
export const MAX_EXPORT_FRAME_COUNT = 5_000_000
export const MAX_BUFFERED_EXPORT_ESTIMATE_BYTES = 4 * 1024 * 1024 * 1024
export const MAX_DIRECT_EXPORT_ESTIMATE_BYTES = 256 * 1024 * 1024 * 1024

export interface ExportWorkBudget {
  readonly allowed: boolean
  readonly frameCount: number
  readonly estimatedOutputBytes: number
  readonly reason: string | null
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

export function exportWorkBudget(
  frameCount: number,
  frameRate: FrameRate,
  profile: Readonly<ExportProfile>,
): ExportWorkBudget {
  if (
    !positiveSafeInteger(frameCount)
    || !positiveSafeInteger(frameRate.num)
    || !positiveSafeInteger(frameRate.den)
  ) {
    return Object.freeze({
      allowed: false,
      frameCount,
      estimatedOutputBytes: Number.NaN,
      reason: 'Export work facts must be positive safe integers.',
    })
  }

  const frames = BigInt(frameCount)
  const rateNumerator = BigInt(frameRate.num)
  const rateDenominator = BigInt(frameRate.den)
  const durationTooLong = frames * rateDenominator
    > BigInt(MAX_EXPORT_DURATION_SECONDS) * rateNumerator
  const totalBitrate = BigInt(profile.videoBitrate + (profile.audioBitrate ?? 0))
  const payloadBytes = ceilDivide(
    frames * rateDenominator * totalBitrate,
    rateNumerator * 8n,
  )
  // Allow ten percent container overhead plus one MiB of fixed metadata.
  const estimated = ceilDivide(payloadBytes * 11n, 10n) + 1_048_576n
  const estimatedOutputBytes = estimated <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(estimated)
    : Number.POSITIVE_INFINITY
  const outputLimit = profile.destination === 'download'
    ? MAX_BUFFERED_EXPORT_ESTIMATE_BYTES
    : MAX_DIRECT_EXPORT_ESTIMATE_BYTES

  let reason: string | null = null
  if (frameCount > MAX_EXPORT_FRAME_COUNT) {
    reason = `Export work exceeds the ${MAX_EXPORT_FRAME_COUNT}-frame limit.`
  } else if (durationTooLong) {
    reason = `Export duration exceeds the ${MAX_EXPORT_DURATION_SECONDS}-second limit.`
  } else if (estimated > BigInt(outputLimit)) {
    reason = profile.destination === 'download'
      ? 'Estimated output exceeds the memory-buffered export limit. Choose direct file output or shorten the timeline.'
      : 'Estimated output exceeds the direct-file export limit.'
  }

  return Object.freeze({
    allowed: reason === null,
    frameCount,
    estimatedOutputBytes,
    reason,
  })
}

export function assertExportWorkBudget(
  frameCount: number,
  frameRate: FrameRate,
  profile: Readonly<ExportProfile>,
): void {
  const budget = exportWorkBudget(frameCount, frameRate, profile)
  if (!budget.allowed) throw new RangeError(budget.reason ?? 'Export exceeds the work limit.')
}
