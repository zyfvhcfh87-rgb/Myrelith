/**
 * engine/playback-engine.ts — the audio-clock-driven playback loop.
 * Phase 4.0.5 (transport bar).
 *
 * ARCHITECTURE rule 3: audio is the master clock. Even while no audio is
 * decoded yet, "which frame to show" is derived ONLY from an injected
 * AudioContext-style clock (float seconds, monotonic while running); the
 * tick scheduler (rAF in production) merely paces how often we ASK the
 * clock and contributes nothing to the position. Rule 2: the engine emits
 * integer frames — the float seconds→frame conversion happens here because
 * the engine IS the clock boundary (floor, so a frame is never shown
 * before its display time has fully arrived).
 *
 * Emission contract: only the NEWEST frame is emitted per tick (if the
 * clock jumped several frames, intermediates are skipped — latest-wins,
 * matching every other async layer). Direction follows a signed integer
 * playback rate: forward rates walk toward the exclusive end, reverse rates
 * walk toward frame 0. In both directions the last displayed frame receives
 * its full duration before the engine parks and ends. Callbacks may
 * reentrantly call stop()/start(); the loop never schedules past a stop.
 *
 * No React, no stores, no browser globals — deps are injected
 * (app/transportController.ts wires the real ones).
 */

import type { FrameRate } from '../domain/schema'

/**
 * Guard against float rounding when flooring clock seconds into frames:
 * products like 1.001 * 30000 / 1001 land epsilon-UNDER the integer in
 * doubles, which would flip every NTSC frame one tick late. 1e-6 of a
 * frame (~33ns of clock at 30fps) is imperceptible yet ~6 orders of
 * magnitude above double error at any plausible timeline length.
 */
const FRAME_EPSILON = 1e-6

/** The slice of AudioContext the engine reads. Seconds; monotonic. */
export interface PlaybackClock {
  readonly currentTime: number
}

export interface PlaybackEngineDeps {
  clock: PlaybackClock
  /** Schedule one tick callback (production: requestAnimationFrame). */
  scheduleTick(cb: () => void): number
  /** Cancel a scheduled tick by its id. */
  cancelTick(id: number): void
  /** A new integer frame is due (monotonic in the signed playback direction). */
  onFrame(frame: number): void
  /** The exclusive end boundary was reached; the engine already stopped. */
  onEnded(): void
}

export class PlaybackEngine {
  // erasableSyntaxOnly: fields declared explicitly, no ctor param props.
  private deps: PlaybackEngineDeps
  private running = false
  private tickId: number | null = null
  private anchorTime = 0
  private anchorFrame = 0
  private endFrameExclusive = 0
  private lastEmitted = 0
  private rate: FrameRate = { num: 30, den: 1 }
  private playbackRate = 1
  private runGeneration = 0

  constructor(deps: PlaybackEngineDeps) {
    this.deps = deps
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Begin playing from `fromFrame` (integer, at `rate`) until the exclusive
   * `endFrameExclusive` boundary. `anchorTime` can be supplied by a scheduled
   * audio session so video and audio share one exact AudioContext origin.
   * `playbackRate` is a signed integer speed (...-8,-4,-2,-1,0,1,2,4,8);
   * 0 does not start. Calling while running restarts cleanly.
   */
  start(
    fromFrame: number,
    endFrameExclusive: number,
    rate: FrameRate,
    anchorTime = this.deps.clock.currentTime,
    playbackRate = 1,
  ): void {
    this.stop()
    this.anchorTime = anchorTime
    this.anchorFrame = fromFrame
    this.endFrameExclusive = endFrameExclusive
    this.rate = rate
    this.playbackRate = Number.isSafeInteger(playbackRate) ? playbackRate : 1
    this.lastEmitted = fromFrame // already on screen; emit only what's new
    if (this.playbackRate === 0) return
    this.running = true
    this.runGeneration++
    this.tickId = this.deps.scheduleTick(this.tick)
  }

  /** Halt without emitting anything further. Safe to call at any time. */
  stop(): void {
    this.runGeneration++
    this.running = false
    if (this.tickId !== null) {
      this.deps.cancelTick(this.tickId)
      this.tickId = null
    }
  }

  /** Arrow field so the scheduler can hold it without re-binding. */
  private tick = (): void => {
    this.tickId = null
    if (!this.running) return
    const generation = this.runGeneration

    // Float seconds are legal exactly here (clock boundary); multiply by
    // num before dividing by den so standard rates stay exact. Signed speed
    // scales that same product; the sign is applied after floor+epsilon so
    // reverse NTSC does not walk one frame early.
    const elapsed = this.deps.clock.currentTime - this.anchorTime
    const magnitude = Math.abs(this.playbackRate)
    const elapsedFrames = Math.max(
      0,
      Math.floor(
        (elapsed * this.rate.num * magnitude) / this.rate.den + FRAME_EPSILON,
      ),
    )
    const frame = this.anchorFrame + Math.sign(this.playbackRate) * elapsedFrames

    if (this.playbackRate < 0 && frame < 0) {
      this.running = false
      if (this.lastEmitted > 0) this.deps.onFrame(0)
      if (generation !== this.runGeneration) return
      this.deps.onEnded()
      return
    }
    if (this.playbackRate > 0 && frame >= this.endFrameExclusive) {
      this.running = false
      const lastFrame = Math.max(this.anchorFrame, this.endFrameExclusive - 1)
      if (lastFrame > this.lastEmitted) this.deps.onFrame(lastFrame)
      // The final-frame callback may have started or stopped a different run.
      // Its lifecycle must not receive this superseded run's ended callback.
      if (generation !== this.runGeneration) return
      this.deps.onEnded()
      return
    }
    if (
      (this.playbackRate > 0 && frame > this.lastEmitted)
      || (this.playbackRate < 0 && frame < this.lastEmitted)
    ) {
      this.lastEmitted = frame
      this.deps.onFrame(frame) // may reentrantly stop() — checked below
    }
    if (this.running && this.tickId === null) {
      this.tickId = this.deps.scheduleTick(this.tick)
    }
  }
}
