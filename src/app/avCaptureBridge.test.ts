import { describe, expect, test, vi } from 'vitest'
import { AvCaptureBridge } from './avCaptureBridge'

function fakeWorker() {
  const posted: { type: string; requestId: number }[] = []
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    onmessageerror: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn((message: { type: string; requestId: number }) => { posted.push(message) }),
    terminate: vi.fn(),
  }
  const reply = (data: unknown) => worker.onmessage?.({ data } as MessageEvent)
  return { worker, posted, reply }
}

describe('camera/screen capture bridge', () => {
  test('resolves each pending call with its own result type', async () => {
    const { worker, posted, reply } = fakeWorker()
    const bridge = new AvCaptureBridge(worker as unknown as Worker)
    const listing = bridge.list()
    reply({ requestId: posted[0]!.requestId, result: { type: 'list', drafts: [] } })
    await expect(listing).resolves.toEqual([])
    expect(bridge.isClosed).toBe(false)
  })

  test('an unreadable reply fails pending calls and reports a crash instead of hanging', async () => {
    const { worker } = fakeWorker()
    const bridge = new AvCaptureBridge(worker as unknown as Worker)
    const onCrash = vi.fn()
    bridge.onCrash = onCrash
    const stopping = bridge.stop()

    worker.onmessageerror?.({} as MessageEvent)

    await expect(stopping).rejects.toThrow('could not be read')
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(onCrash).toHaveBeenCalledOnce()
    expect(bridge.isClosed).toBe(true)
    await expect(bridge.list()).rejects.toThrow('closed')
  })

  test('a reply of the wrong result type is a protocol failure', async () => {
    const { worker, posted, reply } = fakeWorker()
    const bridge = new AvCaptureBridge(worker as unknown as Worker)
    const onCrash = vi.fn()
    bridge.onCrash = onCrash
    const file = bridge.file('capture-1')

    reply({ requestId: posted[0]!.requestId, result: { type: 'list', drafts: [] } })

    await expect(file).rejects.toThrow('wrong result')
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(onCrash).toHaveBeenCalledOnce()
  })

  test('close() fails pending calls without reporting a crash', async () => {
    const { worker } = fakeWorker()
    const bridge = new AvCaptureBridge(worker as unknown as Worker)
    const onCrash = vi.fn()
    bridge.onCrash = onCrash
    const listing = bridge.list()
    bridge.close()
    await expect(listing).rejects.toThrow('closed')
    expect(onCrash).not.toHaveBeenCalled()
  })
})
