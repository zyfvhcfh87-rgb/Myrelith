/**
 * pipeline/demux.test.ts — Phase 2.1 unit tests for the persisted
 * decoder-config string format.
 */

import { describe, expect, test } from 'vitest'
import { serializeDecoderConfig } from './demux'

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

/** Test-side reader: the JSON payload plus its decoded description bytes. */
function readSerialized(serialized: string): {
  payload: Record<string, unknown>
  description: Uint8Array | null
} {
  const payload = JSON.parse(serialized) as Record<string, unknown>
  const encoded = payload.descriptionB64
  if (typeof encoded !== 'string') return { payload, description: null }
  const binary = atob(encoded)
  return {
    payload,
    description: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  }
}

describe('decoder config serialization', () => {
  test('base64-encodes a binary description (H.264-style)', () => {
    const description = testBytes(41) // avcC extradata is ~30-50 bytes
    const { payload, description: stored } = readSerialized(serializeDecoderConfig({
      codec: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
      description,
    }))

    expect(payload).toMatchObject({
      codec: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
    })
    expect('description' in payload).toBe(false)
    expect(stored).toEqual(description)
  })

  test('writes no description field for a description-less config (Annex B / VP9-style)', () => {
    const { payload, description } = readSerialized(
      serializeDecoderConfig({ codec: 'vp09.00.10.08' }),
    )
    expect(payload).toEqual({ codec: 'vp09.00.10.08' })
    expect(description).toBeNull()
  })

  test('preserves JSON-safe extras like colorSpace and acceleration prefs', () => {
    const config: VideoDecoderConfig = {
      codec: 'avc1.42001f',
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' },
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    }
    const { payload } = readSerialized(serializeDecoderConfig(config))
    expect(payload.colorSpace).toEqual(config.colorSpace)
    expect(payload.hardwareAcceleration).toBe('prefer-hardware')
    expect(payload.optimizeForLatency).toBe(true)
  })

  test('handles description given as ArrayBuffer and as offset view', () => {
    const raw = testBytes(64)

    // Whole ArrayBuffer
    const fromBuffer = readSerialized(
      serializeDecoderConfig({ codec: 'avc1', description: raw.slice().buffer }),
    )
    expect(fromBuffer.description).toEqual(raw)

    // View into the middle of a larger buffer — byteOffset must be honored.
    const padded = new Uint8Array(100)
    padded.set(raw, 20)
    const view = new Uint8Array(padded.buffer, 20, 64)
    const fromView = readSerialized(
      serializeDecoderConfig({ codec: 'avc1', description: view }),
    )
    expect(fromView.description).toEqual(raw)
  })

  test('survives large descriptions (chunked base64 path)', () => {
    const big = testBytes(200_000) // way past the 0x8000 chunk size
    const { description } = readSerialized(
      serializeDecoderConfig({ codec: 'hev1.1.6.L93.B0', description: big }),
    )
    expect(description).toEqual(big)
  })
})
