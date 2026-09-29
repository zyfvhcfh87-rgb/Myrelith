import type { FrameRate } from '../domain/schema'

/** Frames per second as a short decimal for labels: 30, 29.97, 23.976. */
export function formatFrameRate(rate: FrameRate): string {
  const framesPerSecond = rate.num / rate.den
  if (Number.isInteger(framesPerSecond)) return String(framesPerSecond)
  return framesPerSecond.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}
