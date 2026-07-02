/**
 * engine/frame-cache.test.ts — Phase 2.3.
 * The property under test: every frame is closed exactly once, by exactly
 * one owner, no matter how the cache is used.
 */

import { describe, expect, test } from 'vitest'
import { FrameRingBuffer } from './frame-cache'

interface MockFrame {
  id: number
  closeCount: number
  close(): void
}

function frame(id: number): MockFrame {
  const f: MockFrame = {
    id,
    closeCount: 0,
    close() {
      f.closeCount++
    },
  }
  return f
}

describe('FrameRingBuffer basics', () => {
  test('put/take round-trips without closing; take removes the entry', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    const f1 = frame(1)
    ring.put(100, f1)

    expect(ring.size).toBe(1)
    expect(ring.take(100)).toBe(f1)
    expect(f1.closeCount).toBe(0) // ownership moved to caller, not closed
    expect(ring.take(100)).toBeNull() // gone after take
    expect(ring.size).toBe(0)
  })

  test('take on a missing key returns null', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    expect(ring.take(42)).toBeNull()
  })

  test('default capacity is 12', () => {
    const ring = new FrameRingBuffer<MockFrame>()
    for (let i = 0; i < 13; i++) ring.put(i, frame(i))
    expect(ring.size).toBe(12)
  })

  test('keys() lists cached keys LRU-first', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    ring.put(10, frame(0))
    ring.put(20, frame(1))
    ring.put(10, ring.take(10) as MockFrame) // touch 10 → now newest
    expect(ring.keys()).toEqual([20, 10])
  })

  test('invalid capacities are rejected', () => {
    expect(() => new FrameRingBuffer(0)).toThrow(TypeError)
    expect(() => new FrameRingBuffer(-1)).toThrow(TypeError)
    expect(() => new FrameRingBuffer(2.5)).toThrow(TypeError)
  })
})

describe('eviction and closing', () => {
  test('exceeding capacity evicts the least recently used and CLOSES it', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    const frames = [frame(0), frame(1), frame(2), frame(3)]
    frames.forEach((f, i) => ring.put(i, f))

    expect(ring.size).toBe(3)
    expect(frames[0].closeCount).toBe(1) // oldest, evicted + closed
    expect(ring.has(0)).toBe(false)
    expect(frames.slice(1).every((f) => f.closeCount === 0)).toBe(true)
  })

  test('re-putting a key refreshes its recency', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    const f0 = frame(0)
    ring.put(0, f0)
    ring.put(1, frame(1))
    ring.put(2, frame(2))

    ring.put(0, f0) // touch key 0: now key 1 is the LRU
    const f3 = frame(3)
    ring.put(3, f3) // evicts key 1, NOT key 0

    expect(ring.has(0)).toBe(true)
    expect(ring.has(1)).toBe(false)
    expect(f0.closeCount).toBe(0) // same object re-put: never closed
  })

  test('replacing a key closes the displaced frame only', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    const oldFrame = frame(1)
    const newFrame = frame(2)
    ring.put(7, oldFrame)
    ring.put(7, newFrame)

    expect(oldFrame.closeCount).toBe(1)
    expect(newFrame.closeCount).toBe(0)
    expect(ring.take(7)).toBe(newFrame)
    expect(ring.size).toBe(0)
  })

  test('caching one frame under two keys is refused (double-close guard)', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    const shared = frame(1)
    ring.put(1, shared)
    expect(() => ring.put(2, shared)).toThrow(TypeError)
  })

  test('clear closes every cached frame exactly once', () => {
    const ring = new FrameRingBuffer<MockFrame>(5)
    const frames = [frame(0), frame(1), frame(2)]
    frames.forEach((f, i) => ring.put(i, f))

    ring.clear()

    expect(ring.size).toBe(0)
    expect(frames.every((f) => f.closeCount === 1)).toBe(true)
    ring.clear() // idempotent
    expect(frames.every((f) => f.closeCount === 1)).toBe(true)
  })

  test('stress: 200 puts through a 12-slot ring — everything closed exactly once', () => {
    const ring = new FrameRingBuffer<MockFrame>()
    const all: MockFrame[] = []
    for (let i = 0; i < 200; i++) {
      const f = frame(i)
      all.push(f)
      ring.put(i, f)
    }
    ring.clear()

    // 200 created; every one closed exactly once (188 evictions + 12 clears).
    expect(all.every((f) => f.closeCount === 1)).toBe(true)
  })
})

describe('take/re-put cycle (the backward-step pattern)', () => {
  test('take → use → put back keeps the frame alive and unclosed', () => {
    const ring = new FrameRingBuffer<MockFrame>(3)
    const f = frame(1)
    ring.put(500, f)

    const taken = ring.take(500)
    expect(taken).toBe(f)
    // ...worker draws it...
    ring.put(500, taken as MockFrame) // back in the cache, recency refreshed

    expect(f.closeCount).toBe(0)
    expect(ring.has(500)).toBe(true)
  })
})
