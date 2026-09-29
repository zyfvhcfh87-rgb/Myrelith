/**
 * Pure A/V capture timestamp rules for camera and screen recording (Issue #209).
 *
 * Chromium stamps `VideoFrame`/`AudioData` from `MediaStreamTrackProcessor`
 * with capture times on one monotonic clock (proven in the Step 13 evidence).
 * The output file uses that clock, never main-thread arrival time:
 *
 * - Video: output time = capture time − base. Non-increasing frames are dropped.
 * - Audio: output time comes from the exact sample count, so the audio track has
 *   no gaps or overlaps. Its capture time is compared against that sample
 *   clock. A gap beyond the tolerance (lost input) is filled with silence to
 *   resynchronize. A negative drift beyond the tolerance cannot be corrected;
 *   it is reported, never hidden.
 * - Base: the first video frame kept once both tracks have started. Earlier
 *   audio is trimmed; later-starting audio gets leading silence.
 *
 * All values are integer microseconds or integer sample counts.
 */

/** Audio drift inside this bound is normal jitter (about one 20 ms packet plus slack). */
export const AV_DRIFT_TOLERANCE_US = 40_000
/** A single audio gap larger than this ends the take as a fault instead of padding. */
export const AV_MAX_GAP_US = 1_000_000

export interface AvClockState {
  readonly hasAudio: boolean
  /** Capture-clock microseconds mapped to output zero; null until both tracks start. */
  readonly baseUs: number | null
  readonly firstAudioUs: number | null
  readonly lastVideoUs: number | null
  readonly audioSampleRate: number | null
  /** Samples already placed on the output audio track (including padding). */
  readonly audioSamples: number
  readonly droppedVideoFrames: number
  readonly paddedAudioSamples: number
  readonly trimmedAudioSamples: number
  readonly gapEvents: number
  /** Largest |capture − sample clock| seen, in microseconds. */
  readonly maxAbsDriftUs: number
  /** Latest signed drift (capture − sample clock), in microseconds. */
  readonly driftUs: number
  /** Negative drift beyond tolerance that could not be corrected. */
  readonly uncorrectedDriftEvents: number
}

export function createAvClock(hasAudio: boolean): AvClockState {
  return { hasAudio, baseUs: null, firstAudioUs: null, lastVideoUs: null, audioSampleRate: null,
    audioSamples: 0, droppedVideoFrames: 0, paddedAudioSamples: 0, trimmedAudioSamples: 0,
    gapEvents: 0, maxAbsDriftUs: 0, driftUs: 0, uncorrectedDriftEvents: 0 }
}

function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`)
}

/** Microseconds → samples (floor), exact integer math. */
export function samplesForMicroseconds(us: number, sampleRate: number): number {
  integer(us, 'Microseconds')
  integer(sampleRate, 'Sample rate')
  return Number((BigInt(us) * BigInt(sampleRate)) / 1_000_000n)
}

/** Samples → microseconds (floor), exact integer math. */
export function microsecondsForSamples(samples: number, sampleRate: number): number {
  integer(samples, 'Samples')
  integer(sampleRate, 'Sample rate')
  return Number((BigInt(samples) * 1_000_000n) / BigInt(sampleRate))
}

export type AvVideoDecision =
  | { readonly action: 'drop'; readonly reason: 'waiting-for-audio' | 'before-base' | 'non-increasing' }
  | { readonly action: 'write'; readonly timestampUs: number }

export function planAvVideoFrame(state: AvClockState, captureUs: number): { state: AvClockState; decision: AvVideoDecision } {
  integer(captureUs, 'Video capture time')
  if (state.baseUs === null) {
    // Video that precedes the first audio chunk is dropped rather than held,
    // so no camera frame is retained while waiting.
    if (state.hasAudio && state.firstAudioUs === null) {
      return { state: { ...state, droppedVideoFrames: state.droppedVideoFrames + 1 },
        decision: { action: 'drop', reason: 'waiting-for-audio' } }
    }
    return { state: { ...state, baseUs: captureUs, lastVideoUs: captureUs },
      decision: { action: 'write', timestampUs: 0 } }
  }
  if (captureUs < state.baseUs) {
    return { state: { ...state, droppedVideoFrames: state.droppedVideoFrames + 1 },
      decision: { action: 'drop', reason: 'before-base' } }
  }
  if (state.lastVideoUs !== null && captureUs <= state.lastVideoUs) {
    return { state: { ...state, droppedVideoFrames: state.droppedVideoFrames + 1 },
      decision: { action: 'drop', reason: 'non-increasing' } }
  }
  return { state: { ...state, lastVideoUs: captureUs }, decision: { action: 'write', timestampUs: captureUs - state.baseUs } }
}

export type AvAudioDecision =
  /** Keep the first chunk until video establishes the base (bounded by the caller). */
  | { readonly action: 'hold' }
  | { readonly action: 'fault'; readonly reason: string }
  | {
    readonly action: 'write'
    /** Silence to write before the chunk (resync or late audio start). */
    readonly leadingSilenceSamples: number
    /** Samples to drop from the chunk's start (audio before the base). */
    readonly trimSamples: number
    /** Output timestamp of the first written sample (silence or data). */
    readonly timestampUs: number
  }

/**
 * Plan one audio chunk of `frames` samples stamped at `captureUs`. A chunk that
 * arrives before video has set the base is held (`hold`); replay it once the
 * base exists.
 */
export function planAvAudioChunk(
  state: AvClockState,
  captureUs: number,
  frames: number,
  sampleRate: number,
): { state: AvClockState; decision: AvAudioDecision } {
  integer(captureUs, 'Audio capture time')
  integer(frames, 'Audio frames')
  integer(sampleRate, 'Audio sample rate')
  if (frames < 1 || sampleRate < 1) throw new RangeError('Audio chunks need positive frames and rate')
  if (state.audioSampleRate !== null && state.audioSampleRate !== sampleRate) {
    return { state, decision: { action: 'fault', reason: 'The audio sample rate changed during capture' } }
  }
  const withRate = { ...state, audioSampleRate: sampleRate,
    firstAudioUs: state.firstAudioUs ?? captureUs }
  if (withRate.baseUs === null) return { state: withRate, decision: { action: 'hold' } }
  const base = withRate.baseUs
  const expectedUs = microsecondsForSamples(withRate.audioSamples, sampleRate)
  const relativeUs = captureUs - base

  if (withRate.audioSamples === 0) {
    // First written chunk: trim audio before the base, or pad up to it.
    if (relativeUs + microsecondsForSamples(frames, sampleRate) <= 0) {
      return { state: { ...withRate, trimmedAudioSamples: withRate.trimmedAudioSamples + frames },
        decision: { action: 'write', leadingSilenceSamples: 0, trimSamples: frames, timestampUs: 0 } }
    }
    if (relativeUs < 0) {
      const trim = Math.min(frames, samplesForMicroseconds(-relativeUs, sampleRate))
      return { state: { ...withRate, audioSamples: frames - trim, trimmedAudioSamples: withRate.trimmedAudioSamples + trim },
        decision: { action: 'write', leadingSilenceSamples: 0, trimSamples: trim, timestampUs: 0 } }
    }
    if (relativeUs > AV_MAX_GAP_US) {
      return { state: withRate, decision: { action: 'fault', reason: 'Audio started more than one second after video' } }
    }
    const lead = samplesForMicroseconds(relativeUs, sampleRate)
    return { state: { ...withRate, audioSamples: lead + frames, paddedAudioSamples: withRate.paddedAudioSamples + lead },
      decision: { action: 'write', leadingSilenceSamples: lead, trimSamples: 0, timestampUs: 0 } }
  }

  const driftUs = relativeUs - expectedUs
  const maxAbsDriftUs = Math.max(withRate.maxAbsDriftUs, Math.abs(driftUs))
  if (driftUs > AV_DRIFT_TOLERANCE_US) {
    if (driftUs > AV_MAX_GAP_US) {
      return { state: { ...withRate, driftUs, maxAbsDriftUs },
        decision: { action: 'fault', reason: 'Audio input stopped for more than one second' } }
    }
    const pad = samplesForMicroseconds(driftUs, sampleRate)
    return { state: { ...withRate, audioSamples: withRate.audioSamples + pad + frames, driftUs, maxAbsDriftUs,
      paddedAudioSamples: withRate.paddedAudioSamples + pad, gapEvents: withRate.gapEvents + 1 },
    decision: { action: 'write', leadingSilenceSamples: pad, trimSamples: 0, timestampUs: expectedUs } }
  }
  const uncorrected = driftUs < -AV_DRIFT_TOLERANCE_US ? 1 : 0
  return { state: { ...withRate, audioSamples: withRate.audioSamples + frames, driftUs, maxAbsDriftUs,
    uncorrectedDriftEvents: withRate.uncorrectedDriftEvents + uncorrected },
  decision: { action: 'write', leadingSilenceSamples: 0, trimSamples: 0, timestampUs: expectedUs } }
}

/** Plain-language drift report for review; null when nothing needs saying. */
export function describeAvClock(state: AvClockState): string | null {
  const notes: string[] = []
  if (state.gapEvents > 0 && state.audioSampleRate) {
    const ms = Math.round(microsecondsForSamples(state.paddedAudioSamples, state.audioSampleRate) / 1000)
    notes.push(`Audio input paused ${state.gapEvents} time(s); ${ms} ms of silence keeps it in sync.`)
  }
  if (state.uncorrectedDriftEvents > 0) {
    notes.push(`Audio ran up to ${Math.round(state.maxAbsDriftUs / 1000)} ms ahead of the video clock and could not be corrected.`)
  }
  return notes.length ? notes.join(' ') : null
}
