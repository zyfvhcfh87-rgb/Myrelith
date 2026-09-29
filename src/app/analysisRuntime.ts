/**
 * Small runtime helpers shared by the motion-analysis product owners
 * (motion tracking and video stabilization): exact-shape checks for cached
 * results, owned-buffer release, cooperative yielding and stable digests.
 */
import { sha256Hex } from './sourceFingerprint'

export const utf8Encoder = new TextEncoder()
/** Non-streaming decodes keep no state between calls, so one instance is shared. */
export const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true })

/** Detach an owned result buffer so its memory is released immediately. */
export function releaseBytes(bytes: Uint8Array<ArrayBuffer>): void {
  if (bytes.buffer.byteLength > 0) structuredClone(null, { transfer: [bytes.buffer] })
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as {
    scheduler?: { yield?: () => Promise<void> }
  }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(undefined)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export function monotonicNow(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now()
}

/** SHA-256 of already-serialized UTF-8 text. */
export async function textDigest(text: string): Promise<string> {
  return sha256Hex(utf8Encoder.encode(text))
}

export async function jsonDigest(value: unknown): Promise<string> {
  return textDigest(JSON.stringify(value))
}
