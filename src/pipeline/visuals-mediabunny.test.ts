import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  DecoderCheckResult,
  DecoderCheckTarget,
  LocalDecoderBudget,
} from '../codecs/mediaCodecFallbacks'

const VISUAL_BUDGET: LocalDecoderBudget = {
  fileBytes: 1,
  durationMicroseconds: 1_000_000,
  width: 1920,
  height: 1080,
  framesPerSecond: 30,
  sampleRate: 48_000,
  channels: 6,
}

const decodeOptions = (sourceId: string) => ({
  sourceId,
  budget: VISUAL_BUDGET,
})

const harness = vi.hoisted(() => ({
  videoTrack: null as null | {
    getCodec(): Promise<string | null>
    getDecoderConfig(): Promise<VideoDecoderConfig | null>
    getDisplayWidth(): Promise<number>
    getDisplayHeight(): Promise<number>
    canDecode(): Promise<boolean>
  },
  audioTrack: null as null | {
    getCodec(): Promise<string | null>
    getDecoderConfig(): Promise<AudioDecoderConfig | null>
    canDecode(): Promise<boolean>
  },
  events: [] as string[],
  durationTrackSets: [] as unknown[][],
  inputs: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  canvasSinks: [] as unknown[],
  audioSinks: [] as unknown[],
  offscreenCanvases: [] as Array<{ width: number; height: number }>,
  durationSec: 1,
  ensureDecoderSupport: vi.fn(),
}))

vi.mock('../codecs/mediaCodecFallbacks', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../codecs/mediaCodecFallbacks')
  >()
  return {
    ...actual,
    ensureMediaDecoderSupport: harness.ensureDecoderSupport,
  }
})

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
      return harness.durationSec
    }
  }

  class CanvasSink {
    private readonly options: { width?: number; height?: number }

    constructor(
      track: unknown,
      options: { width?: number; height?: number },
    ) {
      this.options = options
      harness.events.push('canvas-sink')
      harness.canvasSinks.push({ track, options })
    }

    async *canvasesAtTimestamps(timestamps: Iterable<number>) {
      for (const _timestamp of timestamps) {
        yield {
          canvas: {
            width: this.options.width ?? 80,
            height: this.options.height ?? 44,
          },
        }
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

import {
  MediaVisualDecodeError,
  generateFilmstrip,
  generateWaveform,
} from './visuals'

class FakeOffscreenCanvas {
  readonly width: number
  readonly height: number
  readonly drawImage = vi.fn()

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    harness.offscreenCanvases.push(this)
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
  harness.offscreenCanvases.length = 0
  harness.durationSec = 1
  harness.ensureDecoderSupport.mockReset()
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  URL.createObjectURL = vi.fn(() => 'blob:visual') as typeof URL.createObjectURL
})

describe('Mediabunny visual fallback wiring', () => {
  test('checks local ProRes support and measures only its video track', async () => {
    const configuration: VideoDecoderConfig = {
      codec: 'apch',
      codedWidth: 1280,
      codedHeight: 720,
      description: new Uint8Array([1, 2, 3]),
    }
    const track = {
      getCodec: vi.fn(async () => 'prores'),
      getDecoderConfig: vi.fn(async () => configuration),
      getDisplayWidth: vi.fn(async () => 1920),
      getDisplayHeight: vi.fn(async () => 1080),
      canDecode: vi.fn(async () => false),
    }
    harness.videoTrack = track
    const file = new Blob(['prores'])
    harness.ensureDecoderSupport.mockImplementation(async (
      target: DecoderCheckTarget,
    ) => {
      harness.events.push('decoder-check')
      expect(target).toMatchObject({
        codec: 'prores',
        configuration,
        trackKind: 'video',
        sourceId: 'asset-prores',
        boundary: 'filmstrip',
        policy: 'revalidate',
        budget: {
          ...VISUAL_BUDGET,
          fileBytes: file.size,
        },
      })
      return localSupport('local-prores')
    })

    const result = await generateFilmstrip(
      file,
      decodeOptions('asset-prores'),
    )

    expect(result).toMatchObject({
      url: 'blob:visual',
      tiles: 1,
      tileWidth: 78,
      tileHeight: 44,
    })
    expect(harness.events).toEqual(['decoder-check', 'canvas-sink'])
    expect(harness.canvasSinks).toEqual([
      {
        track,
        options: { width: 78, height: 44, fit: 'contain', poolSize: 1 },
      },
    ])
    expect(harness.offscreenCanvases).toHaveLength(1)
    expect(harness.offscreenCanvases[0]).toMatchObject({
      width: 78,
      height: 44,
    })
    expect(harness.durationTrackSets).toEqual([[track]])
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
  })

  test('preserves a filmstrip resource limit and allocates no sink', async () => {
    harness.videoTrack = {
      getCodec: vi.fn(async () => 'prores'),
      getDecoderConfig: vi.fn(async () => ({
        codec: 'apch',
        codedWidth: 1920,
        codedHeight: 1080,
      })),
      getDisplayWidth: vi.fn(async () => 1920),
      getDisplayHeight: vi.fn(async () => 1080),
      canDecode: vi.fn(async () => false),
    }
    harness.ensureDecoderSupport.mockResolvedValue({
      decodable: false,
      path: null,
      attemptedFallback: 'prores',
      failure: {
        reason: 'resource-limit',
        detail: 'Local ProRes safety budget is incomplete.',
      },
    })

    const failure = await generateFilmstrip(
      new Blob(['prores']),
      decodeOptions('asset-prores'),
    ).catch((cause) => cause)

    expect(failure).toBeInstanceOf(MediaVisualDecodeError)
    expect(failure).toMatchObject({
      message: 'Local ProRes safety budget is incomplete.',
      failure: { reason: 'resource-limit' },
    })
    expect(harness.canvasSinks).toHaveLength(0)
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
  })

  test('bounds extreme-aspect filmstrip sink and joined-canvas geometry', async () => {
    const configuration: VideoDecoderConfig = {
      codec: 'avc1.640028',
      codedWidth: 8192,
      codedHeight: 1,
    }
    const track = {
      getCodec: vi.fn(async () => 'avc'),
      getDecoderConfig: vi.fn(async () => configuration),
      getDisplayWidth: vi.fn(async () => 8192),
      getDisplayHeight: vi.fn(async () => 1),
      canDecode: vi.fn(async () => true),
    }
    harness.videoTrack = track
    harness.durationSec = 600
    harness.ensureDecoderSupport.mockResolvedValue({
      decodable: true,
      path: 'native',
      attemptedFallback: null,
      failure: null,
    })

    const result = await generateFilmstrip(
      new Blob(['extreme-aspect']),
      decodeOptions('asset-wide'),
    )

    expect(result).toMatchObject({
      tiles: 48,
      tileWidth: 333,
      tileHeight: 44,
    })
    expect(harness.canvasSinks).toEqual([{
      track,
      options: { width: 333, height: 44, fit: 'contain', poolSize: 1 },
    }])
    expect(harness.offscreenCanvases).toHaveLength(1)
    expect(harness.offscreenCanvases[0]).toMatchObject({
      width: 15_984,
      height: 44,
    })
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
  })

  test('rejects invalid display geometry before allocating a canvas', async () => {
    const track = {
      getCodec: vi.fn(async () => 'avc'),
      getDecoderConfig: vi.fn(async () => ({
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
      })),
      getDisplayWidth: vi.fn(async () => 0),
      getDisplayHeight: vi.fn(async () => 1080),
      canDecode: vi.fn(async () => true),
    }
    harness.videoTrack = track
    harness.ensureDecoderSupport.mockResolvedValue({
      decodable: true,
      path: 'native',
      attemptedFallback: null,
      failure: null,
    })

    await expect(generateFilmstrip(
      new Blob(['invalid']),
      decodeOptions('asset-invalid'),
    ))
      .rejects.toThrow('Video display dimensions are invalid')

    expect(harness.canvasSinks).toHaveLength(0)
    expect(harness.offscreenCanvases).toHaveLength(0)
    expect(harness.inputs[0].dispose).toHaveBeenCalledOnce()
  })

  test('checks local AC-3 support and measures only its audio track', async () => {
    const configuration: AudioDecoderConfig = {
      codec: 'ac-3',
      sampleRate: 48_000,
      numberOfChannels: 6,
      description: new Uint8Array([4, 5, 6]),
    }
    const track = {
      getCodec: vi.fn(async () => 'ac3'),
      getDecoderConfig: vi.fn(async () => configuration),
      canDecode: vi.fn(async () => false),
    }
    harness.audioTrack = track
    const file = new Blob(['ac3'])
    harness.ensureDecoderSupport.mockImplementation(async (
      target: DecoderCheckTarget,
    ) => {
      harness.events.push('decoder-check')
      expect(target).toMatchObject({
        codec: 'ac3',
        configuration,
        trackKind: 'audio',
        sourceId: 'asset-ac3',
        boundary: 'waveform',
        policy: 'revalidate',
        budget: {
          ...VISUAL_BUDGET,
          fileBytes: file.size,
        },
      })
      return localSupport('local-ac3')
    })

    const result = await generateWaveform(
      file,
      decodeOptions('asset-ac3'),
    )

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
