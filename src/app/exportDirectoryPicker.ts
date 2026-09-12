/**
 * User-gesture directory picker for PNG image-sequence export.
 * The handle is a one-shot app-owned capability and never enters Zustand.
 */

export interface ExportDirectoryPickerHost {
  readonly isSecureContext?: boolean
  readonly showDirectoryPicker?: (options?: {
    readonly mode?: 'read' | 'readwrite'
  }) => Promise<FileSystemDirectoryHandle>
}

export type ExportDirectoryPickerAvailability =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string }

export interface ExportDirectoryDestinationCapability {
  readonly directoryName: string
  takeDirectoryHandle(): FileSystemDirectoryHandle
}

export type ExportDirectoryPickerResult =
  | {
      readonly status: 'selected'
      readonly destination: ExportDirectoryDestinationCapability
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'security-error'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string }

const INSECURE_CONTEXT_REASON =
  'Folder export requires a secure browser context (HTTPS or localhost).'
const UNSUPPORTED_BROWSER_REASON =
  'This browser cannot write an image sequence into a chosen folder.'
const SECURITY_ERROR_REASON =
  'The browser blocked the folder picker. Start export directly from this button in a secure top-level page.'

function browserHost(): ExportDirectoryPickerHost {
  return window as Window & ExportDirectoryPickerHost
}

function namedError(cause: unknown, name: string): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && cause.name === name
}

class OneShotExportDirectoryDestination implements ExportDirectoryDestinationCapability {
  readonly directoryName: string
  #handle: FileSystemDirectoryHandle | null

  constructor(handle: FileSystemDirectoryHandle) {
    this.directoryName = handle.name
    this.#handle = handle
  }

  takeDirectoryHandle(): FileSystemDirectoryHandle {
    const handle = this.#handle
    if (!handle) throw new Error('Export folder destination has already been consumed')
    this.#handle = null
    return handle
  }
}

export function getExportDirectoryPickerAvailability(
  host: ExportDirectoryPickerHost = browserHost(),
): ExportDirectoryPickerAvailability {
  if (host.isSecureContext !== true) {
    return { available: false, reason: INSECURE_CONTEXT_REASON }
  }
  if (typeof host.showDirectoryPicker !== 'function') {
    return { available: false, reason: UNSUPPORTED_BROWSER_REASON }
  }
  return { available: true, reason: null }
}

export async function requestExportDirectoryDestination(
  host: ExportDirectoryPickerHost = browserHost(),
): Promise<ExportDirectoryPickerResult> {
  const availability = getExportDirectoryPickerAvailability(host)
  if (!availability.available) {
    return { status: 'unavailable', reason: availability.reason }
  }
  const picker = host.showDirectoryPicker
  if (typeof picker !== 'function') {
    return { status: 'unavailable', reason: UNSUPPORTED_BROWSER_REASON }
  }
  try {
    const handle = await picker({ mode: 'readwrite' })
    return {
      status: 'selected',
      destination: new OneShotExportDirectoryDestination(handle),
    }
  } catch (cause) {
    if (namedError(cause, 'AbortError')) return { status: 'cancelled' }
    if (namedError(cause, 'SecurityError')) {
      return { status: 'security-error', reason: SECURITY_ERROR_REASON }
    }
    throw cause
  }
}

export function directoryWriterFromHandle(handle: FileSystemDirectoryHandle): {
  readonly directoryName: string
  exists(name: string): Promise<boolean>
  write(name: string, bytes: Uint8Array): Promise<void>
} {
  return {
    directoryName: handle.name,
    async exists(name) {
      try {
        await handle.getFileHandle(name)
        return true
      } catch (cause) {
        if (namedError(cause, 'NotFoundError')) return false
        throw cause
      }
    },
    async write(name, bytes) {
      const file = await handle.getFileHandle(name, { create: true })
      const writable = await file.createWritable({ keepExistingData: false })
      try {
        await writable.write(bytes.slice())
        await writable.close()
      } catch (cause) {
        try {
          await writable.abort()
        } catch {
          // Write failure remains primary.
        }
        throw cause
      }
    },
  }
}
