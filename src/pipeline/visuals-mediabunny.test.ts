import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  DecoderCheckResult,
  DecoderCheckTarget,
} from '../codecs/mediaCodecFallbacks'

const harness = vi.hoisted(() => ({
  videoTrack: null as null | {
    getCodec(): Promise<string | null>
    canDecode(): Promise<boolean>
  },
  audioTrack: null as null | {
    getCodec(): Promise<string | null>
    canDecode(): Promise<boolean>
  },
  events: [] as string[],
  durationTrackSets: [] as unknown[][],
  inputs: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  canvasSinks: [] as unknown[],
  audioSinks: [] as unknown[],
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

    async getPrimaryVideoTrack() {
      return harness.videoTrack
    }

    async getPrimaryAudioTrack() {
      return harness.audioTrack
    }

    async computeDuration(tracks: readonly unknown[] = []) {
      harness.durationTrackSets.push([...tracks])
      return 1
    }
  }

  class CanvasSink {
    constructor(track: unknown, options: unknown) {
      harness.events.push('canvas-sink')
      harness.canvasSinks.push({ track, options })
    }

    async *canvasesAtTimestamps(timestamps: Iterable<number>) {
      for (const _timestamp of timestamps) {
        yield { canvas: { width: 80, height: 44 } }
      }
    }
  }

  class AudioBufferSink {
    constructor(track: unknown) {
      harness.events.push('audio-sink')
      harness.audioSinks.push({ track })
    }

    async *buffers() {
      yield {
        timestamp: 0,
        buffer: {
          numberOfChannels: 1,
          sampleRate: 48_000,
          getChannelData: () => new Float32Array([0, 0.5, -0.25, 0]),
        },
      }
    }
  }

  return {
    ALL_FORMATS: [],
    AudioBufferSink,
    BlobSource,
    CanvasSink,
    Input,
  }
})

import { generateFilmstrip, generateWaveform } from './visuals'

class FakeOffscreenCanvas {
  readonly width: number
  readonly height: number
  readonly drawImage = vi.fn()

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(): { drawImage: ReturnType<typeof vi.fn> } {
    return { drawImage: this.drawImage }
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob(['filmstrip'], { type: 'image/jpeg' })
  }
}

function localSupport(path: 'local-prores' | 'local-ac3'): DecoderCheckResult {
  return {
    decodable: true,
    path,
    attemptedFallback: path === 'local-prores' ? 'prores' : 'ac3',
    failure: null,
  }
}

beforeEach(() => {
  harness.videoTrack = null
  harness.audioTrack = null
  harness.events.length = 0
  harness.durationTrackSets.length = 0
  harness.inputs.length = 0
  harness.canvasSinks.length = 0
  harness.audioSinks.length = 0
  harness.ensureDecoderSupport.mockReset()
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  URL.createObjectURL = vi.fn(() => 'blob:visual') as typeof URL.createObjectURL
})

describe('Mediabunny visual fallback wiring', () => {
  test('checks local ProRes support and measures only its video track', async () => {
    const track = {
      getCodec: vi.fn(async () => 'prores'),
      canDecode: vi.fn(async () => false),
    }
    harness.videoTrack = track
    harness.ensureDecoderSupport.mockImplementation(async (
      target: DecoderCheckTarget,
    ) => {
      harness.events.push('decoder-check')
      expect(target.codec).toBe('prores')
      return localSupport('local-prores')
    })

    const result = await generateFilmstrip(new Blob(['prores']))

    expect(result).toMatchObject({
      url: 'blob:visual',
      tiles: 1,
      tileWidth: 80,
      tileHeight: 44,
    })
    expect(harness.events).toEqual(['decoder-check', 'canvas-sink'])
    expect(harness.canvasSinks).toEqual([
      { track, options: { height: 44, poolSize: 1 } },
    ])
    expect(harness.durationTrackSets).toEqual([[track]])
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
  })

  test('checks local AC-3 support and measures only its audio track', async () => {
    const track = {
      getCodec: vi.fn(async () => 'ac3'),
      canDecode: vi.fn(async () => false),
    }
    harness.audioTrack = track
    harness.ensureDecoderSupport.mockImplementation(async (
      target: DecoderCheckTarget,
    ) => {
      harness.events.push('decoder-check')
      expect(target.codec).toBe('ac3')
      return localSupport('local-ac3')
    })

    const result = await generateWaveform(new Blob(['ac3']))

    expect(result).toEqual({
      url: 'blob:visual',
      width: 100,
      height: 44,
    })
    expect(harness.events).toEqual(['decoder-check', 'audio-sink'])
    expect(harness.audioSinks).toEqual([{ track }])
    expect(harness.durationTrackSets).toEqual([[track]])
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
  })
})
