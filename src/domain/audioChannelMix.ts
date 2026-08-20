/**
 * Browser-free decoded-channel fold-down shared by live preview and export.
 *
 * Layouts match Web Audio's canonical channel orders. Extra discrete channels
 * fold alternately at -6 dB rather than failing closed. Clip balance is a
 * separate stereo-gain step applied after this fold.
 */

export const MAX_DECODED_AUDIO_CHANNELS = 32
export const STEREO_OUTPUT_CHANNELS = 2

/** Center and first-ring surrounds fold at -3 dB. */
export const AUDIO_FOLD_CENTER_GAIN = Math.SQRT1_2
/** LFE and extra discrete channels fold at -6 dB. */
export const AUDIO_FOLD_LFE_GAIN = 0.5

function assertDecodedChannelCount(channelCount: number): void {
  if (
    !Number.isSafeInteger(channelCount)
    || channelCount <= 0
    || channelCount > MAX_DECODED_AUDIO_CHANNELS
  ) {
    throw new RangeError(
      'Decoded audio channel count must be a safe integer from 1 to 32',
    )
  }
}

function foldOneStereoSide(
  sampleAt: (channelIndex: number) => number,
  channelCount: number,
  outputChannel: 0 | 1,
): number {
  let value = sampleAt(outputChannel)
  if (channelCount === 3) {
    value += sampleAt(2) * AUDIO_FOLD_CENTER_GAIN
  } else if (channelCount === 4) {
    value += sampleAt(outputChannel + 2) * AUDIO_FOLD_CENTER_GAIN
  } else if (channelCount === 5) {
    value += sampleAt(2) * AUDIO_FOLD_CENTER_GAIN
    value += sampleAt(outputChannel + 3) * AUDIO_FOLD_CENTER_GAIN
  } else {
    value += sampleAt(2) * AUDIO_FOLD_CENTER_GAIN
    value += sampleAt(3) * AUDIO_FOLD_LFE_GAIN
    value += sampleAt(outputChannel + 4) * AUDIO_FOLD_CENTER_GAIN
    for (
      let index = 6 + outputChannel;
      index < channelCount;
      index += 2
    ) {
      value += sampleAt(index) * AUDIO_FOLD_LFE_GAIN
    }
  }
  return value
}

/**
 * Fold one decoded frame to stereo.
 *
 * 1=M, 2=L/R, 3=L/R/C, 4=L/R/SL/SR, 5=L/R/C/SL/SR, 6=L/R/C/LFE/SL/SR.
 * Channels 7–32 are extra discrete pairs folded alternately at -6 dB.
 */
export function foldSourceChannelsToStereo(
  sampleAt: (channelIndex: number) => number,
  channelCount: number,
): readonly [number, number] {
  assertDecodedChannelCount(channelCount)
  if (channelCount === 1) {
    const mono = sampleAt(0)
    return [mono, mono]
  }
  if (channelCount === 2) return [sampleAt(0), sampleAt(1)]
  return [
    foldOneStereoSide(sampleAt, channelCount, 0),
    foldOneStereoSide(sampleAt, channelCount, 1),
  ]
}

/** Read one frame of planar PCM and fold it with the shared policy. */
export function foldDecodedFrameToStereo(
  channels: readonly ArrayLike<number>[],
  frame: number,
): readonly [number, number] {
  return foldSourceChannelsToStereo(
    (index) => {
      const plane = channels[index]
      return plane?.[frame] ?? 0
    },
    channels.length,
  )
}

/** Apply already-resolved stereo balance gains after fold-down. */
export function applyStereoBalanceToSample(
  left: number,
  right: number,
  leftGain: number,
  rightGain: number,
): readonly [number, number] {
  return [left * leftGain, right * rightGain]
}
