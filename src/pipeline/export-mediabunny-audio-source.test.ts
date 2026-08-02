import { describe, expect, test } from 'vitest'
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
