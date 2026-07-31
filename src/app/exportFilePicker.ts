/**
 * User-gesture boundary for direct-to-file export.
 *
 * The selected file handle is an opaque, one-shot session capability. It
 * stays in app-layer control and must never enter Zustand or project JSON.
 */

import {
  validateExportProfile,
  type ExportProfile,
} from '../domain/exportProfile'

export interface ExportSaveFilePickerOptions {
  readonly suggestedName: string
  readonly excludeAcceptAllOption: true
  readonly types: readonly [{
    readonly description: string
    readonly accept: Readonly<Record<string, readonly [string]>>
  }]
}

export type ExportSaveFilePicker = (
  options: ExportSaveFilePickerOptions,
) => Promise<FileSystemFileHandle>

/** Small browser seam so availability and picker outcomes stay unit-testable. */
export interface ExportFilePickerHost {
  readonly isSecureContext?: boolean
  readonly showSaveFilePicker?: ExportSaveFilePicker
}

export type ExportFilePickerAvailability =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string }

export interface ExportFileDestinationCapability {
  /** The actual name chosen by the user, which may differ from the suggestion. */
  readonly fileName: string
  /** Transfer native-handle ownership exactly once to the export controller. */
  takeFileHandle(): FileSystemFileHandle
}

export type ExportFilePickerResult =
  | {
      readonly status: 'selected'
      readonly destination: ExportFileDestinationCapability
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'security-error'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string }

const INSECURE_CONTEXT_REASON =
  'Direct file export requires a secure browser context (HTTPS or localhost).'
const UNSUPPORTED_BROWSER_REASON =
  'This browser cannot write an export directly to a chosen file.'
const SECURITY_ERROR_REASON =
  'The browser blocked the file picker. Start export directly from this button in a secure top-level page.'

function browserHost(): ExportFilePickerHost {
  return window as Window & ExportFilePickerHost
}

function namedError(cause: unknown, name: string): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && cause.name === name
}

class OneShotExportFileDestination implements ExportFileDestinationCapability {
  readonly #fileName: string
  #handle: FileSystemFileHandle | null

  constructor(handle: FileSystemFileHandle) {
    this.#fileName = handle.name
    this.#handle = handle
  }

  get fileName(): string {
    return this.#fileName
  }

  takeFileHandle(): FileSystemFileHandle {
    const handle = this.#handle
    if (!handle) {
      throw new Error('Export file destination has already been consumed')
    }
    this.#handle = null
    return handle
  }
}

/** Feature detection only: no browser-name or user-agent policy. */
export function getExportFilePickerAvailability(
  host: ExportFilePickerHost = browserHost(),
): ExportFilePickerAvailability {
  if (host.isSecureContext !== true) {
    return { available: false, reason: INSECURE_CONTEXT_REASON }
  }
  if (typeof host.showSaveFilePicker !== 'function') {
    return { available: false, reason: UNSUPPORTED_BROWSER_REASON }
  }
  return { available: true, reason: null }
}

function pickerFailure(cause: unknown): ExportFilePickerResult | never {
  if (namedError(cause, 'AbortError')) return { status: 'cancelled' }
  if (namedError(cause, 'SecurityError')) {
    return { status: 'security-error', reason: SECURITY_ERROR_REASON }
  }
  throw cause
}

/**
 * Ask for one direct-file destination.
 *
 * The native picker call happens before this function returns so a caller can
 * invoke it directly inside the Start button's transient user activation.
 */
export function requestExportFileDestination(
  profile: Readonly<ExportProfile>,
  suggestedName: string,
  host: ExportFilePickerHost = browserHost(),
): Promise<ExportFilePickerResult> {
  const validatedProfile = validateExportProfile(profile)
  if (validatedProfile.destination !== 'file') {
    throw new TypeError('Direct file picker requires the file destination')
  }

  const availability = getExportFilePickerAvailability(host)
  if (!availability.available) {
    return Promise.resolve({
      status: 'unavailable',
      reason: availability.reason,
    })
  }
  const picker = host.showSaveFilePicker
  if (typeof picker !== 'function') {
    return Promise.resolve({
      status: 'unavailable',
      reason: UNSUPPORTED_BROWSER_REASON,
    })
  }

  const options: ExportSaveFilePickerOptions = {
    suggestedName,
    excludeAcceptAllOption: true,
    types: [{
      description: validatedProfile.container === 'mp4'
        ? 'MP4 video'
        : 'WebM video',
      accept: {
        [validatedProfile.mimeType]: [`.${validatedProfile.fileExtension}`],
      },
    }],
  }

  let selection: Promise<FileSystemFileHandle>
  try {
    selection = picker.call(host, options)
  } catch (cause) {
    try {
      return Promise.resolve(pickerFailure(cause))
    } catch (unexpected) {
      return Promise.reject(unexpected)
    }
  }

  return Promise.resolve(selection).then(
    (handle): ExportFilePickerResult => ({
      status: 'selected',
      destination: new OneShotExportFileDestination(handle),
    }),
    pickerFailure,
  )
}
