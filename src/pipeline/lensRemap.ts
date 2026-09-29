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
  /** Pin one frame's exact work through its asynchronous composite; then release. */
  reserveFrameWork?(work: {
    readonly additionalOwnedBytes: number
    readonly outputWidth: number
    readonly outputHeight: number
    readonly includeExportReadback: boolean
  }): () => void
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

/**
 * Probe a render source's pixel size: VideoFrame display size first, then
 * video, image, and canvas/bitmap sizes. Unvalidated; each caller applies
 * its own rule and error type.
 */
export function canvasImageSourceSize(source: CanvasImageSource): {
  readonly width: number | undefined
  readonly height: number | undefined
} {
  const value = source as unknown as {
    readonly displayWidth?: number
    readonly displayHeight?: number
    readonly width?: number
    readonly height?: number
    readonly videoWidth?: number
    readonly videoHeight?: number
    readonly naturalWidth?: number
    readonly naturalHeight?: number
  }
  return {
    width: value.displayWidth
      ?? value.videoWidth
      ?? value.naturalWidth
      ?? value.width,
    height: value.displayHeight
      ?? value.videoHeight
      ?? value.naturalHeight
      ?? value.height,
  }
}
