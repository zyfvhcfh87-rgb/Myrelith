/**
 * workers/decode-protocol.ts — The canonical ToWorker/FromWorker message
 * contract between engine/worker-bridge.ts and workers/decode.worker.ts
 * (referenced by ARCHITECTURE.md). Types only: safe for BOTH sides to
 * import — it carries zero runtime code, so importing it can never drag
 * worker side effects into the main thread or vice versa.
 *
 * Timestamps follow the WebCodecs convention: integer MICROSECONDS.
 * Frame-number <-> microsecond conversion happens on the bridge side with
 * domain/time.ts; the worker never sees frame numbers.
 */

/** One demuxed encoded chunk, ready to rebuild as an EncodedVideoChunk. */
export interface ChunkPayload {
  /** 'key' chunks start a decodable group; the first chunk of a seek MUST be one. */
  type: 'key' | 'delta'
  /** Presentation timestamp in integer microseconds. */
  timestampUs: number
  /** Frame duration in integer microseconds. */
  durationUs: number
  /** Encoded bytes. Transfer this buffer in postMessage — do not copy. */
  data: ArrayBuffer
}

/** Messages the main thread sends to the decode worker. */
export type ToDecodeWorker =
  | {
      /** Hand over the drawing surface. Sent once; canvas is transferred. */
      type: 'init'
      canvas: OffscreenCanvas
    }
  | {
      /**
       * (Re)configure the decoder. A live VideoDecoderConfig survives
       * structured clone (description travels as bytes), so no base64 here —
       * the bridge deserializes MediaAsset.decoderConfigB64 before sending.
       */
      type: 'configure'
      config: VideoDecoderConfig
    }
  | {
      /**
       * Decode `chunks` (keyframe-first) and draw exactly the frame whose
       * timestamp lands within `toleranceUs` of `targetTimestampUs`. A new
       * seek supersedes an in-flight one (latest wins): the worker resets
       * the decoder and abandons the older batch, and only the LATEST seek
       * is guaranteed a frameReady reply.
       */
      type: 'seek'
      /** Echoed back in frameReady so the bridge can match replies. */
      requestId: number
      targetTimestampUs: number
      /** Half a frame duration, in µs — the "is this the target?" window. */
      toleranceUs: number
      chunks: ChunkPayload[]
    }
  | {
      /** Tear down the decoder (worker itself stays alive). */
      type: 'close'
    }

/** Messages the decode worker sends back to the main thread. */
export type FromDecodeWorker =
  | {
      /** Decoder is configured and ready for seeks. */
      type: 'configured'
    }
  | {
      /** A seek finished. drewFrame=false means the target never decoded. */
      type: 'frameReady'
      requestId: number
      drewFrame: boolean
      /** Timestamp of the frame actually drawn, or -1 when drewFrame=false. */
      frameTimestampUs: number
      /** Wall-clock decode+draw time for this seek, ms (perf telemetry). */
      decodeMs: number
    }
  | {
      /** Something failed; requestId present when tied to a specific seek. */
      type: 'error'
      requestId?: number
      message: string
    }
