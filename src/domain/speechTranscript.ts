/** Serializable source coverage is separate from authored cue endpoints. */
export interface SpeechSegment { text: string; fromCentiseconds: number; toCentiseconds: number }
interface WindowCoverage { sourceStartSample: number; sourceSampleCount: number }
export type SpeechWindow = WindowCoverage & (
  | { timing: 'model'; segments: SpeechSegment[] }
  | { timing: 'unavailable'; reason: 'timestamp-coverage'; text: string }
)
export interface SpeechTranscript {
  sourceSampleRate: number; channels: number; sourceStartSample: number; sourceSampleCount: number; windows: SpeechWindow[]
}
export function validateSpeechTranscript(value: SpeechTranscript): void {
  const rate = value?.sourceSampleRate
  if (!Number.isSafeInteger(rate) || rate < 8_000 || rate > 96_000 || ![1, 2].includes(value.channels)
    || !Number.isSafeInteger(value.sourceStartSample) || value.sourceStartSample < 0
    || !Number.isSafeInteger(value.sourceSampleCount) || value.sourceSampleCount < rate
    || value.sourceSampleCount > rate * 300 || !Array.isArray(value.windows)
    || value.windows.length < 1 || value.windows.length > 12) throw new Error('Malformed bounded speech transcript')
  const end = value.sourceStartSample + value.sourceSampleCount
  let next = value.sourceStartSample
  for (const window of value.windows) {
    if (next >= end || window.sourceStartSample !== next || window.sourceSampleCount !== Math.min(rate * 30, end - next)) throw new Error('Speech window plan differs from selected source coverage')
    if (window.timing === 'unavailable') {
      if (window.reason !== 'timestamp-coverage' || typeof window.text !== 'string' || !window.text.trim()
        || window.text.length > 20_000 || 'segments' in window) throw new Error('Malformed untimed speech review')
    } else if (window.timing === 'model') {
      if (!Array.isArray(window.segments) || window.segments.length > 1000 || 'text' in window) throw new Error('Malformed timed speech review')
      let previous = 0, characters = 0
      for (const cue of window.segments) {
        if (!Number.isSafeInteger(cue.fromCentiseconds) || !Number.isSafeInteger(cue.toCentiseconds)
          || cue.fromCentiseconds < previous || cue.toCentiseconds <= cue.fromCentiseconds
          || cue.toCentiseconds * rate > window.sourceSampleCount * 100
          || typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 4_000) throw new Error('Speech cue is outside source coverage')
        previous = cue.toCentiseconds; characters += cue.text.length
      }
      if (characters > 20_000) throw new Error('Speech window text exceeds its budget')
    } else throw new Error('Unknown speech timing mode')
    next = next + window.sourceSampleCount === end ? end : next + rate * 25
  }
  if (next !== end) throw new Error('Speech transcript is incomplete')
}
