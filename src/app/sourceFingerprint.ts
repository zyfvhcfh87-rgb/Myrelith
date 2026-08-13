import type { MediaAsset } from '../domain/schema'

const FINGERPRINT_SAMPLE_BYTES = 64 * 1024

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this browser')
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * Bounded content fingerprint shared by disposable local media sidecars.
 *
 * The digest covers immutable import metadata plus first/middle/last 64 KiB
 * samples. The algorithm name is explicit because this is intentionally not a
 * full-file digest.
 */
export async function fingerprintLocalMediaSource(
  blob: Blob,
  identity: Pick<MediaAsset, 'fileName' | 'size' | 'lastModified'>,
) {
  const offsets = [
    0,
    Math.max(0, Math.floor((blob.size - FINGERPRINT_SAMPLE_BYTES) / 2)),
    Math.max(0, blob.size - FINGERPRINT_SAMPLE_BYTES),
  ]
  const metadata = new TextEncoder().encode(JSON.stringify({
    algorithm: 'sha256-sampled-v1',
    fileName: identity.fileName,
    size: identity.size,
    lastModified: identity.lastModified,
    liveSize: blob.size,
    offsets,
  }))
  const samples = await Promise.all(offsets.map(async (offset) => (
    new Uint8Array(await blob.slice(offset, offset + FINGERPRINT_SAMPLE_BYTES).arrayBuffer())
  )))
  const total = metadata.byteLength + samples.reduce((sum, sample) => sum + sample.byteLength, 0)
  const joined = new Uint8Array(total)
  joined.set(metadata)
  let cursor = metadata.byteLength
  for (const sample of samples) {
    joined.set(sample, cursor)
    cursor += sample.byteLength
  }
  return {
    algorithm: 'sha256-sampled-v1' as const,
    digest: await sha256Hex(joined),
    fileName: identity.fileName,
    size: identity.size,
    lastModified: identity.lastModified,
  }
}
