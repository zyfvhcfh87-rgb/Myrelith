import {
  base64urlEncode,
  concatBytes,
  hexBytes,
  sha256Hex,
  u32BigEndian,
  utf8Bytes,
} from './bytes'

const GOLDEN_PUBLIC_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'
const GOLDEN_FINGERPRINT = 'sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9'
const GOLDEN_SIGNATURE = 'mGj9h_CF_9V9S01ClcHESESk0QxSo-HM1Dxxpo98lo3UA-R9zRGjIXuv8XoLmBAFti0625yjz-UbiktJmpQJDg'
const PLUGIN_FIXTURE_SCHEMA_VERSION = 1

export const GOLDEN_MANIFEST_JSON = JSON.stringify({
  api: { maxVersion: 1, minVersion: 1 },
  contributions: [{
    contributionVersion: 1,
    descriptorVersion: 1,
    entrypoint: 'myrelith_effect_fixture',
    id: 'fixture',
    kind: 'video-effect',
    migrations: [],
    name: 'Fixture',
    parameters: [],
  }],
  id: 'com.example.fixture',
  name: 'Fixture',
  permissions: [{
    id: 'myrelith.effect.video-frame.rgba8',
    maxVersion: 1,
    minVersion: 1,
    required: true,
  }],
  runtime: {
    entry: 'runtime/plugin.wasm',
    kind: 'wasm',
    memoryMaximumPages: 258,
  },
  schemaVersion: PLUGIN_FIXTURE_SCHEMA_VERSION,
  version: '1.0.0',
})
export const GOLDEN_WASM_HEX = '0061736d01000000010f01600a7f7f7f7f7f7f7f7f7f7f017f021701086d7972656c697468066d656d6f727902018202820203020100071b01176d7972656c6974685f6566666563745f6669787475726500000a0601040041000b'
export const GOLDEN_SIGNATURE_JSON = JSON.stringify({
  algorithm: 'Ed25519',
  entries: [
    {
      length: 496,
      path: 'manifest.json',
      sha256: '4e0895870d15157857e53bbd261230b8d3cffad62d7d2fb8a5be1bd65c8b59b7',
    },
    {
      length: 91,
      path: 'runtime/plugin.wasm',
      sha256: 'a14d35d3869f4460413d414bef13e060c7e20c9a37f27a91a2cab8a6d8e79915',
    },
  ],
  fingerprint: GOLDEN_FINGERPRINT,
  format: 'myrelith-plugin-signature',
  formatVersion: 1,
  publicKey: GOLDEN_PUBLIC_KEY,
  signature: GOLDEN_SIGNATURE,
})

export const GOLDEN_PLUGIN_FACTS = Object.freeze({
  manifestLength: 496,
  manifestSha256: '4e0895870d15157857e53bbd261230b8d3cffad62d7d2fb8a5be1bd65c8b59b7',
  moduleLength: 91,
  moduleSha256: 'a14d35d3869f4460413d414bef13e060c7e20c9a37f27a91a2cab8a6d8e79915',
  signedPayloadLength: 469,
  signedPayloadSha256: 'a99cac0e2462fd36cb0c329b7e33dc97bbeeaaffe2f8a3ff3fa24c6bfb71876a',
  signatureEnvelopeLength: 570,
  signatureEnvelopeSha256: '04881c8c0d9c0e3094d2be3a03708db61ad4ef4e5b792c576b682f1ec687ac4d',
  publicKey: GOLDEN_PUBLIC_KEY,
  signerFingerprint: GOLDEN_FINGERPRINT,
  signature: GOLDEN_SIGNATURE,
  packageDigest: 'sha256:cb47299284c74ad83fce88a8c2d50af97e9de6f6d56513f9e07ac7dac2851d97',
})

const FIXTURE_PRIVATE_KEY_PKCS8_HEX = '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'

export interface StoredZipEntry {
  readonly path: string
  readonly bytes: Uint8Array
  readonly unixMode?: number
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

export function storedZip(entries: readonly StoredZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new RangeError('stored ZIP fixture has too many entries')
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = utf8Bytes(entry.path)
    const checksum = crc32(entry.bytes)
    const local = new Uint8Array(30 + name.byteLength + entry.bytes.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x0403_4b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, entry.bytes.byteLength, true)
    localView.setUint32(22, entry.bytes.byteLength, true)
    localView.setUint16(26, name.byteLength, true)
    local.set(name, 30)
    local.set(entry.bytes, 30 + name.byteLength)
    localChunks.push(local)

    const central = new Uint8Array(46 + name.byteLength)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x0201_4b50, true)
    centralView.setUint16(4, entry.unixMode === undefined ? 20 : (3 << 8) | 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, entry.bytes.byteLength, true)
    centralView.setUint32(24, entry.bytes.byteLength, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint32(38, ((entry.unixMode ?? 0) << 16) >>> 0, true)
    centralView.setUint32(42, localOffset, true)
    central.set(name, 46)
    centralChunks.push(central)
    localOffset += local.byteLength
  }

  const locals = concatBytes(localChunks)
  const central = concatBytes(centralChunks)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x0605_4b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, central.byteLength, true)
  endView.setUint32(16, locals.byteLength, true)
  return concatBytes([locals, central, end])
}

export function goldenPluginEntries(): StoredZipEntry[] {
  return [
    { path: 'manifest.json', bytes: utf8Bytes(GOLDEN_MANIFEST_JSON) },
    { path: 'runtime/plugin.wasm', bytes: hexBytes(GOLDEN_WASM_HEX) },
    { path: 'signature.json', bytes: utf8Bytes(GOLDEN_SIGNATURE_JSON) },
  ]
}

export function goldenPluginArchive(): Uint8Array {
  return storedZip(goldenPluginEntries())
}

export interface SignedPackageFixtureInput {
  readonly manifestJson: string
  readonly modulePath: string
  readonly moduleBytes: Uint8Array
}

export interface SignedPackageFixture {
  readonly archive: Uint8Array
  readonly manifestBytes: Uint8Array
  readonly moduleBytes: Uint8Array
  readonly signatureBytes: Uint8Array
  readonly signedPayloadBytes: Uint8Array
  readonly signature: Uint8Array
  readonly packageDigest: string
}

export async function buildSignedPackageFixture(
  input: SignedPackageFixtureInput,
): Promise<SignedPackageFixture> {
  const manifestBytes = utf8Bytes(input.manifestJson)
  const moduleBytes = input.moduleBytes.slice()
  const entries = [
    {
      length: manifestBytes.byteLength,
      path: 'manifest.json',
      sha256: await sha256Hex(manifestBytes),
    },
    {
      length: moduleBytes.byteLength,
      path: input.modulePath,
      sha256: await sha256Hex(moduleBytes),
    },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const unsignedEnvelope = {
    algorithm: 'Ed25519',
    entries,
    fingerprint: GOLDEN_PLUGIN_FACTS.signerFingerprint,
    format: 'myrelith-plugin-signature',
    formatVersion: 1,
    publicKey: GOLDEN_PLUGIN_FACTS.publicKey,
  }
  const signedPayloadBytes = utf8Bytes(JSON.stringify(unsignedEnvelope))
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(hexBytes(FIXTURE_PRIVATE_KEY_PKCS8_HEX)).buffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    Uint8Array.from(signedPayloadBytes).buffer,
  ))
  const signatureBytes = utf8Bytes(JSON.stringify({
    ...unsignedEnvelope,
    signature: base64urlEncode(signature),
  }))
  const digestInput = concatBytes([
    utf8Bytes('myrelith-plugin-package-digest-v1\0'),
    u32BigEndian(signedPayloadBytes.byteLength),
    signedPayloadBytes,
    u32BigEndian(signature.byteLength),
    signature,
  ])
  const archive = storedZip([
    { path: 'manifest.json', bytes: manifestBytes },
    { path: input.modulePath, bytes: moduleBytes },
    { path: 'signature.json', bytes: signatureBytes },
  ])
  return {
    archive,
    manifestBytes,
    moduleBytes,
    signatureBytes,
    signedPayloadBytes,
    signature,
    packageDigest: `sha256:${await sha256Hex(digestInput)}`,
  }
}

export function appendArchiveTrailingBytes(archive: Uint8Array): Uint8Array {
  return concatBytes([archive, Uint8Array.of(0xde, 0xad)])
}

export function corruptFirstEntryChecksum(archive: Uint8Array): Uint8Array {
  const output = archive.slice()
  const end = new DataView(output.buffer, output.byteOffset + output.byteLength - 22, 22)
  const centralOffset = end.getUint32(16, true)
  new DataView(output.buffer, output.byteOffset, 30).setUint32(14, 0, true)
  new DataView(output.buffer, output.byteOffset + centralOffset, 46).setUint32(16, 0, true)
  return output
}

export interface HostileArchiveFixture {
  readonly id: string
  readonly expectedGate: string
  readonly build: () => Uint8Array
}

export function hostileArchiveFixtures(): HostileArchiveFixture[] {
  const entries = goldenPluginEntries()
  const withRuntimePath = (path: string) => storedZip([
    entries[0]!,
    { path, bytes: entries[1]!.bytes },
    entries[2]!,
  ])
  return [
    {
      id: 'duplicate-entry',
      expectedGate: 'duplicate names',
      build: () => storedZip([...entries, entries[0]!]),
    },
    { id: 'absolute-path', expectedGate: 'absolute paths', build: () => withRuntimePath('/plugin.wasm') },
    { id: 'parent-segment', expectedGate: 'dot-dot segments', build: () => withRuntimePath('../plugin.wasm') },
    { id: 'backslash', expectedGate: 'backslashes', build: () => withRuntimePath('runtime\\plugin.wasm') },
    { id: 'nul', expectedGate: 'NULs', build: () => withRuntimePath('runtime/plugin.wasm\0') },
    {
      id: 'case-fold-collision',
      expectedGate: 'Unicode/case-fold collisions',
      build: () => storedZip([...entries, { path: 'Runtime/PLUGIN.wasm', bytes: entries[1]!.bytes }]),
    },
    {
      id: 'unix-symlink',
      expectedGate: 'symlinks',
      build: () => storedZip([{ ...entries[0]!, unixMode: 0o120777 }, ...entries.slice(1)]),
    },
    {
      id: 'checksum-mismatch',
      expectedGate: 'CRC mismatch',
      build: () => corruptFirstEntryChecksum(goldenPluginArchive()),
    },
    {
      id: 'trailing-bytes',
      expectedGate: 'trailing bytes',
      build: () => appendArchiveTrailingBytes(goldenPluginArchive()),
    },
  ]
}

export interface ByteRangeBoundary {
  readonly minimum: number
  readonly maximum: number
  readonly belowMinimum: () => Uint8Array | null
  readonly atMinimum: () => Uint8Array
  readonly atMaximum: () => Uint8Array
  readonly aboveMaximum: () => Uint8Array
}

function byteRangeBoundary(minimum: number, maximum: number): ByteRangeBoundary {
  return Object.freeze({
    minimum,
    maximum,
    belowMinimum: () => minimum === 0 ? null : new Uint8Array(minimum - 1),
    atMinimum: () => new Uint8Array(minimum),
    atMaximum: () => new Uint8Array(maximum),
    aboveMaximum: () => new Uint8Array(maximum + 1),
  })
}

export function wasmPathAtLength(length: number): string {
  if (!Number.isInteger(length) || length < 6) throw new RangeError('Wasm fixture path is too short')
  return `${'a'.repeat(length - 5)}.wasm`
}

export const ISSUE77_PACKAGE_BOUNDARIES = Object.freeze({
  archive: byteRangeBoundary(1, 32 * 1024 * 1024),
  expanded: byteRangeBoundary(1, 64 * 1024 * 1024),
  manifest: byteRangeBoundary(1, 65_536),
  signature: byteRangeBoundary(1, 65_536),
  wasm: byteRangeBoundary(8, 32 * 1024 * 1024),
  entries: Object.freeze({
    maximum: 256,
    atMaximum: () => Array.from({ length: 256 }, (_unused, index) => ({
      path: `fixture-${index.toString().padStart(3, '0')}.bin`,
      bytes: Uint8Array.of(index & 0xff),
    })),
    aboveMaximum: () => Array.from({ length: 257 }, (_unused, index) => ({
      path: `fixture-${index.toString().padStart(3, '0')}.bin`,
      bytes: Uint8Array.of(index & 0xff),
    })),
  }),
  runtimePath: Object.freeze({
    maximum: 240,
    atMaximum: () => wasmPathAtLength(240),
    aboveMaximum: () => wasmPathAtLength(241),
  }),
})
