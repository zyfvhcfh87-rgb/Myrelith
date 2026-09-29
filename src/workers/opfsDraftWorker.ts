/**
 * OPFS plumbing shared by the draft-owning capture and voiceover workers:
 * one directory of drafts, short-lived sync handles, and strictly serialized
 * request handling. Browser-worker only; imports nothing from pipeline/.
 */

type SyncAccessFileHandle<T> = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<T>
}

function isDomException(cause: unknown, name: string): boolean {
  return cause instanceof DOMException && cause.name === name
}

/** Open (or create) one named directory under the origin-private root. */
export async function opfsDirectory(
  name: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(name, { create })
}

export async function opfsFileExists(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(name)
    return true
  } catch (cause) {
    if (isDomException(cause, 'NotFoundError')) return false
    throw cause
  }
}

/**
 * A listing in another worker or tab probes each file with a momentary sync
 * handle; retry that short lock instead of failing a create or recovery.
 * A recording that really owns the file keeps it locked past this window.
 */
export async function openSyncHandle<T>(handle: FileSystemFileHandle): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await (handle as SyncAccessFileHandle<T>).createSyncAccessHandle()
    } catch (cause) {
      if (!isDomException(cause, 'NoModificationAllowedError') || attempt >= 8) throw cause
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/**
 * Metadata-only size probe through a momentary sync handle (no file read).
 * Chromium refuses a second sync access handle while one is open, so a
 * draft still being recorded reports `null` instead of failing the whole
 * listing. Other storage failures surface so they cannot make a draft look
 * like an ordinary orphan.
 */
export async function probeDraftSize(entry: FileSystemFileHandle): Promise<number | null> {
  try {
    const sync = await (entry as SyncAccessFileHandle<{
      getSize(): number
      close(): void
    }>).createSyncAccessHandle()
    try {
      return sync.getSize()
    } finally {
      sync.close()
    }
  } catch (cause) {
    if (isDomException(cause, 'NoModificationAllowedError')) return null
    throw cause
  }
}

/**
 * Describe every `suffix` file in one draft directory, sorted by id. A
 * missing directory means nothing was ever recorded in this browser.
 */
export async function listDraftFiles<T extends { readonly id: string }>(
  directoryName: string,
  suffix: string,
  describe: (
    id: string,
    entry: FileSystemFileHandle,
    directory: FileSystemDirectoryHandle,
  ) => Promise<T>,
): Promise<T[]> {
  let directory: FileSystemDirectoryHandle
  try {
    directory = await opfsDirectory(directoryName, false)
  } catch (cause) {
    if (isDomException(cause, 'NotFoundError')) return []
    throw cause
  }
  const drafts: T[] = []
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith(suffix)) continue
    const id = entry.name.slice(0, -suffix.length)
    drafts.push(await describe(id, entry as FileSystemFileHandle, directory))
  }
  return drafts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

type SerializedReply<Result> =
  | { requestId: number; result: Result }
  | { requestId: number; error: { name: string; message: string } }

/**
 * Handle requests strictly in arrival order so OPFS handles are never opened
 * concurrently. Every request gets exactly one reply: a failure becomes an
 * error reply, and a reply that cannot be cloned becomes a DataCloneError
 * reply so the bridge never waits forever.
 */
export function serveSerializedRequests<
  Request extends { readonly requestId: number },
  Result,
>(
  run: (request: Request) => Promise<Result>,
  post: (reply: SerializedReply<Result>) => void,
): (event: MessageEvent<Request>) => void {
  let tail: Promise<void> = Promise.resolve()
  return ({ data }) => {
    tail = tail.then(async () => {
      let reply: SerializedReply<Result>
      try {
        reply = { requestId: data.requestId, result: await run(data) }
      } catch (cause) {
        reply = { requestId: data.requestId, error: {
          name: cause instanceof Error ? cause.name : 'Error',
          message: cause instanceof Error ? cause.message : String(cause),
        } }
      }
      try {
        post(reply)
      } catch (cause) {
        post({ requestId: data.requestId, error: {
          name: 'DataCloneError',
          message: cause instanceof Error ? cause.message : String(cause),
        } })
      }
    }).catch(() => {
      // Keep serializing later requests even if a reply could not be posted.
    })
  }
}
