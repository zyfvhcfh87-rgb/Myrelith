import { describe, expect, test } from 'vitest'
import { createPcmS16WavBuffer, writePcmS16WavFrames } from './export-wav'

function encodeWhole(
  planes: readonly Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  const sampleCount = planes[0]!.length
  const buffer = createPcmS16WavBuffer(sampleCount, planes.length, sampleRate)
  writePcmS16WavFrames(new DataView(buffer), planes, 0, sampleCount)
  return buffer
}

describe('PCM WAV writer', () => {
  test('writes a canonical 48 kHz stereo header and interleaved s16 samples', () => {
    const left = new Float32Array([0, 1, -1])
    const right = new Float32Array([0.5, 0, -0.25])
    const buffer = encodeWhole([left, right], 48_000)
    const view = new DataView(buffer)
    expect(buffer.byteLength).toBe(44 + 3 * 2 * 2)
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF')
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 32767))
    expect(view.getInt16(48, true)).toBe(32767)
  })

  test('preserves a mono 96 kHz contract without inventing a second channel', () => {
    const buffer = encodeWhole([new Float32Array([0.25, 0.25])], 96_000)
    const view = new DataView(buffer)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(96_000)
    expect(buffer.byteLength).toBe(44 + 4)
  })

  test('block writes at frame offsets produce the same bytes as one whole write', () => {
    const left = Float32Array.from({ length: 11 }, (_, index) => Math.sin(index) * 1.2)
    const right = Float32Array.from({ length: 11 }, (_, index) => Math.cos(index) * 1.2)
    const whole = encodeWhole([left, right], 44_100)
    const blocked = createPcmS16WavBuffer(11, 2, 44_100)
    const view = new DataView(blocked)
    for (const [start, end] of [[0, 4], [4, 5], [5, 11]] as const) {
      writePcmS16WavFrames(
        view,
        [left.subarray(start, end), right.subarray(start, end)],
        start,
        end - start,
      )
    }
    expect(new Uint8Array(blocked)).toEqual(new Uint8Array(whole))
  })

  test('rejects mismatched planes and writes outside the allocation', () => {
    const view = new DataView(createPcmS16WavBuffer(2, 1, 48_000))
    const plane = new Float32Array(2)
    expect(() => writePcmS16WavFrames(view, [plane, plane], 0, 2)).toThrow(/channel count/)
    expect(() => writePcmS16WavFrames(view, [plane], 1, 2)).toThrow(/outside/)
    expect(() => writePcmS16WavFrames(view, [plane], -1, 1)).toThrow(/outside/)
    expect(() => createPcmS16WavBuffer(2, 3, 48_000)).toThrow(/mono or stereo/)
    expect(() => createPcmS16WavBuffer(-1, 2, 48_000)).toThrow(/sample count/)
    expect(() => createPcmS16WavBuffer(2, 2, 0)).toThrow(/sample rate/)
  })
})
