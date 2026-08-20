import { describe, expect, test } from 'vitest'
import { stereoBalanceGains } from './clipInspector'
import {
  applyStereoBalanceToSample,
  AUDIO_FOLD_CENTER_GAIN,
  AUDIO_FOLD_LFE_GAIN,
  foldDecodedFrameToStereo,
  foldSourceChannelsToStereo,
} from './audioChannelMix'

const CENTER = AUDIO_FOLD_CENTER_GAIN
const LFE = AUDIO_FOLD_LFE_GAIN

function planesFromValues(values: readonly number[]): number[][] {
  return values.map((value) => [value])
}

function isolatedValues(channelCount: number, hotIndex: number): number[] {
  return Array.from({ length: channelCount }, (_, index) => (
    index === hotIndex ? 1 : 0
  ))
}

describe('shared decoded-channel fold-down', () => {
  test('duplicates mono and passes stereo through unchanged', () => {
    expect(foldSourceChannelsToStereo(() => 0.4, 1)).toEqual([0.4, 0.4])
    expect(foldDecodedFrameToStereo(planesFromValues([0.25, -0.5]), 0))
      .toEqual([0.25, -0.5])
  })

  test.each([
    {
      name: '3-channel L/R/C',
      values: isolatedValues(3, 0),
      expected: [1, 0],
    },
    {
      name: '3-channel right',
      values: isolatedValues(3, 1),
      expected: [0, 1],
    },
    {
      name: '3-channel center',
      values: isolatedValues(3, 2),
      expected: [CENTER, CENTER],
    },
    {
      name: 'quad left-surround',
      values: isolatedValues(4, 2),
      expected: [CENTER, 0],
    },
    {
      name: 'quad right-surround',
      values: isolatedValues(4, 3),
      expected: [0, CENTER],
    },
    {
      name: '5.0 center',
      values: isolatedValues(5, 2),
      expected: [CENTER, CENTER],
    },
    {
      name: '5.0 left-surround',
      values: isolatedValues(5, 3),
      expected: [CENTER, 0],
    },
    {
      name: '5.0 right-surround',
      values: isolatedValues(5, 4),
      expected: [0, CENTER],
    },
    {
      name: '5.1 left',
      values: isolatedValues(6, 0),
      expected: [1, 0],
    },
    {
      name: '5.1 right',
      values: isolatedValues(6, 1),
      expected: [0, 1],
    },
    {
      name: '5.1 center',
      values: isolatedValues(6, 2),
      expected: [CENTER, CENTER],
    },
    {
      name: '5.1 LFE',
      values: isolatedValues(6, 3),
      expected: [LFE, LFE],
    },
    {
      name: '5.1 left-surround',
      values: isolatedValues(6, 4),
      expected: [CENTER, 0],
    },
    {
      name: '5.1 right-surround',
      values: isolatedValues(6, 5),
      expected: [0, CENTER],
    },
    {
      name: '7.1 extra left discrete',
      values: isolatedValues(8, 6),
      expected: [LFE, 0],
    },
    {
      name: '7.1 extra right discrete',
      values: isolatedValues(8, 7),
      expected: [0, LFE],
    },
  ])('includes $name in the stereo fold', ({ values, expected }) => {
    expect(foldDecodedFrameToStereo(planesFromValues(values), 0)).toEqual(
      expected,
    )
  })

  test('folds a mixed 5.1 frame before balance', () => {
    const values = [0.05, 0.1, 0.05, 0.02, 0.05, 0.1]
    let left = 0.05
    left += 0.05 * CENTER
    left += 0.02 * LFE
    left += 0.05 * CENTER
    let right = 0.1
    right += 0.05 * CENTER
    right += 0.02 * LFE
    right += 0.1 * CENTER
    expect(foldDecodedFrameToStereo(planesFromValues(values), 0)).toEqual([
      left,
      right,
    ])
  })

  test('applies stereo balance only after fold-down', () => {
    const [leftGain, rightGain] = stereoBalanceGains(0.5)
    const [left, right] = foldDecodedFrameToStereo(
      planesFromValues(isolatedValues(3, 2)),
      0,
    )
    expect(applyStereoBalanceToSample(left, right, leftGain, rightGain))
      .toEqual([CENTER * 0.5, CENTER])
  })

  test.each([-1, -0.25, 0, 0.5, 1])(
    'keeps duplicated mono audible after balance %s',
    (balance) => {
      const [foldedLeft, foldedRight] = foldSourceChannelsToStereo(() => 0.4, 1)
      const [leftGain, rightGain] = stereoBalanceGains(balance)
      const [left, right] = applyStereoBalanceToSample(
        foldedLeft,
        foldedRight,
        leftGain,
        rightGain,
      )
      expect(foldedLeft).toBe(0.4)
      expect(foldedRight).toBe(0.4)
      expect(left).toBeCloseTo(0.4 * leftGain)
      expect(right).toBeCloseTo(0.4 * rightGain)
      if (balance < 1) expect(Math.abs(left)).toBeGreaterThan(0)
      if (balance > -1) expect(Math.abs(right)).toBeGreaterThan(0)
    },
  )

  test('rejects an invalid decoded channel count', () => {
    expect(() => foldSourceChannelsToStereo(() => 0, 0)).toThrow(/1 to 32/)
    expect(() => foldSourceChannelsToStereo(() => 0, 33)).toThrow(/1 to 32/)
  })
})
