import { VOICEOVER_RECORDINGS_DIRECTORY, VoiceoverWavDraft, type VoiceoverDraftInfo, type VoiceoverDraftStorage, type VoiceoverSyncFile } from '../pipeline/voiceoverWavDraft'

import type { VoiceoverWavReply, VoiceoverWavRequest, VoiceoverWavResult } from '../pipeline/voiceoverWavProtocol'
import {
  listDraftFiles,
  opfsDirectory,
  opfsFileExists as exists,
  openSyncHandle,
  probeDraftSize,
  serveSerializedRequests,
} from './opfsDraftWorker'

const DIRECTORY = VOICEOVER_RECORDINGS_DIRECTORY

const recordingDirectory = (create: boolean) => opfsDirectory(DIRECTORY, create)

function names(id: string) {
  return { audio: `${id}.wav`, journal: `${id}.checkpoint` }
}

async function removeIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try { await directory.removeEntry(name) }
  catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause
  }
}

/**
 * Metadata-only directory read: sizes come from momentary sync handles (no
 * whole-take buffer, no file read), and a take still being recorded reports
 * a `null` size.
 */
function listDrafts(): Promise<VoiceoverDraftInfo[]> {
  return listDraftFiles<VoiceoverDraftInfo>(DIRECTORY, '.wav', async (id, entry, directory) => ({
    id,
    sizeBytes: await probeDraftSize(entry),
    hasJournal: await exists(directory, `${id}.checkpoint`),
  }))
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
      audio = await openSyncHandle<VoiceoverSyncFile>(audioFile)
      const journal = await openSyncHandle<VoiceoverSyncFile>(journalFile)
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
    let directory: FileSystemDirectoryHandle
    try { directory = await recordingDirectory(false) }
    catch (cause) {
      // Nothing was ever written, so there is nothing to remove.
      if (cause instanceof DOMException && cause.name === 'NotFoundError') return
      throw cause
    }
    const name = names(id)
    await removeIfPresent(directory, name.audio)
    await removeIfPresent(directory, name.journal)
  },
  list: () => listDrafts(),
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
    case 'discard-id': await draft.discardStored(request.id); return { type: 'discard-id' }
    case 'list': return { type: 'list', drafts: await draft.list() }
  }
}

// OPFS opens and reads are asynchronous; serialize them with synchronous
// writes. A FileSystemFileHandle clones (it never transfers through
// postMessage); the File clones the same way, so no transfer list is needed.
globalThis.onmessage = serveSerializedRequests<VoiceoverWavRequest, VoiceoverWavResult>(
  run,
  (reply: VoiceoverWavReply) => globalThis.postMessage(reply),
)
