/**
 * pipeline/demux.ts — The persisted decoder-config string format
 * (MediaAsset.decoderConfigB64). Import analysis itself lives in
 * mediaCompatibilityProbe.ts.
 *
 * Layering: pipeline/ → domain/ only. No React, no state/, no ui/.
 */

/* ------------------------------------------------------------------ */
/* VideoDecoderConfig -> string (MediaAsset.decoderConfigB64)           */
/* ------------------------------------------------------------------ */

/** Bytes -> base64, chunked so large buffers cannot blow the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Normalize BufferSource (ArrayBuffer or any view) to an exact Uint8Array.
 * Deliberately never references the SharedArrayBuffer global: it does not
 * exist on non-cross-origin-isolated pages, and touching the bare name
 * throws ReferenceError there (found by the Phase 2.5 browser smoke test).
 */
function toUint8(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  }
  return new Uint8Array(source as ArrayBuffer)
}

/**
 * Serialize a VideoDecoderConfig to a JSON string, base64-encoding the
 * binary `description` (e.g. H.264 avcC extradata) if present — the format
 * stored in MediaAsset.decoderConfigB64.
 */
export function serializeDecoderConfig(config: VideoDecoderConfig): string {
  const { description, ...rest } = config
  const payload: Record<string, unknown> = { ...rest }
  if (description !== undefined) {
    payload.descriptionB64 = bytesToBase64(toUint8(description))
  }
  return JSON.stringify(payload)
}
