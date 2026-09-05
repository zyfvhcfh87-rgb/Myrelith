import { describe, expect, test, vi } from 'vitest'
import { consumeAlignmentSample } from './audioAlignmentDecode'

const request = { inputSampleRate: 48_000, channels: 2, startSample: 48_000, binCount: 2000 }
function sample(patch = {}) {
  return { timestamp: 0.99, sampleRate: 48_000, numberOfChannels: 2, numberOfFrames: 8192,
    copyTo: vi.fn(), close: vi.fn(), ...patch }
}
describe('bounded decoded audio ownership', () => {
  test('keeps source origin, skips leading overlap and never copies more than 4096 frames', () => {
    const value = sample()
    const push = vi.fn()
    const result = consumeAlignmentSample(value, request, 48_000, null, push)
    expect(result).toEqual({ nextSample: 55_712, previousEnd: 55_712 })
    expect(push.mock.calls.map((call) => [call[0][0].length, call[1]])).toEqual([[4096, 48000], [3616, 52096]])
    expect(value.copyTo.mock.calls[0][1]).toMatchObject({ frameOffset: 480, frameCount: 4096, planeIndex: 0 })
    expect(value.close).toHaveBeenCalledOnce()
  })
  test.each([{ sampleRate: 44_100 }, { numberOfChannels: 3 }, { timestamp: NaN },
    { timestamp: 1.1 }, { timestamp: 1 + 0.4 / 48_000 }, { numberOfFrames: 96001 }, { numberOfFrames: 0 }])('rejects malformed decoded facts before copying: %j', (patch) => {
    const value = sample(patch)
    expect(() => consumeAlignmentSample(value, request, 48_000, null, vi.fn())).toThrow()
    expect(value.copyTo).not.toHaveBeenCalled()
    expect(value.close).toHaveBeenCalledOnce()
  })
  test('refuses discontinuity and always closes after a consumer failure', () => {
    const value = sample()
    expect(() => consumeAlignmentSample(value, request, 48_000, 47_521, vi.fn())).toThrow(/continuous/)
    const failing = sample()
    expect(() => consumeAlignmentSample(failing, request, 48_000, null, () => { throw new Error('consumer failed') })).toThrow('consumer failed')
    expect(failing.close).toHaveBeenCalledOnce()
  })
})
