/**
 * pipeline/decode.ts — Chunk orchestration: "I want the frame at time T" →
 * the exact list of encoded chunks the decoder must eat, keyframe first.
 * Phase 2.4 (consumed by engine/worker-bridge).
 *
 * Correctness notes, because this is where seeks go subtly wrong:
 * - Packets are walked in DECODE order (storage order). With B-frames,
 *   presentation timestamps inside the batch are NOT monotonic — a packet
 *   presented later can precede the target in decode order and is required
 *   to decode it. That is why the loop stops only once the packet whose
 *   PRESENTATION time matches the target has been pushed: everything a
 *   decoder needs to output frame T sits earlier in decode order.
 * - Keyframes are looked up with verifyKeyPackets: container sync tables
 *   sometimes mark non-keyframes as keyframes; trusting them yields gray
 *   garbage after seeks.
 * - Chunk bytes are COPIED out of Mediabunny's buffers: payloads get
 *   transferred (detached) when posted to the worker, and detaching a
 *   buffer the demuxer still owns would corrupt later reads.
 *
 * Layering: pipeline/ → domain/. The sink is injected behind a structural
 * interface so tests drive synthetic GOP layouts without real files.
 */

import { EncodedPacketSink } from 'mediabunny'
import type { InputVideoTrack } from 'mediabunny'
import type { FrameRate } from '../domain/schema'
import type { ChunkPayload } from '../workers/decode-protocol'

/** The slice of Mediabunny's EncodedPacket this module reads. */
export interface PacketLike {
  type: 'key' | 'delta'
  /** Presentation timestamp in seconds. */
  timestamp: number
  /** Canonical integer-microsecond timestamp (matches WebCodecs). */
  microsecondTimestamp: number
  /** Canonical integer-microsecond duration; 0 when the container omits it. */
  microsecondDuration: number
  data: Uint8Array
}

/** The slice of Mediabunny's EncodedPacketSink this module drives. */
export interface PacketSinkLike {
  getFirstPacket(): Promise<PacketLike | null>
  getNextPacket(packet: PacketLike): Promise<PacketLike | null>
  getKeyPacket(
    timestampSec: number,
    options?: { verifyKeyPackets?: boolean },
  ): Promise<PacketLike | null>
}

/**
 * How far past the target we keep reading before giving up on finding a
 * packet that matches it (timestamp holes / dropped frames in the source).
 */
const MAX_OVERSHOOT_SEC = 0.25

export class VideoChunkSource {
  private readonly sink: PacketSinkLike
  /** Used when a container reports zero-duration packets. */
  private readonly fallbackDurationUs: number

  constructor(sink: PacketSinkLike, rate: FrameRate) {
    this.sink = sink
    this.fallbackDurationUs = Math.round((1e6 * rate.den) / rate.num)
  }

  /**
   * Chunks from the governing keyframe up to (and including) the packet
   * whose presentation time lands within `toleranceSec` of `targetSec`, in
   * decode order. Returns fewer chunks — without a matching packet — when
   * the target falls in a timestamp hole; the worker then replies
   * frameReady(drewFrame=false) and the caller decides what to do.
   */
  async chunksForTimestamp(
    targetSec: number,
    toleranceSec: number,
  ): Promise<ChunkPayload[]> {
    let packet =
      (await this.sink.getKeyPacket(targetSec, { verifyKeyPackets: true })) ??
      (await this.sink.getFirstPacket())
    if (packet === null) return []
    if (packet.type !== 'key') {
      throw new Error(
        'VideoChunkSource: no keyframe at or before the target — stream is not seekable',
      )
    }

    const chunks: ChunkPayload[] = []
    let current: PacketLike | null = packet
    while (current !== null) {
      if (current.timestamp > targetSec + MAX_OVERSHOOT_SEC) break
      chunks.push(this.toPayload(current))
      if (Math.abs(current.timestamp - targetSec) <= toleranceSec) break
      current = await this.sink.getNextPacket(current)
    }
    return chunks
  }

  private toPayload(packet: PacketLike): ChunkPayload {
    return {
      type: packet.type,
      timestampUs: packet.microsecondTimestamp,
      durationUs: packet.microsecondDuration || this.fallbackDurationUs,
      // slice() copies into a fresh buffer sized to the view — transferable
      // without detaching demuxer-owned memory.
      data: packet.data.slice().buffer,
    }
  }
}

/** Real wiring: a chunk source reading from a demuxed Mediabunny track. */
export function createChunkSource(
  track: InputVideoTrack,
  rate: FrameRate,
): VideoChunkSource {
  return new VideoChunkSource(new EncodedPacketSink(track), rate)
}
