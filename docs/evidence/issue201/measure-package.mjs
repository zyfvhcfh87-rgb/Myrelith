/** Read-only upstream measurements. Never imported by the product or a test. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const scratch = path.join(root, '.tmp/issue201-package-probe')
const evidence = path.join(root, 'docs/evidence/issue201/package-measurements.json')
const model = 'Xenova/whisper-tiny'
const revision = '5332fcc35e32a33b86612b9a57a89be7906102b1'
const runtimeVersion = '1.22.0-dev.20250409-89f8206ba4'
const selectedFiles = [
  'config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function read(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Content length exceeds cap')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('Stream exceeds cap')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function tarMembers(gzip) {
  const tar = gunzipSync(gzip, { maxOutputLength: 300_000_000 })
  const members = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().split('\0', 1)[0]
    if (!name) break
    const length = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString().split('\0', 1)[0].trim(), 8)
    if (!Number.isSafeInteger(length) || length < 0 || offset + 512 + length > tar.length) throw new Error('Invalid tar member')
    const body = tar.subarray(offset + 512, offset + 512 + length)
    if (/^package\/dist\/.*(?:\.min\.js|\.mjs|\.wasm)$/u.test(name) || /(?:^|\/)(?:LICENSE|NOTICE|ThirdPartyNotices\.txt)$/u.test(name)) {
      members.push({ path: name, bytes: length, gzipBytes: gzipSync(body, { level: 9 }).length, sha256: hash(body) })
    }
    offset += 512 + Math.ceil(length / 512) * 512
  }
  return members
}

await mkdir(scratch, { recursive: true })
const packages = []
for (const [name, version] of [['@huggingface/transformers', '3.8.1'], ['onnxruntime-web', runtimeVersion]]) {
  const url = `https://registry.npmjs.org/${name}/${version}`
  const metadata = JSON.parse((await read(url, 2_000_000)).toString())
  const tarball = await read(metadata.dist.tarball, 100_000_000)
  const [algorithm, digest] = metadata.dist.integrity.split('-')
  if (createHash(algorithm).update(tarball).digest('base64') !== digest) throw new Error('npm integrity mismatch')
  await writeFile(path.join(scratch, `${name.replaceAll('/', '-').replace('@', '')}-${version}.tgz`), tarball)
  packages.push({ name, version, metadataUrl: url, license: metadata.license,
    dependencies: metadata.dependencies, tarballUrl: metadata.dist.tarball,
    integrity: metadata.dist.integrity, downloadedBytes: tarball.length,
    unpackedBytes: metadata.dist.unpackedSize, members: tarMembers(tarball) })
}

const modelUrl = `https://huggingface.co/api/models/${model}/revision/${revision}?blobs=true`
const metadata = JSON.parse((await read(modelUrl, 2_000_000)).toString())
const files = []
for (const name of selectedFiles) {
  const remote = metadata.siblings.find((file) => file.rfilename === name)
  if (!remote || remote.size > 40_000_000) throw new Error(`Missing or oversized model member: ${name}`)
  const url = `https://huggingface.co/${model}/resolve/${revision}/${name}`
  const bytes = await read(url, 40_000_000)
  const sha256 = hash(bytes)
  if (remote.size !== bytes.length || (remote.lfs && remote.lfs.sha256 !== sha256)) throw new Error('Model integrity mismatch')
  const destination = path.join(scratch, 'model', name)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
  files.push({ path: name, url, bytes: bytes.length, sha256, upstreamBlobId: remote.blobId })
}
const result = {
  measuredAt: new Date().toISOString(), scope: 'Downloaded bytes and npm archive members; no inference, runtime-memory, or application-bundle claim.',
  host: { node: process.version, platform: process.platform, arch: process.arch },
  packages, model: { id: model, revision, metadataUrl: modelUrl, declaredLicense: metadata.cardData?.license,
    files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) },
}
await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ evidence, packages: packages.map(({ name, downloadedBytes, unpackedBytes, members }) => ({ name, downloadedBytes, unpackedBytes, members })), modelBytes: result.model.totalBytes }, null, 2))
