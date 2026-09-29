/**
 * Deterministic ZIP STORE writer. PNG payloads are already compressed; STORE
 * keeps byte-exact names and contents without a native compressor.
 */

export interface ZipStoreEntry {
  readonly name: string
  readonly data: Uint8Array
}

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let crc = index
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) === 1 ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1
  }
  CRC_TABLE[index] = crc >>> 0
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index++) {
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function encodeUtf8Name(name: string): Uint8Array {
  if (name.length === 0 || name.includes('\0') || name.startsWith('/') || name.includes('\\')) {
    throw new TypeError('ZIP entry names must be relative and non-empty')
  }
  return new TextEncoder().encode(name)
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true)
}

/**
 * Build an uncompressed ZIP. DOS timestamps stay zero so the archive is
 * deterministic. The result exactly spans its own buffer (offset 0), so
 * callers may hand `result.buffer` on without another copy.
 */
export function zipStore(entries: readonly ZipStoreEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length > 65_535) throw new RangeError('ZIP STORE is limited to 65535 files')
  const encoded = entries.map((entry) => {
    const name = encodeUtf8Name(entry.name)
    if (name.byteLength > 0xffff) throw new RangeError('ZIP entry name is too long')
    const size = entry.data.byteLength
    if (size > 0xffffffff) throw new RangeError('ZIP entry exceeds 4 GiB')
    return { name, data: entry.data, crc: crc32(entry.data), size }
  })

  let localSize = 0
  let centralSize = 0
  for (const entry of encoded) {
    localSize += 30 + entry.name.byteLength + entry.size
    centralSize += 46 + entry.name.byteLength
  }
  const total = localSize + centralSize + 22
  if (total > Number.MAX_SAFE_INTEGER) throw new RangeError('ZIP archive is too large')
  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)

  let offset = 0
  const localOffsets: number[] = []
  for (const entry of encoded) {
    localOffsets.push(offset)
    writeUint32(view, offset, 0x04034b50)
    writeUint16(view, offset + 4, 20)
    writeUint16(view, offset + 6, 0)
    writeUint16(view, offset + 8, 0)
    writeUint16(view, offset + 10, 0)
    writeUint16(view, offset + 12, 0)
    writeUint32(view, offset + 14, entry.crc)
    writeUint32(view, offset + 18, entry.size)
    writeUint32(view, offset + 22, entry.size)
    writeUint16(view, offset + 26, entry.name.byteLength)
    writeUint16(view, offset + 28, 0)
    output.set(entry.name, offset + 30)
    output.set(entry.data, offset + 30 + entry.name.byteLength)
    offset += 30 + entry.name.byteLength + entry.size
  }

  const centralStart = offset
  for (const [index, entry] of encoded.entries()) {
    writeUint32(view, offset, 0x02014b50)
    writeUint16(view, offset + 4, 20)
    writeUint16(view, offset + 6, 20)
    writeUint16(view, offset + 8, 0)
    writeUint16(view, offset + 10, 0)
    writeUint16(view, offset + 12, 0)
    writeUint16(view, offset + 14, 0)
    writeUint32(view, offset + 16, entry.crc)
    writeUint32(view, offset + 18, entry.size)
    writeUint32(view, offset + 22, entry.size)
    writeUint16(view, offset + 26, entry.name.byteLength)
    writeUint16(view, offset + 28, 0)
    writeUint16(view, offset + 30, 0)
    writeUint16(view, offset + 32, 0)
    writeUint16(view, offset + 34, 0)
    writeUint32(view, offset + 36, 0)
    writeUint32(view, offset + 38, localOffsets[index]!)
    output.set(entry.name, offset + 46)
    offset += 46 + entry.name.byteLength
  }

  writeUint32(view, offset, 0x06054b50)
  writeUint16(view, offset + 4, 0)
  writeUint16(view, offset + 6, 0)
  writeUint16(view, offset + 8, encoded.length)
  writeUint16(view, offset + 10, encoded.length)
  writeUint32(view, offset + 12, centralSize)
  writeUint32(view, offset + 16, centralStart)
  writeUint16(view, offset + 20, 0)
  return output
}
