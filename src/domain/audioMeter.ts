/** Browser-free peak-meter math shared by playback telemetry and its tests. */

export const AUDIO_METER_FLOOR_DB = -60
export const AUDIO_METER_CEILING_DB = 6
export const AUDIO_METER_OVERLOAD_DB = 0
export const AUDIO_METER_FFT_SIZE = 256
export const AUDIO_METER_UPDATE_INTERVAL_MS = 100
export const AUDIO_METER_UPDATE_HZ = 1_000 / AUDIO_METER_UPDATE_INTERVAL_MS
export const AUDIO_METER_RELEASE_DB_PER_SECOND = 18
export const AUDIO_METER_OVERLOAD_HOLD_MS = 2_000

const MAX_METER_LINEAR = 10 ** (AUDIO_METER_CEILING_DB / 20)

export interface AudioMeterPeaks {
  readonly left: number
  readonly right: number
  readonly master: number
}

export interface AudioMeterSample extends AudioMeterPeaks {
  readonly rms: number
}

export interface AudioMeterFlags {
  readonly left: boolean
  readonly right: boolean
  readonly master: boolean
}

export interface AudioMeterTimes {
  readonly left: number
  readonly right: number
  readonly master: number
}

export interface AudioMeterBallisticsState {
  readonly peaks: AudioMeterPeaks
  readonly overloadHeldUntilMs: AudioMeterTimes
  readonly overloadLatched: AudioMeterFlags
  readonly sampleTimeMs: number | null
}

export interface AudioMeterReadout {
  readonly db: AudioMeterPeaks
  readonly overloadHeld: AudioMeterFlags
  readonly overloadLatched: AudioMeterFlags
}

const ZERO_PEAKS: AudioMeterPeaks = Object.freeze({
  left: 0,
  right: 0,
  master: 0,
})

const ZERO_TIMES: AudioMeterTimes = Object.freeze({
  left: 0,
  right: 0,
  master: 0,
})

const CLEAR_FLAGS: AudioMeterFlags = Object.freeze({
  left: false,
  right: false,
  master: false,
})

function finiteSample(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

function boundedPeak(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_METER_LINEAR, value)
}

/** Reference sample-peak and stereo RMS calculation for one analyser window. */
export function measureAudioMeterSample(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): AudioMeterSample {
  const length = Math.max(left.length, right.length)
  if (length === 0) return { ...ZERO_PEAKS, rms: 0 }

  let leftPeak = 0
  let rightPeak = 0
  let squareSum = 0
  for (let index = 0; index < length; index++) {
    const leftSample = finiteSample(left[index])
    const rightSample = finiteSample(right[index])
    const leftMagnitude = Math.abs(leftSample)
    const rightMagnitude = Math.abs(rightSample)
    leftPeak = Math.max(leftPeak, leftMagnitude)
    rightPeak = Math.max(rightPeak, rightMagnitude)
    squareSum += leftSample * leftSample + rightSample * rightSample
  }

  return {
    left: boundedPeak(leftPeak),
    right: boundedPeak(rightPeak),
    master: boundedPeak(Math.max(leftPeak, rightPeak)),
    rms: Math.sqrt(squareSum / (length * 2)),
  }
}

export function linearPeakToDb(peak: number): number {
  const bounded = boundedPeak(peak)
  if (bounded === 0) return AUDIO_METER_FLOOR_DB
  return Math.max(
    AUDIO_METER_FLOOR_DB,
    Math.min(AUDIO_METER_CEILING_DB, 20 * Math.log10(bounded)),
  )
}

export function createAudioMeterBallistics(): AudioMeterBallisticsState {
  return {
    peaks: ZERO_PEAKS,
    overloadHeldUntilMs: ZERO_TIMES,
    overloadLatched: CLEAR_FLAGS,
    sampleTimeMs: null,
  }
}

function releasedPeak(previous: number, elapsedSeconds: number): number {
  if (previous <= 0 || elapsedSeconds <= 0) return boundedPeak(previous)
  const releasedDb = linearPeakToDb(previous)
    - AUDIO_METER_RELEASE_DB_PER_SECOND * elapsedSeconds
  if (releasedDb <= AUDIO_METER_FLOOR_DB) return 0
  return boundedPeak(10 ** (releasedDb / 20))
}

function overloadFlags(peaks: AudioMeterPeaks): AudioMeterFlags {
  return {
    left: peaks.left >= 1,
    right: peaks.right >= 1,
    master: peaks.master >= 1,
  }
}

/** Immediate attack, 18 dB/s release, two-second hold, and explicit latch. */
export function advanceAudioMeterBallistics(
  previous: AudioMeterBallisticsState,
  rawPeaks: AudioMeterPeaks,
  sampleTimeMs: number,
): AudioMeterBallisticsState {
  if (!Number.isFinite(sampleTimeMs) || sampleTimeMs < 0) {
    throw new RangeError('Audio meter sample time must be non-negative')
  }
  const peaks = {
    left: boundedPeak(rawPeaks.left),
    right: boundedPeak(rawPeaks.right),
    master: boundedPeak(rawPeaks.master),
  }
  const elapsedSeconds = previous.sampleTimeMs === null
    ? 0
    : Math.max(0, sampleTimeMs - previous.sampleTimeMs) / 1_000
  const smoothed = {
    left: Math.max(peaks.left, releasedPeak(previous.peaks.left, elapsedSeconds)),
    right: Math.max(peaks.right, releasedPeak(previous.peaks.right, elapsedSeconds)),
    master: Math.max(
      peaks.master,
      releasedPeak(previous.peaks.master, elapsedSeconds),
    ),
  }
  const overloaded = overloadFlags(peaks)
  const holdUntil = {
    left: overloaded.left
      ? sampleTimeMs + AUDIO_METER_OVERLOAD_HOLD_MS
      : previous.overloadHeldUntilMs.left,
    right: overloaded.right
      ? sampleTimeMs + AUDIO_METER_OVERLOAD_HOLD_MS
      : previous.overloadHeldUntilMs.right,
    master: overloaded.master
      ? sampleTimeMs + AUDIO_METER_OVERLOAD_HOLD_MS
      : previous.overloadHeldUntilMs.master,
  }
  return {
    peaks: smoothed,
    overloadHeldUntilMs: holdUntil,
    overloadLatched: {
      left: previous.overloadLatched.left || overloaded.left,
      right: previous.overloadLatched.right || overloaded.right,
      master: previous.overloadLatched.master || overloaded.master,
    },
    sampleTimeMs,
  }
}

export function audioMeterReadout(
  state: AudioMeterBallisticsState,
  nowMs: number,
): AudioMeterReadout {
  return {
    db: {
      left: linearPeakToDb(state.peaks.left),
      right: linearPeakToDb(state.peaks.right),
      master: linearPeakToDb(state.peaks.master),
    },
    overloadHeld: {
      left: nowMs < state.overloadHeldUntilMs.left,
      right: nowMs < state.overloadHeldUntilMs.right,
      master: nowMs < state.overloadHeldUntilMs.master,
    },
    overloadLatched: state.overloadLatched,
  }
}

/** Stop/seek clears moving levels and hold, but keeps a warning until reset. */
export function silenceAudioMeterBallistics(
  state: AudioMeterBallisticsState,
): AudioMeterBallisticsState {
  return {
    peaks: ZERO_PEAKS,
    overloadHeldUntilMs: ZERO_TIMES,
    overloadLatched: state.overloadLatched,
    sampleTimeMs: null,
  }
}

export function clearAudioMeterOverload(
  state: AudioMeterBallisticsState,
): AudioMeterBallisticsState {
  return {
    ...state,
    overloadHeldUntilMs: ZERO_TIMES,
    overloadLatched: CLEAR_FLAGS,
  }
}
