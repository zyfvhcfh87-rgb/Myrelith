import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDITED_INVERT_EXPORT,
  AUDITED_INVERT_FALSE_PARAMETERS,
  AUDITED_INVERT_MEMORY_PAGES,
  AUDITED_INVERT_PARAMETER_POINTER,
  AUDITED_INVERT_PIXEL_POINTER,
  AUDITED_INVERT_TRUE_PARAMETERS,
  buildAuditedInvertModule,
} from './source/module.mjs'

const SAMPLE_ROOT = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = join(SAMPLE_ROOT, 'manifest.json')
const MODULE_SOURCE_PATH = join(SAMPLE_ROOT, 'source', 'module.mjs')
const VERIFIER_PATH = fileURLToPath(import.meta.url)
const SIGNATURE_FILE = 'signature.json'
const AUDIT_FILE = 'audit.json'
const PACKAGE_FILE = 'audited-invert-v1.myrelith-plugin'
const MODULE_PACKAGE_PATH = 'runtime/audited-invert.wasm'
const EXPECTED_PUBLIC_ARTIFACTS = Object.freeze([
  AUDIT_FILE,
  PACKAGE_FILE,
  SIGNATURE_FILE,
])
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PACKAGE_DIGEST_DOMAIN = new TextEncoder().encode('myrelith-plugin-package-digest-v1\0')

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function expectedManifest() {
  return {
    api: { maxVersion: 1, minVersion: 1 },
    contributions: [{
      contributionVersion: 1,
      descriptorVersion: 1,
      entrypoint: AUDITED_INVERT_EXPORT,
      id: 'invert',
      kind: 'video-effect',
      migrations: [],
      name: 'Audited Invert',
      parameters: [{
        default: true,
        key: 'invert',
        kind: 'boolean',
        name: 'Invert RGB',
      }],
    }],
    id: 'com.myrelith.sample.audited-invert',
    name: 'Audited Invert',
    permissions: [{
      id: 'myrelith.effect.video-frame.rgba8',
      maxVersion: 1,
      minVersion: 1,
      required: true,
    }],
    runtime: {
      entry: MODULE_PACKAGE_PATH,
      kind: 'wasm',
      memoryMaximumPages: AUDITED_INVERT_MEMORY_PAGES,
    },
    schemaVersion: 1,
    version: '1.0.0',
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'canonical JSON cannot contain a non-finite number')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  invariant(value !== null && typeof value === 'object', 'canonical JSON received an unsupported value')
  const record = value
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`
}

function utf8(value) {
  return new TextEncoder().encode(value)
}

function text(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest()
}

function sha256Hex(bytes) {
  return sha256(bytes).toString('hex')
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function decodeBase64url(value, expectedLength, label) {
  invariant(typeof value === 'string' && !value.includes('='), `${label} is not unpadded base64url`)
  const decoded = Buffer.from(value, 'base64url')
  invariant(decoded.byteLength === expectedLength && base64url(decoded) === value, `${label} is not canonical`)
  return decoded
}

function u32BigEndian(value) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff, 'u32 length is invalid')
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function packageDigest(message, signature) {
  return `sha256:${sha256Hex(Buffer.concat([
    PACKAGE_DIGEST_DOMAIN,
    u32BigEndian(message.byteLength),
    message,
    u32BigEndian(signature.byteLength),
    signature,
  ]))}`
}

function crc32(bytes) {
  let value = 0xffff_ffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb8_8320)
    }
  }
  return (value ^ 0xffff_ffff) >>> 0
}

function storedZip(entries) {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  for (const entry of entries) {
    const name = utf8(entry.path)
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30 + name.byteLength + entry.bytes.byteLength)
    local.writeUInt32LE(0x0403_4b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.bytes.byteLength, 18)
    local.writeUInt32LE(entry.bytes.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    Buffer.from(name).copy(local, 30)
    Buffer.from(entry.bytes).copy(local, 30 + name.byteLength)
    localParts.push(local)

    const central = Buffer.alloc(46 + name.byteLength)
    central.writeUInt32LE(0x0201_4b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.bytes.byteLength, 20)
    central.writeUInt32LE(entry.bytes.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE(localOffset, 42)
    Buffer.from(name).copy(central, 46)
    centralParts.push(central)
    localOffset += local.byteLength
  }

  const locals = Buffer.concat(localParts)
  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.byteLength, 12)
  end.writeUInt32LE(locals.byteLength, 16)
  return Buffer.concat([locals, central, end])
}

function canonicalManifestBytes() {
  return utf8(canonicalJson(expectedManifest()))
}

function readCanonicalJson(path, label) {
  const bytes = readFileSync(path)
  invariant(bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf, `${label} has a BOM`)
  const value = JSON.parse(text(bytes))
  invariant(canonicalJson(value) === text(bytes), `${label} is not exact RFC 8785 canonical JSON`)
  return { bytes, value }
}

function releaseState(outputDirectory = SAMPLE_ROOT) {
  const states = EXPECTED_PUBLIC_ARTIFACTS.map((name) => existsSync(join(outputDirectory, name)))
  invariant(states.every((state) => state === states[0]), 'release artifacts are only partially present')
  return states[0] ? 'present' : 'absent'
}

function publicKeyFromRaw(raw) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

function unsignedEnvelope(publicKeyRaw, manifestBytes, moduleBytes) {
  const fingerprint = `sha256:${sha256Hex(publicKeyRaw)}`
  return {
    algorithm: 'Ed25519',
    entries: [
      {
        length: manifestBytes.byteLength,
        path: 'manifest.json',
        sha256: sha256Hex(manifestBytes),
      },
      {
        length: moduleBytes.byteLength,
        path: MODULE_PACKAGE_PATH,
        sha256: sha256Hex(moduleBytes),
      },
    ],
    fingerprint,
    format: 'myrelith-plugin-signature',
    formatVersion: 1,
    publicKey: base64url(publicKeyRaw),
  }
}

function packageBytes(manifestBytes, moduleBytes, signatureBytes) {
  return storedZip([
    { path: 'manifest.json', bytes: manifestBytes },
    { path: MODULE_PACKAGE_PATH, bytes: moduleBytes },
    { path: SIGNATURE_FILE, bytes: signatureBytes },
  ])
}

async function instantiate(moduleBytes) {
  const memory = new WebAssembly.Memory({
    initial: AUDITED_INVERT_MEMORY_PAGES,
    maximum: AUDITED_INVERT_MEMORY_PAGES,
  })
  const result = await WebAssembly.instantiate(moduleBytes, { myrelith: { memory } })
  const render = result.instance.exports[AUDITED_INVERT_EXPORT]
  invariant(typeof render === 'function', 'render export is missing')
  return { memory, render }
}

function invoke(render, memory, parameters, pixels) {
  const bytes = new Uint8Array(memory.buffer)
  bytes.fill(0, AUDITED_INVERT_PARAMETER_POINTER, AUDITED_INVERT_PARAMETER_POINTER + 65_536)
  bytes.set(utf8(parameters), AUDITED_INVERT_PARAMETER_POINTER)
  bytes[AUDITED_INVERT_PIXEL_POINTER - 1] = 0xa5
  bytes.set(pixels, AUDITED_INVERT_PIXEL_POINTER)
  bytes[AUDITED_INVERT_PIXEL_POINTER + pixels.byteLength] = 0x5a
  const parameterBefore = bytes.slice(
    AUDITED_INVERT_PARAMETER_POINTER,
    AUDITED_INVERT_PARAMETER_POINTER + utf8(parameters).byteLength,
  )
  const code = render(
    AUDITED_INVERT_PIXEL_POINTER,
    pixels.byteLength / 4,
    1,
    pixels.byteLength,
    0,
    0,
    30,
    1,
    AUDITED_INVERT_PARAMETER_POINTER,
    utf8(parameters).byteLength,
  )
  return {
    code,
    output: [...bytes.slice(
      AUDITED_INVERT_PIXEL_POINTER,
      AUDITED_INVERT_PIXEL_POINTER + pixels.byteLength,
    )],
    parameterUnchanged: Buffer.from(parameterBefore).equals(Buffer.from(bytes.slice(
      AUDITED_INVERT_PARAMETER_POINTER,
      AUDITED_INVERT_PARAMETER_POINTER + parameterBefore.byteLength,
    ))),
    sentinelsUnchanged: bytes[AUDITED_INVERT_PIXEL_POINTER - 1] === 0xa5
      && bytes[AUDITED_INVERT_PIXEL_POINTER + pixels.byteLength] === 0x5a,
  }
}

async function sourceReport() {
  const manifestOnDisk = readFileSync(MANIFEST_PATH)
  const expectedBytes = canonicalManifestBytes()
  invariant(Buffer.from(manifestOnDisk).equals(Buffer.from(expectedBytes)), 'manifest.json differs from canonical source')
  const moduleBytes = buildAuditedInvertModule()
  invariant(WebAssembly.validate(moduleBytes), 'generated module fails WebAssembly.validate')

  const compiled = new WebAssembly.Module(moduleBytes)
  const imports = WebAssembly.Module.imports(compiled)
  const exports = WebAssembly.Module.exports(compiled)
  invariant(imports.length === 1
    && imports[0].module === 'myrelith'
    && imports[0].name === 'memory'
    && imports[0].kind === 'memory', 'generated module import surface drifted')
  invariant(exports.length === 1
    && exports[0].name === AUDITED_INVERT_EXPORT
    && exports[0].kind === 'function', 'generated module export surface drifted')

  const input = Uint8Array.of(0, 1, 127, 255, 10, 20, 30, 40)
  const expectedInverted = [255, 254, 128, 255, 245, 235, 225, 40]
  const first = await instantiate(moduleBytes)
  const identity = invoke(first.render, first.memory, AUDITED_INVERT_FALSE_PARAMETERS, input)
  const invalid = invoke(first.render, first.memory, '{"invert":null}', input)
  const inverted = invoke(first.render, first.memory, AUDITED_INVERT_TRUE_PARAMETERS, input)
  const repeated = invoke(first.render, first.memory, AUDITED_INVERT_TRUE_PARAMETERS, input)
  const fresh = await instantiate(moduleBytes)
  const freshInverted = invoke(fresh.render, fresh.memory, AUDITED_INVERT_TRUE_PARAMETERS, input)

  invariant(identity.code === 1 && Buffer.from(identity.output).equals(Buffer.from(input)), 'false parameter is not identity')
  invariant(identity.parameterUnchanged && identity.sentinelsUnchanged, 'identity call wrote outside the pixel range')
  invariant(invalid.code === 2 && Buffer.from(invalid.output).equals(Buffer.from(input)), 'invalid parameters changed output')
  invariant(invalid.parameterUnchanged && invalid.sentinelsUnchanged, 'failed call wrote outside the pixel range')
  for (const result of [inverted, repeated, freshInverted]) {
    invariant(result.code === 0, 'true parameter did not succeed')
    invariant(Buffer.from(result.output).equals(Buffer.from(expectedInverted)), 'inverted pixels are not deterministic')
    invariant(result.parameterUnchanged && result.sentinelsUnchanged, 'module wrote outside the exact pixel range')
  }

  return {
    status: 'source-ready',
    releaseState: releaseState(),
    manifestBytes: manifestOnDisk.byteLength,
    manifestSha256: sha256Hex(manifestOnDisk),
    moduleBytes: moduleBytes.byteLength,
    moduleSha256: sha256Hex(moduleBytes),
    moduleSourceSha256: sha256Hex(readFileSync(MODULE_SOURCE_PATH)),
    verifierSha256: sha256Hex(readFileSync(VERIFIER_PATH)),
    abi: {
      entrypoint: AUDITED_INVERT_EXPORT,
      memoryPages: AUDITED_INVERT_MEMORY_PAGES,
      parameterPointer: AUDITED_INVERT_PARAMETER_POINTER,
      pixelPointer: AUDITED_INVERT_PIXEL_POINTER,
    },
    vectors: {
      input: [...input],
      false: { code: identity.code, output: identity.output },
      invalid: { code: invalid.code, output: invalid.output },
      true: { code: inverted.code, output: inverted.output },
      repeated: repeated.output,
      fresh: freshInverted.output,
    },
  }
}

function auditRecord(source, envelope, signatureBytes, signedPayload, archiveBytes) {
  const signature = decodeBase64url(envelope.signature, 64, 'signature')
  return {
    schemaVersion: 1,
    artifact: 'audited-invert-v1',
    source: {
      manifest: { path: 'manifest.json', bytes: source.manifestBytes, sha256: source.manifestSha256 },
      moduleGenerator: { path: 'source/module.mjs', sha256: source.moduleSourceSha256 },
      verifier: { path: 'verify.mjs', sha256: source.verifierSha256 },
      wasm: { path: MODULE_PACKAGE_PATH, bytes: source.moduleBytes, sha256: source.moduleSha256 },
    },
    release: {
      package: { path: PACKAGE_FILE, bytes: archiveBytes.byteLength, sha256: sha256Hex(archiveBytes) },
      signatureEnvelope: { path: SIGNATURE_FILE, bytes: signatureBytes.byteLength, sha256: sha256Hex(signatureBytes) },
      signedPayload: { bytes: signedPayload.byteLength, sha256: sha256Hex(signedPayload) },
      publicKey: envelope.publicKey,
      signerFingerprint: envelope.fingerprint,
      packageDigest: packageDigest(signedPayload, signature),
      privateKeyPersisted: false,
    },
    abi: source.abi,
    vectors: source.vectors,
  }
}

function validateEnvelope(value, manifestBytes, moduleBytes) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'signature envelope is not an object')
  invariant(Object.keys(value).sort().join(',') === [
    'algorithm',
    'entries',
    'fingerprint',
    'format',
    'formatVersion',
    'publicKey',
    'signature',
  ].sort().join(','), 'signature envelope keys drifted')
  invariant(value.algorithm === 'Ed25519'
    && value.format === 'myrelith-plugin-signature'
    && value.formatVersion === 1, 'signature format drifted')
  const publicKeyRaw = decodeBase64url(value.publicKey, 32, 'public key')
  const signature = decodeBase64url(value.signature, 64, 'signature')
  invariant(value.fingerprint === `sha256:${sha256Hex(publicKeyRaw)}`, 'signer fingerprint is invalid')
  const expected = unsignedEnvelope(publicKeyRaw, manifestBytes, moduleBytes)
  invariant(canonicalJson(value.entries) === canonicalJson(expected.entries), 'signed integrity entries drifted')
  const unsigned = { ...value }
  delete unsigned.signature
  const signedPayload = Buffer.from(utf8(canonicalJson(unsigned)))
  invariant(verifyEd25519(null, signedPayload, publicKeyFromRaw(publicKeyRaw), signature), 'Ed25519 signature is invalid')
  return { signedPayload, signature }
}

async function verifyRelease(outputDirectory, strictDirectory = false) {
  invariant(releaseState(outputDirectory) === 'present', 'release artifacts are missing')
  if (strictDirectory) {
    const names = readdirSync(outputDirectory).sort()
    invariant(names.join(',') === [...EXPECTED_PUBLIC_ARTIFACTS].sort().join(','), 'trial output contains a non-public artifact')
  }
  const source = await sourceReport()
  const manifestBytes = readFileSync(MANIFEST_PATH)
  const moduleBytes = Buffer.from(buildAuditedInvertModule())
  const signaturePath = join(outputDirectory, SIGNATURE_FILE)
  const signature = readCanonicalJson(signaturePath, SIGNATURE_FILE)
  const validated = validateEnvelope(signature.value, manifestBytes, moduleBytes)
  const archiveBytes = packageBytes(manifestBytes, moduleBytes, signature.bytes)
  const committedArchive = readFileSync(join(outputDirectory, PACKAGE_FILE))
  invariant(archiveBytes.equals(committedArchive), 'committed package differs from deterministic ZIP reconstruction')
  const expectedAudit = auditRecord(source, signature.value, signature.bytes, validated.signedPayload, archiveBytes)
  const actualAudit = JSON.parse(readFileSync(join(outputDirectory, AUDIT_FILE), 'utf8'))
  invariant(JSON.stringify(actualAudit) === JSON.stringify(expectedAudit), 'audit.json differs from recomputed evidence')
  return {
    status: 'release-verified',
    archiveBytes: archiveBytes.byteLength,
    archiveSha256: sha256Hex(archiveBytes),
    packageDigest: expectedAudit.release.packageDigest,
    signerFingerprint: signature.value.fingerprint,
    publicArtifacts: [...EXPECTED_PUBLIC_ARTIFACTS],
    privateArtifactsWritten: 0,
    source,
  }
}

async function createRelease(outputDirectory, strictDirectory = false) {
  invariant(releaseState(outputDirectory) === 'absent', 'release artifacts already exist; refusing to overwrite')
  mkdirSync(outputDirectory, { recursive: true })
  if (strictDirectory) invariant(readdirSync(outputDirectory).length === 0, 'trial output directory must be empty')
  const source = await sourceReport()
  const manifestBytes = readFileSync(MANIFEST_PATH)
  const moduleBytes = Buffer.from(buildAuditedInvertModule())
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  invariant(publicDer.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX), 'unexpected Ed25519 public-key encoding')
  const publicKeyRaw = publicDer.subarray(ED25519_SPKI_PREFIX.byteLength)
  invariant(publicKeyRaw.byteLength === 32, 'unexpected Ed25519 public-key length')
  const unsigned = unsignedEnvelope(publicKeyRaw, manifestBytes, moduleBytes)
  const signedPayload = Buffer.from(utf8(canonicalJson(unsigned)))
  const signature = signEd25519(null, signedPayload, privateKey)
  invariant(signature.byteLength === 64, 'unexpected Ed25519 signature length')
  const envelope = { ...unsigned, signature: base64url(signature) }
  const signatureBytes = Buffer.from(utf8(canonicalJson(envelope)))
  const archiveBytes = packageBytes(manifestBytes, moduleBytes, signatureBytes)
  const audit = auditRecord(source, envelope, signatureBytes, signedPayload, archiveBytes)

  writeFileSync(join(outputDirectory, SIGNATURE_FILE), signatureBytes, { flag: 'wx' })
  writeFileSync(join(outputDirectory, PACKAGE_FILE), archiveBytes, { flag: 'wx' })
  writeFileSync(join(outputDirectory, AUDIT_FILE), `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx' })
  return verifyRelease(outputDirectory, strictDirectory)
}

function writeManifest() {
  invariant(!existsSync(MANIFEST_PATH), 'manifest.json already exists; refusing to overwrite')
  writeFileSync(MANIFEST_PATH, canonicalManifestBytes(), { flag: 'wx' })
  return { status: 'manifest-written', path: MANIFEST_PATH }
}

function options(argv) {
  const selected = { command: '--check', outputDirectory: SAMPLE_ROOT, json: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--json') selected.json = true
    else if (argument === '--source-check' || argument === '--check' || argument === '--write-manifest' || argument === '--sign-once') {
      selected.command = argument
    } else if (argument === '--trial-sign') {
      selected.command = argument
      const directory = argv[++index]
      invariant(directory !== undefined, '--trial-sign requires an output directory')
      selected.outputDirectory = resolve(directory)
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  return selected
}

async function main() {
  const selected = options(process.argv.slice(2))
  let report
  if (selected.command === '--write-manifest') report = writeManifest()
  else if (selected.command === '--source-check') report = await sourceReport()
  else if (selected.command === '--trial-sign') report = await createRelease(selected.outputDirectory, true)
  else if (selected.command === '--sign-once') report = await createRelease(SAMPLE_ROOT)
  else report = await verifyRelease(SAMPLE_ROOT)
  const output = selected.json ? JSON.stringify(report) : JSON.stringify(report, null, 2)
  process.stdout.write(`${output}\n`)
}

await main()
