/**
 * Camera/screen capture worker (Issue #209). Owns the transferred processor
 * streams, the Mediabunny recorder, and one synchronous OPFS file in the
 * captures directory. The page owns and stops the tracks. Serializes requests.
 */
import { AvCaptureRecorder, chooseAvEncoding, type AvSyncFile } from '../pipeline/avCaptureRecorder'
import {
  AV_CAPTURE_DIRECTORY,
  type AvCaptureRequest,
  type AvCaptureResult,
  type AvCaptureWorkerMessage,
  type AvClockSample,
} from '../pipeline/avCaptureProtocol'
import { scanFragmentedMp4 } from '../pipeline/fragmentedMp4Recovery'
import type { VoiceoverDraftInfo } from '../domain/voiceoverDrafts'

type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<AvSyncFile & {
  read(bytes: Uint8Array, options: { at: number }): number
}> }

const post = (message: AvCaptureWorkerMessage) => globalThis.postMessage(message)

function validId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new RangeError('Invalid capture id')
}

async function directory(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(AV_CAPTURE_DIRECTORY, { create })
}

async function openSync(handle: FileSystemFileHandle) {
  for (let attempt = 0; ; attempt++) {
    try { return await (handle as SyncFileHandle).createSyncAccessHandle() }
    catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'NoModificationAllowedError') || attempt >= 8) throw cause
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** Optional pass-through tap recording capture-clock facts for evidence runs. */
function tap<T extends { timestamp: number; close(): void }>(
  stream: ReadableStream<T>,
  frames: (chunk: T) => number,
): { readable: ReadableStream<T>; summary(): AvClockSample } {
  const offsets: number[] = []
  let first: number | null = null
  let last: number | null = null
  let total = 0
  const readable = stream.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      const nowUs = Math.round((performance.timeOrigin + performance.now()) * 1000)
      if (offsets.length < 20_000) offsets.push(nowUs - chunk.timestamp)
      first ??= chunk.timestamp
      last = chunk.timestamp
      total += frames(chunk)
      controller.enqueue(chunk)
    },
  }))
  return {
    readable,
    summary() {
      const sorted = [...offsets].sort((a, b) => a - b)
      return { count: offsets.length, offsetMedianUs: sorted[Math.floor(sorted.length / 2)] ?? 0,
        offsetMinUs: sorted[0] ?? 0, offsetMaxUs: sorted.at(-1) ?? 0,
        firstTimestampUs: first, lastTimestampUs: last, frames: total }
    },
  }
}

interface Session {
  id: string
  recorder: AvCaptureRecorder
  file: AvSyncFile
  taps: { video: ReturnType<typeof tap>; audio: ReturnType<typeof tap> | null } | null
}

let session: Session | null = null

function release(active: Session): void {
  try { active.file.close() } catch { /* closed */ }
  if (session === active) session = null
}

async function start(request: Extract<AvCaptureRequest, { type: 'start' }>): Promise<AvCaptureResult> {
  validId(request.id)
  if (session) throw new Error('A capture is already recording')
  let file: AvSyncFile | null = null
  const cancelStreams = () => { void request.video.cancel().catch(() => {}); void request.audio?.cancel().catch(() => {}) }
  try {
    const { width, height } = request.videoSettings
    const encoding = await chooseAvEncoding(width, height, request.audioSettings)
    if (!encoding) throw new Error('This browser cannot encode camera or screen video')
    const dir = await directory(true)
    const name = `${request.id}.mp4`
    try { await dir.getFileHandle(name); throw new Error('Capture draft already exists') }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause }
    file = await openSync(await dir.getFileHandle(name, { create: true }))
    let video: ReadableStream<VideoFrame> = request.video
    let audio: ReadableStream<AudioData> | null = request.audio && encoding.audio ? request.audio : null
    if (request.audio && !audio) void request.audio.cancel().catch(() => {})
    let taps: Session['taps'] = null
    if (request.diagnostics) {
      const videoTap = tap(video, () => 1)
      const audioTap = audio ? tap(audio, (data) => data.numberOfFrames) : null
      video = videoTap.readable
      audio = audioTap?.readable ?? null
      taps = { video: videoTap, audio: audioTap }
    }
    if (!Number.isSafeInteger(request.videoClockOffsetUs)) throw new RangeError('Invalid video clock offset')
    const recorder = new AvCaptureRecorder({ video, audio, file, encoding, videoClockOffsetUs: request.videoClockOffsetUs,
      onProgress: (progress) => post({ type: 'progress', progress }),
      onSelfStop: (reason) => post({ type: 'self-stop', reason }) })
    session = { id: request.id, recorder, file, taps }
    await recorder.start()
    return { type: 'start', encoding, width, height }
  } catch (cause) {
    cancelStreams()
    try { file?.close() } catch { /* closed */ }
    session = null
    throw cause
  }
}

async function run(request: AvCaptureRequest): Promise<AvCaptureResult> {
  switch (request.type) {
    case 'start': return start(request)
    case 'stop': {
      const active = session
      if (!active) throw new Error('No capture is recording')
      const clock = () => active.taps ? { video: active.taps.video.summary(),
        audio: active.taps.audio?.summary() ?? active.taps.video.summary() } : undefined
      try {
        const result = await active.recorder.stop()
        const taps = clock()
        return { type: 'stop', result, ...(taps ? { clock: taps } : {}) }
      } catch (cause) {
        // Evidence runs still need the clock facts of a failed take.
        const taps = clock()
        if (taps) post({ type: 'diagnostic-clock', clock: taps, progress: active.recorder.progress })
        throw cause
      } finally { release(active) }
    }
    case 'abort': {
      const active = session
      if (active) { try { await active.recorder.abort() } finally { release(active) } }
      return { type: 'abort' }
    }
    case 'recover': {
      validId(request.id)
      if (session?.id === request.id) throw new Error('The capture is still recording')
      const handle = await (await directory(false)).getFileHandle(`${request.id}.mp4`)
      const sync = await openSync(handle)
      try {
        const size = sync.getSize()
        const scan = scanFragmentedMp4({ size, read: (at, length) => {
          const bytes = new Uint8Array(Math.max(0, Math.min(length, size - at)))
          const read = sync.read(bytes, { at })
          return bytes.subarray(0, read)
        } })
        if (scan.status !== 'recoverable') throw new Error(scan.reason)
        if (scan.validBytes < size) { sync.truncate(scan.validBytes); sync.flush() }
        return { type: 'recover', validBytes: scan.validBytes, fragments: scan.fragments, discardedBytes: scan.discardedBytes }
      } finally { sync.close() }
    }
    case 'file': {
      validId(request.id)
      const handle = await (await directory(false)).getFileHandle(`${request.id}.mp4`)
      return { type: 'file', file: await handle.getFile(), handle }
    }
    case 'discard-id': {
      validId(request.id)
      if (session?.id === request.id) throw new Error('Stop the capture before discarding it')
      try { await (await directory(false)).removeEntry(`${request.id}.mp4`) }
      catch (cause) { if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause }
      return { type: 'discard-id' }
    }
    case 'list': {
      let dir: FileSystemDirectoryHandle
      try { dir = await directory(false) }
      catch (cause) {
        if (cause instanceof DOMException && cause.name === 'NotFoundError') return { type: 'list', drafts: [] }
        throw cause
      }
      const drafts: VoiceoverDraftInfo[] = []
      for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.mp4')) continue
        const id = entry.name.slice(0, -'.mp4'.length)
        let sizeBytes: number | null
        if (session?.id === id) sizeBytes = null
        else {
          try {
            const sync = await (entry as SyncFileHandle).createSyncAccessHandle()
            try { sizeBytes = sync.getSize() } finally { sync.close() }
          } catch (cause) {
            if (cause instanceof DOMException && cause.name === 'NoModificationAllowedError') sizeBytes = null
            else throw cause
          }
        }
        drafts.push({ id, sizeBytes, hasJournal: true, fileName: entry.name })
      }
      return { type: 'list', drafts: drafts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
    }
  }
}

// Stop/abort must not wait behind a long-running start, but every other
// request is serialized so OPFS handles are never opened concurrently.
let tail: Promise<void> = Promise.resolve()
globalThis.onmessage = ({ data }: MessageEvent<AvCaptureRequest>) => {
  const execute = async () => {
    let reply: AvCaptureWorkerMessage
    try { reply = { requestId: data.requestId, result: await run(data) } }
    catch (cause) {
      reply = { requestId: data.requestId, error: {
        name: cause instanceof Error ? cause.name : 'Error',
        message: cause instanceof Error ? cause.message : String(cause) } }
    }
    try { post(reply) }
    catch (cause) {
      post({ requestId: data.requestId, error: { name: 'DataCloneError',
        message: cause instanceof Error ? cause.message : String(cause) } })
    }
  }
  tail = tail.then(execute).catch(() => {})
}
