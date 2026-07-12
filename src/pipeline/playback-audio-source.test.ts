/**
 * Ownership tests for the real Mediabunny adapter. The library boundary is
 * mocked so these tests can pin Input sharing/eviction without browser codecs.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

const media = vi.hoisted(() => ({
  inputs: [] as Array<{ disposeCalls: number }>,
  iterators: [] as Array<{ returnCalls: number }>,
  failTrackCount: 0,
}))

vi.mock('mediabunny', () => {
  class BlobSource {
    blob: Blob

    constructor(blob: Blob) {
      this.blob = blob
    }
  }

  class Input {
    disposeCalls = 0

    constructor() {
      media.inputs.push(this)
    }

    async getPrimaryAudioTrack() {
      if (media.failTrackCount > 0) {
        media.failTrackCount--
        return null
      }
      return { canDecode: async () => true }
    }

    dispose() {
      this.disposeCalls++
    }
  }

  class AudioBufferSink {
    buffers() {
      return {
        [Symbol.asyncIterator]() {
          const iterator = {
            returnCalls: 0,
            async next() {
              return { done: true, value: undefined }
            },
            async return() {
              iterator.returnCalls++
              return { done: true, value: undefined }
            },
          }
          media.iterators.push(iterator)
          return iterator
        },
      }
    }
  }

  return {
    ALL_FORMATS: [],
    AudioBufferSink,
    BlobSource,
    Input,
  }
})

import { createMediabunnyPlaybackAudioSource } from './playback-audio'

beforeEach(() => {
  media.inputs.length = 0
  media.iterators.length = 0
  media.failTrackCount = 0
})

describe('createMediabunnyPlaybackAudioSource ownership', () => {
  test('shares an Input across overlapping cursors and evicts on the last close', async () => {
    const resolveAsset = vi.fn(async () => new Blob(['media']))
    const source = createMediabunnyPlaybackAudioSource(resolveAsset)

    const first = await source.openClip({
      assetId: 'asset-1',
      startTime: 0,
      endTime: 1,
    })
    const second = await source.openClip({
      assetId: 'asset-1',
      startTime: 0.25,
      endTime: 1.25,
    })

    expect(resolveAsset).toHaveBeenCalledOnce()
    expect(media.inputs).toHaveLength(1)

    await first.close()
    expect(media.inputs[0].disposeCalls).toBe(0)

    await second.close()
    expect(media.inputs[0].disposeCalls).toBe(1)
    expect(media.iterators.map(({ returnCalls }) => returnCalls)).toEqual([1, 1])
    await expect(source.close()).resolves.toBeUndefined()
  })

  test('releases a finished asset before retaining the next one', async () => {
    const source = createMediabunnyPlaybackAudioSource(
      async () => new Blob(['media']),
    )
    const first = await source.openClip({
      assetId: 'asset-1',
      startTime: 0,
      endTime: 1,
    })
    await first.close()

    expect(media.inputs[0].disposeCalls).toBe(1)
    const second = await source.openClip({
      assetId: 'asset-2',
      startTime: 0,
      endTime: 1,
    })
    expect(media.inputs).toHaveLength(2)
    expect(media.inputs[1].disposeCalls).toBe(0)

    await second.close()
    await source.close()
    expect(media.inputs[1].disposeCalls).toBe(1)
  })

  test('does not cache or rethrow an already-reported open failure', async () => {
    media.failTrackCount = 1
    const resolveAsset = vi.fn(async () => new Blob(['media']))
    const source = createMediabunnyPlaybackAudioSource(resolveAsset)

    await expect(source.openClip({
      assetId: 'asset-1',
      startTime: 0,
      endTime: 1,
    })).rejects.toThrow('has no audio track')

    const retry = await source.openClip({
      assetId: 'asset-1',
      startTime: 0,
      endTime: 1,
    })
    expect(resolveAsset).toHaveBeenCalledTimes(2)
    await retry.close()
    await expect(source.close()).resolves.toBeUndefined()
  })
})
