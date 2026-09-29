import { describe, expect, test } from 'vitest'
import { bytesToHex } from './bytes'

describe('bytesToHex', () => {
  test('pads every byte to two lowercase digits', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe('00010f10abff')
    expect(bytesToHex(new Uint8Array())).toBe('')
  })

  test('reads an ArrayBuffer whole and a view only within its window', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    expect(bytesToHex(bytes.buffer)).toBe('deadbeef')
    expect(bytesToHex(bytes.subarray(1, 3))).toBe('adbe')
  })
})
