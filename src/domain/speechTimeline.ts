/** Cover exact native centisecond endpoints on the document frame grid. */
import type { FrameRate } from './schema'
export function projectSpeechCue(windowOffsetSamples: number, fromCentiseconds: number, toCentiseconds: number,
  sourceRate: number, frameRate: FrameRate, targetFrame: number): { startFrame: number; endFrame: number } {
  for (const value of [windowOffsetSamples, fromCentiseconds, targetFrame]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid speech cue origin')
  for (const value of [sourceRate, frameRate.num, frameRate.den, toCentiseconds]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid speech cue timebase')
  if (toCentiseconds <= fromCentiseconds) throw new Error('Speech cue has no positive duration')
  const denominator = BigInt(sourceRate) * 100n * BigInt(frameRate.den)
  const numerator = (centiseconds: number) => (BigInt(windowOffsetSamples) * 100n + BigInt(centiseconds) * BigInt(sourceRate)) * BigInt(frameRate.num)
  const start = BigInt(targetFrame) + numerator(fromCentiseconds) / denominator
  const end = BigInt(targetFrame) + (numerator(toCentiseconds) + denominator - 1n) / denominator
  if (end > 1_000_000_000n) throw new Error('Speech cue exceeds the timeline frame limit')
  return { startFrame: Number(start), endFrame: Number(end) }
}
