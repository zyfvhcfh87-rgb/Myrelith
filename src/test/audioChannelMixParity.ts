/** Shared mono, 3-channel, and 5.1 fixtures for preview/export fold-down parity. */

import {
  applyStereoBalanceToSample,
  foldDecodedFrameToStereo,
} from '../domain/audioChannelMix'
import { stereoBalanceGains } from '../domain/clipInspector'

export const PARITY_SAMPLE_RATE = 48_000
export const PARITY_FRAME_COUNT = 8

export interface ChannelMixParityCase {
  readonly id: string
  readonly layout: 'mono' | '3-channel' | '5.1'
  readonly channelCount: number
  readonly hotChannel: number
  readonly channelName: string
  readonly balance: number
}

/** Center, full-left, full-right, and intermediate clip-balance values. */
export const MONO_BALANCE_PARITY_VALUES = [-1, -0.25, 0, 0.5, 1] as const

export const MONO_BALANCE_PARITY_CASES: readonly ChannelMixParityCase[] =
  MONO_BALANCE_PARITY_VALUES.map((balance) => ({
    id: `mono balance=${balance}`,
    layout: 'mono',
    channelCount: 1,
    hotChannel: 0,
    channelName: 'mono',
    balance,
  }))

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

/**
 * Discrete ChannelSplitter(2) semantics: output i is source channel i,
 * or silence when that channel is absent. This is what the live meter
 * and clip-balance graphs hear if preview skips the shared upmix.
 */
export function discreteSplitterPlanes(buffer: AudioBuffer): readonly [
  Float32Array,
  Float32Array,
] {
  const silent = new Float32Array(buffer.length)
  return [
    buffer.numberOfChannels > 0 ? buffer.getChannelData(0) : silent,
    buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : silent,
  ]
}

export function planeEnergy(plane: ArrayLike<number>): {
  readonly max: number
  readonly sum: number
} {
  let max = 0
  let sum = 0
  for (let index = 0; index < plane.length; index++) {
    const magnitude = Math.abs(plane[index] ?? 0)
    max = Math.max(max, magnitude)
    sum += magnitude
  }
  return { max, sum }
}
