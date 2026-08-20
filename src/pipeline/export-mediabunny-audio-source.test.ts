import { describe, expect, test } from 'vitest'
import { applyStereoBalanceToSample } from '../domain/audioChannelMix'
import { stereoBalanceGains } from '../domain/clipInspector'
import {
  expectedParityStereo,
  isolatedParityPlanes,
  MULTICHANNEL_FOLD_PARITY_CASES,
  PARITY_FRAME_COUNT,
  PARITY_SAMPLE_RATE,
} from '../test/audioChannelMixParity'
import {
  adapterTestSubject,
  audioTrack,
  decodedAudioSample,
  inputAt,
  mb,
  resolvedAsset,
} from './export-mediabunny.test-harness'

const {
  MediaAssetRuntimeError,
  createMediabunnyExportAudioSource,
} = adapterTestSubject

async function exportFoldedParity(
  planes: readonly Float32Array[],
  balance: number,
): Promise<readonly [Float32Array, Float32Array]> {
  const decoded = decodedAudioSample(planes, PARITY_SAMPLE_RATE)
  mb.audioTracks.push(audioTrack(true, planes.length))
  mb.audioSinkSampleSequences.push([decoded])
  const source = createMediabunnyExportAudioSource(
    async () => resolvedAsset(new Blob(['multichannel-audio'])),
  )
  const reader = await source.openClip({
    clipId: 'parity',
    assetId: 'audio-asset',
    startSample: 0,
    endSample: PARITY_FRAME_COUNT,
    sampleRate: PARITY_SAMPLE_RATE,
    channelCount: 2,
  })
  const channels = await reader.read(PARITY_FRAME_COUNT)
  const [leftGain, rightGain] = stereoBalanceGains(balance)
  const left = new Float32Array(PARITY_FRAME_COUNT)
  const right = new Float32Array(PARITY_FRAME_COUNT)
  for (let frame = 0; frame < PARITY_FRAME_COUNT; frame++) {
    const balanced = applyStereoBalanceToSample(
      channels[0][frame],
      channels[1][frame],
      leftGain,
      rightGain,
    )
    left[frame] = balanced[0]
    right[frame] = balanced[1]
  }
  await reader.close()
  await source.close()
  expect(decoded.copyTo).toHaveBeenCalledTimes(planes.length)
  expect(decoded.close).toHaveBeenCalledOnce()
  return [left, right]
}

describe('createMediabunnyExportAudioSource exact ranges', () => {
  test('fails an exact crossfade handle instead of zero-filling early EOF', async () => {
    const decoded = decodedAudioSample(
      [new Float32Array(4).fill(0.25)],
      48_000,
    )
    mb.audioTracks.push(audioTrack(true, 1))
    mb.audioSinkSampleSequences.push([decoded])
    const source = createMediabunnyExportAudioSource(
      async () => resolvedAsset(new Blob(['short-audio'])),
    )
    const reader = await source.openClip({
      clipId: 'exact-handle',
      assetId: 'audio-asset',
      startSample: 0,
      endSample: 10,
      sampleRate: 48_000,
      channelCount: 2,
      requireComplete: true,
    })

    const failure = await reader.read(10).catch((cause) => cause)
    expect(failure).toBeInstanceOf(MediaAssetRuntimeError)
    expect(failure).toMatchObject({
      assetId: 'audio-asset',
      failure: {
        surface: 'export',
        trackKind: 'audio',
        reason: 'decode-failed',
        detail: expect.stringContaining('source ended early'),
      },
    })

    await reader.close()
    await source.close()
    expect(decoded.close).toHaveBeenCalledOnce()
    expect(inputAt().dispose).toHaveBeenCalledOnce()
  })
})

describe('multichannel preview/export fold-down parity', () => {
  test.each(MULTICHANNEL_FOLD_PARITY_CASES)(
    'export keeps $id through fold-down and balance',
    async ({ channelCount, hotChannel, balance }) => {
      const planes = isolatedParityPlanes(channelCount, hotChannel)
      const [left, right] = await exportFoldedParity(planes, balance)
      for (let frame = 0; frame < PARITY_FRAME_COUNT; frame++) {
        const expected = expectedParityStereo(planes, frame, balance)
        expect(left[frame]).toBeCloseTo(expected[0])
        expect(right[frame]).toBeCloseTo(expected[1])
      }
    },
  )

  test('export mixed 5.1 matches the shared fold before and after balance', async () => {
    const values = [0.05, 0.1, 0.05, 0.02, 0.05, 0.1]
    const planes = values.map((value) => {
      const plane = new Float32Array(PARITY_FRAME_COUNT)
      plane.fill(value)
      return plane
    })
    for (const balance of [0, 0.5]) {
      const [left, right] = await exportFoldedParity(planes, balance)
      const expected = expectedParityStereo(planes, 0, balance)
      expect(left[0]).toBeCloseTo(expected[0])
      expect(right[0]).toBeCloseTo(expected[1])
    }
  })
})
