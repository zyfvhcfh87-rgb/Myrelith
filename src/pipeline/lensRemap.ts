/** Shared source-space lens-remap boundary for preview and export. */

import type { Clip } from '../domain/schema'

export {
  LENS_REMAP_BACKEND_VERSION,
  type LensRemapAvailability,
} from '../domain/lensCorrection'

/** A renderer-owned failure that must never silently bypass lens intent. */
export class LensRemapUnavailableError extends Error {
  readonly terminalOwner: boolean

  constructor(message: string, terminalOwner = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LensRemapUnavailableError'
    this.terminalOwner = terminalOwner
  }
}

export interface LensRemapProvider {
  /** Returns a reusable corrected source valid until the next remap call. */
  remap(clip: Readonly<Clip>, source: CanvasImageSource): CanvasImageSource
  /** Update disposable compositor/readback admission without revalidating models. */
  setOutputSurface?(
    width: number,
    height: number,
    includeExportReadback: boolean,
  ): void
}

export function rethrowLensRemapUnavailable(cause: unknown): void {
  if (cause instanceof LensRemapUnavailableError) throw cause
}
