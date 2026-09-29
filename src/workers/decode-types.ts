/**
 * Runtime-neutral structural decode types for the render worker. This module
 * has no runtime code and stays safe on either side of a worker boundary.
 */

/** The slice of ImageBitmap retained by worker-owned render sources. */
export interface BitmapLike {
  width: number
  height: number
  close(): void
}
