import { describe, expect, test } from 'vitest'
import {
  hasExactKeys,
  isBoundedString,
  isPlainRecord,
  isRecord,
  isSha256Hex,
} from './guards'

/** The sort-and-compare form several parsers used before sharing hasExactKeys. */
function sortedKeysMatch(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index])
}

describe('shape guards', () => {
  test('isRecord accepts any non-array object; isPlainRecord only plain data', () => {
    class Custom {}
    const bare = Object.create(null) as Record<string, unknown>
    for (const value of [{}, bare, new Custom(), new Map()]) {
      expect(isRecord(value)).toBe(true)
    }
    for (const value of [null, undefined, [], 'text', 1, () => {}]) {
      expect(isRecord(value)).toBe(false)
      expect(isPlainRecord(value)).toBe(false)
    }
    expect(isPlainRecord({ a: 1 })).toBe(true)
    expect(isPlainRecord(bare)).toBe(true)
    expect(isPlainRecord(new Custom())).toBe(false)
    expect(isPlainRecord(new Map())).toBe(false)
  })

  test('hasExactKeys ignores order but not extra, missing or hidden keys', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['b', 'a'])).toBe(true)
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false)
    expect(hasExactKeys({}, [])).toBe(true)
    const hidden = Object.defineProperty({ a: 1 }, 'b', { value: 2, enumerable: false })
    expect(hasExactKeys(hidden, ['a', 'b'])).toBe(false)
  })

  test('hasExactKeys agrees with the sort-and-compare form, duplicates included', () => {
    const values: Record<string, unknown>[] = [
      {}, { a: 1 }, { b: 1 }, { a: 1, b: 2 }, { a: 1, c: 3 }, { a: 1, b: 2, c: 3 },
    ]
    const expectations: string[][] = [
      [], ['a'], ['b'], ['a', 'b'], ['b', 'a'], ['a', 'a'], ['a', 'b', 'b'], ['a', 'b', 'c'], ['c', 'a'],
    ]
    for (const value of values) {
      for (const expected of expectations) {
        expect(hasExactKeys(value, expected)).toBe(sortedKeysMatch(value, expected))
      }
    }
  })

  test('isBoundedString bounds UTF-16 length and rejects empty text unless allowed', () => {
    expect(isBoundedString('abc', 3)).toBe(true)
    expect(isBoundedString('abcd', 3)).toBe(false)
    expect(isBoundedString('', 3)).toBe(false)
    expect(isBoundedString('', 3, true)).toBe(true)
    expect(isBoundedString(3, 3)).toBe(false)
  })

  test('isSha256Hex accepts only 64 lowercase hex characters in a string', () => {
    const digest = 'a'.repeat(63) + '0'
    expect(isSha256Hex(digest)).toBe(true)
    expect(isSha256Hex(digest.toUpperCase())).toBe(false)
    expect(isSha256Hex(digest.slice(1))).toBe(false)
    expect(isSha256Hex(`${digest}0`)).toBe(false)
    expect(isSha256Hex([digest])).toBe(false)
  })
})
