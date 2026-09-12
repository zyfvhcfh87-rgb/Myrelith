/**
 * First-party PCM WAV writer. Sample rate and channel count stay on the
 * document contract; this path never downsamples or invents a video stream.
 */

export type WavChannelLayout = 'mono' | 'stereo'

function clampS16(sample: number): number {
  const scaled = Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
  return Math.max(-32768, Math.min(32767, scaled))
}

export function wavPcmByteLength(
  sampleCount: number,
  layout: WavChannelLayout,
): number {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
    throw new RangeError('WAV sample count must be a non-negative safe integer')
  }
  const channels = layout === 'mono' ? 1 : 2
  return 44 + sampleCount * channels * 2
}

export function encodePcmS16Wav(
  channels: readonly Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('WAV sample rate must be a positive safe integer')
  }
  if (channels.length !== 1 && channels.length !== 2) {
    throw new TypeError('WAV PCM requires mono or stereo float planes')
  }
  const sampleCount = channels[0]?.length ?? 0
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
    throw new RangeError('WAV sample count must be a non-negative safe integer')
  }
  for (const plane of channels) {
    if (plane.length !== sampleCount) throw new RangeError('WAV channel planes must match in length')
  }
  const channelCount = channels.length
  const dataBytes = sampleCount * channelCount * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let sample = 0; sample < sampleCount; sample++) {
    for (const plane of channels) {
      view.setInt16(offset, clampS16(plane[sample]!), true)
      offset += 2
    }
  }
  return buffer
}

export function wavChannelCount(layout: WavChannelLayout): 1 | 2 {
  return layout === 'mono' ? 1 : 2
}
