import { describe, expect, test } from 'vitest'
import {
  abortError,
  errorMessage,
  hasErrorName,
  MAX_RUNTIME_FAILURE_DETAIL_CHARACTERS,
  runtimeFailureDetail,
  throwIfAborted,
  truncateText,
} from './errors'

describe('error helpers', () => {
  test('errorMessage reads Error messages and stringifies anything else', () => {
    expect(errorMessage(new TypeError('bad input'))).toBe('bad input')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage({ message: 'not an Error' })).toBe('[object Object]')
  })

  test('runtimeFailureDetail cuts at the diagnostic bound without an ellipsis', () => {
    const long = 'x'.repeat(MAX_RUNTIME_FAILURE_DETAIL_CHARACTERS + 10)
    expect(runtimeFailureDetail(new Error(long))).toBe(
      'x'.repeat(MAX_RUNTIME_FAILURE_DETAIL_CHARACTERS),
    )
    expect(runtimeFailureDetail('short')).toBe('short')
  })

  test('truncateText keeps text at the limit and marks a cut with an ellipsis', () => {
    expect(truncateText('abcd', 4)).toBe('abcd')
    expect(truncateText('abcde', 4)).toBe('abc…')
    expect(truncateText('abcde', 4)).toHaveLength(4)
  })

  test('abortError and throwIfAborted create a fresh AbortError every time', () => {
    const first = abortError('Stopped')
    expect(first).toBeInstanceOf(Error)
    expect(first.name).toBe('AbortError')
    expect(first.message).toBe('Stopped')
    expect(abortError('Stopped')).not.toBe(first)

    expect(() => throwIfAborted(undefined, 'Stopped')).not.toThrow()
    const controller = new AbortController()
    expect(() => throwIfAborted(controller.signal, 'Stopped')).not.toThrow()
    const reason = new Error('caller reason')
    controller.abort(reason)
    let thrown: unknown
    try {
      throwIfAborted(controller.signal, 'Stopped')
    } catch (cause) {
      thrown = cause
    }
    expect(thrown).not.toBe(reason)
    expect(thrown).toMatchObject({ name: 'AbortError', message: 'Stopped' })
  })

  test('hasErrorName matches any listed name on error-shaped values only', () => {
    const quota = new DOMException('full', 'QuotaExceededError')
    expect(hasErrorName(quota, 'QuotaExceededError')).toBe(true)
    expect(hasErrorName(quota, 'AbortError', 'QuotaExceededError')).toBe(true)
    expect(hasErrorName(quota, 'AbortError')).toBe(false)
    expect(hasErrorName({ name: 'SecurityError' }, 'SecurityError')).toBe(true)
    expect(hasErrorName('SecurityError', 'SecurityError')).toBe(false)
    expect(hasErrorName(null, 'AbortError')).toBe(false)
    expect(hasErrorName(abortError('x'), 'AbortError')).toBe(true)
  })
})
