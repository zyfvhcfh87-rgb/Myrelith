/** Shared 3-channel and 5.1 fixtures for preview/export fold-down parity. */

import {
  applyStereoBalanceToSample,
  foldDecodedFrameToStereo,
} from '../domain/audioChannelMix'
import { stereoBalanceGains } from '../domain/clipInspector'

export const PARITY_SAMPLE_RATE = 48_000
export const PARITY_FRAME_COUNT = 8

export interface ChannelMixParityCase {
  readonly id: string
  readonly layout: '3-channel' | '5.1'
  readonly channelCount: number
  readonly hotChannel: number
  readonly channelName: string
  readonly balance: number
}

function layoutCases(
  layout: ChannelMixParityCase['layout'],
  channelCount: number,
  channels: readonly (readonly [number, string])[],
): ChannelMixParityCase[] {
  const cases: ChannelMixParityCase[] = []
  for (const balance of [0, 0.5, -0.25]) {
    for (const [hotChannel, channelName] of channels) {
      cases.push({
        id: `${layout} ${channelName} balance=${balance}`,
        layout,
        channelCount,
        hotChannel,
        channelName,
        balance,
      })
    }
  }
  return cases
}

export const MULTICHANNEL_FOLD_PARITY_CASES: readonly ChannelMixParityCase[] = [
  ...layoutCases('3-channel', 3, [
    [0, 'left'],
    [1, 'right'],
    [2, 'center'],
  ]),
  ...layoutCases('5.1', 6, [
    [0, 'left'],
    [1, 'right'],
    [2, 'center'],
    [3, 'LFE'],
    [4, 'left-surround'],
    [5, 'right-surround'],
  ]),
]

export function isolatedParityPlanes(
  channelCount: number,
  hotChannel: number,
): Float32Array[] {
  return Array.from({ length: channelCount }, (_, index) => {
    const plane = new Float32Array(PARITY_FRAME_COUNT)
    if (index === hotChannel) plane.fill(1)
    return plane
  })
}

export function expectedParityStereo(
  planes: readonly Float32Array[],
  frame: number,
  balance: number,
): readonly [number, number] {
  const [left, right] = foldDecodedFrameToStereo(planes, frame)
  const [leftGain, rightGain] = stereoBalanceGains(balance)
  return applyStereoBalanceToSample(left, right, leftGain, rightGain)
}
