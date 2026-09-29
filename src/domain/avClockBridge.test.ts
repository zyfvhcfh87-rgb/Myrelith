import { describe, expect, test } from 'vitest'
import { estimateAvClockBridge } from './avClockBridge'

describe('A/V clock bridge', () => {
  test('recovers the tick-to-page offset from the Step 13 tab-capture sample', () => {
    // Real Chromium 151 tab capture: processor stamps (µs) and rVFC captureTime (ms).
    const stamps = [99523783700, 99523833200, 99523891700]
    const captures = [90.1, 139.7, 198.2].map((ms) => ms * 1000)
    // Three pairs agree; lower the minimum for this short sample.
    expect(estimateAvClockBridge(stamps, captures)).toBeNull()
    const longer = [...stamps, 99523940000, 99523990100, 99524040300]
    const longerCaptures = [...captures, 246_500, 296_600, 346_800]
    const bridge = estimateAvClockBridge(longer, longerCaptures)
    expect(bridge).not.toBeNull()
    expect(Math.abs(bridge!.offsetUs - 99523693500)).toBeLessThanOrEqual(100)
    expect(bridge!.pairs).toBeGreaterThanOrEqual(5)
    expect(bridge!.spreadUs).toBeLessThanOrEqual(200)
  })

  test('works when the lists start at different frames and have jittery spacing', () => {
    const offset = 50_000_000_000
    const captureMs = [0, 33.4, 70.1, 99.9, 133.2, 170.8, 200.3, 236.6, 266.9, 300.2]
    const stamps = captureMs.map((ms) => Math.round(ms * 1000) + offset + (Math.round(ms) % 2 ? 100 : 0))
    // The <video> element missed the first two frames and added one of its own.
    const captures = [...captureMs.slice(2).map((ms) => ms * 1000), 400_000]
    const bridge = estimateAvClockBridge(stamps, captures)
    expect(bridge).not.toBeNull()
    expect(Math.abs(bridge!.offsetUs - offset)).toBeLessThanOrEqual(100)
  })

  test('a stream already on page time bridges to an offset near zero', () => {
    const captureMs = [10, 43, 77, 110, 143, 177, 210]
    const stamps = captureMs.map((ms) => ms * 1000 + 2_000)
    const captures = captureMs.map((ms) => ms * 1000)
    // Near-regular spacing is ambiguous without delivery times…
    expect(estimateAvClockBridge(stamps, captures)).toBeNull()
    // …and exact once each frame's (1 ms later) delivery is known.
    expect(estimateAvClockBridge(stamps, captures, captures.map((us) => us + 1_000))?.offsetUs).toBe(2_000)
  })

  test('refuses a bridge from too few or unrelated frames', () => {
    expect(estimateAvClockBridge([], [1, 2, 3])).toBeNull()
    expect(estimateAvClockBridge([1_000_000], [0, 33_000, 66_000, 99_000, 132_000, 165_000])).toBeNull()
    const random = [5_123, 81_777, 190_010, 260_500, 399_999, 450_101]
    expect(estimateAvClockBridge(random.map((value) => value * 7), random)).toBeNull()
  })

  test('perfectly regular frames: causality picks the true lag, not an earlier one', () => {
    // 21 frames at exactly 50 ms; the <video> starts presenting 2 frames late.
    const offset = 5_000_000
    const captureTimes = Array.from({ length: 21 }, (_, index) => 1_000_000 + index * 50_000)
    const stamps = captureTimes.map((capture) => capture + offset)
    const presented = captureTimes.slice(2)
    // Each frame reaches the page 3 ms after capture.
    const deliveries = captureTimes.map((capture) => capture + 3_000)
    const bridge = estimateAvClockBridge(stamps, presented, deliveries)
    expect(bridge?.offsetUs).toBe(offset)
    // Without delivery times the same data is ambiguous and refused.
    expect(estimateAvClockBridge(stamps, presented)).toBeNull()
  })

  test('refuses when every dense pairing would mean delivery before capture', () => {
    const captureTimes = Array.from({ length: 10 }, (_, index) => index * 40_000 + 7_000 * (index % 3))
    const stamps = captureTimes.map((capture) => capture + 1_000_000)
    // Deliveries claim frames arrived 10 ms before their capture: impossible.
    const deliveries = captureTimes.map((capture) => capture - 10_000)
    expect(estimateAvClockBridge(stamps, captureTimes, deliveries)).toBeNull()
  })
})
