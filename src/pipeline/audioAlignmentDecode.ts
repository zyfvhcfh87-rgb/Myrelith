/** One source, one iterator, bounded copied PCM; called only in the analysis worker. */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type AudioSample } from 'mediabunny'
import { ensureMediaDecoderSupport, refineAudioDecoderBudget, type LocalDecoderBudget } from '../codecs/mediaCodecFallbacks'
import { createAudioFingerprintBuilder, MULTICAM_ALIGNMENT_LIMITS as LIMITS, type AudioFingerprintRequest } from '../domain/multicamAlignment'
import type { AudioAlignmentSourceFacts } from './audioAlignmentProtocol'

/** Consume an owned sample in bounded blocks and close it even on malformed output. */
export function consumeAlignmentSample(
  sample: Pick<AudioSample, 'timestamp' | 'sampleRate' | 'numberOfChannels' | 'numberOfFrames' | 'copyTo' | 'close'>,
  request: AudioFingerprintRequest,
  nextSample: number,
  previousEnd: number | null,
  push: (planes: readonly Float32Array[], firstSample: number) => void,
): { nextSample: number; previousEnd: number } {
  try {
    const position = sample.timestamp * request.inputSampleRate
    const start = Math.round(position)
    if (!Number.isFinite(position) || !Number.isSafeInteger(start)
      || Math.abs(position - start) > 0.25
      || sample.sampleRate !== request.inputSampleRate || sample.numberOfChannels !== request.channels
      || !Number.isSafeInteger(sample.numberOfFrames) || sample.numberOfFrames < 1
      || sample.numberOfFrames > LIMITS.maxInputRate // Reject >1 second native blocks before copying.
      || start > nextSample || (previousEnd !== null && start !== previousEnd)) {
      throw new Error('Audio timestamps, rate or channel layout are not continuous on the source sample grid')
    }
    const end = start + sample.numberOfFrames
    const requestedEnd = request.startSample + Math.ceil(request.binCount * request.inputSampleRate / LIMITS.featureRate)
    while (nextSample < Math.min(end, requestedEnd)) {
      const count = Math.min(LIMITS.maxBlockFrames, end - nextSample, requestedEnd - nextSample)
      const planes = Array.from({ length: request.channels }, (_, planeIndex) => {
        const plane = new Float32Array(count)
        sample.copyTo(plane, { format: 'f32-planar', planeIndex, frameOffset: nextSample - start, frameCount: count })
        return plane
      })
      push(planes, nextSample)
      nextSample += count
    }
    return { nextSample, previousEnd: end }
  } finally { sample.close() }
}

export async function openAudioAlignmentSource(blob: Blob, sourceId: string, budget: LocalDecoderBudget) {
  if (!(blob instanceof Blob) || blob.size < 1) throw new TypeError('Audio source is empty')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('This angle has no included audio stream')
    const configuration = await track.getDecoderConfig()
    if (!configuration) throw new Error('Audio decoder configuration is unavailable')
    const rate = await track.getSampleRate()
    const channels = await track.getNumberOfChannels()
    const firstTimestamp = await track.getFirstTimestamp()
    const endTimestamp = await track.computeDuration()
    if (!Number.isSafeInteger(rate) || rate < LIMITS.minInputRate || rate > LIMITS.maxInputRate
      || !Number.isSafeInteger(channels) || channels < 1 || channels > LIMITS.maxChannels
      || !Number.isFinite(firstTimestamp) || !Number.isFinite(endTimestamp)
      || Math.abs(firstTimestamp) > LIMITS.maxSourceSeconds || endTimestamp <= 0 || endTimestamp > LIMITS.maxSourceSeconds
      || !Number.isSafeInteger(track.number) || track.number < 1 || track.number > 256
      || configuration.sampleRate !== rate || configuration.numberOfChannels !== channels) {
      throw new RangeError('Audio alignment supports continuous mono/stereo sources at 8–96 kHz, up to 24 hours')
    }
    const description = configuration.description
    if (description && description.byteLength > 65_536) throw new RangeError('Audio codec configuration is too large')
    const descriptionBytes = !description ? [] : Array.from(ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description))
    if (Object.keys(configuration).some((key) => !['codec', 'sampleRate', 'numberOfChannels', 'description'].includes(key))) {
      throw new Error('Audio codec configuration contains unsupported semantics')
    }
    const support = await ensureMediaDecoderSupport({
      codec: await track.getCodec(), configuration, canDecode: () => track.canDecode(),
      trackKind: 'audio', sourceId, boundary: 'audio-alignment', policy: 'revalidate',
      budget: refineAudioDecoderBudget(budget, blob.size, configuration),
    })
    if (!support.decodable) throw new Error(support.failure.detail)
    const facts: AudioAlignmentSourceFacts = {
      inputSampleRate: rate, channels, audioStreamIndex: track.number - 1, audioTrackId: String(track.id),
      firstTimestamp, endTimestamp,
      decodePolicy: JSON.stringify(['myrelith-audio-decode-v1', 'mediabunny-1.50.9',
        support.path, support.attemptedFallback, navigator.userAgent,
        configuration.codec, rate, channels, descriptionBytes,
        'source-presentation-zero-continuous-v1', 'quarter-sample-timestamp-tolerance',
        'no-padding-no-resampling', LIMITS.maxBlockFrames, LIMITS.maxInputRate]),
    }
    let used = false
    return {
      facts,
      async decode(request: AudioFingerprintRequest, progress: (fraction: number) => void) {
        if (used) throw new Error('Audio decode owner is one-shot')
        used = true
        const builder = createAudioFingerprintBuilder(request)
        const count = Math.ceil(request.binCount * rate / LIMITS.featureRate)
        const end = request.startSample + count
        if (request.inputSampleRate !== rate || request.channels !== channels
          || request.startSample / rate < Math.max(0, firstTimestamp)
          || end / rate > endTimestamp + 0.25 / rate) {
          throw new RangeError('The complete selected audio window is outside the source coverage')
        }
        const iterator = new AudioSampleSink(track).samples(request.startSample / rate, end / rate)
        let cursor = { nextSample: request.startSample, previousEnd: null as number | null }
        let blocks = 0
        try {
          while (cursor.nextSample < end) {
            const step = await iterator.next()
            if (step.done) break
            cursor = consumeAlignmentSample(step.value, request, cursor.nextSample, cursor.previousEnd, builder.push)
            if (++blocks % 16 === 0) progress((cursor.nextSample - request.startSample) / count)
          }
          return builder.finish()
        } finally {
          await iterator.return()
          input.dispose()
        }
      },
      close: () => input.dispose(),
    }
  } catch (cause) { input.dispose(); throw cause }
}
