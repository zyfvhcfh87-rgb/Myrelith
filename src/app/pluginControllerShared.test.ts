import { describe, expect, test, vi } from 'vitest'
import {
  boundedDetail,
  linkedAbortSignal,
  returnOrCloseSession,
  throwCleanupFailures,
} from './pluginControllerShared'

describe('plugin controller shared helpers', () => {
  test('rethrows one cleanup failure unchanged and aggregates several', () => {
    const first = new Error('first')
    const second = new Error('second')
    expect(() => throwCleanupFailures([], 'cleanup failed')).not.toThrow()
    expect(() => throwCleanupFailures([first], 'cleanup failed')).toThrow(first)
    try {
      throwCleanupFailures([first, second], 'cleanup failed')
      expect.unreachable()
    } catch (cause) {
      expect(cause).toBeInstanceOf(AggregateError)
      expect((cause as AggregateError).message).toBe('cleanup failed')
      expect((cause as AggregateError).errors).toEqual([first, second])
    }
  })

  test('returns a current session and closes a stale one before rethrowing', async () => {
    const session = { close: vi.fn(async () => undefined) }
    await expect(returnOrCloseSession(session, () => {}, 'stale', 'both failed'))
      .resolves.toBe(session)
    expect(session.close).not.toHaveBeenCalled()

    const stale = new Error('stale')
    await expect(returnOrCloseSession(session, () => { throw stale }, 'stale', 'both failed'))
      .rejects.toBe(stale)
    expect(session.close).toHaveBeenCalledWith('stale')

    const closeFailure = new Error('close failed')
    session.close.mockRejectedValueOnce(closeFailure)
    const failure = await returnOrCloseSession(
      session,
      () => { throw stale },
      'stale',
      'both failed',
    ).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toBe('both failed')
    expect((failure as AggregateError).errors).toEqual([stale, closeFailure])
  })

  test('bounds public detail text to 512 characters', () => {
    expect(boundedDetail('short')).toBe('short')
    const bounded = boundedDetail('x'.repeat(600))
    expect(bounded).toHaveLength(512)
    expect(bounded.endsWith('…')).toBe(true)
  })

  test('links abort signals and detaches on dispose', () => {
    const first = new AbortController()
    const second = new AbortController()
    const linked = linkedAbortSignal([first.signal, undefined, second.signal])
    first.abort()
    expect(linked.signal.aborted).toBe(true)

    const detached = linkedAbortSignal([second.signal])
    detached.dispose()
    second.abort()
    expect(detached.signal.aborted).toBe(false)
    expect(linkedAbortSignal([first.signal]).signal.aborted).toBe(true)
  })
})
