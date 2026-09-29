import { describe, expect, test } from 'vitest'
import { WINDOWS_RESERVED_FILE_NAME, windowsSafeFileStem } from './fileNames'

describe('Windows-safe file-name stems', () => {
  test('replaces invalid and control characters with dashes', () => {
    expect(windowsSafeFileStem('a<b>c:d"e/f\\g|h?i*j', 80)).toBe('a-b-c-d-e-f-g-h-i-j')
    expect(windowsSafeFileStem('tab\there\u001f', 80)).toBe('tab-here-')
  })

  test('caps by code point, then drops trailing dots and spaces', () => {
    const emoji = String.fromCodePoint(0x1f3ac)
    expect(Array.from(windowsSafeFileStem(emoji.repeat(90), 80))).toHaveLength(80)
    expect(windowsSafeFileStem(`${'a'.repeat(78)}. x`, 80)).toBe('a'.repeat(78))
    expect(windowsSafeFileStem('. .', 80)).toBe('')
  })

  test('prefixes device names, with or without an extension', () => {
    expect(windowsSafeFileStem('CON', 80)).toBe('myrelith-CON')
    expect(windowsSafeFileStem('com1.txt', 80)).toBe('myrelith-com1.txt')
    expect(windowsSafeFileStem('clock$', 80)).toBe('myrelith-clock$')
    expect(windowsSafeFileStem('console', 80)).toBe('console')
    expect(WINDOWS_RESERVED_FILE_NAME.test('LPT9.log')).toBe(true)
    expect(WINDOWS_RESERVED_FILE_NAME.test('lpt10')).toBe(false)
  })
})
