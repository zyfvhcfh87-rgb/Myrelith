import { describe, expect, test, vi } from 'vitest'
import {
  PluginPackageError,
  verifyPluginPackageArchive,
} from './pluginPackage'
import { hostileArchiveFixtures } from '../test/plugins/archiveFixtures'

const MANIFEST_JSON = '{"api":{"maxVersion":1,"minVersion":1},"contributions":[{"contributionVersion":1,"descriptorVersion":1,"entrypoint":"myrelith_effect_fixture","id":"fixture","kind":"video-effect","migrations":[],"name":"Fixture","parameters":[]}],"id":"com.example.fixture","name":"Fixture","permissions":[{"id":"myrelith.effect.video-frame.rgba8","maxVersion":1,"minVersion":1,"required":true}],"runtime":{"entry":"runtime/plugin.wasm","kind":"wasm","memoryMaximumPages":258},"schemaVersion":1,"version":"1.0.0"}'
const WASM_HEX = '0061736d01000000010f01600a7f7f7f7f7f7f7f7f7f7f017f021701086d7972656c697468066d656d6f727902018202820203020100071b01176d7972656c6974685f6566666563745f6669787475726500000a0601040041000b'
const SIGNATURE_JSON = '{"algorithm":"Ed25519","entries":[{"length":496,"path":"manifest.json","sha256":"4e0895870d15157857e53bbd261230b8d3cffad62d7d2fb8a5be1bd65c8b59b7"},{"length":91,"path":"runtime/plugin.wasm","sha256":"a14d35d3869f4460413d414bef13e060c7e20c9a37f27a91a2cab8a6d8e79915"}],"fingerprint":"sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9","format":"myrelith-plugin-signature","formatVersion":1,"publicKey":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","signature":"mGj9h_CF_9V9S01ClcHESESk0QxSo-HM1Dxxpo98lo3UA-R9zRGjIXuv8XoLmBAFti0625yjz-UbiktJmpQJDg"}'
const FIXTURE_PUBLIC_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'
const FIXTURE_FINGERPRINT = 'sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9'
const FIXTURE_PRIVATE_KEY_PKCS8 = '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'

interface ArchiveEntry {
  readonly path: string
  readonly bytes: Uint8Array
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function hex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error('hex fixture must have an even length')
  return Uint8Array.from(
    { length: value.length / 2 },
    (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
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

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function base64url(bytes: Uint8Array): string {
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function storedZip(entries: readonly ArchiveEntry[]): Uint8Array {
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = utf8(entry.path)
    const checksum = crc32(entry.bytes)
    const local = new Uint8Array(30 + name.byteLength + entry.bytes.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x0403_4b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, 0, true)
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
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, entry.bytes.byteLength, true)
    centralView.setUint32(24, entry.bytes.byteLength, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint32(42, localOffset, true)
    central.set(name, 46)
    centralChunks.push(central)
    localOffset += local.byteLength
  }

  const locals = concat(localChunks)
  const central = concat(centralChunks)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x0605_4b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, central.byteLength, true)
  endView.setUint32(16, locals.byteLength, true)
  return concat([locals, central, end])
}

async function signedArchive(
  manifestJson: string,
  modulePath: string,
  moduleBytes: Uint8Array,
): Promise<Uint8Array> {
  const manifestBytes = utf8(manifestJson)
  const entries = [
    {
      length: manifestBytes.byteLength,
      path: 'manifest.json',
      sha256: await sha256Hex(manifestBytes),
    },
    {
      length: moduleBytes.byteLength,
      path: modulePath,
      sha256: await sha256Hex(moduleBytes),
    },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const unsignedEnvelope = {
    algorithm: 'Ed25519',
    entries,
    fingerprint: FIXTURE_FINGERPRINT,
    format: 'myrelith-plugin-signature',
    formatVersion: 1,
    publicKey: FIXTURE_PUBLIC_KEY,
  }
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(hex(FIXTURE_PRIVATE_KEY_PKCS8)).buffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    Uint8Array.from(utf8(JSON.stringify(unsignedEnvelope))).buffer,
  ))
  const signatureBytes = utf8(JSON.stringify({
    ...unsignedEnvelope,
    signature: base64url(signature),
  }))
  return storedZip([
    { path: 'manifest.json', bytes: manifestBytes },
    { path: modulePath, bytes: moduleBytes },
    { path: 'signature.json', bytes: signatureBytes },
  ])
}

function goldenEntries(overrides: Partial<Record<string, Uint8Array>> = {}): ArchiveEntry[] {
  return [
    { path: 'manifest.json', bytes: overrides['manifest.json'] ?? utf8(MANIFEST_JSON) },
    { path: 'runtime/plugin.wasm', bytes: overrides['runtime/plugin.wasm'] ?? hex(WASM_HEX) },
    { path: 'signature.json', bytes: overrides['signature.json'] ?? utf8(SIGNATURE_JSON) },
  ]
}

function markFirstEntryAsUnixSymlink(archive: Uint8Array): Uint8Array {
  const output = archive.slice()
  const endOffset = output.byteLength - 22
  const end = new DataView(output.buffer, output.byteOffset + endOffset, 22)
  const centralOffset = end.getUint32(16, true)
  const central = new DataView(output.buffer, output.byteOffset + centralOffset, 46)
  central.setUint16(4, (3 << 8) | 20, true)
  central.setUint32(38, (0o120777 << 16) >>> 0, true)
  return output
}

function corruptFirstEntryChecksum(archive: Uint8Array): Uint8Array {
  const output = archive.slice()
  const endOffset = output.byteLength - 22
  const end = new DataView(output.buffer, output.byteOffset + endOffset, 22)
  const centralOffset = end.getUint32(16, true)
  new DataView(output.buffer, output.byteOffset, 30).setUint32(14, 0, true)
  new DataView(output.buffer, output.byteOffset + centralOffset, 46).setUint32(16, 0, true)
  return output
}

describe('signed plugin package verification', () => {
  test.each(hostileArchiveFixtures())(
    'rejects independently built hostile archive $id ($expectedGate)',
    async ({ build }) => {
      await expect(verifyPluginPackageArchive(build())).rejects.toEqual(
        expect.objectContaining<Partial<PluginPackageError>>({
          name: 'PluginPackageError',
          code: 'archive-invalid',
        }),
      )
    },
  )

  test('accepts the complete canonical Ed25519 golden package', async () => {
    const archive = storedZip(goldenEntries())
    const verified = await verifyPluginPackageArchive(archive)

    expect(verified).toMatchObject({
      packageDigest: 'sha256:cb47299284c74ad83fce88a8c2d50af97e9de6f6d56513f9e07ac7dac2851d97',
      signerFingerprint: 'sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
      modulePath: 'runtime/plugin.wasm',
      moduleSha256: 'a14d35d3869f4460413d414bef13e060c7e20c9a37f27a91a2cab8a6d8e79915',
      manifest: {
        id: 'com.example.fixture',
        version: '1.0.0',
      },
      compatibility: {
        status: 'compatible',
      },
    })
    expect([...verified.manifestBytes]).toEqual([...utf8(MANIFEST_JSON)])
    expect([...verified.moduleBytes]).toEqual([...hex(WASM_HEX)])
    expect(verified.moduleByteLength).toBe(hex(WASM_HEX).byteLength)
    expect([...verified.signatureBytes]).toEqual([...utf8(SIGNATURE_JSON)])
    expect([...verified.archiveBytes]).toEqual([...archive])
  })

  test('rejects a ZIP entry marked as a Unix symlink', async () => {
    const archive = markFirstEntryAsUnixSymlink(storedZip(goldenEntries()))

    await expect(verifyPluginPackageArchive(archive)).rejects.toEqual(
      expect.objectContaining<Partial<PluginPackageError>>({
        name: 'PluginPackageError',
        code: 'archive-invalid',
      }),
    )
  })

  test('rejects an oversized manifest from central framing before payload CRC work', async () => {
    const archive = corruptFirstEntryChecksum(storedZip(goldenEntries({
      'manifest.json': new Uint8Array(65_537),
    })))

    await expect(verifyPluginPackageArchive(archive)).rejects.toThrow(
      'Package entry manifest.json must be between 1 and 65536 bytes.',
    )
  })

  test('rejects a correctly signed WebAssembly entry shorter than eight bytes', async () => {
    const archive = await signedArchive(
      MANIFEST_JSON,
      'runtime/plugin.wasm',
      new Uint8Array(7),
    )

    await expect(verifyPluginPackageArchive(archive)).rejects.toThrow(
      'Package entry runtime/plugin.wasm must be between 8 and 33554432 bytes.',
    )
  })

  test('yields to the host while checksumming a large package entry', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const archive = storedZip(goldenEntries({
      'runtime/plugin.wasm': new Uint8Array(1024 * 1024 + 1),
    }))

    try {
      await expect(verifyPluginPackageArchive(archive)).rejects.toThrow(
        'The signed entry table does not exactly match the package entries.',
      )
      expect(timer).toHaveBeenCalled()
    } finally {
      timer.mockRestore()
    }
  })

  test('accepts a canonically sorted runtime entry before manifest.json', async () => {
    const runtimePath = '0.wasm'
    const manifest = MANIFEST_JSON.replace('runtime/plugin.wasm', runtimePath)
    const archive = await signedArchive(manifest, runtimePath, hex(WASM_HEX))

    await expect(verifyPluginPackageArchive(archive)).resolves.toMatchObject({
      modulePath: runtimePath,
      manifest: {
        runtime: { entry: runtimePath },
      },
    })
  })

  test('never exposes the retained verified module buffer to caller mutation', async () => {
    const verified = await verifyPluginPackageArchive(storedZip(goldenEntries()))
    const callerCopy = verified.moduleBytes
    callerCopy[0] = 0xff

    expect([...verified.moduleBytes]).toEqual([...hex(WASM_HEX)])
    expect(verified.moduleBytes).not.toBe(callerCopy)
  })

  test('snapshots the archive before asynchronous verification yields', async () => {
    const archive = storedZip(goldenEntries())
    const original = archive.slice()
    const verification = verifyPluginPackageArchive(archive)
    archive.fill(0)

    const verified = await verification
    const callerCopy = verified.archiveBytes
    callerCopy.fill(0xff)

    expect([...verified.archiveBytes]).toEqual([...original])
    expect(verified.archiveBytes).not.toBe(callerCopy)
  })

  test('rejects an oversized outer archive before copying caller bytes', async () => {
    const archive = new Uint8Array(32 * 1024 * 1024 + 1)
    const copy = vi.spyOn(archive, 'slice')

    await expect(verifyPluginPackageArchive(archive)).rejects.toThrow(
      'Plugin packages must not exceed 33554432 bytes.',
    )
    expect(copy).not.toHaveBeenCalled()
  })

  test('deep-freezes verified manifest and compatibility metadata', async () => {
    const verified = await verifyPluginPackageArchive(storedZip(goldenEntries()))

    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.manifest)).toBe(true)
    expect(Object.isFrozen(verified.manifest.api)).toBe(true)
    expect(Object.isFrozen(verified.manifest.contributions)).toBe(true)
    expect(Object.isFrozen(verified.manifest.contributions[0])).toBe(true)
    expect(Object.isFrozen(verified.compatibility)).toBe(true)
    expect(Object.isFrozen(verified.compatibility.permissions)).toBe(true)
    expect(Object.isFrozen(verified.compatibility.permissions[0])).toBe(true)
  })
})
