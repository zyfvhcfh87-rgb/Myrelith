/** Byte helpers shared by every layer (pure TypeScript). */

/** Lowercase hexadecimal text, two digits per byte. */
export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  // Unlike instanceof, isView also recognizes a view from another realm (jsdom).
  const view = ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes)
  return Array.from(view, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
