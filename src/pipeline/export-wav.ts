/**
 * First-party PCM WAV writer. Sample rate and channel count stay on the
 * document contract; this path never downsamples or invents a video stream.
 * The file is allocated once and filled block by block, so a WAV export
 * never holds whole-program float planes beside the encoded bytes.
 */

const WAV_HEADER_BYTES = 44

function clampS16(sample: number): number {
  const scaled = Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
  return Math.max(-32768, Math.min(32767, scaled))
}

/**
 * Allocate a complete mono/stereo 16-bit PCM WAV file for `sampleCount`
 * frames and write its header. Fill the data with writePcmS16WavFrames.
 */
export function createPcmS16WavBuffer(
  sampleCount: number,
  channelCount: number,
  sampleRate: number,
): ArrayBuffer {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('WAV sample rate must be a positive safe integer')
  }
  if (channelCount !== 1 && channelCount !== 2) {
    throw new TypeError('WAV PCM requires mono or stereo float planes')
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
    throw new RangeError('WAV sample count must be a non-negative safe integer')
  }
  const dataBytes = sampleCount * channelCount * 2
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
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
  return buffer
}

/**
 * Write `count` frames of clamped, interleaved s16 samples from one float
 * plane per WAV channel, starting at output frame `frameOffset`.
 */
export function writePcmS16WavFrames(
  view: DataView,
  planes: readonly ArrayLike<number>[],
  frameOffset: number,
  count: number,
): void {
  const channelCount = view.getUint16(22, true)
  if (planes.length !== channelCount) {
    throw new TypeError('WAV block planes must match the file channel count')
  }
  let offset = WAV_HEADER_BYTES + frameOffset * channelCount * 2
  if (
    !Number.isSafeInteger(frameOffset)
    || frameOffset < 0
    || offset + count * channelCount * 2 > view.byteLength
  ) {
    throw new RangeError('WAV block is outside the allocated sample range')
  }
  for (let sample = 0; sample < count; sample++) {
    for (const plane of planes) {
      view.setInt16(offset, clampS16(plane[sample]!), true)
      offset += 2
    }
  }
}
