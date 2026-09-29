// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { scanFragmentedMp4, scanMp4TopLevelBoxes, type Mp4ByteReader } from './fragmentedMp4Recovery'

function box(type: string, payload = 8): Uint8Array {
  const bytes = new Uint8Array(8 + payload)
  new DataView(bytes.buffer).setUint32(0, bytes.length)
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index)
  return bytes
}

function largeBox(type: string, payload = 8): Uint8Array {
  const bytes = new Uint8Array(16 + payload)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 1)
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index)
  view.setBigUint64(8, BigInt(bytes.length))
  return bytes
}

function file(...parts: Uint8Array[]): Mp4ByteReader {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { all.set(part, at); at += part.length }
  return { size: all.length, read: (start, length) => all.slice(start, start + length) }
}

describe('fragmented MP4 recovery scan', () => {
  test('keeps every complete fragment and drops a torn tail', () => {
    const complete = [box('ftyp'), box('moov', 40), box('moof', 20), box('mdat', 100), box('moof', 20), box('mdat', 90)]
    const torn = box('moof', 20).slice(0, 12)
    const reader = file(...complete, torn)
    const scan = scanFragmentedMp4(reader)
    const validBytes = complete.reduce((sum, part) => sum + part.length, 0)
    expect(scan).toMatchObject({ status: 'recoverable', fragments: 2, validBytes, discardedBytes: 12 })
  })

  test('a moof without its mdat is not a fragment; a torn mdat is cut', () => {
    const head = [box('ftyp'), box('moov', 40), box('moof', 20), box('mdat', 100)]
    const reader = file(...head, box('moof', 20), box('mdat', 500).slice(0, 200))
    const scan = scanFragmentedMp4(reader)
    expect(scan).toMatchObject({ status: 'recoverable', fragments: 1,
      validBytes: head.reduce((sum, part) => sum + part.length, 0) })
  })

  test('a finished file keeps its mfra index; 64-bit sizes are read', () => {
    const parts = [box('ftyp'), box('moov', 40), box('moof', 20), largeBox('mdat', 64), box('mfra', 16)]
    const scan = scanFragmentedMp4(file(...parts))
    expect(scan).toMatchObject({ status: 'recoverable', fragments: 1, discardedBytes: 0 })
  })

  test('without header, track header, or any fragment the capture is unrecoverable', () => {
    expect(scanFragmentedMp4(file(box('moov'), box('moof'), box('mdat')))).toMatchObject({ status: 'unrecoverable' })
    expect(scanFragmentedMp4(file(box('ftyp'), box('moof'), box('mdat')))).toMatchObject({ status: 'unrecoverable' })
    expect(scanFragmentedMp4(file(box('ftyp'), box('moov'), box('moof')))).toMatchObject({ status: 'unrecoverable' })
    expect(scanFragmentedMp4(file())).toMatchObject({ status: 'unrecoverable' })
  })

  test('garbage and zero/undersized box sizes stop the walk', () => {
    const garbage = new Uint8Array([0, 0, 0, 16, 0xff, 0xfe, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(scanMp4TopLevelBoxes(file(box('ftyp'), garbage)).tornAt).toBe(16)
    const zero = box('mdat'); new DataView(zero.buffer).setUint32(0, 0)
    expect(scanMp4TopLevelBoxes(file(box('ftyp'), zero)).tornAt).toBe(16)
    const tiny = box('mdat'); new DataView(tiny.buffer).setUint32(0, 4)
    expect(scanMp4TopLevelBoxes(file(box('ftyp'), tiny)).tornAt).toBe(16)
  })
})
