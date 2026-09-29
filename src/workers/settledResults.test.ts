import { describe, expect, test } from 'vitest'
import { rejectionReasons, throwIfRejected } from './settledResults'

describe('settled cleanup results', () => {
  test('collects every rejection reason in input order', async () => {
    const first = new Error('first')
    const second = new Error('second')
    const results = await Promise.allSettled([
      Promise.reject(first),
      Promise.resolve('closed'),
      Promise.reject(second),
    ])

    expect(rejectionReasons(results)).toEqual([first, second])
    let thrown: unknown
    try {
      throwIfRejected(results, 'Failed to close owners')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown).toMatchObject({
      message: 'Failed to close owners',
      errors: [first, second],
    })
  })

  test('does not throw when every owner settled cleanly', async () => {
    const results = await Promise.allSettled([Promise.resolve(), Promise.resolve(1)])
    expect(rejectionReasons(results)).toEqual([])
    expect(() => throwIfRejected(results, 'unused')).not.toThrow()
  })
})
