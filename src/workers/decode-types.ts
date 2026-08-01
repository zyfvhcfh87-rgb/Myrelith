/**
 * Runtime-neutral structural decode types shared by current and compatibility
 * workers. This module has no runtime code and stays safe on either side of a
 * worker boundary.
 */

/** One demuxed encoded chunk, ready to rebuild as an EncodedVideoChunk. */
export interface ChunkPayload {
  type: 'key' | 'delta'
  /** Presentation timestamp in integer microseconds. */
  timestampUs: number
  /** Frame duration in integer microseconds. */
  durationUs: number
  /** Encoded bytes. Transfer this buffer in postMessage; do not copy it. */
  data: ArrayBuffer
}

/** The slice of VideoFrame used by injected decoder implementations. */
export interface DecodableFrame {
  timestamp: number
  displayWidth: number
  displayHeight: number
  close(): void
}

/** The slice of ImageBitmap retained by worker-owned caches. */
export interface BitmapLike {
  width: number
  height: number
  close(): void
}

/** The slice of VideoDecoder driven by compatibility decode workers. */
export interface VideoDecoderLike {
  decodeQueueSize: number
  ondequeue: (() => void) | null
  configure(config: VideoDecoderConfig): void
  decode(chunk: unknown): void
  flush(): Promise<void>
  reset(): void
  close(): void
}

export interface Canvas2DLike {
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
}

export interface CanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): Canvas2DLike | null
}
