/**
 * pipeline/decode.test.ts — Phase 2.4. Synthetic GOP layouts drive the
 * keyframe walk, including the cases that break naive implementations:
 * B-frame reordering and timestamp holes.
 */

import { describe, expect, test } from 'vitest'
import type { FrameRate } from '../domain/schema'
import type { PacketLike, PacketSinkLike } from './decode'
import { VideoChunkSource } from './decode'

const F30: FrameRate = { num: 30, den: 1 }
const FRAME_SEC = 1 / 30
const TOL_SEC = FRAME_SEC / 2

function pkt(
  frameIndex: number,
  type: 'key' | 'delta' = 'delta',
  payloadByte = frameIndex,
): PacketLike {
  const timestamp = frameIndex * FRAME_SEC
  return {
    type,
    timestamp,
    microsecondTimestamp: Math.round(timestamp * 1e6),
    microsecondDuration: Math.round(FRAME_SEC * 1e6),
    data: new Uint8Array([payloadByte & 0xff, 1, 2, 3]),
  }
}

/** Packets in DECODE order; getKeyPacket works on presentation timestamps. */
class FakeSink implements PacketSinkLike {
  private readonly packets: PacketLike[]

  constructor(packets: PacketLike[]) {
    this.packets = packets
  }

  async getFirstPacket(): Promise<PacketLike | null> {
    return this.packets[0] ?? null
  }

  async getNextPacket(packet: PacketLike): Promise<PacketLike | null> {
    const i = this.packets.indexOf(packet)
    if (i === -1) throw new Error('getNextPacket: unknown packet')
    return this.packets[i + 1] ?? null
  }

  async getKeyPacket(timestampSec: number): Promise<PacketLike | null> {
    let best: PacketLike | null = null
    for (const p of this.packets) {
      if (p.type === 'key' && p.timestamp <= timestampSec + 1e-9) best = p
    }
    return best
  }
}

/** Two GOPs of 10 frames each: keys at frame 0 and frame 10. */
function twoGops(): PacketLike[] {
  return Array.from({ length: 20 }, (_, i) =>
    pkt(i, i % 10 === 0 ? 'key' : 'delta'),
  )
}

const source = (packets: PacketLike[]) =>
  new VideoChunkSource(new FakeSink(packets), F30)

describe('keyframe walk', () => {
  test('mid-GOP target: chunks run keyframe → target inclusive', async () => {
    const chunks = await source(twoGops()).chunksForTimestamp(5 * FRAME_SEC, TOL_SEC)
    expect(chunks).toHaveLength(6) // frames 0..5
    expect(chunks[0].type).toBe('key')
    expect(chunks.at(-1)?.timestampUs).toBe(Math.round(5 * FRAME_SEC * 1e6))
  })

  test('target in the second GOP starts from the SECOND keyframe', async () => {
    const chunks = await source(twoGops()).chunksForTimestamp(12 * FRAME_SEC, TOL_SEC)
    expect(chunks).toHaveLength(3) // frames 10, 11, 12
    expect(chunks[0].type).toBe('key')
    expect(chunks[0].timestampUs).toBe(Math.round(10 * FRAME_SEC * 1e6))
  })

  test('target exactly on a keyframe yields a single chunk', async () => {
    const chunks = await source(twoGops()).chunksForTimestamp(10 * FRAME_SEC, TOL_SEC)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].type).toBe('key')
  })

  test('target at zero yields just the first keyframe', async () => {
    const chunks = await source(twoGops()).chunksForTimestamp(0, TOL_SEC)
    expect(chunks).toHaveLength(1)
  })

  test('B-frame reordering: keeps feeding until the TARGET packet is included', async () => {
    // Decode order: I(0), P(3), B(1), B(2) — presentation of frame 3 comes
    // through the pipe before frames 1 and 2.
    const packets = [pkt(0, 'key'), pkt(3), pkt(1), pkt(2)]
    const chunks = await source(packets).chunksForTimestamp(1 * FRAME_SEC, TOL_SEC)

    // Frame 1 sits at decode position 3, so all three prior packets ride along.
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.timestampUs)).toEqual([
      0,
      Math.round(3 * FRAME_SEC * 1e6),
      Math.round(1 * FRAME_SEC * 1e6),
    ])
  })

  test('timestamp hole: stops after bounded overshoot, no infinite read', async () => {
    // Frames 0,1 then a jump to 0.667s — target 0.333s falls in the hole.
    const packets = [pkt(0, 'key'), pkt(1), pkt(20)]
    const chunks = await source(packets).chunksForTimestamp(10 * FRAME_SEC, TOL_SEC)

    // Packets 0 and 1 are gathered; the 0.667s packet exceeds the 0.25s
    // overshoot window and is dropped — no target match in the batch.
    expect(chunks).toHaveLength(2)
    const targetUs = Math.round(10 * FRAME_SEC * 1e6)
    expect(chunks.some((c) => Math.abs(c.timestampUs - targetUs) < 16_667)).toBe(false)
  })

  test('empty stream yields an empty batch', async () => {
    expect(await source([]).chunksForTimestamp(0, TOL_SEC)).toEqual([])
  })

  test('stream without any keyframe throws', async () => {
    const packets = [pkt(0), pkt(1)] // deltas only
    await expect(source(packets).chunksForTimestamp(0, TOL_SEC)).rejects.toThrow(
      /no keyframe/,
    )
  })
})

describe('payload construction', () => {
  test('bytes are copied: mutating the source never touches the payload', async () => {
    const original = pkt(0, 'key', 0xaa)
    const chunks = await source([original]).chunksForTimestamp(0, TOL_SEC)

    const view = new Uint8Array(chunks[0].data)
    expect(view[0]).toBe(0xaa)
    original.data[0] = 0x00
    expect(view[0]).toBe(0xaa) // still the copy
    expect(chunks[0].data).not.toBe(original.data.buffer)
  })

  test('zero-duration packets fall back to one frame at the doc rate', async () => {
    const packet = pkt(0, 'key')
    packet.microsecondDuration = 0
    const chunks = await source([packet]).chunksForTimestamp(0, TOL_SEC)
    expect(chunks[0].durationUs).toBe(Math.round(1e6 / 30))
  })
})
