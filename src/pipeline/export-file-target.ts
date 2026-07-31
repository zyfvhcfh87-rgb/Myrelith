/**
 * One-shot direct-file target for Mediabunny export.
 *
 * The selected file handle is consumed only when this adapter is created.
 * Mediabunny writes through a proxy stream so closing its StreamTarget never
 * commits the native file. The caller explicitly commits after a successful
 * mux, or aborts after cancellation/failure.
 */

import { StreamTarget, type StreamTargetChunk } from 'mediabunny'
import { ExportCleanupIntegrityError } from './export'

export const DIRECT_FILE_STREAM_CHUNK_SIZE = 2 ** 20

/** Opaque, one-shot capability prepared synchronously by the picker facade. */
export interface PreparedExportFileCapability {
  readonly fileName: string
  takeFileHandle(): FileSystemFileHandle
}

/** Small terminal fact set; it deliberately contains no bytes or capability. */
export interface CommittedExportFile {
  readonly destination: 'file'
  readonly fileName: string
  readonly byteLength: number
}

export interface DirectFileExportTarget {
  readonly target: StreamTarget
  readonly fileName: string
  readonly byteLength: number
  commit(): Promise<Readonly<CommittedExportFile>>
  abort(reason?: unknown): Promise<void>
}

const ABORT_FAILURE_MESSAGE =
  'Could not discard the selected export file; the selected file may be incomplete.'

/**
 * Raised only when discarding a cancelled or failed direct-file export also
 * fails. Both the operational and abort causes remain available for logging.
 */
export class DirectFileAbortError extends ExportCleanupIntegrityError {
  readonly operationalCause: unknown
  readonly abortCause: unknown

  constructor(operationalCause: unknown, abortCause: unknown) {
    const cause = operationalCause === undefined
      ? abortCause
      : new AggregateError(
          [operationalCause, abortCause],
          'Direct-file export and cleanup both failed',
        )
    super(ABORT_FAILURE_MESSAGE, { cause })
    this.name = 'DirectFileAbortError'
    this.operationalCause = operationalCause
    this.abortCause = abortCause
  }
}

type TerminalState =
  | 'open'
  | 'committing'
  | 'committed'
  | 'aborting'
  | 'aborted'
  | 'abort-failed'

const consumedCapabilities = new WeakSet<object>()

function validateCapability(
  value: PreparedExportFileCapability,
): asserts value is PreparedExportFileCapability & object {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Direct-file export requires a prepared file capability')
  }
  if (typeof value.fileName !== 'string' || value.fileName.trim() === '') {
    throw new TypeError('Direct-file export requires a selected file name')
  }
  if (typeof value.takeFileHandle !== 'function') {
    throw new TypeError('Direct-file export requires a one-shot file handle')
  }
}

function chunkEnd(chunk: StreamTargetChunk): number {
  if (
    chunk.type !== 'write'
    || !(chunk.data instanceof Uint8Array)
    || !Number.isSafeInteger(chunk.position)
    || chunk.position < 0
  ) {
    throw new TypeError('Mediabunny produced an invalid positioned file write')
  }
  const end = chunk.position + chunk.data.byteLength
  if (!Number.isSafeInteger(end)) {
    throw new RangeError('Direct-file export exceeded the safe file-size range')
  }
  return end
}

async function abortAfterSetupFailure(
  writable: FileSystemWritableFileStream,
  operationalCause: unknown,
): Promise<never> {
  try {
    await writable.abort(operationalCause)
  } catch (abortCause) {
    throw new DirectFileAbortError(operationalCause, abortCause)
  }
  throw operationalCause
}

/**
 * Consume a picker capability and create the target used by Mediabunny.
 * Call this only after export preflight has succeeded.
 */
export async function createDirectFileExportTarget(
  capability: PreparedExportFileCapability,
): Promise<DirectFileExportTarget> {
  validateCapability(capability)
  if (consumedCapabilities.has(capability)) {
    throw new Error('The selected file capability has already been consumed')
  }
  consumedCapabilities.add(capability)
  const fileName = capability.fileName

  const fileHandle = capability.takeFileHandle()
  if (
    typeof fileHandle !== 'object'
    || fileHandle === null
    || typeof fileHandle.createWritable !== 'function'
  ) {
    throw new TypeError('The selected file capability returned an invalid handle')
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false })
  let byteLength = 0
  let muxerClosed = false
  let state: TerminalState = 'open'
  let abortPromise: Promise<void> | null = null
  let commitPromise: Promise<Readonly<CommittedExportFile>> | null = null

  const abortNativeOnce = (reason?: unknown): Promise<void> => {
    if (abortPromise !== null) return abortPromise

    state = 'aborting'
    abortPromise = (async () => {
      try {
        await writable.abort(reason)
        state = 'aborted'
      } catch (abortCause) {
        state = 'abort-failed'
        throw new DirectFileAbortError(reason, abortCause)
      }
    })()
    return abortPromise
  }

  let target: StreamTarget
  try {
    const proxy = new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        if (state !== 'open') {
          throw new Error('Cannot write after direct-file export cleanup has begun')
        }

        let end: number
        try {
          end = chunkEnd(chunk)
          // Awaiting this native positioned write propagates filesystem
          // backpressure through the proxy and back into Mediabunny.
          await writable.write(chunk)
        } catch (cause) {
          await abortNativeOnce(cause)
          throw cause
        }
        byteLength = Math.max(byteLength, end)
      },
      close: () => {
        // StreamTarget calls this during both finalize and cancel. It must never
        // commit the native stream; commit()/abort() below own that decision.
        muxerClosed = true
      },
      abort: async (reason) => {
        muxerClosed = true
        await abortNativeOnce(reason)
      },
    })
    target = new StreamTarget(proxy, {
      chunked: true,
      chunkSize: DIRECT_FILE_STREAM_CHUNK_SIZE,
    })
  } catch (cause) {
    return await abortAfterSetupFailure(writable, cause)
  }

  const adapter: DirectFileExportTarget = {
    target,
    fileName,
    get byteLength() {
      return byteLength
    },
    commit() {
      if (commitPromise !== null) return commitPromise
      if (abortPromise !== null || state !== 'open') {
        return Promise.reject(
          new Error('Cannot commit a cancelled or failed direct-file export'),
        )
      }
      if (!muxerClosed) {
        return Promise.reject(
          new Error('Cannot commit before Mediabunny closes the export target'),
        )
      }

      state = 'committing'
      const result: Readonly<CommittedExportFile> = Object.freeze({
        destination: 'file',
        fileName,
        byteLength,
      })
      commitPromise = (async () => {
        try {
          await writable.close()
          state = 'committed'
          return result
        } catch (cause) {
          await abortNativeOnce(cause)
          throw cause
        }
      })()
      return commitPromise
    },
    abort(reason) {
      if (state === 'committed') {
        return Promise.reject(
          new Error('Cannot abort an already committed direct-file export'),
        )
      }
      if (abortPromise !== null) return abortPromise
      if (commitPromise !== null) {
        return commitPromise.then(
          () => {
            throw new Error('Cannot abort an already committed direct-file export')
          },
          () => abortPromise ?? Promise.resolve(),
        )
      }
      return abortNativeOnce(reason)
    },
  }
  return adapter
}
