/** Bounded streaming 16 kHz mono preparation; no complete source-rate window. */
import { foldDecodedFrameToStereo } from './audioChannelMix'
export const SPEECH_AUDIO = Object.freeze({ rate: 16_000, minInputRate: 8_000, maxInputRate: 96_000,
  maxChannels: 2, maxBlockFrames: 4_096, maxWindowSeconds: 30, maxSeconds: 300,
  maxWindows: 12, maxPcmBytes: 3_840_000, maxScratchBytes: 2 * 1024 * 1024 })

export function createSpeechResampler(rate: number, channels: number, sourceSamples: number) {
  if (!Number.isSafeInteger(rate) || rate < SPEECH_AUDIO.minInputRate || rate > SPEECH_AUDIO.maxInputRate
    || !Number.isSafeInteger(channels) || channels < 1 || channels > SPEECH_AUDIO.maxChannels
    || !Number.isSafeInteger(sourceSamples) || sourceSamples < 1 || sourceSamples > rate * 30) {
    throw new RangeError('Speech supports bounded mono/stereo audio at 8–96 kHz')
  }
  const output = new Float32Array(Math.floor(sourceSamples * SPEECH_AUDIO.rate / rate))
  if (output.length < 1) throw new RangeError('Speech window contains no complete output sample')
  const ring = new Float32Array(64)
  const radius = 16, cutoff = Math.min(1, SPEECH_AUDIO.rate / rate)
  let received = 0, written = 0, finished = false
  function drain(tail: boolean) {
    while (written < output.length) {
      const position = written * rate / SPEECH_AUDIO.rate
      if (!tail && Math.floor(position) + radius >= received) break
      const first = Math.max(0, Math.floor(position) - radius + 1)
      const last = Math.min(received - 1, Math.floor(position) + radius)
      let sum = 0, weights = 0
      for (let source = first; source <= last; source++) {
        const offset = source - position, x = Math.PI * offset * cutoff
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x
        const weight = cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * offset / radius))
        sum += ring[source % ring.length]! * weight
        weights += weight
      }
      output[written++] = weights === 0 ? 0 : sum / weights
    }
  }
  return {
    outputBytes: output.byteLength,
    scratchBytes: ring.byteLength + channels * SPEECH_AUDIO.maxBlockFrames * 4,
    push(planes: readonly Float32Array[]) {
      const frames = planes[0]?.length ?? 0
      if (finished || planes.length !== channels || frames < 1 || frames > SPEECH_AUDIO.maxBlockFrames
        || planes.some(plane => plane.length !== frames) || received + frames > sourceSamples) {
        throw new RangeError('Speech PCM block exceeds its declared shape or coverage')
      }
      for (let frame = 0; frame < frames; frame++) {
        if (planes.some(plane => !Number.isFinite(plane[frame]))) throw new Error('Non-finite speech PCM')
        const [left, right] = foldDecodedFrameToStereo(planes, frame)
        const mono = (left + right) / 2
        if (!Number.isFinite(mono)) throw new Error('Non-finite speech fold-down')
        ring[received++ % ring.length] = mono
        if (rate === SPEECH_AUDIO.rate) output[written++] = mono
        else drain(false)
      }
    },
    finish(): Float32Array<ArrayBuffer> {
      if (finished || received !== sourceSamples) throw new Error('Incomplete speech audio window')
      finished = true
      if (rate !== SPEECH_AUDIO.rate) drain(true)
      if (written !== output.length || output.some(value => !Number.isFinite(value))) throw new Error('Invalid prepared speech audio')
      return output
    },
  }
}
