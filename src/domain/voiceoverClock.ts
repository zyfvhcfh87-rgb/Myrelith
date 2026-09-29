/** Pure sample-grid rules for one pinned microphone take. No browser clock reads. */
import { requireNonNegativeSafeInteger } from './numeric'
import { audioSampleBoundary, type AudioSampleDocument } from './time'

/** Physical timing is uncalibrated by default. Limit manual adjustment to ±0.5 s. */
export const MAX_VOICEOVER_COMPENSATION_SECONDS = 0.5

function safe(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} is outside the safe integer range`)
  }
  return Number(value)
}

function sampleGrid(doc: AudioSampleDocument): void {
  audioSampleBoundary(0, doc) // use the canonical rate validation
  if (BigInt(doc.frameRate.num) > BigInt(doc.audioSampleRate) * BigInt(doc.frameRate.den)) {
    throw new RangeError('A document frame must span at least one audio sample')
  }
}

/** Count-in is a frame duration ending at the scheduled context sample anchor. */
export function voiceoverCountInWindow(
  anchorSample: number,
  durationFrames: number,
  doc: AudioSampleDocument,
): { startSample: number; endSample: number } {
  requireNonNegativeSafeInteger(anchorSample, 'Anchor sample')
  requireNonNegativeSafeInteger(durationFrames, 'Count-in frames')
  sampleGrid(doc)
  const duration = audioSampleBoundary(durationFrames, doc)
  if (duration > anchorSample) throw new RangeError('Count-in precedes context sample zero')
  return { startSample: anchorSample - duration, endSample: anchorSample }
}

/** Exact grid distance from the pinned timeline frame, with no float seconds. */
export function voiceoverSampleAtTimelineFrame(
  frame: number,
  anchorSample: number,
  targetFrame: number,
  doc: AudioSampleDocument,
): number {
  requireNonNegativeSafeInteger(frame, 'Timeline frame')
  requireNonNegativeSafeInteger(anchorSample, 'Anchor sample')
  requireNonNegativeSafeInteger(targetFrame, 'Target frame')
  sampleGrid(doc)
  return safe(
    BigInt(anchorSample) + BigInt(audioSampleBoundary(frame, doc)) -
      BigInt(audioSampleBoundary(targetFrame, doc)),
    'Context sample',
  )
}

/** The frame containing this context sample; null before timeline frame zero. */
export function voiceoverTimelineFrameAtSample(
  contextSample: number,
  anchorSample: number,
  targetFrame: number,
  doc: AudioSampleDocument,
): number | null {
  requireNonNegativeSafeInteger(contextSample, 'Context sample')
  requireNonNegativeSafeInteger(anchorSample, 'Anchor sample')
  requireNonNegativeSafeInteger(targetFrame, 'Target frame')
  sampleGrid(doc)
  const projected = BigInt(audioSampleBoundary(targetFrame, doc)) +
    BigInt(contextSample) - BigInt(anchorSample)
  if (projected < 0n) return null
  safe(projected, 'Projected sample')
  const divisor = BigInt(doc.audioSampleRate) * BigInt(doc.frameRate.den)
  let frame = safe(projected * BigInt(doc.frameRate.num) / divisor, 'Timeline frame')
  // Frame boundaries round to the nearest sample, so the rational floor can
  // be adjacent to (but never far from) the containing frame.
  const boundary = (f: number) => BigInt(audioSampleBoundary(f, doc))
  if (boundary(frame) > projected) frame--
  else if (frame < Number.MAX_SAFE_INTEGER - 1 &&
    boundary(frame + 1) <= projected) frame++
  return frame
}

/** First timeline-frame boundary safely after a stop request reaches the app. */
export function voiceoverStopBoundary(
  nowSample: number,
  anchorSample: number,
  startFrame: number,
  leadSamples: number,
  doc: AudioSampleDocument,
): { stopSample: number; stopFrame: number } {
  requireNonNegativeSafeInteger(nowSample, 'Current sample')
  requireNonNegativeSafeInteger(leadSamples, 'Stop lead samples')
  if (nowSample < anchorSample) throw new RangeError('Voiceover has not reached its anchor')
  const after = safe(BigInt(nowSample) + BigInt(leadSamples), 'Stop lead boundary')
  const containing = voiceoverTimelineFrameAtSample(after, anchorSample, startFrame, doc)
  if (containing === null || containing < startFrame || containing >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Stop frame is outside the timeline sample grid')
  }
  const stopFrame = containing + 1
  return { stopFrame, stopSample: voiceoverSampleAtTimelineFrame(stopFrame, anchorSample, startFrame, doc) }
}

/** Four count-in cues, each on an integer frame's exact sample boundary. */
export function voiceoverCountInCues(
  anchorSample: number,
  durationFrames: number,
  doc: AudioSampleDocument,
): readonly number[] {
  const window = voiceoverCountInWindow(anchorSample, durationFrames, doc)
  if (durationFrames === 0) return []
  const beats = Math.min(4, durationFrames)
  return Array.from({ length: beats }, (_, index) =>
    window.startSample + audioSampleBoundary(Math.floor(index * durationFrames / beats), doc))
}

export interface VoiceoverSampleWindow {
  readonly anchorSample: number
  readonly stopSample: number
  /** Available contiguous worklet input, [start, end). */
  readonly inputStartSample: number
  readonly inputEndSample: number
  /** Positive advances input (head trim); negative delays it (head silence). */
  readonly compensationSamples: number
  readonly audioSampleRate: number
}

export interface VoiceoverSamplePlan {
  readonly outputSamples: number
  readonly leadingSilenceSamples: number
  readonly sourceOffsetSamples: number
  readonly sourceSamples: number
  readonly trailingSilenceSamples: number
  /** Missing input only; excludes intentional silence from compensation. */
  readonly missingInputSamples: number
}

/**
 * Fit a contiguous source interval into the fixed [anchor, stop) output.
 * Never borrow count-in samples before anchor or samples after stop. The
 * caller writes leading silence, a source slice, then trailing silence.
 */
export function planVoiceoverSampleWindow(window: VoiceoverSampleWindow): VoiceoverSamplePlan {
  const { anchorSample, stopSample, inputStartSample, inputEndSample,
    compensationSamples, audioSampleRate } = window
  for (const [value, name] of [
    [anchorSample, 'Anchor sample'], [stopSample, 'Stop sample'],
    [inputStartSample, 'Input start sample'], [inputEndSample, 'Input end sample'],
  ] as const) requireNonNegativeSafeInteger(value, name)
  if (stopSample < anchorSample || inputEndSample < inputStartSample) {
    throw new RangeError('Sample windows must have non-negative lengths')
  }
  if (!Number.isSafeInteger(audioSampleRate) || audioSampleRate <= 0) {
    throw new RangeError('Audio sample rate must be a positive safe integer')
  }
  if (!Number.isSafeInteger(compensationSamples) ||
    Math.abs(compensationSamples) > Math.floor(audioSampleRate * MAX_VOICEOVER_COMPENSATION_SECONDS)) {
    throw new RangeError('Voiceover compensation exceeds the half-second sample bound')
  }

  const anchor = BigInt(anchorSample)
  const stop = BigInt(stopSample)
  const inputStart = BigInt(inputStartSample)
  const inputEnd = BigInt(inputEndSample)
  const shiftedStart = anchor + BigInt(compensationSamples)
  const shiftedEnd = stop + BigInt(compensationSamples)
  const idealStart = shiftedStart > anchor ? shiftedStart : anchor
  const idealEnd = shiftedEnd < stop ? shiftedEnd : stop
  const idealCount = idealEnd > idealStart ? idealEnd - idealStart : 0n
  const sourceStart = idealStart > inputStart ? idealStart : inputStart
  const sourceEnd = idealEnd < inputEnd ? idealEnd : inputEnd
  const sourceCount = sourceEnd > sourceStart ? sourceEnd - sourceStart : 0n
  const total = safe(stop - anchor, 'Output duration')
  const leading = sourceCount === 0n ? total : safe(sourceStart - shiftedStart, 'Leading silence')
  const count = safe(sourceCount, 'Source duration')
  return {
    outputSamples: total,
    leadingSilenceSamples: leading,
    sourceOffsetSamples: sourceCount === 0n ? 0 : safe(sourceStart - inputStart, 'Source offset'),
    sourceSamples: count,
    trailingSilenceSamples: total - leading - count,
    missingInputSamples: safe(idealCount - sourceCount, 'Missing input'),
  }
}

/**
 * The last timeline-frame boundary whose take length stays within
 * `maxSamples`. The capture owner schedules this as the worklet's hard stop,
 * so reaching the take limit ends on an exact frame instead of a writer fault.
 */
export function voiceoverLimitStop(
  anchorSample: number,
  startFrame: number,
  maxSamples: number,
  doc: AudioSampleDocument,
): { stopSample: number; stopFrame: number } {
  requireNonNegativeSafeInteger(anchorSample, 'Anchor sample')
  requireNonNegativeSafeInteger(startFrame, 'Start frame')
  requireNonNegativeSafeInteger(maxSamples, 'Maximum samples')
  sampleGrid(doc)
  const startBoundary = audioSampleBoundary(startFrame, doc)
  const fits = (frames: number) =>
    audioSampleBoundary(startFrame + frames, doc) - startBoundary <= maxSamples
  // Exact floor of maxSamples × rate / sampleRate, then correct the rounding
  // of per-frame sample boundaries by at most one frame either way.
  let frames = safe(BigInt(maxSamples) * BigInt(doc.frameRate.num) /
    (BigInt(doc.audioSampleRate) * BigInt(doc.frameRate.den)), 'Limit frames')
  while (frames > 0 && !fits(frames)) frames--
  while (fits(frames + 1)) frames++
  if (frames < 1) throw new RangeError('The take limit is shorter than one timeline frame')
  const stopFrame = startFrame + frames
  return { stopFrame, stopSample: voiceoverSampleAtTimelineFrame(stopFrame, anchorSample, startFrame, doc) }
}

/**
 * Microphone signal for timeline sample `t` arrives at context sample `t + C`
 * when the input path is `C` samples late. The capture window is therefore the
 * timeline window shifted by the signed compensation; its length is unchanged.
 */
export function voiceoverCaptureSample(timelineSample: number, compensationSamples: number, audioSampleRate: number): number {
  requireNonNegativeSafeInteger(timelineSample, 'Timeline sample')
  if (!Number.isSafeInteger(audioSampleRate) || audioSampleRate <= 0) {
    throw new RangeError('Audio sample rate must be a positive safe integer')
  }
  if (!Number.isSafeInteger(compensationSamples) ||
    Math.abs(compensationSamples) > Math.floor(audioSampleRate * MAX_VOICEOVER_COMPENSATION_SECONDS)) {
    throw new RangeError('Voiceover compensation exceeds the half-second sample bound')
  }
  return safe(BigInt(timelineSample) + BigInt(compensationSamples), 'Capture sample')
}
