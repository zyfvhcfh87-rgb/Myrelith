/**
 * Small shared seams over the File System Access API. Handles stay with their
 * app-layer owners; these helpers only normalize read-permission checks and
 * the write → close / abort-on-failure contract.
 */

export type FileSystemReadPermission = 'granted' | 'denied' | 'prompt'

/** Structural subset of a handle whose read permission may be queried. */
export interface ReadPermissionHandle {
  queryPermission?: (descriptor?: { mode: 'read' }) => Promise<FileSystemReadPermission>
  requestPermission?: (descriptor?: { mode: 'read' }) => Promise<FileSystemReadPermission>
}

export interface WritableFileStreamLike {
  close(): Promise<void>
  abort?(reason?: unknown): Promise<void>
}

export interface WritableFileHandleLike<S extends WritableFileStreamLike> {
  createWritable(options?: { keepExistingData?: boolean }): Promise<S>
}

/** Browsers without the permission methods grant read access implicitly. */
export function queryReadPermission(
  handle: ReadPermissionHandle,
): Promise<FileSystemReadPermission> {
  return handle.queryPermission?.({ mode: 'read' })
    ?? Promise.resolve('granted')
}

export function requestReadPermission(
  handle: ReadPermissionHandle,
): Promise<FileSystemReadPermission> {
  return handle.requestPermission?.({ mode: 'read' })
    ?? Promise.resolve('granted')
}

/**
 * Replace a file's contents through one writable stream. The file changes only
 * when `close()` commits; any failure aborts the stream and stays primary.
 */
export async function withWritableFile<S extends WritableFileStreamLike>(
  handle: WritableFileHandleLike<S>,
  write: (writable: S) => Promise<void>,
): Promise<void> {
  const writable = await handle.createWritable({ keepExistingData: false })
  try {
    await write(writable)
    await writable.close()
  } catch (cause) {
    try {
      await writable.abort?.(cause)
    } catch {
      // Preserve the original write failure.
    }
    throw cause
  }
}

export function writeFileHandle<
  D,
  S extends WritableFileStreamLike & { write(data: D): Promise<void> },
>(handle: WritableFileHandleLike<S>, data: D): Promise<void> {
  return withWritableFile(handle, (writable) => writable.write(data))
}
