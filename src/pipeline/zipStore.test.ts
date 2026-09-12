import { describe, expect, test } from 'vitest'
import { crc32, unzipStore, zipStore } from './zipStore'

describe('ZIP STORE', () => {
  test('round-trips named payloads with matching CRC and deterministic bytes', () => {
    const first = zipStore([
      { name: 'frame_00000.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'notes.chapters.json', data: new TextEncoder().encode('{"ok":true}') },
    ])
    const second = zipStore([
      { name: 'frame_00000.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'notes.chapters.json', data: new TextEncoder().encode('{"ok":true}') },
    ])
    expect(first).toEqual(second)
    const entries = unzipStore(first)
    expect(entries.map((entry) => entry.name)).toEqual([
      'frame_00000.png',
      'notes.chapters.json',
    ])
    expect([...entries[0]!.data]).toEqual([1, 2, 3])
    expect(crc32(entries[1]!.data)).toBe(crc32(new TextEncoder().encode('{"ok":true}')))
  })

  test('rejects empty or absolute names instead of rewriting them', () => {
    expect(() => zipStore([{ name: '', data: new Uint8Array() }])).toThrow(/relative/)
    expect(() => zipStore([{ name: '/tmp/x', data: new Uint8Array() }])).toThrow(/relative/)
  })
})
