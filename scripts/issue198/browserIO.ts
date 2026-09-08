import type { EvidenceRecord } from './maskPerformanceGate'

declare global {
  var __issue198Record: (record: EvidenceRecord) => Promise<void>
  var __issue198Binary: (part: { name: string; totalBytes: number; offset: number; bytes: number[] }) => Promise<void>
}
export async function recordEvidence(record: EvidenceRecord) {
  await globalThis.__issue198Record({ browserTimeMs: performance.now(), ...record })
}
export async function persistBinary(name: string, buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    await globalThis.__issue198Binary({ name, totalBytes: bytes.length, offset, bytes: Array.from(bytes.subarray(offset, offset + 65_536)) })
  }
}
