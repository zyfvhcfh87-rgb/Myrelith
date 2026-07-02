/**
 * engine/frame-cache.ts — FrameRingBuffer: a small LRU cache for decoded
 * frames. Phase 2.3.
 *
 * Ownership contract (this is the whole point of the class):
 * - put(key, frame) TRANSFERS ownership of the frame to the buffer. The
 *   buffer closes it on eviction, on replacement, and on clear() — those
 *   are the only places cached frames ever get closed.
 * - take(key) TRANSFERS ownership back to the caller, who must close the
 *   frame (or re-put it) — the buffer forgets it entirely.
 *
 * So at any instant, every decoded-but-unclosed frame has exactly one
 * owner: either the buffer or the code that just took it. That is what
 * makes "seek backward one frame" cheap without ever leaking GPU memory.
 *
 * Pure TS, no imports — usable from the decode worker (its main consumer)
 * and unit-testable in Node with mock closeables.
 */

/** Anything with a close() — VideoFrame satisfies this structurally. */
export interface CloseableFrame {
  close(): void
}

/** Plan-specified default capacity. */
const DEFAULT_CAPACITY = 12

export class FrameRingBuffer<T extends CloseableFrame = CloseableFrame> {
  private readonly capacity: number
  /** Insertion-ordered; first entry = least recently used. */
  private readonly entries = new Map<number, T>()

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError(
        `FrameRingBuffer capacity must be an integer >= 1, got ${capacity}`,
      )
    }
    this.capacity = capacity
  }

  /**
   * Cache a frame under a key (the worker keys by frame timestamp in µs).
   * Replacing a key closes the frame it displaces. When full, the least
   * recently used entry is evicted and CLOSED — the explicit close-on-evict
   * the architecture demands.
   *
   * Caching one frame object under two keys would eventually double-close
   * it; that is a bug at the call site, so it throws.
   */
  put(key: number, frame: T): void {
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      this.entries.delete(key)
      if (existing !== frame) existing.close()
    } else {
      // Max 12 entries — a linear alias scan is effectively free.
      for (const held of this.entries.values()) {
        if (held === frame) {
          throw new TypeError(
            'FrameRingBuffer.put: frame is already cached under another key',
          )
        }
      }
    }
    this.entries.set(key, frame)

    while (this.entries.size > this.capacity) {
      const oldestKey: number = this.entries.keys().next().value as number
      const oldest = this.entries.get(oldestKey) as T
      this.entries.delete(oldestKey)
      oldest.close()
    }
  }

  /**
   * Remove and return the frame for `key`, or null on miss. Ownership moves
   * to the caller: close it or put it back when done.
   */
  take(key: number): T | null {
    const frame = this.entries.get(key)
    if (frame === undefined) return null
    this.entries.delete(key)
    return frame
  }

  /** Close and drop everything (reconfigure/teardown path). */
  clear(): void {
    for (const frame of this.entries.values()) frame.close()
    this.entries.clear()
  }

  has(key: number): boolean {
    return this.entries.has(key)
  }

  get size(): number {
    return this.entries.size
  }
}
