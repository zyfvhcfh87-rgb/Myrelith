import { describe, expect, test } from 'vitest'
import { encodePcmS16Wav, wavPcmByteLength } from './export-wav'

describe('PCM WAV writer', () => {
  test('writes a canonical 48 kHz stereo header and interleaved s16 samples', () => {
    const left = new Float32Array([0, 1, -1])
    const right = new Float32Array([0.5, 0, -0.25])
    const buffer = encodePcmS16Wav([left, right], 48_000)
    const view = new DataView(buffer)
    expect(buffer.byteLength).toBe(wavPcmByteLength(3, 'stereo'))
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF')
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 32767))
    expect(view.getInt16(48, true)).toBe(32767)
  })

  test('preserves a mono 96 kHz contract without inventing a second channel', () => {
    const buffer = encodePcmS16Wav([new Float32Array([0.25, 0.25])], 96_000)
    const view = new DataView(buffer)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(96_000)
    expect(buffer.byteLength).toBe(44 + 4)
  })
})
