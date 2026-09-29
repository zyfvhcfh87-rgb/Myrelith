import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { holdAsyncLease } from './asyncLease'

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

describe('async lease lifetime', () => {
  test('releases an acquired lease on cleanup', async () => {
    const release = vi.fn(async () => {})
    const cleanup = holdAsyncLease(async () => release, '[test] runtime')
    await flush()
    expect(release).not.toHaveBeenCalled()
    cleanup()
    expect(release).toHaveBeenCalledOnce()
  })

  test('releases a lease that arrives after cleanup', async () => {
    let resolve!: (release: () => Promise<void>) => void
    const release = vi.fn(async () => {})
    const cleanup = holdAsyncLease(() => new Promise((r) => { resolve = r }), '[test] runtime')
    cleanup()
    resolve(release)
    await flush()
    expect(release).toHaveBeenCalledOnce()
  })

  test('logs acquisition and release failures instead of leaving unhandled rejections', async () => {
    const failedInit = holdAsyncLease(async () => { throw new Error('init') }, '[test] runtime')
    await flush()
    failedInit()
    expect(warn).toHaveBeenCalledWith('[test] runtime initialization failed:', expect.any(Error))

    const cleanup = holdAsyncLease(async () => async () => { throw new Error('dispose') }, '[test] runtime')
    await flush()
    cleanup()
    await flush()
    expect(warn).toHaveBeenCalledWith('[test] runtime cleanup failed:', expect.any(Error))

    let resolve!: (release: () => Promise<void>) => void
    const late = holdAsyncLease(() => new Promise((r) => { resolve = r }), '[test] late')
    late()
    resolve(async () => { throw new Error('late dispose') })
    await flush()
    expect(warn).toHaveBeenCalledWith('[test] late cleanup failed:', expect.any(Error))
  })
})
