import { describe, expect, test, vi } from 'vitest'
import {
  planProxyGeneration,
  probeProxyEncoderSupport,
  type ProxyGenerationAsset,
} from './proxyGeneration'

function asset(
  firstTimestampUs: number,
  endTimestampUs: number,
): ProxyGenerationAsset {
  return {
    id: 'asset-1',
    fileName: 'source.mp4',
    size: 10_000,
    videoBounds: { firstTimestampUs, endTimestampUs },
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
  }
}

describe('editing proxy generation plan', () => {
  test('uses the exact video span when the containing asset has longer audio', () => {
    // The source fixture's notional audio ends at 8 s; only the exact 2 s video
    // span is admitted to the video-only proxy plan.
    const plan = planProxyGeneration(asset(2_000_000, 4_000_000))

    expect(plan.durationMicroseconds).toBe(2_000_000)
    expect(plan.frameCount).toBe(60)
    expect(plan.sourceTimestampSeconds(0)).toBe(2)
    expect(plan.sourceTimestampSeconds(59)).toBeLessThan(4)
    expect(plan.outputTimestampSeconds(0)).toBe(0)
  })

  test.each([
    { first: 250_000, end: 1_250_000 },
    { first: -250_000, end: 750_000 },
  ])('normalizes nonzero source bounds $first..$end to zero', ({ first, end }) => {
    const plan = planProxyGeneration(asset(first, end))

    expect(plan.sourceTimestampSeconds(0)).toBe(first / 1_000_000)
    expect(plan.outputTimestampSeconds(0)).toBe(0)
    expect(plan.durationMicroseconds).toBe(1_000_000)
    expect(plan.sourceTimestampSeconds(plan.frameCount - 1)).toBeLessThan(end / 1_000_000)
    expect(plan.outputDurationSeconds(plan.frameCount - 1)).toBeGreaterThan(0)
  })

  test('probes the exact output frame rate and reports an unsupported rate', async () => {
    const runExactProbe = vi.fn(async () => ({ supported: false }))
    const support = await probeProxyEncoderSupport(
      1_920,
      1_080,
      { num: 240, den: 1 },
      undefined,
      { runExactProbe },
    )

    expect(runExactProbe).toHaveBeenCalledWith(expect.objectContaining({
      width: 1_280,
      height: 720,
      framesPerSecond: 240,
    }))
    expect(support).toEqual(expect.objectContaining({
      supported: false,
      reason: expect.stringContaining('240.000 fps'),
    }))
  })
})
