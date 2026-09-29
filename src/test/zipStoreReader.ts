/** Test-side reader for archives written by pipeline/zipStore (STORE only). */

import { crc32, type ZipStoreEntry } from '../pipeline/zipStore'

export function unzipStore(buffer: Uint8Array): readonly ZipStoreEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const entries: ZipStoreEntry[] = []
  let offset = 0
  while (offset + 4 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true)
    if (method !== 0) throw new Error('Only uncompressed ZIP STORE entries are readable here')
    const crc = view.getUint32(offset + 14, true)
    const size = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(buffer.subarray(offset + 30, offset + 30 + nameLength))
    const dataStart = offset + 30 + nameLength + extraLength
    const data = buffer.subarray(dataStart, dataStart + size)
    if (crc32(data) !== crc) throw new Error(`ZIP CRC mismatch for ${name}`)
    entries.push({ name, data: new Uint8Array(data) })
    offset = dataStart + size
  }
  return Object.freeze(entries)
}
