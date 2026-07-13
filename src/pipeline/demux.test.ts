/**
 * pipeline/demux.test.ts — Phase 2.1 unit tests for the pure parts.
 * The container adapter is mocked here; real media stays covered by the
 * browser decode/export gates.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { FrameRate } from '../domain/schema'
import {
  deserializeDecoderConfig,
  loadAsset,
  serializeDecoderConfig,
} from './demux'

interface FakeVideoTrack {
  displayWidth: number
  displayHeight: number
  computePacketStats: ReturnType<typeof vi.fn>
  getDecoderConfig: ReturnType<typeof vi.fn>
}

interface FakeAudioTrack {
  sampleRate: number
  numberOfChannels: number
}

const media = vi.hoisted(() => ({
  durationSec: 0,
  videoTrack: null as FakeVideoTrack | null,
  audioTrack: null as FakeAudioTrack | null,
}))

vi.mock('mediabunny', () => {
  class BlobSource {
    blob: Blob

    constructor(blob: Blob) {
      this.blob = blob
    }
  }

  class Input {
    async getPrimaryVideoTrack(): Promise<FakeVideoTrack | null> {
      return media.videoTrack
    }

    async getPrimaryAudioTrack(): Promise<FakeAudioTrack | null> {
      return media.audioTrack
    }

    async computeDuration(): Promise<number> {
      return media.durationSec
    }
  }

  return { ALL_FORMATS: {}, BlobSource, Input }
})

/** Deterministic pseudo-random bytes covering the full 0..255 range. */
function testBytes(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length)
  let s = seed >>> 0
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    bytes[i] = s & 0xff
  }
  return bytes
}

describe('decoder config serialization', () => {
  test('round-trips a config with a binary description (H.264-style)', () => {
    const description = testBytes(41) // avcC extradata is ~30-50 bytes
    const config: VideoDecoderConfig = {
      codec: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
      description,
    }

    const revived = deserializeDecoderConfig(serializeDecoderConfig(config))

    expect(revived.codec).toBe('avc1.640028')
    expect(revived.codedWidth).toBe(1920)
    expect(revived.codedHeight).toBe(1080)
    expect(new Uint8Array(revived.description as Uint8Array)).toEqual(description)
  })

  test('round-trips a description-less config (Annex B / VP9-style)', () => {
    const config: VideoDecoderConfig = { codec: 'vp09.00.10.08' }
    const revived = deserializeDecoderConfig(serializeDecoderConfig(config))
    expect(revived.codec).toBe('vp09.00.10.08')
    expect('description' in revived).toBe(false)
  })

  test('preserves JSON-safe extras like colorSpace and acceleration prefs', () => {
    const config: VideoDecoderConfig = {
      codec: 'avc1.42001f',
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' },
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    }
    const revived = deserializeDecoderConfig(serializeDecoderConfig(config))
    expect(revived.colorSpace).toEqual(config.colorSpace)
    expect(revived.hardwareAcceleration).toBe('prefer-hardware')
    expect(revived.optimizeForLatency).toBe(true)
  })

  test('handles description given as ArrayBuffer and as offset view', () => {
    const raw = testBytes(64)

    // Whole ArrayBuffer
    const fromBuffer = deserializeDecoderConfig(
      serializeDecoderConfig({ codec: 'avc1', description: raw.slice().buffer }),
    )
    expect(new Uint8Array(fromBuffer.description as Uint8Array)).toEqual(raw)

    // View into the middle of a larger buffer — byteOffset must be honored.
    const padded = new Uint8Array(100)
    padded.set(raw, 20)
    const view = new Uint8Array(padded.buffer, 20, 64)
    const fromView = deserializeDecoderConfig(
      serializeDecoderConfig({ codec: 'avc1', description: view }),
    )
    expect(new Uint8Array(fromView.description as Uint8Array)).toEqual(raw)
  })

  test('survives large descriptions (chunked base64 path)', () => {
    const big = testBytes(200_000) // way past the 0x8000 chunk size
    const revived = deserializeDecoderConfig(
      serializeDecoderConfig({ codec: 'hev1.1.6.L93.B0', description: big }),
    )
    expect(new Uint8Array(revived.description as Uint8Array)).toEqual(big)
  })
})

describe('loadAsset duration conformance', () => {
  const F30: FrameRate = { num: 30, den: 1 }

  beforeEach(() => {
    media.durationSec = 10
    media.audioTrack = { sampleRate: 48_000, numberOfChannels: 2 }
    media.videoTrack = {
      displayWidth: 1920,
      displayHeight: 1080,
      computePacketStats: vi.fn(async () => ({ averagePacketRate: 60 })),
      getDecoderConfig: vi.fn(async () => ({ codec: 'avc1.640028' })),
    }
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:demux-test'),
    })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001',
    )
  })

  test('stores canonical duration and conforms a 60fps source to 30fps', async () => {
    const loaded = await loadAsset(
      new File(['fixture'], 'ten-seconds.mp4', {
        type: 'video/mp4',
        lastModified: 1_725_000_000_003,
      }),
      F30,
    )

    expect(loaded.asset.mimeType).toBe('video/mp4')
    expect(loaded.asset.size).toBe(7)
    expect(loaded.asset.lastModified).toBe(1_725_000_000_003)
    expect(loaded.asset.frameRate).toEqual({ num: 60, den: 1 })
    expect(loaded.asset.durationMicroseconds).toBe(10_000_000)
    expect(loaded.asset.durationFrames).toBe(300)
  })

  test('keeps the existing native-rate default when docRate is omitted', async () => {
    const loaded = await loadAsset(
      new File(['fixture'], 'ten-seconds.mp4', { type: 'video/mp4' }),
    )

    expect(loaded.asset.durationMicroseconds).toBe(10_000_000)
    expect(loaded.asset.durationFrames).toBe(600)
  })

  test('conforms canonical duration at an exact rational document rate', async () => {
    media.videoTrack!.computePacketStats = vi.fn(async () => ({
      averagePacketRate: 29.97002997,
    }))

    const loaded = await loadAsset(
      new File(['fixture'], 'ntsc.mp4', { type: 'video/mp4' }),
      { num: 30000, den: 1001 },
    )

    expect(loaded.asset.frameRate).toEqual({ num: 30000, den: 1001 })
    expect(loaded.asset.durationFrames).toBe(300)
  })
})
