import { describe, expect, test } from 'vitest'
import { createSpeechResampler } from './speechAudio'
function resample(rate: number, planes: Float32Array[], block = 4096) {
  const resampler = createSpeechResampler(rate, planes.length, planes[0]!.length)
  for (let offset = 0; offset < planes[0]!.length; offset += block) resampler.push(planes.map(plane => plane.subarray(offset, offset + block)))
  return resampler.finish()
}
describe('bounded speech preparation', () => {
  test('48 kHz stereo uses the shared fold and preserves DC across irregular block boundaries', () => {
    const input = [new Float32Array(48_000).fill(0.6), new Float32Array(48_000).fill(-0.2)]
    const output = resample(48_000, input, 137)
    expect(output.length).toBe(16_000)
    expect(Math.max(...output) - Math.min(...output)).toBeLessThan(1e-6)
    expect(output[400]).toBeCloseTo(0.2, 6)
    expect(output).toEqual(resample(48_000, input))
  })
  test('streaming windowed sinc rejects high frequency aliasing while preserving speech-band tone', () => {
    const tone = (hz: number) => Float32Array.from({ length: 96_000 }, (_, i) => Math.sin(2 * Math.PI * hz * i / 96_000))
    const rms = (audio: Float32Array) => Math.sqrt(audio.subarray(100, -100).reduce((sum, x) => sum + x * x, 0) / (audio.length - 200))
    expect(rms(resample(96_000, [tone(1000)]))).toBeGreaterThan(0.65)
    expect(rms(resample(96_000, [tone(24000)]))).toBeLessThan(0.02)
  })
  test('16 kHz is exact and 8 kHz upsamples with the exact output count', () => {
    const source = Float32Array.from({ length: 16_000 }, (_, i) => Math.sin(i))
    expect(resample(16_000, [source])).toEqual(source)
    expect(resample(8_000, [new Float32Array(8000).fill(1)]).length).toBe(16000)
  })
  test('the largest output/native pair stays at 3.84 MB without retaining source-rate planes', () => {
    const builder = createSpeechResampler(96_000, 2, 96_000 * 30)
    expect(builder.outputBytes * 2).toBe(3_840_000)
    expect(builder.scratchBytes).toBeLessThan(2 * 1024 * 1024)
    expect(() => builder.finish()).toThrow('Incomplete')
    expect(() => builder.push([new Float32Array([NaN]), new Float32Array([0])])).toThrow('Non-finite')
  })
})

test('fractional 44.1 kHz source coverage never gains a native timestamp', () => {
  const count = 264599
  const output = resample(44100, [new Float32Array(count).fill(0.3)])
  expect(output.length).toBe(95999)
  expect(output.length * 44100).toBeLessThanOrEqual(count * 16000)
  expect(output.at(-1)).toBeCloseTo(0.3, 6)
})
