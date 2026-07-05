/**
 * engine/playback-engine.test.ts — Phase 4.0.5.
 *
 * The engine's one job: derive integer frames from the CLOCK, never from
 * how often ticks fire. So the harness pumps ticks manually and moves a
 * fake clock — frames must follow the clock alone.
 */

import { describe, expect, test } from 'vitest'
import type { FrameRate } from '../domain/schema'
import { PlaybackEngine } from './playback-engine'

function makeHarness(onFrameHook?: (frame: number, engine: PlaybackEngine) => void) {
  const clock = { currentTime: 0 }
  let nextId = 1
  const pending = new Map<number, () => void>()
  const frames: number[] = []
  let ended = 0

  const engine = new PlaybackEngine({
    clock,
    scheduleTick: (cb) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelTick: (id) => void pending.delete(id),
    onFrame: (f) => {
      frames.push(f)
      onFrameHook?.(f, engine)
    },
    onEnded: () => {
      ended++
    },
  })

  /** Run every currently-scheduled tick exactly once. */
  const pump = () => {
    const cbs = [...pending.values()]
    pending.clear()
    for (const cb of cbs) cb()
  }

  return {
    clock,
    engine,
    frames,
    pump,
    ended: () => ended,
    pendingCount: () => pending.size,
  }
}

const FPS30: FrameRate = { num: 30, den: 1 }
const NTSC: FrameRate = { num: 30000, den: 1001 }

describe('PlaybackEngine', () => {
  test('frames come from the clock, not from tick count', () => {
    const h = makeHarness()
    h.engine.start(0, 300, FPS30)

    h.pump() // clock has not moved: ticking alone must emit nothing
    h.pump()
    h.pump()
    expect(h.frames).toEqual([])

    h.clock.currentTime = 0.5
    h.pump()
    expect(h.frames).toEqual([15])
  })

  test('floor semantics: a frame appears only once its time fully arrived', () => {
    const h = makeHarness()
    h.engine.start(0, 300, FPS30)

    h.clock.currentTime = 0.0333 // just SHORT of frame 1 at 30fps (1/30 ≈ 0.03333…)
    h.pump()
    expect(h.frames).toEqual([])

    h.clock.currentTime = 0.034
    h.pump()
    expect(h.frames).toEqual([1])
  })

  test('same clock reading twice never re-emits a frame', () => {
    const h = makeHarness()
    h.engine.start(0, 300, FPS30)
    h.clock.currentTime = 0.5
    h.pump()
    h.pump() // clock unchanged
    expect(h.frames).toEqual([15])
  })

  test('NTSC stays exact: 1.001s at 30000/1001 is exactly frame 30', () => {
    const h = makeHarness()
    h.engine.start(0, 300, NTSC)
    h.clock.currentTime = 1.001
    h.pump()
    expect(h.frames).toEqual([30])
  })

  test('a large clock jump emits only the newest frame (latest-wins)', () => {
    const h = makeHarness()
    h.engine.start(0, 300, FPS30)
    h.clock.currentTime = 1 // 30 frames elapsed in one tick
    h.pump()
    expect(h.frames).toEqual([30])
  })

  test('reaching endFrame emits endFrame then onEnded, once, and halts', () => {
    const h = makeHarness()
    h.engine.start(0, 60, FPS30)
    h.clock.currentTime = 10 // way past the end
    h.pump()
    expect(h.frames).toEqual([60])
    expect(h.ended()).toBe(1)
    expect(h.engine.isRunning).toBe(false)
    expect(h.pendingCount()).toBe(0) // nothing rescheduled

    h.clock.currentTime = 20
    h.pump() // no pending ticks anyway; nothing may happen
    expect(h.frames).toEqual([60])
    expect(h.ended()).toBe(1)
  })

  test('stop() cancels the pending tick and emits nothing further', () => {
    const h = makeHarness()
    h.engine.start(0, 300, FPS30)
    expect(h.pendingCount()).toBe(1)
    h.engine.stop()
    expect(h.pendingCount()).toBe(0)
    expect(h.engine.isRunning).toBe(false)

    h.clock.currentTime = 5
    h.pump()
    expect(h.frames).toEqual([])
    expect(h.ended()).toBe(0)
  })

  test('reentrant stop() from onFrame prevents rescheduling', () => {
    const h = makeHarness((frame, engine) => {
      if (frame >= 15) engine.stop()
    })
    h.engine.start(0, 300, FPS30)
    h.clock.currentTime = 0.5
    h.pump()
    expect(h.frames).toEqual([15])
    expect(h.engine.isRunning).toBe(false)
    expect(h.pendingCount()).toBe(0)
  })

  test('restart re-anchors on the current clock reading', () => {
    const h = makeHarness()
    h.engine.start(0, 300, FPS30)
    h.clock.currentTime = 1
    h.pump()
    expect(h.frames).toEqual([30])

    h.engine.stop()
    h.engine.start(100, 300, FPS30) // clock already at 1s — must not jump
    h.clock.currentTime = 1.5
    h.pump()
    expect(h.frames).toEqual([30, 115]) // 100 + 0.5s * 30fps
  })

  test('starting at/past endFrame settles on endFrame and ends immediately', () => {
    const h = makeHarness()
    h.engine.start(120, 120, FPS30)
    h.pump()
    expect(h.frames).toEqual([]) // lastEmitted was already 120 — no re-emit
    expect(h.ended()).toBe(1)
    expect(h.engine.isRunning).toBe(false)
  })
})
