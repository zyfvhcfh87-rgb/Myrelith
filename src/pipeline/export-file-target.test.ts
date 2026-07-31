import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { StreamTargetChunk, StreamTargetOptions } from 'mediabunny'

interface StreamTargetRecord {
  writable: WritableStream<StreamTargetChunk>
  options: StreamTargetOptions
}

const mb = vi.hoisted(() => ({
  targets: [] as StreamTargetRecord[],
  throwOnCreate: null as unknown,
}))

vi.mock('mediabunny', () => ({
  StreamTarget: class StreamTarget {
    constructor(
      writable: WritableStream<StreamTargetChunk>,
      options: StreamTargetOptions,
    ) {
      if (mb.throwOnCreate !== null) throw mb.throwOnCreate
      mb.targets.push({ writable, options })
    }
  },
}))

import {
  DIRECT_FILE_STREAM_CHUNK_SIZE,
  DirectFileAbortError,
  createDirectFileExportTarget,
  type PreparedExportFileCapability,
} from './export-file-target'

interface CapabilityHarness {
  capability: PreparedExportFileCapability
  takeFileHandle: ReturnType<typeof vi.fn>
  createWritable: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

function createCapability(): CapabilityHarness {
  const write = vi.fn(async (_chunk: StreamTargetChunk) => undefined)
  const close = vi.fn(async () => undefined)
  const abort = vi.fn(async (_reason?: unknown) => undefined)
  const writable = { write, close, abort } as unknown as FileSystemWritableFileStream
  const createWritable = vi.fn(async () => writable)
  const handle = { createWritable } as unknown as FileSystemFileHandle
  const takeFileHandle = vi.fn(() => handle)
  return {
    capability: { fileName: 'selected-video.mp4', takeFileHandle },
    takeFileHandle,
    createWritable,
    write,
    close,
    abort,
  }
}

function currentWriter(): WritableStreamDefaultWriter<StreamTargetChunk> {
  const record = mb.targets.at(-1)
  if (!record) throw new Error('Expected a StreamTarget')
  return record.writable.getWriter()
}

function writeChunk(position: number, bytes: number): StreamTargetChunk {
  return {
    type: 'write',
    position,
    data: new Uint8Array(bytes),
  }
}

function deferred(): {
  promise: Promise<void>
  resolve(): void
} {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve() {
      resolvePromise?.()
    },
  }
}

beforeEach(() => {
  mb.targets.length = 0
  mb.throwOnCreate = null
})

describe('createDirectFileExportTarget', () => {
  test('takes the picker capability once and configures explicit 1 MiB chunking', async () => {
    const h = createCapability()
    const adapter = await createDirectFileExportTarget(h.capability)

    expect(h.takeFileHandle).toHaveBeenCalledOnce()
    expect(h.createWritable).toHaveBeenCalledWith({ keepExistingData: false })
    expect(mb.targets).toHaveLength(1)
    expect(mb.targets[0]?.options).toEqual({
      chunked: true,
      chunkSize: DIRECT_FILE_STREAM_CHUNK_SIZE,
    })
    expect(DIRECT_FILE_STREAM_CHUNK_SIZE).toBe(1_048_576)
    expect(adapter.fileName).toBe('selected-video.mp4')

    await adapter.abort()
  })

  test('awaits positioned writes and propagates backpressure in order', async () => {
    const h = createCapability()
    const firstWrite = deferred()
    h.write.mockImplementationOnce(() => firstWrite.promise)
    const adapter = await createDirectFileExportTarget(h.capability)
    const writer = currentWriter()

    const first = writer.write(writeChunk(100, 20))
    const second = writer.write(writeChunk(0, 10))
    await Promise.resolve()

    expect(h.write).toHaveBeenCalledTimes(1)
    expect(adapter.byteLength).toBe(0)

    firstWrite.resolve()
    await first
    await second

    expect(h.write.mock.calls.map(([chunk]) => chunk.position)).toEqual([100, 0])
    expect(adapter.byteLength).toBe(120)

    await writer.close()
    await adapter.abort()
  })

  test('tracks the maximum written end instead of summing positioned writes', async () => {
    const h = createCapability()
    const adapter = await createDirectFileExportTarget(h.capability)
    const writer = currentWriter()

    await writer.write(writeChunk(100, 20))
    await writer.write(writeChunk(0, 10))
    await writer.write(writeChunk(105, 5))

    expect(adapter.byteLength).toBe(120)

    await writer.close()
    await adapter.abort()
  })

  test('keeps Mediabunny close non-committing and commits the native file once', async () => {
    const h = createCapability()
    const adapter = await createDirectFileExportTarget(h.capability)
    const writer = currentWriter()
    await writer.write(writeChunk(64, 32))

    await writer.close()
    expect(h.close).not.toHaveBeenCalled()
    expect(h.abort).not.toHaveBeenCalled()

    const first = await adapter.commit()
    const second = await adapter.commit()

    expect(h.close).toHaveBeenCalledOnce()
    expect(h.abort).not.toHaveBeenCalled()
    expect(second).toBe(first)
    expect(first).toEqual({
      destination: 'file',
      fileName: 'selected-video.mp4',
      byteLength: 96,
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.keys(first)).toEqual(['destination', 'fileName', 'byteLength'])
    expect(first).not.toHaveProperty('buffer')
    expect(first).not.toHaveProperty('handle')
    expect(first).not.toHaveProperty('writable')
    await expect(adapter.abort()).rejects.toThrow(/already committed/)
    expect(h.abort).not.toHaveBeenCalled()
  })

  test('requires the muxer target to close before committing', async () => {
    const h = createCapability()
    const adapter = await createDirectFileExportTarget(h.capability)

    await expect(adapter.commit()).rejects.toThrow(/before Mediabunny closes/)
    expect(h.close).not.toHaveBeenCalled()

    const writer = currentWriter()
    await writer.close()
    await adapter.commit()
    expect(h.close).toHaveBeenCalledOnce()
  })

  test('aborts cancellation once without committing', async () => {
    const h = createCapability()
    const adapter = await createDirectFileExportTarget(h.capability)
    const writer = currentWriter()
    await writer.close()

    const reason = new Error('user cancelled')
    await adapter.abort(reason)
    await adapter.abort(reason)

    expect(h.abort).toHaveBeenCalledOnce()
    expect(h.abort).toHaveBeenCalledWith(reason)
    expect(h.close).not.toHaveBeenCalled()
    await expect(adapter.commit()).rejects.toThrow(/cancelled or failed/)
  })

  test('aborts a failed native write once and preserves the write error', async () => {
    const h = createCapability()
    const writeFailure = new Error('disk full')
    h.write.mockRejectedValueOnce(writeFailure)
    const adapter = await createDirectFileExportTarget(h.capability)
    const writer = currentWriter()

    await expect(writer.write(writeChunk(0, 16))).rejects.toBe(writeFailure)
    expect(h.abort).toHaveBeenCalledOnce()
    expect(h.abort).toHaveBeenCalledWith(writeFailure)

    await adapter.abort(writeFailure)
    expect(h.abort).toHaveBeenCalledOnce()
  })

  test('aborts once when native commit fails and preserves the close error', async () => {
    const h = createCapability()
    const closeFailure = new Error('commit failed')
    h.close.mockRejectedValueOnce(closeFailure)
    const adapter = await createDirectFileExportTarget(h.capability)
    const writer = currentWriter()
    await writer.close()

    await expect(adapter.commit()).rejects.toBe(closeFailure)
    expect(h.close).toHaveBeenCalledOnce()
    expect(h.abort).toHaveBeenCalledOnce()
    expect(h.abort).toHaveBeenCalledWith(closeFailure)

    await adapter.abort(closeFailure)
    expect(h.abort).toHaveBeenCalledOnce()
  })

  test('reports a possibly incomplete selected file when abort also fails', async () => {
    const h = createCapability()
    const writeFailure = new Error('write failed')
    const abortFailure = new Error('abort failed')
    h.write.mockRejectedValueOnce(writeFailure)
    h.abort.mockRejectedValueOnce(abortFailure)
    const adapter = await createDirectFileExportTarget(h.capability)
    const writer = currentWriter()

    const failure = await writer.write(writeChunk(0, 16)).catch((cause) => cause)

    expect(failure).toBeInstanceOf(DirectFileAbortError)
    expect(failure).toMatchObject({
      message: expect.stringMatching(/selected file may be incomplete/),
      operationalCause: writeFailure,
      abortCause: abortFailure,
    })
    expect(h.abort).toHaveBeenCalledOnce()
    await expect(adapter.abort()).rejects.toBe(failure)
    expect(h.abort).toHaveBeenCalledOnce()
  })

  test('aborts an acquired writable if StreamTarget construction fails', async () => {
    const h = createCapability()
    const setupFailure = new Error('target failed')
    mb.throwOnCreate = setupFailure

    await expect(createDirectFileExportTarget(h.capability)).rejects.toBe(setupFailure)

    expect(h.abort).toHaveBeenCalledOnce()
    expect(h.abort).toHaveBeenCalledWith(setupFailure)
    expect(h.close).not.toHaveBeenCalled()
  })

  test('does not allow one prepared capability to create two targets', async () => {
    const h = createCapability()
    const adapter = await createDirectFileExportTarget(h.capability)

    await expect(createDirectFileExportTarget(h.capability)).rejects.toThrow(
      /already been consumed/,
    )
    expect(h.takeFileHandle).toHaveBeenCalledOnce()

    await adapter.abort()
  })
})
