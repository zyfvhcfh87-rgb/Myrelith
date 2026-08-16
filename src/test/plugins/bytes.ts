const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function utf8Text(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}

export function hexBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new TypeError('fixture hex must contain an even number of lowercase hexadecimal characters')
  }
  return Uint8Array.from(
    { length: value.length / 2 },
    (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}

export function bytesToHex(value: Uint8Array): string {
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  if (!Number.isSafeInteger(length)) throw new RangeError('fixture byte length is not a safe integer')
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export function encodeU32Leb(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('fixture u32 value is out of range')
  }
  const bytes: number[] = []
  let remaining = value
  do {
    const payload = remaining % 128
    remaining = Math.floor(remaining / 128)
    bytes.push(remaining === 0 ? payload : payload | 0x80)
  } while (remaining !== 0)
  return Uint8Array.from(bytes)
}

export interface DecodedU32Leb {
  readonly value: number
  readonly nextOffset: number
}

export function decodeU32Leb(bytes: Uint8Array, offset = 0): DecodedU32Leb {
  let value = 0
  let multiplier = 1
  for (let index = 0; index < 5; index++) {
    const byte = bytes[offset + index]
    if (byte === undefined) throw new RangeError('truncated fixture u32 LEB')
    const payload = byte & 0x7f
    if (index === 4 && payload > 0x0f) throw new RangeError('overflowing fixture u32 LEB')
    value += payload * multiplier
    if ((byte & 0x80) === 0) {
      const encodedLength = index + 1
      if (encodeU32Leb(value).byteLength !== encodedLength) {
        throw new RangeError('noncanonical fixture u32 LEB')
      }
      return { value, nextOffset: offset + encodedLength }
    }
    multiplier *= 128
  }
  throw new RangeError('overflowing fixture u32 LEB')
}

export function base64urlEncode(bytes: Uint8Array): string {
  let output = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset]!
    const second = bytes[offset + 1]
    const third = bytes[offset + 2]
    output += BASE64URL_ALPHABET[first >>> 2]
    output += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]
    if (second !== undefined) {
      output += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]
    }
    if (third !== undefined) output += BASE64URL_ALPHABET[third & 0x3f]
  }
  return output
}

export function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TypeError('fixture base64url must be canonical and unpadded')
  }
  const output: number[] = []
  for (let offset = 0; offset < value.length; offset += 4) {
    const chunk = value.slice(offset, offset + 4)
    const values = [...chunk].map((character) => BASE64URL_ALPHABET.indexOf(character))
    if (values.some((entry) => entry < 0)) throw new TypeError('invalid fixture base64url')
    const [first = 0, second = 0, third = 0, fourth = 0] = values
    output.push((first << 2) | (second >>> 4))
    if (chunk.length >= 3) output.push(((second & 0x0f) << 4) | (third >>> 2))
    if (chunk.length === 4) output.push(((third & 0x03) << 6) | fourth)
  }
  const decoded = Uint8Array.from(output)
  if (base64urlEncode(decoded) !== value) throw new TypeError('noncanonical fixture base64url')
  return decoded
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return new Uint8Array(digest)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await sha256Bytes(bytes))
}

export function u32BigEndian(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('fixture u32 value is out of range')
  }
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, value, false)
  return output
}
