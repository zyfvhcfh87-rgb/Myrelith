
import type { BitmapLike } from '../decode-types';
import type { DecodedVideoFrame } from '../video-source';
import { SRGB_2D_CONTEXT } from './contracts';

export async function createOrientedStreamingBitmap(
  decoded: DecodedVideoFrame,
): Promise<BitmapLike> {
  if (decoded.rotation === 0) {
    return createImageBitmap(decoded.frame as unknown as ImageBitmapSource)
  }

  const outputWidth = decoded.displayWidth
  const outputHeight = decoded.displayHeight
  const sourceWidth = decoded.rotation === 180 ? outputWidth : outputHeight
  const sourceHeight = decoded.rotation === 180 ? outputHeight : outputWidth
  const canvas = new OffscreenCanvas(outputWidth, outputHeight)
  const context = canvas.getContext('2d', SRGB_2D_CONTEXT)
  if (!context) throw new Error('orientation canvas 2d context unavailable')

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
}
