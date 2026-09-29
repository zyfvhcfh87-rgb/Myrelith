
import type { BitmapLike } from '../decode-types';
import type { DecodedVideoFrame } from '../video-source';
import { SRGB_2D_CONTEXT } from './contracts';

export interface OrientedBitmapNormalizer {
  /** Normalize orientation and copy a streamed frame. Does not close it. */
  normalize(decoded: DecodedVideoFrame): Promise<BitmapLike>
  /** Drop the reusable orientation surface; a later frame recreates it. */
  release(): void
}

interface OrientationSurface {
  readonly canvas: OffscreenCanvas
  readonly context: OffscreenCanvasRenderingContext2D
}

/**
 * One render-worker-owned orientation surface. A rotated frame is drawn and
 * transferred out synchronously, so calls never interleave on the surface,
 * and transferToImageBitmap leaves it transparent for the next frame. A
 * frame of different dimensions replaces the surface instead of resizing it;
 * a failed draw discards it so partial pixels are never reused.
 */
export function createOrientedBitmapNormalizer(): OrientedBitmapNormalizer {
  let surface: OrientationSurface | null = null

  function surfaceFor(width: number, height: number): OrientationSurface {
    if (surface?.canvas.width === width && surface.canvas.height === height) {
      return surface
    }
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', SRGB_2D_CONTEXT)
    if (!context) throw new Error('orientation canvas 2d context unavailable')
    surface = { canvas, context }
    return surface
  }

  function release(): void {
    if (surface) {
      surface.canvas.width = 1
      surface.canvas.height = 1
    }
    surface = null
  }

  return {
    async normalize(decoded) {
      if (decoded.rotation === 0) {
        return createImageBitmap(decoded.frame as unknown as ImageBitmapSource)
      }

      const outputWidth = decoded.displayWidth
      const outputHeight = decoded.displayHeight
      const sourceWidth = decoded.rotation === 180 ? outputWidth : outputHeight
      const sourceHeight = decoded.rotation === 180 ? outputHeight : outputWidth
      const { canvas, context } = surfaceFor(outputWidth, outputHeight)

      try {
        context.save()
        try {
          if (decoded.rotation === 90) {
            context.translate(outputWidth, 0)
            context.rotate(Math.PI / 2)
          } else if (decoded.rotation === 180) {
            context.translate(outputWidth, outputHeight)
            context.rotate(Math.PI)
          } else {
            context.translate(0, outputHeight)
            context.rotate(-Math.PI / 2)
          }
          context.drawImage(
            decoded.frame as unknown as CanvasImageSource,
            0,
            0,
            sourceWidth,
            sourceHeight,
          )
        } finally {
          context.restore()
        }
        return canvas.transferToImageBitmap()
      } catch (error) {
        release()
        throw error
      }
    },
    release,
  }
}
