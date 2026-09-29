import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  listDraftFiles,
  openSyncHandle,
  probeDraftSize,
  serveSerializedRequests,
} from './opfsDraftWorker'

const locked = () => new DOMException('locked', 'NoModificationAllowedError')

function fileEntry(name: string, open: () => Promise<unknown>) {
  return { kind: 'file', name, createSyncAccessHandle: open } as unknown as FileSystemFileHandle
}

function stubStorage(directory: unknown): void {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async (name: string, options: { create: boolean }) => {
          if (directory === null) throw new DOMException(name, 'NotFoundError')
          expect(options).toEqual({ create: false })
          return directory
        },
      }),
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OPFS draft worker helpers', () => {
  test('retries only a momentarily locked sync handle', async () => {
    const handle = { kind: 'sync' }
    let attempts = 0
    const retried = fileEntry('a.wav', async () => {
      attempts++
      if (attempts < 3) throw locked()
      return handle
    })
    await expect(openSyncHandle(retried)).resolves.toBe(handle)
    expect(attempts).toBe(3)

    const failure = new DOMException('gone', 'NotFoundError')
    let failedAttempts = 0
    const missing = fileEntry('b.wav', async () => {
      failedAttempts++
      throw failure
    })
    await expect(openSyncHandle(missing)).rejects.toBe(failure)
    expect(failedAttempts).toBe(1)
  })

  test('probes size through a closed momentary handle and tolerates only a held lock', async () => {
    const close = vi.fn()
    await expect(probeDraftSize(fileEntry('a.wav', async () => ({
      getSize: () => 42,
      close,
    })))).resolves.toBe(42)
    expect(close).toHaveBeenCalledOnce()

    await expect(probeDraftSize(fileEntry('b.wav', async () => {
      throw locked()
    }))).resolves.toBeNull()

    const failure = new DOMException('broken', 'InvalidStateError')
    await expect(probeDraftSize(fileEntry('c.wav', async () => {
      throw failure
    }))).rejects.toBe(failure)
  })

  test('lists matching draft files by id and treats a missing directory as empty', async () => {
    stubStorage(null)
    await expect(listDraftFiles('drafts', '.wav', async (id) => ({ id })))
      .resolves.toEqual([])

    const directory = {
      async *values() {
        yield fileEntry('b.wav', async () => undefined)
        yield fileEntry('a.checkpoint', async () => undefined)
        yield { kind: 'directory', name: 'nested.wav' }
        yield fileEntry('a.wav', async () => undefined)
      },
    }
    stubStorage(directory)
    const seen: unknown[] = []
    await expect(listDraftFiles('drafts', '.wav', async (id, entry, parent) => {
      seen.push(parent)
      return { id, fileName: entry.name }
    })).resolves.toEqual([
      { id: 'a', fileName: 'a.wav' },
      { id: 'b', fileName: 'b.wav' },
    ])
    expect(seen).toEqual([directory, directory])
  })

  test('answers requests one at a time with exactly one reply each', async () => {
    type Request = { readonly requestId: number; readonly value: string }
    const replies: unknown[] = []
    let releaseFirst: () => void = () => undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const started: number[] = []
    const onmessage = serveSerializedRequests<Request, string>(async (request) => {
      started.push(request.requestId)
      if (request.requestId === 1) await firstGate
      if (request.value === 'fail') throw new RangeError('bad request')
      return request.value
    }, (reply) => {
      if ('result' in reply && reply.result === 'uncloneable') {
        throw new TypeError('cannot clone')
      }
      replies.push(reply)
    })

    const deliver = (data: Request) => onmessage({ data } as MessageEvent<Request>)
    deliver({ requestId: 1, value: 'first' })
    deliver({ requestId: 2, value: 'fail' })
    deliver({ requestId: 3, value: 'uncloneable' })
    deliver({ requestId: 4, value: 'last' })
    await vi.waitFor(() => expect(started).toEqual([1]))

    releaseFirst()
    await vi.waitFor(() => expect(replies).toHaveLength(4))
    expect(started).toEqual([1, 2, 3, 4])
    expect(replies).toEqual([
      { requestId: 1, result: 'first' },
      { requestId: 2, error: { name: 'RangeError', message: 'bad request' } },
      { requestId: 3, error: { name: 'DataCloneError', message: 'cannot clone' } },
      { requestId: 4, result: 'last' },
    ])
  })
})
