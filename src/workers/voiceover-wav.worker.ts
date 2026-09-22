import { VoiceoverWavDraft, type VoiceoverDraftStorage, type VoiceoverSyncFile } from '../pipeline/voiceoverWavDraft'
import type { VoiceoverWavReply, VoiceoverWavRequest, VoiceoverWavResult } from '../pipeline/voiceoverWavProtocol'

const DIRECTORY = 'myrelith-recordings-v1'
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<VoiceoverSyncFile> }

async function recordingDirectory(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(DIRECTORY, { create })
}

function names(id: string) {
  return { audio: `${id}.wav`, journal: `${id}.checkpoint` }
}

async function exists(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await directory.getFileHandle(name); return true }
  catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return false
    throw cause
  }
}

async function removeIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try { await directory.removeEntry(name) }
  catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause
  }
}

const storage: VoiceoverDraftStorage<FileSystemFileHandle> = {
  async open(id, create) {
    const directory = await recordingDirectory(create)
    const name = names(id)
    if (create && (await exists(directory, name.audio) || await exists(directory, name.journal))) {
      throw new Error('Recording draft already exists')
    }
    let audio: VoiceoverSyncFile | null = null
    let audioCreated = false
    let journalCreated = false
    try {
      const audioFile = await directory.getFileHandle(name.audio, { create })
      audioCreated = create
      const journalFile = await directory.getFileHandle(name.journal, { create })
      journalCreated = create
      audio = await (audioFile as SyncFileHandle).createSyncAccessHandle()
      const journal = await (journalFile as SyncFileHandle).createSyncAccessHandle()
      return { audio, journal }
    } catch (cause) {
      try { audio?.close() }
      catch (closeCause) { throw new AggregateError([cause, closeCause], 'Recording handle opening and close both failed') }
      if (create) {
        try {
          if (audioCreated) await removeIfPresent(directory, name.audio)
          if (journalCreated) await removeIfPresent(directory, name.journal)
        } catch (cleanupCause) {
          throw new AggregateError([cause, cleanupCause], 'Recording handle opening and cleanup both failed')
        }
      }
      throw cause
    }
  },
  async file(id) {
    const directory = await recordingDirectory(false)
    const handle = await directory.getFileHandle(names(id).audio)
    return { handle, file: await handle.getFile() }
  },
  async remove(id) {
    const directory = await recordingDirectory(false)
    const name = names(id)
    await removeIfPresent(directory, name.audio)
    await removeIfPresent(directory, name.journal)
  },
}

const draft = new VoiceoverWavDraft(storage)

async function run(request: VoiceoverWavRequest): Promise<VoiceoverWavResult> {
  switch (request.type) {
    case 'create': return { type: 'create', progress: await draft.create(request.id) }
    case 'append': return { type: 'append', progress: draft.append(new Uint8Array(request.buffer)) }
    case 'stop': return { type: 'stop', progress: draft.stop() }
    case 'release': return { type: 'release', progress: draft.release() }
    case 'recover': return { type: 'recover', progress: await draft.recover(request.id) }
    case 'finalize': return { type: 'finalize', ...await draft.finalize() }
    case 'discard': await draft.discard(); return { type: 'discard' }
  }
}

// OPFS opens and reads are asynchronous; serialize them with synchronous writes.
let tail: Promise<void> = Promise.resolve()
globalThis.onmessage = ({ data }: MessageEvent<VoiceoverWavRequest>) => {
  tail = tail.then(async () => {
    let reply: VoiceoverWavReply
    try { reply = { requestId: data.requestId, result: await run(data) } }
    catch (cause) {
      reply = { requestId: data.requestId, error: {
        name: cause instanceof Error ? cause.name : 'Error',
        message: cause instanceof Error ? cause.message : String(cause),
      } }
    }
    globalThis.postMessage(reply)
  })
}
