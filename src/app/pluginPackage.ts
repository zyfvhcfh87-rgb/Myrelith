import {
  PLUGIN_MANIFEST_LIMITS,
  negotiatePluginCompatibility,
  validatePluginManifest,
  type PluginCompatibilityResult,
  type PluginManifestV1,
} from '../domain/pluginManifest'

const ARCHIVE_LIMIT_BYTES = 32 * 1024 * 1024
const EXPANDED_LIMIT_BYTES = 64 * 1024 * 1024
const SIGNATURE_LIMIT_BYTES = 65_536
const PACKAGE_ENTRY_COUNT = 3
const PACKAGE_DIGEST_DOMAIN = 'myrelith-plugin-package-digest-v1\0'

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type PluginPackageErrorCode =
  | 'archive-invalid'
  | 'manifest-invalid'
  | 'signature-invalid'
  | 'integrity-invalid'
  | 'crypto-unavailable'

export class PluginPackageError extends Error {
  readonly code: PluginPackageErrorCode

  constructor(code: PluginPackageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginPackageError'
    this.code = code
  }
}

export interface VerifiedPluginPackage {
  readonly packageDigest: `sha256:${string}`
  readonly signerFingerprint: `sha256:${string}`
  readonly modulePath: string
  readonly moduleSha256: string
  readonly manifest: PluginManifestV1
  readonly compatibility: PluginCompatibilityResult
  readonly manifestBytes: Uint8Array
  readonly moduleBytes: Uint8Array
  readonly signatureBytes: Uint8Array
}

interface ZipEntry {
  readonly path: string
  readonly bytes: Uint8Array
  readonly checksum: number
  readonly localOffset: number
  readonly localEnd: number
}

interface CentralEntry {
  readonly path: string
  readonly flags: number
  readonly method: number
  readonly modifiedTime: number
  readonly modifiedDate: number
  readonly checksum: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

interface SignatureEntry {
  readonly path: string
  readonly length: number
  readonly sha256: string
}

interface SignatureEnvelope {
  readonly format: 'myrelith-plugin-signature'
  readonly formatVersion: 1
  readonly algorithm: 'Ed25519'
  readonly publicKey: string
  readonly fingerprint: `sha256:${string}`
  readonly entries: readonly SignatureEntry[]
  readonly signature: string
}

function fail(
  code: PluginPackageErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new PluginPackageError(code, message, cause === undefined ? undefined : { cause })
}

function boundedView(bytes: Uint8Array, offset: number, length: number): DataView {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    fail('archive-invalid', 'The package archive contains an out-of-bounds ZIP record.')
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length)
}

function asciiPath(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) {
    if (byte > 0x7f) {
      fail('archive-invalid', 'Package entry names must use canonical ASCII paths.')
    }
    value += String.fromCharCode(byte)
  }
  const segments = value.split('/')
  if (value === '' || value.startsWith('/') || value.includes('\\')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('archive-invalid', `Package entry path ${JSON.stringify(value)} is unsafe.`)
  }
  return value
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb8_8320)
    }
  }
  return (value ^ 0xffff_ffff) >>> 0
}

function parseStoredZip(archiveBytes: Uint8Array): ReadonlyMap<string, ZipEntry> {
  if (archiveBytes.byteLength > ARCHIVE_LIMIT_BYTES) {
    fail('archive-invalid', `Plugin packages must not exceed ${ARCHIVE_LIMIT_BYTES} bytes.`)
  }
  if (archiveBytes.byteLength < 22) {
    fail('archive-invalid', 'The package is too short to contain a ZIP end record.')
  }

  const endOffset = archiveBytes.byteLength - 22
  const end = boundedView(archiveBytes, endOffset, 22)
  if (end.getUint32(0, true) !== 0x0605_4b50) {
    fail('archive-invalid', 'The package must end with one unambiguous ZIP end record.')
  }
  if (end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0
    || end.getUint16(20, true) !== 0) {
    fail('archive-invalid', 'Multi-disk and commented ZIP packages are not supported.')
  }
  const entriesOnDisk = end.getUint16(8, true)
  const entryCount = end.getUint16(10, true)
  if (entriesOnDisk !== entryCount || entryCount !== PACKAGE_ENTRY_COUNT) {
    fail('archive-invalid', `A plugin package must contain exactly ${PACKAGE_ENTRY_COUNT} entries.`)
  }
  const centralSize = end.getUint32(12, true)
  const centralOffset = end.getUint32(16, true)
  if (centralOffset + centralSize !== endOffset) {
    fail('archive-invalid', 'The ZIP central directory is not contiguous with the end record.')
  }

  const centralEntries: CentralEntry[] = []
  const canonicalNames = new Set<string>()
  let cursor = centralOffset
  let expandedBytes = 0
  for (let index = 0; index < entryCount; index++) {
    const header = boundedView(archiveBytes, cursor, 46)
    if (header.getUint32(0, true) !== 0x0201_4b50) {
      fail('archive-invalid', 'The ZIP central directory contains an invalid entry header.')
    }
    const nameLength = header.getUint16(28, true)
    const extraLength = header.getUint16(30, true)
    const commentLength = header.getUint16(32, true)
    const recordLength = 46 + nameLength + extraLength + commentLength
    boundedView(archiveBytes, cursor, recordLength)
    if (extraLength !== 0 || commentLength !== 0 || header.getUint16(34, true) !== 0) {
      fail('archive-invalid', 'ZIP entry extras, comments, and alternate disks are not supported.')
    }
    const path = asciiPath(archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength))
    const canonicalName = path.normalize('NFC').toLowerCase()
    if (canonicalNames.has(canonicalName)) {
      fail('archive-invalid', `Package entry ${path} collides with another entry name.`)
    }
    canonicalNames.add(canonicalName)

    const flags = header.getUint16(8, true)
    const method = header.getUint16(10, true)
    const compressedSize = header.getUint32(20, true)
    const uncompressedSize = header.getUint32(24, true)
    const creatorSystem = header.getUint16(4, true) >>> 8
    const unixFileType = (header.getUint32(38, true) >>> 16) & 0xf000
    if (creatorSystem === 3 && unixFileType !== 0 && unixFileType !== 0x8000) {
      fail('archive-invalid', `Package entry ${path} must be a regular file, not a link or device.`)
    }
    if (flags !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      fail('archive-invalid', 'Plugin packages must use unencrypted stored ZIP entries.')
    }
    expandedBytes += uncompressedSize
    if (expandedBytes > EXPANDED_LIMIT_BYTES) {
      fail('archive-invalid', `Expanded plugin packages must not exceed ${EXPANDED_LIMIT_BYTES} bytes.`)
    }
    centralEntries.push({
      path,
      flags,
      method,
      modifiedTime: header.getUint16(12, true),
      modifiedDate: header.getUint16(14, true),
      checksum: header.getUint32(16, true),
      compressedSize,
      uncompressedSize,
      localOffset: header.getUint32(42, true),
    })
    cursor += recordLength
  }
  if (cursor !== centralOffset + centralSize) {
    fail('archive-invalid', 'The ZIP central directory contains trailing or hidden records.')
  }

  const parsedEntries: ZipEntry[] = centralEntries.map((entry) => {
    const local = boundedView(archiveBytes, entry.localOffset, 30)
    if (local.getUint32(0, true) !== 0x0403_4b50) {
      fail('archive-invalid', `Package entry ${entry.path} has an invalid local header.`)
    }
    const nameLength = local.getUint16(26, true)
    const extraLength = local.getUint16(28, true)
    if (extraLength !== 0) {
      fail('archive-invalid', `Package entry ${entry.path} has an unsupported local extra field.`)
    }
    const localPath = asciiPath(archiveBytes.subarray(
      entry.localOffset + 30,
      entry.localOffset + 30 + nameLength,
    ))
    if (localPath !== entry.path
      || local.getUint16(6, true) !== entry.flags
      || local.getUint16(8, true) !== entry.method
      || local.getUint16(10, true) !== entry.modifiedTime
      || local.getUint16(12, true) !== entry.modifiedDate
      || local.getUint32(14, true) !== entry.checksum
      || local.getUint32(18, true) !== entry.compressedSize
      || local.getUint32(22, true) !== entry.uncompressedSize) {
      fail('archive-invalid', `Package entry ${entry.path} disagrees with its central record.`)
    }
    const dataOffset = entry.localOffset + 30 + nameLength
    const localEnd = dataOffset + entry.compressedSize
    if (localEnd > centralOffset) {
      fail('archive-invalid', `Package entry ${entry.path} overlaps the central directory.`)
    }
    const bytes = archiveBytes.slice(dataOffset, localEnd)
    if (crc32(bytes) !== entry.checksum) {
      fail('archive-invalid', `Package entry ${entry.path} failed its ZIP checksum.`)
    }
    return {
      path: entry.path,
      bytes,
      checksum: entry.checksum,
      localOffset: entry.localOffset,
      localEnd,
    }
  })

  const ranges = [...parsedEntries].sort((left, right) => left.localOffset - right.localOffset)
  let expectedOffset = 0
  for (const entry of ranges) {
    if (entry.localOffset !== expectedOffset) {
      fail('archive-invalid', 'The ZIP local entries contain hidden gaps or overlapping records.')
    }
    expectedOffset = entry.localEnd
  }
  if (expectedOffset !== centralOffset) {
    fail('archive-invalid', 'The ZIP local entries do not end at the central directory.')
  }
  return new Map(parsedEntries.map((entry) => [entry.path, entry]))
}

class JsonParser {
  readonly source: string
  private offset = 0
  private nodes = 0

  constructor(source: string) {
    this.source = source
  }

  parse(): JsonValue {
    const value = this.value(0)
    this.whitespace()
    if (this.offset !== this.source.length) this.invalid('contains trailing JSON data')
    return value
  }

  private invalid(message: string): never {
    throw new SyntaxError(`Canonical JSON ${message} at character ${this.offset}.`)
  }

  private whitespace(): void {
    while (this.offset < this.source.length
      && (this.source[this.offset] === ' '
        || this.source[this.offset] === '\n'
        || this.source[this.offset] === '\r'
        || this.source[this.offset] === '\t')) {
      this.offset++
    }
  }

  private value(depth: number): JsonValue {
    this.whitespace()
    this.nodes++
    if (depth > 128 || this.nodes > 16_384) this.invalid('exceeds structural limits')
    const token = this.source[this.offset]
    if (token === '{') return this.object(depth + 1)
    if (token === '[') return this.array(depth + 1)
    if (token === '"') return this.string()
    if (token === 't') return this.literal('true', true)
    if (token === 'f') return this.literal('false', false)
    if (token === 'n') return this.literal('null', null)
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9')) {
      return this.number()
    }
    return this.invalid('contains an invalid value')
  }

  private object(depth: number): JsonValue {
    this.offset++
    const output = Object.create(null) as Record<string, JsonValue>
    const keys = new Set<string>()
    this.whitespace()
    if (this.source[this.offset] === '}') {
      this.offset++
      return output
    }
    while (true) {
      this.whitespace()
      if (this.source[this.offset] !== '"') this.invalid('requires string object keys')
      const key = this.string()
      if (keys.has(key)) this.invalid(`contains duplicate key ${JSON.stringify(key)}`)
      keys.add(key)
      this.whitespace()
      if (this.source[this.offset] !== ':') this.invalid('requires a colon after an object key')
      this.offset++
      output[key] = this.value(depth)
      this.whitespace()
      const token = this.source[this.offset]
      this.offset++
      if (token === '}') return output
      if (token !== ',') this.invalid('requires a comma between object members')
    }
  }

  private array(depth: number): JsonValue {
    this.offset++
    const output: JsonValue[] = []
    this.whitespace()
    if (this.source[this.offset] === ']') {
      this.offset++
      return output
    }
    while (true) {
      output.push(this.value(depth))
      this.whitespace()
      const token = this.source[this.offset]
      this.offset++
      if (token === ']') return output
      if (token !== ',') this.invalid('requires a comma between array entries')
    }
  }

  private string(): string {
    const start = this.offset
    this.offset++
    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset)
      if (code === 0x22) {
        this.offset++
        let value: unknown
        try {
          value = JSON.parse(this.source.slice(start, this.offset))
        } catch (cause) {
          return this.invalid(cause instanceof Error ? cause.message : 'contains an invalid string')
        }
        if (typeof value !== 'string') return this.invalid('contains a non-string token')
        for (let index = 0; index < value.length; index++) {
          const unit = value.charCodeAt(index)
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1)
            if (next < 0xdc00 || next > 0xdfff) this.invalid('contains an unpaired surrogate')
            index++
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            this.invalid('contains an unpaired surrogate')
          }
        }
        return value
      }
      if (code <= 0x1f) this.invalid('contains an unescaped control character')
      if (code === 0x5c) {
        this.offset++
        const escape = this.source[this.offset]
        if (escape === 'u') {
          const digits = this.source.slice(this.offset + 1, this.offset + 5)
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) this.invalid('contains an invalid Unicode escape')
          this.offset += 5
          continue
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          this.invalid('contains an invalid escape')
        }
      }
      this.offset++
    }
    return this.invalid('contains an unterminated string')
  }

  private literal<T extends boolean | null>(token: string, value: T): T {
    if (this.source.slice(this.offset, this.offset + token.length) !== token) {
      this.invalid(`contains an invalid ${token} literal`)
    }
    this.offset += token.length
    return value
  }

  private number(): number {
    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy
    numberPattern.lastIndex = this.offset
    const match = numberPattern.exec(this.source)
    if (!match) return this.invalid('contains an invalid number')
    this.offset = numberPattern.lastIndex
    const value = Number(match[0])
    if (!Number.isFinite(value)) return this.invalid('contains a non-finite number')
    return value
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite.')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Readonly<Record<string, JsonValue>>
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`
}

function canonicalObject(
  bytes: Uint8Array,
  maximumBytes: number,
  code: 'manifest-invalid' | 'signature-invalid',
): Readonly<Record<string, JsonValue>> {
  if (bytes.byteLength > maximumBytes) fail(code, `Canonical JSON must not exceed ${maximumBytes} bytes.`)
  if (bytes.byteLength >= 3
    && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(code, 'Canonical JSON must not include a byte-order mark.')
  }
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    fail(code, 'Canonical JSON must be valid UTF-8.', cause)
  }
  let value: JsonValue
  try {
    value = new JsonParser(source).parse()
  } catch (cause) {
    fail(code, 'Canonical JSON could not be parsed.', cause)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(code, 'Canonical JSON roots must be objects.')
  }
  if (canonicalJson(value) !== source) {
    fail(code, 'JSON bytes must exactly match RFC 8785 canonical form.')
  }
  return value as Readonly<Record<string, JsonValue>>
}

function exactKeys(
  value: Readonly<Record<string, JsonValue>>,
  expected: readonly string[],
  code: PluginPackageErrorCode,
  path: string,
): void {
  const expectedSet = new Set(expected)
  if (Object.keys(value).length !== expected.length
    || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !expectedSet.has(key))) {
    fail(code, `${path} must contain exactly: ${expected.join(', ')}.`)
  }
}

function stringValue(value: JsonValue | undefined, code: PluginPackageErrorCode, path: string): string {
  if (typeof value !== 'string') fail(code, `${path} must be a string.`)
  return value
}

function integerValue(value: JsonValue | undefined, code: PluginPackageErrorCode, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(code, `${path} must be a non-negative safe integer.`)
  }
  return value as number
}

function signatureEnvelope(bytes: Uint8Array): SignatureEnvelope {
  const value = canonicalObject(bytes, SIGNATURE_LIMIT_BYTES, 'signature-invalid')
  exactKeys(value, [
    'format',
    'formatVersion',
    'algorithm',
    'publicKey',
    'fingerprint',
    'entries',
    'signature',
  ], 'signature-invalid', 'signature.json')
  if (value.format !== 'myrelith-plugin-signature'
    || value.formatVersion !== 1
    || value.algorithm !== 'Ed25519') {
    fail('signature-invalid', 'signature.json declares an unsupported signature format.')
  }
  if (!Array.isArray(value.entries) || value.entries.length !== 2) {
    fail('signature-invalid', 'signature.json must declare exactly two signed entries.')
  }
  const entries = value.entries.map((candidate, index): SignatureEntry => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      fail('signature-invalid', `signature.json.entries[${index}] must be an object.`)
    }
    const record = candidate as Readonly<Record<string, JsonValue>>
    exactKeys(record, ['length', 'path', 'sha256'], 'signature-invalid', `signature.json.entries[${index}]`)
    const sha256 = stringValue(record.sha256, 'signature-invalid', `signature.json.entries[${index}].sha256`)
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      fail('signature-invalid', `signature.json.entries[${index}].sha256 must be lowercase SHA-256 hex.`)
    }
    return {
      length: integerValue(record.length, 'signature-invalid', `signature.json.entries[${index}].length`),
      path: stringValue(record.path, 'signature-invalid', `signature.json.entries[${index}].path`),
      sha256,
    }
  })
  const fingerprint = stringValue(value.fingerprint, 'signature-invalid', 'signature.json.fingerprint')
  if (!/^sha256:[0-9a-f]{64}$/u.test(fingerprint)) {
    fail('signature-invalid', 'signature.json.fingerprint must be a lowercase SHA-256 fingerprint.')
  }
  return {
    format: 'myrelith-plugin-signature',
    formatVersion: 1,
    algorithm: 'Ed25519',
    publicKey: stringValue(value.publicKey, 'signature-invalid', 'signature.json.publicKey'),
    fingerprint: fingerprint as `sha256:${string}`,
    entries,
    signature: stringValue(value.signature, 'signature-invalid', 'signature.json.signature'),
  }
}

function base64urlEncode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let output = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset]
    const second = bytes[offset + 1]
    const third = bytes[offset + 2]
    output += alphabet[first >>> 2]
    output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]
    if (second !== undefined) {
      output += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]
    }
    if (third !== undefined) output += alphabet[third & 0x3f]
  }
  return output
}

function base64urlDecode(value: string, expectedLength: number, path: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    fail('signature-invalid', `${path} must be unpadded base64url.`)
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let bits = 0
  let bitCount = 0
  const output: number[] = []
  for (const character of value) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) fail('signature-invalid', `${path} must be unpadded base64url.`)
    bits = bits * 64 + digit
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      output.push(Math.floor(bits / 2 ** bitCount) & 0xff)
      bits %= 2 ** bitCount
    }
  }
  const bytes = Uint8Array.from(output)
  if (bytes.byteLength !== expectedLength || base64urlEncode(bytes) !== value) {
    fail('signature-invalid', `${path} is not a canonical ${expectedLength}-byte base64url value.`)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

async function sha256(bytes: Uint8Array, subtle: SubtleCrypto): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', ownedBuffer(bytes)))
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function bigEndianU32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail('integrity-invalid', 'Package digest fields must fit unsigned 32-bit lengths.')
  }
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, value)
  return output
}

function signedPayload(envelope: SignatureEnvelope): Uint8Array {
  const value: JsonValue = {
    algorithm: envelope.algorithm,
    entries: envelope.entries.map((entry) => ({
      length: entry.length,
      path: entry.path,
      sha256: entry.sha256,
    })),
    fingerprint: envelope.fingerprint,
    format: envelope.format,
    formatVersion: envelope.formatVersion,
    publicKey: envelope.publicKey,
  }
  return new TextEncoder().encode(canonicalJson(value))
}

async function packageDigest(
  message: Uint8Array,
  signature: Uint8Array,
  subtle: SubtleCrypto,
): Promise<`sha256:${string}`> {
  const framed = concatBytes([
    new TextEncoder().encode(PACKAGE_DIGEST_DOMAIN),
    bigEndianU32(message.byteLength),
    message,
    bigEndianU32(signature.byteLength),
    signature,
  ])
  return `sha256:${bytesToHex(await sha256(framed, subtle))}`
}

/** Verify a complete offline package before any install, trust, or execution decision. */
export async function verifyPluginPackageArchive(
  archiveBytes: Uint8Array,
): Promise<VerifiedPluginPackage> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) fail('crypto-unavailable', 'Web Crypto is required to verify plugin packages.')
  const archive = parseStoredZip(archiveBytes)
  const manifestEntry = archive.get('manifest.json')
  const signatureEntry = archive.get('signature.json')
  if (!manifestEntry || !signatureEntry) {
    fail('archive-invalid', 'The package must contain manifest.json and signature.json.')
  }

  const manifestValue = canonicalObject(
    manifestEntry.bytes,
    PLUGIN_MANIFEST_LIMITS.maxManifestBytes,
    'manifest-invalid',
  )
  const manifestResult = validatePluginManifest(manifestValue)
  if (!manifestResult.ok) {
    fail(
      'manifest-invalid',
      `Plugin manifest ${manifestResult.problem.path} ${manifestResult.problem.message}.`,
    )
  }
  const manifest = manifestResult.manifest
  const moduleEntry = archive.get(manifest.runtime.entry)
  if (!moduleEntry || archive.size !== PACKAGE_ENTRY_COUNT) {
    fail('archive-invalid', 'The package entries do not exactly match the manifest runtime path.')
  }

  const envelope = signatureEnvelope(signatureEntry.bytes)
  const signedEntries = [manifestEntry, moduleEntry]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  for (const [index, signedEntry] of signedEntries.entries()) {
    const declaration = envelope.entries[index]
    if (!declaration || declaration.path !== signedEntry.path
      || declaration.length !== signedEntry.bytes.byteLength) {
      fail('integrity-invalid', 'The signed entry table does not exactly match the package entries.')
    }
    const digest = bytesToHex(await sha256(signedEntry.bytes, subtle))
    if (declaration.sha256 !== digest) {
      fail('integrity-invalid', `Signed digest mismatch for ${signedEntry.path}.`)
    }
  }
  const moduleDeclaration = envelope.entries.find((entry) => entry.path === moduleEntry.path)
  if (!moduleDeclaration) {
    fail('integrity-invalid', 'The signed entry table does not declare the runtime module.')
  }

  const publicKey = base64urlDecode(envelope.publicKey, 32, 'signature.json.publicKey')
  const signature = base64urlDecode(envelope.signature, 64, 'signature.json.signature')
  const fingerprint = `sha256:${bytesToHex(await sha256(publicKey, subtle))}`
  if (fingerprint !== envelope.fingerprint) {
    fail('signature-invalid', 'The signer fingerprint does not match the public key.')
  }

  let key: CryptoKey
  let signatureValid: boolean
  const message = signedPayload(envelope)
  try {
    key = await subtle.importKey(
      'raw',
      ownedBuffer(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    signatureValid = await subtle.verify(
      { name: 'Ed25519' },
      key,
      ownedBuffer(signature),
      ownedBuffer(message),
    )
  } catch (cause) {
    fail('signature-invalid', 'The Ed25519 signature could not be verified.', cause)
  }
  if (!signatureValid) fail('signature-invalid', 'The Ed25519 signature is invalid.')

  const digest = await packageDigest(message, signature, subtle)
  const retainedManifestBytes = manifestEntry.bytes.slice()
  const retainedModuleBytes = moduleEntry.bytes.slice()
  const retainedSignatureBytes = signatureEntry.bytes.slice()
  const frozenManifest = deepFreeze(manifest)
  const frozenCompatibility = deepFreeze(negotiatePluginCompatibility(frozenManifest))
  const verified: VerifiedPluginPackage = {
    packageDigest: digest,
    signerFingerprint: envelope.fingerprint,
    modulePath: moduleEntry.path,
    moduleSha256: moduleDeclaration.sha256,
    manifest: frozenManifest,
    compatibility: frozenCompatibility,
    get manifestBytes() { return retainedManifestBytes.slice() },
    get moduleBytes() { return retainedModuleBytes.slice() },
    get signatureBytes() { return retainedSignatureBytes.slice() },
  }
  return Object.freeze(verified)
}