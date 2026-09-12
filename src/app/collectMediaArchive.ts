/**
 * Authorized local-folder I/O for collect-media archives.
 *
 * Destination handles stay in this module. Zustand, project JSON, and UI never
 * receive a directory capability. Copies stream in bounded chunks.
 */

import {
  COLLECT_MEDIA_FOLDERS,
  COLLECT_MEDIA_INCOMPLETE_MARKER,
  COLLECT_MEDIA_INCOMPLETE_MARKER_TEXT,
  COLLECT_MEDIA_MANIFEST_FILE,
  CollectMediaError,
  assertCollectedRelativePath,
  collectArchiveDestinationKind,
  collectArchiveIsComplete,
  collectMediaPathSegments,
  parseCollectMediaManifest,
  serializeCollectMediaManifest,
  type CollectArchiveDestinationKind,
  type CollectMediaFolder,
  type CollectMediaManifest,
} from '../domain/collectMedia'

export const COLLECT_STREAM_CHUNK_BYTES = 1024 * 1024

export interface CollectMediaWritableStream {
  write(data: BufferSource | Blob | string): Promise<void>
  close(): Promise<void>
  abort?(reason?: unknown): Promise<void>
}

export interface CollectMediaFileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<CollectMediaWritableStream>
}

export interface CollectMediaDirectoryHandle {
  readonly kind: 'directory'
  readonly name: string
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<CollectMediaDirectoryHandle>
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<CollectMediaFileHandle>
  removeEntry(name: string): Promise<void>
  values?(): AsyncIterableIterator<CollectMediaFileHandle | CollectMediaDirectoryHandle>
  queryPermission?(
    descriptor: { mode: 'read' | 'readwrite' },
  ): Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?(
    descriptor: { mode: 'read' | 'readwrite' },
  ): Promise<'granted' | 'denied' | 'prompt'>
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
}

type CollectPickerWindow = Window & {
  isSecureContext?: boolean
  showDirectoryPicker?: (
    options?: DirectoryPickerOptions,
  ) => Promise<CollectMediaDirectoryHandle>
}

export type CollectMediaPickerAvailability =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string }

export interface LoadedCollectedArchive {
  readonly root: CollectMediaDirectoryHandle
  readonly manifest: CollectMediaManifest
  readonly complete: boolean
  readonly projectFile: File
  readonly projectHandle: CollectMediaFileHandle
}

export interface CollectDestinationInspection {
  readonly kind: CollectArchiveDestinationKind
  readonly names: readonly string[]
  readonly manifest: CollectMediaManifest | null
  readonly hasIncompleteMarker: boolean
}

const INSECURE_REASON =
  'Collect media requires a secure browser context (HTTPS or localhost).'
const UNSUPPORTED_REASON =
  'This browser cannot write a collect-media folder. Use a Chromium browser with folder access.'
const WRITE_DENIED_REASON = 'Write access to the chosen folder was not granted.'
const READ_DENIED_REASON = 'Access to the chosen folder was not granted.'

function pickerWindow(): CollectPickerWindow {
  return window as CollectPickerWindow
}

function namedError(cause: unknown, name: string): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && cause.name === name
}

export function isCollectMediaAbort(cause: unknown): boolean {
  return namedError(cause, 'AbortError')
}

export function isCollectMediaQuotaFailure(cause: unknown): boolean {
  return namedError(cause, 'QuotaExceededError')
}

export function isCollectMediaPermissionFailure(cause: unknown): boolean {
  return namedError(cause, 'NotAllowedError') || namedError(cause, 'SecurityError')
}

export function collectMediaAbortError(): DOMException {
  return new DOMException('The collect-media copy was cancelled', 'AbortError')
}

export function getCollectMediaPickerAvailability(
  host: CollectPickerWindow = pickerWindow(),
): CollectMediaPickerAvailability {
  if (host.isSecureContext !== true) {
    return { available: false, reason: INSECURE_REASON }
  }
  if (typeof host.showDirectoryPicker !== 'function') {
    return { available: false, reason: UNSUPPORTED_REASON }
  }
  return { available: true, reason: null }
}

async function requirePermission(
  handle: CollectMediaDirectoryHandle,
  mode: 'read' | 'readwrite',
  denied: string,
): Promise<void> {
  const current = await handle.queryPermission?.({ mode }) ?? 'granted'
  if (current === 'granted') return
  const next = await handle.requestPermission?.({ mode }) ?? current
  if (next !== 'granted') throw new CollectMediaError(denied)
}

export async function pickCollectMediaDestination(
  host: CollectPickerWindow = pickerWindow(),
): Promise<CollectMediaDirectoryHandle> {
  const availability = getCollectMediaPickerAvailability(host)
  if (!availability.available) throw new CollectMediaError(availability.reason)
  const picker = host.showDirectoryPicker
  if (!picker) throw new CollectMediaError(UNSUPPORTED_REASON)
  const directory = await picker.call(host, {
    id: 'myrelith-collect-media',
    mode: 'readwrite',
  })
  await requirePermission(directory, 'readwrite', WRITE_DENIED_REASON)
  return directory
}

export async function pickCollectedArchiveDirectory(
  host: CollectPickerWindow = pickerWindow(),
): Promise<CollectMediaDirectoryHandle> {
  const availability = getCollectMediaPickerAvailability(host)
  if (!availability.available) throw new CollectMediaError(availability.reason)
  const picker = host.showDirectoryPicker
  if (!picker) throw new CollectMediaError(UNSUPPORTED_REASON)
  const directory = await picker.call(host, {
    id: 'myrelith-collect-archive-open',
    mode: 'read',
  })
  await requirePermission(directory, 'read', READ_DENIED_REASON)
  return directory
}

export async function listDirectoryEntryNames(
  root: CollectMediaDirectoryHandle,
): Promise<string[]> {
  if (typeof root.values !== 'function') {
    throw new CollectMediaError('This folder cannot be listed')
  }
  const names: string[] = []
  for await (const entry of root.values()) {
    names.push(entry.name)
  }
  return names.sort((left, right) => left.localeCompare(right))
}

export async function readOptionalTextFile(
  root: CollectMediaDirectoryHandle,
  fileName: string,
): Promise<string | null> {
  try {
    const handle = await root.getFileHandle(fileName)
    return handle.getFile().then((file) => file.text())
  } catch (cause) {
    if (namedError(cause, 'NotFoundError')) return null
    throw cause
  }
}

export async function writeTextFile(
  root: CollectMediaDirectoryHandle,
  fileName: string,
  text: string,
): Promise<void> {
  const handle = await root.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable({ keepExistingData: false })
  try {
    await writable.write(text)
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

export async function removeFileIfPresent(
  root: CollectMediaDirectoryHandle,
  fileName: string,
): Promise<void> {
  try {
    await root.removeEntry(fileName)
  } catch (cause) {
    if (!namedError(cause, 'NotFoundError')) throw cause
  }
}

export async function inspectCollectDestination(
  root: CollectMediaDirectoryHandle,
): Promise<CollectDestinationInspection> {
  const names = await listDirectoryEntryNames(root)
  const markerText = await readOptionalTextFile(root, COLLECT_MEDIA_INCOMPLETE_MARKER)
  const hasIncompleteMarker = markerText !== null
  let manifest: CollectMediaManifest | null = null
  const serialized = await readOptionalTextFile(root, COLLECT_MEDIA_MANIFEST_FILE)
  if (serialized) {
    try {
      manifest = parseCollectMediaManifest(JSON.parse(serialized))
    } catch (cause) {
      if (hasIncompleteMarker) {
        manifest = null
      } else {
        throw cause
      }
    }
  }
  return {
    kind: collectArchiveDestinationKind(
      names,
      manifest?.status ?? null,
      hasIncompleteMarker,
    ),
    names,
    manifest,
    hasIncompleteMarker,
  }
}

export async function prepareCollectDestination(
  root: CollectMediaDirectoryHandle,
): Promise<CollectDestinationInspection> {
  const inspection = await inspectCollectDestination(root)
  if (inspection.kind === 'occupied' || inspection.kind === 'complete') {
    throw new CollectMediaError(
      'Choose an empty folder or a previous incomplete collect-media archive.',
    )
  }
  await writeTextFile(
    root,
    COLLECT_MEDIA_INCOMPLETE_MARKER,
    COLLECT_MEDIA_INCOMPLETE_MARKER_TEXT,
  )
  for (const folder of COLLECT_MEDIA_FOLDERS) {
    await root.getDirectoryHandle(folder, { create: true })
  }
  return inspection
}

export async function streamCopyBlob(
  blob: Blob,
  writable: CollectMediaWritableStream,
  signal: AbortSignal,
  onChunk?: (bytes: number) => void,
): Promise<void> {
  const stream = typeof blob.stream === 'function' ? blob.stream() : null
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    try {
      while (true) {
        if (signal.aborted) throw collectMediaAbortError()
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        await writable.write(value)
        onChunk?.(value.byteLength)
      }
    } finally {
      reader.releaseLock()
    }
    return
  }
  for (let offset = 0; offset < blob.size; offset += COLLECT_STREAM_CHUNK_BYTES) {
    if (signal.aborted) throw collectMediaAbortError()
    const chunk = blob.slice(
      offset,
      Math.min(blob.size, offset + COLLECT_STREAM_CHUNK_BYTES),
    )
    await writable.write(chunk)
    onChunk?.(chunk.size)
  }
}

export async function writeBlobAtRelativePath(
  root: CollectMediaDirectoryHandle,
  relativePath: string,
  blob: Blob,
  signal: AbortSignal,
  onChunk?: (bytes: number) => void,
): Promise<CollectMediaFileHandle> {
  const [folder, fileName] = collectMediaPathSegments(
    assertCollectedRelativePath(relativePath),
  )
  const directory = await root.getDirectoryHandle(folder as CollectMediaFolder, {
    create: true,
  })
  const handle = await directory.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable({ keepExistingData: false })
  try {
    await streamCopyBlob(blob, writable, signal, onChunk)
    if (signal.aborted) throw collectMediaAbortError()
    await writable.close()
  } catch (cause) {
    try {
      await writable.abort?.(cause)
    } catch {
      // Preserve the copy failure; the incomplete marker stays authoritative.
    }
    throw cause
  }
  const written = await handle.getFile()
  if (written.size !== blob.size) {
    throw new CollectMediaError(
      `Copied size for "${relativePath}" does not match the source`,
    )
  }
  return handle
}

export async function readFileAtRelativePath(
  root: CollectMediaDirectoryHandle,
  relativePath: string,
): Promise<{ file: File; handle: CollectMediaFileHandle }> {
  const [folder, fileName] = collectMediaPathSegments(
    assertCollectedRelativePath(relativePath),
  )
  const directory = await root.getDirectoryHandle(folder as CollectMediaFolder)
  const handle = await directory.getFileHandle(fileName)
  return { file: await handle.getFile(), handle }
}

export async function writeCollectManifest(
  root: CollectMediaDirectoryHandle,
  manifest: CollectMediaManifest,
): Promise<void> {
  await writeTextFile(root, COLLECT_MEDIA_MANIFEST_FILE, serializeCollectMediaManifest(manifest))
}

export async function finalizeCollectArchive(
  root: CollectMediaDirectoryHandle,
  manifest: CollectMediaManifest,
): Promise<boolean> {
  await writeCollectManifest(root, manifest)
  const complete = collectArchiveIsComplete(manifest, false)
  if (complete) await removeFileIfPresent(root, COLLECT_MEDIA_INCOMPLETE_MARKER)
  const marker = await readOptionalTextFile(root, COLLECT_MEDIA_INCOMPLETE_MARKER)
  return collectArchiveIsComplete(manifest, marker !== null)
}

export async function loadCollectedArchive(
  root: CollectMediaDirectoryHandle,
): Promise<LoadedCollectedArchive> {
  const inspection = await inspectCollectDestination(root)
  if (!inspection.manifest) {
    throw new CollectMediaError(
      `This folder is not a collect-media archive. Choose a folder that contains ${COLLECT_MEDIA_MANIFEST_FILE}.`,
    )
  }
  const complete = collectArchiveIsComplete(
    inspection.manifest,
    inspection.hasIncompleteMarker,
  )
  const projectHandle = await root.getFileHandle(inspection.manifest.projectFileName)
  const projectFile = await projectHandle.getFile()
  return {
    root,
    manifest: inspection.manifest,
    complete,
    projectFile,
    projectHandle,
  }
}

export async function loadCollectedArchiveFromPicker(
  host: CollectPickerWindow = pickerWindow(),
): Promise<LoadedCollectedArchive> {
  const root = await pickCollectedArchiveDirectory(host)
  return loadCollectedArchive(root)
}
