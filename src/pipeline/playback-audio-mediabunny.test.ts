import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  DecoderCheckResult,
  DecoderCheckTarget,
} from '../codecs/mediaCodecFallbacks'

const harness = vi.hoisted(() => ({
  track: null as null | {
    getCodec(): Promise<string | null>
    getDecoderConfig(): Promise<AudioDecoderConfig | null>
    canDecode(): Promise<boolean>
  },
  events: [] as string[],
  inputs: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  sinks: [] as Array<{ track: unknown }>,
  ensureDecoderSupport: vi.fn(),
}))

vi.mock('../codecs/mediaCodecFallbacks', () => ({
  ensureMediaDecoderSupport: harness.ensureDecoderSupport,
}))

vi.mock('mediabunny', () => {
  class BlobSource {
    constructor(_blob: Blob) {}
  }

  class Input {
    dispose = vi.fn()

    constructor(_options: unknown) {
      harness.inputs.push(this)
    }

    async getPrimaryAudioTrack() {
      return harness.track
    }
  }

  class AudioBufferSink {
    constructor(track: unknown) {
      harness.events.push('audio-sink')
      harness.sinks.push({ track })
    }

    buffers() {
      return (async function* () {})()
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
  harness.track = null
  harness.events.length = 0
  harness.inputs.length = 0
  harness.sinks.length = 0
  harness.ensureDecoderSupport.mockReset()
})

describe('Mediabunny live-audio fallback wiring', () => {
  test('awaits local E-AC-3 support before constructing an audio sink', async () => {
    const configuration: AudioDecoderConfig = {
      codec: 'ec-3',
      numberOfChannels: 6,
      sampleRate: 48_000,
    }
    const track = {
      getCodec: vi.fn(async () => 'eac3'),
      getDecoderConfig: vi.fn(async () => configuration),
      canDecode: vi.fn(async () => false),
    }
    harness.track = track
    harness.ensureDecoderSupport.mockImplementation(async (
      target: DecoderCheckTarget,
    ): Promise<DecoderCheckResult> => {
      harness.events.push('decoder-check')
      expect(target).toMatchObject({
        codec: 'eac3',
        configuration,
        trackKind: 'audio',
        sourceId: 'asset-eac3',
        boundary: 'audio-playback',
        policy: 'revalidate',
      })
      expect(target.configuration).toBe(configuration)
      expect(await target.canDecode()).toBe(false)
      return {
        decodable: true,
        path: 'local-ac3',
        attemptedFallback: 'ac3',
        failure: null,
      }
    })
    const source = createMediabunnyPlaybackAudioSource(
      async () => new Blob(['eac3']),
    )

    const cursor = await source.openClip({
      assetId: 'asset-eac3',
      startTime: 0,
      endTime: 1,
    })

    expect(harness.events).toEqual(['decoder-check', 'audio-sink'])
    expect(harness.sinks).toEqual([{ track }])
    expect(track.getDecoderConfig).toHaveBeenCalledOnce()
    expect(track.canDecode).toHaveBeenCalledOnce()
    await cursor.close()
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
    await source.close()
  })

  test('disposes the Input when the fallback seam rejects the track', async () => {
    harness.track = {
      getCodec: vi.fn(async () => 'eac3'),
      getDecoderConfig: vi.fn(async () => ({
        codec: 'ec-3',
        numberOfChannels: 6,
        sampleRate: 48_000,
      })),
      canDecode: vi.fn(async () => false),
    }
    harness.ensureDecoderSupport.mockResolvedValue({
      decodable: false,
      path: null,
      attemptedFallback: 'ac3',
      failure: {
        reason: 'unsupported-codec',
        detail: 'Local E-AC-3 decoder rejected this configuration.',
      },
    })
    const source = createMediabunnyPlaybackAudioSource(
      async () => new Blob(['bad-eac3']),
    )

    await expect(source.openClip({
      assetId: 'asset-bad-eac3',
      startTime: 0,
      endTime: 1,
    })).rejects.toThrow('Local E-AC-3 decoder rejected')

    expect(harness.sinks).toHaveLength(0)
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
    await source.close()
  })
})
