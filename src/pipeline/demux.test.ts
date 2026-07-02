/**
 * pipeline/demux.test.ts — Phase 2.1 unit tests for the pure parts.
 * (loadAsset itself needs a real media file: validated via the Phase 2.5
 * sandbox, then a fixture-MP4 integration test per the plan's test strategy.)
 */

import { describe, expect, test } from 'vitest'
import { deserializeDecoderConfig, serializeDecoderConfig } from './demux'

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
