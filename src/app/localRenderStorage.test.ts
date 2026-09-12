import { afterEach, describe, expect, test, vi } from 'vitest'
import { renderTransaction } from './localRenderStorage'

function database(raw: unknown = undefined) {
  const open: {
    result?: unknown
    onblocked?: () => void
    onsuccess?: () => void
  } = {}
  const get: { result: unknown; onsuccess?: () => void } = { result: raw }
  const put = vi.fn()
  const close = vi.fn()
  const transaction = {
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    error: null,
    objectStore: () => ({ get: () => get, put }),
    abort: vi.fn(() => transaction.onabort()),
  }
  const connection = {
    close,
    transaction: vi.fn(() => transaction),
    onversionchange: () => {},
  }
  vi.stubGlobal('indexedDB', { open: vi.fn(() => open) })
  return {
    open,
    get,
    put,
    close,
    transaction,
    connection,
    opened: () => {
      open.result = connection
      open.onsuccess!()
    },
    read: () => get.onsuccess!(),
    complete: () => transaction.oncomplete(),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('local render storage transaction lifecycle', () => {
  test('publishes a mutation only after transaction completion', async () => {
    const db = database()
    const pending = renderTransaction('jobs', (value) => value, (rows) => [
      ...rows,
      'job',
    ])
    let settled = false
    void pending.then(() => { settled = true })

    db.opened()
    db.read()
    expect(db.put).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(db.close).not.toHaveBeenCalled()

    db.complete()
    await expect(pending).resolves.toMatchObject({
      version: 1,
      revision: 1,
      records: ['job'],
    })
    expect(db.close).toHaveBeenCalledOnce()
  })

  test('rejects failed writes and closes the connection', async () => {
    const db = database()
    const pending = renderTransaction('jobs', (value) => value, (rows) => [
      ...rows,
      'job',
    ])
    db.opened()
    db.read()
    db.transaction.onabort()

    await expect(pending).rejects.toThrow(/transaction failed/i)
    expect(db.close).toHaveBeenCalledOnce()
  })

  test('does not use a blocked connection after rejecting the request', async () => {
    const db = database()
    const pending = renderTransaction('jobs', (value) => value)
    const rejected = expect(pending).rejects.toThrow(/blocking render storage/i)

    db.open.onblocked!()
    await rejected
    db.opened()
    expect(db.close).toHaveBeenCalledOnce()
    expect(db.connection.transaction).not.toHaveBeenCalled()
  })

  test('fails explicitly when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(renderTransaction('jobs', (value) => value))
      .rejects.toThrow(/unavailable/i)
  })
})
