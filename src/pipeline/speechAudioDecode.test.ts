import { expect, test, vi } from 'vitest'
import { consumeSpeechSample } from './speechAudioDecode'
test('sample copying stays bounded and closes after the last copied plane', () => {
  const copyTo = vi.fn((target: Float32Array) => target.fill(0.25)), close = vi.fn()
  const push = vi.fn()
  const next = consumeSpeechSample({ timestamp: 0, sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 48000, copyTo, close }, 48000, 2, 0, 48000, null, push)
  expect(next.cursor).toBe(48000); expect(close).toHaveBeenCalledOnce()
  expect(copyTo.mock.calls.every(([plane]) => plane.length <= 4096)).toBe(true)
  expect(push).toHaveBeenCalledTimes(12)
})
test('malformed timestamps, oversized native blocks and consumer cancellation close samples', () => {
  for (const timestamp of [1, Number.NaN]) {
    const close = vi.fn(), copyTo = vi.fn()
    expect(() => consumeSpeechSample({ timestamp, sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 480, copyTo, close }, 48000, 2, 0, 480, null, () => {})).toThrow()
    expect(close).toHaveBeenCalledOnce(); expect(copyTo).not.toHaveBeenCalled()
  }
  const close = vi.fn()
  expect(() => consumeSpeechSample({ timestamp: 0, sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 480, copyTo: vi.fn(), close }, 48000, 2, 0, 480, null, () => { throw new Error('cancelled') })).toThrow('cancelled')
  expect(close).toHaveBeenCalledOnce()
})
