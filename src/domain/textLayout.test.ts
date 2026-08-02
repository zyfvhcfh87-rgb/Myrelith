import { describe, expect, test } from 'vitest'
import { wrapTextLines } from './textLayout'

const monospace = (value: string): number => Array.from(value).length * 10

describe('wrapTextLines', () => {
  test('preserves explicit blank lines and wraps words greedily', () => {
    expect(wrapTextLines('one two three\n\nfour', 75, 10, monospace)).toEqual([
      'one two',
      'three',
      '',
      'four',
    ])
  })

  test('splits overlong words by Unicode code point and obeys its line budget', () => {
    expect(wrapTextLines('abcdef 😀😀😀', 25, 3, monospace)).toEqual([
      'ab',
      'cd',
      'ef',
    ])
  })

  test('fails closed for unusable geometry', () => {
    expect(wrapTextLines('hello', 0, 3, monospace)).toEqual([])
    expect(wrapTextLines('hello', 100, 0, monospace)).toEqual([])
  })
})
