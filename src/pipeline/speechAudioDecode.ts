/** One sequential source/iterator, bounded copied planes, exact sample ownership. */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type AudioSample } from 'mediabunny'
import { ensureMediaDecoderSupport, refineAudioDecoderBudget, type LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import { createSpeechResampler, SPEECH_AUDIO } from '../domain/speechAudio'

export interface SpeechDecodeLedger {
  inputOwners: number; sampleOwners: number; acquiredSamples: number; closedSamples: number
}
export function consumeSpeechSample(sample: Pick<AudioSample, 'timestamp' | 'sampleRate' | 'numberOfChannels' | 'numberOfFrames' | 'copyTo' | 'close'>,
  rate: number, channels: number, cursor: number, end: number, previousEnd: number | null,
  push: (planes: readonly Float32Array[]) => void): { cursor: number; previousEnd: number } {
  try {
    const position = sample.timestamp * rate, first = Math.round(position)
    if (!Number.isSafeInteger(first) || Math.abs(position - first) > 0.25 || sample.sampleRate !== rate
      || sample.numberOfChannels !== channels || !Number.isSafeInteger(sample.numberOfFrames)
      || sample.numberOfFrames < 1 || sample.numberOfFrames > rate || first > cursor
      || (previousEnd !== null && first !== previousEnd)) throw new Error('Speech requires continuous audio timestamps on the source sample grid')
    const last = first + sample.numberOfFrames
    while (cursor < Math.min(end, last)) {
      const count = Math.min(SPEECH_AUDIO.maxBlockFrames, end - cursor, last - cursor)
      const planes = Array.from({ length: channels }, (_, planeIndex) => {
        const plane = new Float32Array(count)
        sample.copyTo(plane, { format: 'f32-planar', planeIndex, frameOffset: cursor - first, frameCount: count })
        return plane
      })
      push(planes)
      cursor += count
    }
    return { cursor, previousEnd: last }
  } finally { sample.close() }
}
export async function openSpeechAudioSource(blob: Blob, sourceId: string, budget: LocalDecoderBudget, ledger: SpeechDecodeLedger) {
  if (!(blob instanceof Blob) || blob.size < 1) throw new Error('The connected audio source is empty')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  ledger.inputOwners++
  let closed = false
  const close = () => { if (!closed) { input.dispose(); closed = true; ledger.inputOwners-- } }
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('This source has no audio stream')
    const configuration = await track.getDecoderConfig()
    if (!configuration) throw new Error('Audio decoder configuration is unavailable')
    const rate = await track.getSampleRate(), channels = await track.getNumberOfChannels()
    const firstTimestamp = await track.getFirstTimestamp(), endTimestamp = await track.computeDuration()
    if (!Number.isSafeInteger(rate) || rate < 8_000 || rate > 96_000 || ![1, 2].includes(channels)
      || !Number.isFinite(firstTimestamp) || !Number.isFinite(endTimestamp) || Math.abs(firstTimestamp) > 86400
      || endTimestamp <= 0 || endTimestamp > 86400 || configuration.sampleRate !== rate
      || configuration.numberOfChannels !== channels || (configuration.description?.byteLength ?? 0) > 65_536
      || Object.keys(configuration).some(key => !['codec', 'sampleRate', 'numberOfChannels', 'description'].includes(key))) {
      throw new Error('Speech supports continuous mono/stereo sources at 8–96 kHz, up to 24 hours')
    }
    const support = await ensureMediaDecoderSupport({ codec: await track.getCodec(), configuration,
      canDecode: () => track.canDecode(), trackKind: 'audio', sourceId, boundary: 'caption-transcription', policy: 'revalidate',
      budget: refineAudioDecoderBudget(budget, blob.size, configuration) })
    if (!support.decodable) throw new Error(support.failure.detail)
    return { rate, channels, firstTimestamp, endTimestamp, close,
      async prepare(first: number, count: number, cancellationPoint: () => Promise<void>) {
        if (closed || !Number.isSafeInteger(first) || !Number.isSafeInteger(count)
          || first / rate < Math.max(0, firstTimestamp) || (first + count) / rate > endTimestamp + 0.25 / rate) {
          throw new Error('The complete speech window is outside audio source coverage')
        }
        const builder = createSpeechResampler(rate, channels, count)
        const end = first + count
        const iterator = new AudioSampleSink(track).samples(first / rate, end / rate)
        let cursor = { cursor: first, previousEnd: null as number | null }
        try {
          while (cursor.cursor < end) {
            await cancellationPoint()
            const step = await iterator.next()
            if (step.done) break
            ledger.acquiredSamples++; ledger.sampleOwners++
            let sampleClosed = false
            // Record closure only after close returns; an exception cannot forge acknowledgement.
            const sample = step.value
            try {
              cursor = consumeSpeechSample({ timestamp: sample.timestamp, sampleRate: sample.sampleRate,
                numberOfChannels: sample.numberOfChannels, numberOfFrames: sample.numberOfFrames,
                copyTo: sample.copyTo.bind(sample), close: () => { sample.close(); sampleClosed = true } },
              rate, channels, cursor.cursor, end, cursor.previousEnd, builder.push)
            } finally { if (sampleClosed) { ledger.sampleOwners--; ledger.closedSamples++ } }
          }
          return builder.finish()
        } finally { await iterator.return() }
      },
    }
  } catch (cause) { close(); throw cause }
}
