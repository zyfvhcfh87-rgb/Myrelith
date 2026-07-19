import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { FrameRate } from '../domain/schema'
import {
  MEDIA_PROBE_LIMITS,
  probeMediaFile,
  type MediaProbeResult,
} from './mediaCompatibilityProbe'

const localDecoders = vi.hoisted(() => ({
  proresRegistered: false,
  proresRegistrations: 0,
  ac3Registered: false,
  ac3Registrations: 0,
}))

vi.mock('@mediabunny/prores', () => ({
  registerProresDecoder: () => {
    localDecoders.proresRegistered = true
    localDecoders.proresRegistrations++
  },
}))

vi.mock('@mediabunny/ac3', () => ({
  registerAc3Decoder: () => {
    localDecoders.ac3Registered = true
    localDecoders.ac3Registrations++
  },
}))

interface FakeVideoTrack {
  isVideoTrack: ReturnType<typeof vi.fn>
  isAudioTrack: ReturnType<typeof vi.fn>
  getCodec: ReturnType<typeof vi.fn>
  getCodecParameterString: ReturnType<typeof vi.fn>
  getInternalCodecId: ReturnType<typeof vi.fn>
  getDecoderConfig: ReturnType<typeof vi.fn>
  getCodedWidth: ReturnType<typeof vi.fn>
  getCodedHeight: ReturnType<typeof vi.fn>
  getDisplayWidth: ReturnType<typeof vi.fn>
  getDisplayHeight: ReturnType<typeof vi.fn>
  computePacketStats: ReturnType<typeof vi.fn>
  canDecode: ReturnType<typeof vi.fn>
}

interface FakeAudioTrack {
  isVideoTrack: ReturnType<typeof vi.fn>
  isAudioTrack: ReturnType<typeof vi.fn>
  getCodec: ReturnType<typeof vi.fn>
  getCodecParameterString: ReturnType<typeof vi.fn>
  getInternalCodecId: ReturnType<typeof vi.fn>
  getDecoderConfig: ReturnType<typeof vi.fn>
  getSampleRate: ReturnType<typeof vi.fn>
  getNumberOfChannels: ReturnType<typeof vi.fn>
  canDecode: ReturnType<typeof vi.fn>
}

const media = vi.hoisted(() => ({
  canRead: true as boolean | Promise<boolean>,
  format: { name: 'MPEG-4 Part 14', mimeType: 'video/mp4' },
  fullMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  durationSec: 4,
  videoTracks: [] as FakeVideoTrack[],
  audioTracks: [] as FakeAudioTrack[],
  disposeCount: 0,
  onDispose: null as (() => void) | null,
  getMimeTypeCount: 0,
  mimeTypeError: null as Error | null,
  primaryVideoError: null as Error | null,
  primaryAudioError: null as Error | null,
}))

vi.mock('mediabunny', () => {
  class BlobSource {
    constructor(_blob: Blob) {}
  }

  class UnsupportedInputFormatError extends Error {}

  class Input {
    async canRead(): Promise<boolean> {
      return media.canRead
    }

    async getFormat() {
      return media.format
    }

    async getMimeType(): Promise<string> {
      media.getMimeTypeCount++
      if (media.mimeTypeError) throw media.mimeTypeError
      return media.fullMimeType
    }

    async getTracks(): Promise<Array<FakeVideoTrack | FakeAudioTrack>> {
      return [...media.videoTracks, ...media.audioTracks]
    }

    async getVideoTracks(): Promise<FakeVideoTrack[]> {
      return media.videoTracks
    }

    async getAudioTracks(): Promise<FakeAudioTrack[]> {
      return media.audioTracks
    }

    async getPrimaryVideoTrack(): Promise<FakeVideoTrack | null> {
      if (media.primaryVideoError) throw media.primaryVideoError
      return media.videoTracks[0] ?? null
    }

    async getPrimaryAudioTrack(): Promise<FakeAudioTrack | null> {
      if (media.primaryAudioError) throw media.primaryAudioError
      return media.audioTracks[0] ?? null
    }

    async computeDuration(): Promise<number> {
      return media.durationSec
    }

    dispose(): void {
      media.disposeCount++
      media.onDispose?.()
    }
  }

  return { ALL_FORMATS: [], BlobSource, Input, UnsupportedInputFormatError }
})

const F30: FrameRate = { num: 30, den: 1 }

function videoTrack(overrides: Partial<FakeVideoTrack> = {}): FakeVideoTrack {
  return {
    isVideoTrack: vi.fn(() => true),
    isAudioTrack: vi.fn(() => false),
    getCodec: vi.fn(async () => 'avc'),
    getCodecParameterString: vi.fn(async () => 'avc1.640028'),
    getInternalCodecId: vi.fn(async () => 'avc1'),
    getDecoderConfig: vi.fn(async () => ({
      codec: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
      description: new Uint8Array([1, 2, 3]),
    })),
    getCodedWidth: vi.fn(async () => 1920),
    getCodedHeight: vi.fn(async () => 1080),
    getDisplayWidth: vi.fn(async () => 1920),
    getDisplayHeight: vi.fn(async () => 1080),
    computePacketStats: vi.fn(async () => ({ averagePacketRate: 29.97002997 })),
    canDecode: vi.fn(async () => true),
    ...overrides,
  }
}

function audioTrack(overrides: Partial<FakeAudioTrack> = {}): FakeAudioTrack {
  return {
    isVideoTrack: vi.fn(() => false),
    isAudioTrack: vi.fn(() => true),
    getCodec: vi.fn(async () => 'aac'),
    getCodecParameterString: vi.fn(async () => 'mp4a.40.2'),
    getInternalCodecId: vi.fn(async () => 'mp4a'),
    getDecoderConfig: vi.fn(async () => ({
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      numberOfChannels: 2,
    })),
    getSampleRate: vi.fn(async () => 48_000),
    getNumberOfChannels: vi.fn(async () => 2),
    canDecode: vi.fn(async () => true),
    ...overrides,
  }
}

function selectedFile(): File {
  return new File(['fixture'], 'spoofed.mp4', {
    type: 'video/mp4',
    lastModified: 1_725_000_000_003,
  })
}

beforeEach(() => {
  media.canRead = true
  media.format = { name: 'Matroska', mimeType: 'video/x-matroska' }
  media.fullMimeType = 'video/x-matroska; codecs="avc1.640028, mp4a.40.2"'
  media.durationSec = 4
  media.videoTracks = [videoTrack()]
  media.audioTracks = [audioTrack()]
  media.disposeCount = 0
  media.onDispose = null
  media.getMimeTypeCount = 0
  media.mimeTypeError = null
  media.primaryVideoError = null
  media.primaryAudioError = null
  URL.createObjectURL = vi.fn(
    () => 'blob:compatible',
  ) as typeof URL.createObjectURL
})

describe('probeMediaFile', () => {
  test('detects content, reports every real track config, and disposes exactly once', async () => {
    const result = await probeMediaFile(
      selectedFile(),
      F30,
      'asset-probed',
    )

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('ready fixture rejected')
    expect(result.asset).toMatchObject({
      id: 'asset-probed',
      fileName: 'spoofed.mp4',
      mimeType: 'video/mp4',
      durationFrames: 120,
      frameRate: { num: 30_000, den: 1_001 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      audioChannels: 2,
    })
    expect(result.compatibility.container).toEqual({
      name: 'Matroska',
      mimeType: 'video/x-matroska',
      fullMimeType: media.fullMimeType,
    })
    expect(result.compatibility.tracks).toEqual([
      expect.objectContaining({
        kind: 'video',
        codec: 'avc',
        codecParameter: 'avc1.640028',
        internalCodecId: 'avc1',
        decoderPath: 'native',
        decodable: true,
        width: 1920,
        height: 1080,
        codedWidth: 1920,
        codedHeight: 1080,
        decoderConfig: expect.objectContaining({
          codec: 'avc1.640028',
          descriptionBytes: 3,
        }),
      }),
      expect.objectContaining({
        kind: 'audio',
        codec: 'aac',
        codecParameter: 'mp4a.40.2',
        decoderPath: 'native',
        decodable: true,
        sampleRate: 48_000,
        channels: 2,
      }),
    ])
    expect(media.videoTracks[0].canDecode).toHaveBeenCalledOnce()
    expect(media.audioTracks[0].canDecode).toHaveBeenCalledOnce()
    expect(media.disposeCount).toBe(1)
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(media.getMimeTypeCount).toBe(0)
  })

  test('synthesizes full MIME after bounded track probes', async () => {
    media.mimeTypeError = new Error('malformed codec list')

    const result = await probeMediaFile(selectedFile(), F30, 'asset-mime')

    expect(result.status).toBe('ready')
    expect(result.compatibility.container?.fullMimeType).toBe(
      'video/x-matroska; codecs="avc1.640028, mp4a.40.2"',
    )
    expect(media.getMimeTypeCount).toBe(0)
    expect(media.disposeCount).toBe(1)
  })

  test('bounds attacker-controlled codec diagnostics before publishing them', async () => {
    const oversizedParameter = `avc1.${'f'.repeat(1_000)}`
    const oversizedInternalId = `codec-${'x'.repeat(1_000)}`
    media.videoTracks = [videoTrack({
      getCodecParameterString: vi.fn(async () => oversizedParameter),
      getInternalCodecId: vi.fn(async () => oversizedInternalId),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-diagnostics')

    expect(result.status).toBe('ready')
    const [track] = result.compatibility.tracks
    expect(track.codecParameter).not.toBe(oversizedParameter)
    expect(track.codecParameter).toHaveLength(256)
    expect(track.codecParameter).toMatch(/…$/)
    expect(track.internalCodecId).not.toBe(oversizedInternalId)
    expect(track.internalCodecId).toHaveLength(256)
    expect(track.internalCodecId).toMatch(/…$/)
    expect(result.compatibility.container?.fullMimeType).not.toContain(
      oversizedParameter,
    )
  })

  test('uses an audio MIME base for an audio-only container', async () => {
    media.format = { name: 'MPEG-4 Part 14', mimeType: 'video/mp4' }
    media.videoTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-audio')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('audio source rejected')
    expect(result.asset.kind).toBe('audio')
    expect(result.compatibility.container).toEqual({
      name: 'MPEG-4 Part 14',
      mimeType: 'video/mp4',
      fullMimeType: 'audio/mp4; codecs="mp4a.40.2"',
    })
    expect(media.disposeCount).toBe(1)
  })

  test('rejects over-limit track counts before any decoder-config fanout', async () => {
    media.videoTracks = Array.from(
      { length: MEDIA_PROBE_LIMITS.maxTracks + 1 },
      () => videoTrack(),
    )

    const result = await probeMediaFile(selectedFile(), F30, 'asset-tracks')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        reason: 'resource-limit',
        detail: expect.stringContaining('media tracks'),
      },
    })
    expect(media.videoTracks[0].getDecoderConfig).not.toHaveBeenCalled()
    expect(media.getMimeTypeCount).toBe(0)
    expect(media.disposeCount).toBe(1)
  })

  test('rejects an over-limit file before opening an Input', async () => {
    const oversized = selectedFile()
    Object.defineProperty(oversized, 'size', {
      value: MEDIA_PROBE_LIMITS.maxFileBytes + 1,
    })

    const result = await probeMediaFile(oversized, F30, 'asset-file-heavy')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        reason: 'resource-limit',
        detail: expect.stringContaining('64 GiB'),
      },
    })
    expect(media.disposeCount).toBe(0)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test('rejects over-limit duration before creating an object URL', async () => {
    media.durationSec = 24 * 60 * 60 + 1

    const result = await probeMediaFile(selectedFile(), F30, 'asset-long')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        reason: 'resource-limit',
        detail: expect.stringContaining('24-hour'),
      },
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('never probes more than four tracks concurrently', async () => {
    let active = 0
    let maxActive = 0
    let totalStarted = 0
    const releases: Array<() => void> = []
    media.videoTracks = Array.from({ length: 8 }, () => videoTrack({
      getDecoderConfig: vi.fn(async () => {
        active++
        totalStarted++
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => {
          releases.push(() => {
            active--
            resolve()
          })
        })
        return {
          codec: 'avc1.640028',
          codedWidth: 1920,
          codedHeight: 1080,
        }
      }),
    }))
    media.audioTracks = []
    const result = probeMediaFile(selectedFile(), F30, 'asset-concurrency')
    const waitForStarts = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (totalStarted === expected) return
        await Promise.resolve()
      }
      throw new Error(`Expected ${expected} track probes, saw ${totalStarted}`)
    }

    await waitForStarts(4)
    expect(maxActive).toBe(4)
    releases.splice(0).forEach((release) => release())
    await waitForStarts(8)
    expect(maxActive).toBe(4)
    releases.splice(0).forEach((release) => release())

    await expect(result).resolves.toMatchObject({ status: 'ready' })
    expect(maxActive).toBe(4)
    expect(media.disposeCount).toBe(1)
  })

  test('falls back to the first tracks when primary ranking metadata fails', async () => {
    media.primaryVideoError = new Error('broken disposition')
    media.primaryAudioError = new Error('broken pairing metadata')

    const result = await probeMediaFile(selectedFile(), F30, 'asset-primary')

    expect(result.status).toBe('ready')
    expect(result.compatibility.tracks).toEqual([
      expect.objectContaining({ kind: 'video', primary: true }),
      expect.objectContaining({ kind: 'audio', primary: true }),
    ])
    expect(media.disposeCount).toBe(1)
  })

  test('keeps a positive sub-frame source valid with one timeline frame', async () => {
    media.durationSec = 0.01

    const result = await probeMediaFile(selectedFile(), F30, 'asset-short')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('short source rejected')
    expect(result.asset.durationFrames).toBe(1)
    expect(media.disposeCount).toBe(1)
  })

  test('returns limited when only one track is decodable and creates no URL', async () => {
    media.audioTracks = [audioTrack({ canDecode: vi.fn(async () => false) })]

    const result = await probeMediaFile(selectedFile(), F30, 'asset-limited')

    expect(result).toMatchObject({
      status: 'limited',
      asset: null,
      compatibility: {
        reason: 'unsupported-codec',
        tracks: [
          { kind: 'video', decodable: true },
          {
            kind: 'audio',
            decodable: false,
            reason: 'unsupported-codec',
            detail: expect.stringContaining('no reviewed local fallback'),
          },
        ],
      },
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('promotes ProRes to Ready only after the local decoder recheck', async () => {
    media.videoTracks = [videoTrack({
      getCodec: vi.fn(async () => 'prores'),
      getCodecParameterString: vi.fn(async () => 'apch'),
      getInternalCodecId: vi.fn(async () => 'apch'),
      getDecoderConfig: vi.fn(async () => ({
        codec: 'apch',
        codedWidth: 1920,
        codedHeight: 1080,
      })),
      canDecode: vi.fn(async () => localDecoders.proresRegistered),
    })]
    media.audioTracks = []
    const registrationsBefore = localDecoders.proresRegistrations

    const result = await probeMediaFile(selectedFile(), F30, 'asset-prores')

    expect(result.status).toBe('ready')
    expect(result.compatibility.tracks).toEqual([
      expect.objectContaining({
        codec: 'prores',
        decoderPath: 'local-prores',
        decodable: true,
        reason: null,
      }),
    ])
    expect(localDecoders.proresRegistrations).toBe(registrationsBefore + 1)
    expect(media.videoTracks[0].canDecode).toHaveBeenCalledTimes(2)
  })

  test('uses one local decoder path for both AC-3 codec variants', async () => {
    media.videoTracks = []
    media.audioTracks = [audioTrack({
      getCodec: vi.fn(async () => 'eac3'),
      getCodecParameterString: vi.fn(async () => 'ec-3'),
      getInternalCodecId: vi.fn(async () => 'ec-3'),
      getDecoderConfig: vi.fn(async () => ({
        codec: 'ec-3',
        sampleRate: 48_000,
        numberOfChannels: 6,
      })),
      getNumberOfChannels: vi.fn(async () => 6),
      canDecode: vi.fn(async () => localDecoders.ac3Registered),
    })]
    const registrationsBefore = localDecoders.ac3Registrations

    const result = await probeMediaFile(selectedFile(), F30, 'asset-eac3')

    expect(result.status).toBe('ready')
    expect(result.compatibility.tracks).toEqual([
      expect.objectContaining({
        codec: 'eac3',
        decoderPath: 'local-ac3',
        channels: 6,
        decodable: true,
      }),
    ])
    expect(localDecoders.ac3Registrations).toBe(registrationsBefore + 1)
    expect(media.audioTracks[0].canDecode).toHaveBeenCalledTimes(2)
  })

  test('warns instead of loading fallback above the documented duration budget', async () => {
    media.durationSec = 2 * 60 * 60 + 1
    media.videoTracks = [videoTrack({
      getCodec: vi.fn(async () => 'prores'),
      getCodecParameterString: vi.fn(async () => 'apch'),
      getInternalCodecId: vi.fn(async () => 'apch'),
      getDecoderConfig: vi.fn(async () => ({
        codec: 'apch',
        codedWidth: 1920,
        codedHeight: 1080,
      })),
      canDecode: vi.fn(async () => false),
    })]
    media.audioTracks = []
    const registrationsBefore = localDecoders.proresRegistrations

    const result = await probeMediaFile(
      selectedFile(),
      F30,
      'asset-prores-budget',
    )

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          decoderPath: null,
          reason: 'resource-limit',
          detail: expect.stringContaining('2-hour automatic decode budget'),
        }],
      },
    })
    expect(localDecoders.proresRegistrations).toBe(registrationsBefore)
    expect(media.videoTracks[0].canDecode).toHaveBeenCalledOnce()
  })

  test('distinguishes an unknown codec from a known unsupported codec', async () => {
    media.videoTracks = [videoTrack({
      getCodec: vi.fn(async () => null),
      getDecoderConfig: vi.fn(async () => null),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-unknown')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{ reason: 'unknown-codec', decodable: false }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('classifies a known codec with no decoder config as malformed', async () => {
    media.videoTracks = [videoTrack({
      getDecoderConfig: vi.fn(async () => null),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-config')

    expect(result).toMatchObject({
      status: 'error',
      compatibility: {
        tracks: [{
          codec: 'avc',
          reason: 'malformed-media',
          detail: expect.stringContaining('decoder configuration'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('preserves an unexpected video decode-check failure', async () => {
    media.videoTracks = [videoTrack({
      canDecode: vi.fn(async () => {
        throw new Error('VideoDecoder.isConfigSupported exploded')
      }),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-video-check')

    expect(result).toMatchObject({
      status: 'error',
      compatibility: {
        reason: 'decode-failed',
        tracks: [{
          codec: 'avc',
          reason: 'decode-failed',
          detail: expect.stringContaining('VideoDecoder.isConfigSupported exploded'),
        }],
      },
    })
    expect(media.disposeCount).toBe(1)
  })

  test('preserves an unexpected audio decode-check failure', async () => {
    media.videoTracks = []
    media.audioTracks = [audioTrack({
      canDecode: vi.fn(async () => {
        throw new Error('AudioDecoder.isConfigSupported exploded')
      }),
    })]

    const result = await probeMediaFile(selectedFile(), F30, 'asset-audio-check')

    expect(result).toMatchObject({
      status: 'error',
      compatibility: {
        reason: 'decode-failed',
        tracks: [{
          codec: 'aac',
          reason: 'decode-failed',
          detail: expect.stringContaining('AudioDecoder.isConfigSupported exploded'),
        }],
      },
    })
    expect(media.disposeCount).toBe(1)
  })

  test('rejects an unrecognized container without trusting extension or MIME', async () => {
    media.canRead = false

    const result = await probeMediaFile(selectedFile(), F30, 'asset-container')

    expect(result).toMatchObject({
      status: 'unsupported',
      asset: null,
      compatibility: {
        container: null,
        reason: 'unsupported-container',
        detail: expect.stringContaining('not a supported media container'),
      },
    })
    expect(media.disposeCount).toBe(1)
  })

  test('reports malformed track metadata without throwing away the diagnosis', async () => {
    media.videoTracks = [videoTrack({
      getDecoderConfig: vi.fn(async () => {
        throw new Error('truncated sample description')
      }),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-broken')

    expect(result).toMatchObject({
      status: 'error',
      compatibility: {
        tracks: [{
          reason: 'malformed-media',
          detail: expect.stringContaining('truncated sample description'),
        }],
      },
    })
    expect(media.disposeCount).toBe(1)
  })

  test('enforces coded-pixel limits before decoder use', async () => {
    media.videoTracks = [videoTrack({
      getCodedWidth: vi.fn(async () => 7680),
      getCodedHeight: vi.fn(async () => 4320),
      getDisplayWidth: vi.fn(async () => 7680),
      getDisplayHeight: vi.fn(async () => 4320),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-heavy')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          reason: 'resource-limit',
          detail: expect.stringContaining('pixels-per-frame'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('enforces frame-rate limits before decoder use', async () => {
    media.videoTracks = [videoTrack({
      computePacketStats: vi.fn(async () => ({ averagePacketRate: 241 })),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-fast')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          reason: 'resource-limit',
          detail: expect.stringContaining('frame-rate'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
  })

  test('enforces decoder-description limits before decoder use', async () => {
    media.videoTracks = [videoTrack({
      getDecoderConfig: vi.fn(async () => ({
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
        description: new Uint8Array(
          MEDIA_PROBE_LIMITS.maxDecoderDescriptionBytes + 1,
        ),
      })),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-config-large')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          reason: 'resource-limit',
          detail: expect.stringContaining('1 MiB'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
  })

  test('bounds display dimensions independently from coded dimensions', async () => {
    media.videoTracks = [videoTrack({
      getDisplayWidth: vi.fn(async () => 65_536),
      getDisplayHeight: vi.fn(async () => 1080),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-display-heavy')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          codedWidth: 1920,
          codedHeight: 1080,
          reason: 'resource-limit',
          detail: expect.stringContaining('display-dimension'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('bounds decoder-config dimensions independently from track metadata', async () => {
    media.videoTracks = [videoTrack({
      getDecoderConfig: vi.fn(async () => ({
        codec: 'avc1.640028',
        codedWidth: 8192,
        codedHeight: 8192,
      })),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-config-heavy')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          codedWidth: 1920,
          codedHeight: 1080,
          decoderConfig: { codedWidth: 8192, codedHeight: 8192 },
          reason: 'resource-limit',
          detail: expect.stringContaining('pixels-per-frame'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('rejects oversized decoder codec identifiers before decoder use', async () => {
    media.videoTracks = [videoTrack({
      getDecoderConfig: vi.fn(async () => ({
        codec: 'c'.repeat(1_000),
        codedWidth: 1920,
        codedHeight: 1080,
      })),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-codec-id-heavy')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          reason: 'resource-limit',
          detail: expect.stringContaining('codec identifier'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('bounds decoder-config display aspects independently from track metadata', async () => {
    media.videoTracks = [videoTrack({
      getDecoderConfig: vi.fn(async () => ({
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
        displayAspectWidth: 65_536,
        displayAspectHeight: 1080,
      })),
    })]
    media.audioTracks = []

    const result = await probeMediaFile(selectedFile(), F30, 'asset-aspect-heavy')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          width: 1920,
          height: 1080,
          reason: 'resource-limit',
          detail: expect.stringContaining('display-dimension'),
        }],
      },
    })
    expect(media.videoTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('bounds decoder-config audio facts independently from track metadata', async () => {
    media.videoTracks = []
    media.audioTracks = [audioTrack({
      getDecoderConfig: vi.fn(async () => ({
        codec: 'mp4a.40.2',
        sampleRate: 768_000,
        numberOfChannels: 2,
      })),
    })]

    const result = await probeMediaFile(selectedFile(), F30, 'asset-config-audio-heavy')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          sampleRate: 48_000,
          channels: 2,
          decoderConfig: { sampleRate: 768_000, channels: 2 },
          reason: 'resource-limit',
          detail: expect.stringContaining('sample-rate'),
        }],
      },
    })
    expect(media.audioTracks[0].canDecode).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })

  test('enforces audio channel limits before decoder use', async () => {
    media.videoTracks = []
    media.audioTracks = [audioTrack({
      getDecoderConfig: vi.fn(async () => ({
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 33,
      })),
      getNumberOfChannels: vi.fn(async () => 33),
    })]

    const result = await probeMediaFile(selectedFile(), F30, 'asset-many-channels')

    expect(result).toMatchObject({
      status: 'unsupported',
      compatibility: {
        tracks: [{
          reason: 'resource-limit',
          detail: expect.stringContaining('audio channels'),
        }],
      },
    })
    expect(media.audioTracks[0].canDecode).not.toHaveBeenCalled()
  })

  test('abort disposes once and rejects as cancellation', async () => {
    let rejectRead!: (cause: unknown) => void
    media.canRead = new Promise<boolean>((_resolve, reject) => {
      rejectRead = reject
    })
    media.onDispose = () => rejectRead(new Error('input disposed'))
    const controller = new AbortController()
    const result = probeMediaFile(
      selectedFile(),
      F30,
      'asset-cancelled',
      controller.signal,
    )

    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(media.disposeCount).toBe(1)
  })

  test('the result remains fully serializable', async () => {
    const result: MediaProbeResult = await probeMediaFile(
      selectedFile(),
      F30,
      'asset-json',
    )

    expect(() => JSON.stringify(result.compatibility)).not.toThrow()
  })

  test('does not create an object URL when asset serialization fails', async () => {
    media.videoTracks = [videoTrack({
      getDecoderConfig: vi.fn(async () => ({
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
        colorSpace: { unsafeFixture: 1n },
      })),
    })]
    media.audioTracks = []

    await expect(
      probeMediaFile(selectedFile(), F30, 'asset-serialization-error'),
    ).rejects.toThrow(/BigInt/)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(media.disposeCount).toBe(1)
  })
})
