// Source/artifact qualification only. This script never imports or runs the model.
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = path.join(root, '.tmp/issue201-package-probe')
const output = path.join(root, '.tmp/issue201-speech-lab')
const evidence = path.join(root, 'docs/evidence/issue201')
const hash = (b) => createHash('sha256').update(b).digest('hex')
const transformerVersion = '4.2.0'
const ortVersion = '1.26.0-dev.20260416-b7804b056c'
const commonVersion = '1.24.0-dev.20251116-b39e144322'
await mkdir(path.join(output, 'assets'), { recursive: true })
await mkdir(path.join(output, 'fixtures'), { recursive: true })

async function download(url, cap = 2_000_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${response.status}: ${new URL(url).pathname}`)
  let length = 0
  const chunks = []
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > cap) throw new Error('Download exceeds declared cap')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
function member(archive, name) {
  const tar = gunzipSync(archive, { maxOutputLength: 300_000_000 })
  for (let offset = 0; offset + 512 <= tar.length;) {
    const current = tar.subarray(offset, offset + 100).toString().split('\0', 1)[0]
    const length = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString().split('\0', 1)[0].trim(), 8)
    if (!current) break
    if (!Number.isSafeInteger(length) || length < 0 || offset + 512 + length > tar.length) throw new Error('Invalid tar member')
    if (current === `package/${name}`) return Buffer.from(tar.subarray(offset + 512, offset + 512 + length))
    offset += 512 + Math.ceil(length / 512) * 512
  }
  throw new Error(`Missing archive member: ${name}`)
}
async function archive(name, version) {
  const filename = `${name.replaceAll('/', '-').replace('@', '')}-${version}`
  const metadataUrl = `https://registry.npmjs.org/${name}/${version}`
  const metadataBytes = await download(metadataUrl)
  const metadata = JSON.parse(metadataBytes)
  const location = path.join(scratch, `${filename}.tgz`)
  let bytes = await readFile(location).catch((e) => { if (e.code === 'ENOENT') return null; throw e })
  if (!bytes) { bytes = await download(metadata.dist.tarball, 100_000_000); await writeFile(location, bytes) }
  const [algorithm, digest] = metadata.dist.integrity.split('-')
  if (createHash(algorithm).update(bytes).digest('base64') !== digest) throw new Error('npm archive integrity mismatch')
  return { name, version, metadataUrl, metadataSha256: hash(metadataBytes), metadata, bytes }
}
function imports(name, bytes) {
  const text = bytes.toString()
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse module: ${name}`)
  const found = { static: [], dynamic: [] }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      found.static.push({ specifier: node.moduleSpecifier.text, start: node.moduleSpecifier.getStart(source), end: node.moduleSpecifier.end })
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.dynamic.push(node.getText(source).slice(0, 300))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
const transformer = await archive('@huggingface/transformers', transformerVersion)
const ort = await archive('onnxruntime-web', ortVersion)
const transformerSource = member(transformer.bytes, 'dist/transformers.web.js')
const transformerMin = member(transformer.bytes, 'dist/transformers.web.min.js')
const parsedImports = imports('transformers.web.min.js', transformerMin)
if (parsedImports.static.length !== 2 || parsedImports.static.some(({ specifier }) => !['onnxruntime-web/webgpu', 'onnxruntime-common'].includes(specifier))) throw new Error('Unexpected transformer static import closure')
let resolved = transformerMin.toString()
for (const entry of parsedImports.static.slice().sort((a, b) => b.start - a.start)) {
  resolved = resolved.slice(0, entry.start) + '"./ort.wasm.min.mjs"' + resolved.slice(entry.end)
}
const ortBytes = member(ort.bytes, 'dist/ort.wasm.min.mjs')
const ortMap = JSON.parse(member(ort.bytes, 'dist/ort.wasm.min.mjs.map'))
if (ortMap.sources.some((source) => !/^(?:\.\.\/\.\.\/common\/lib\/|\.\.\/lib\/(?:wasm\/|backend-wasm\.ts$|index\.ts$|version\.ts$))/u.test(source))) throw new Error('Unreviewed ORT WASM source-map member')
if (imports('ort.wasm.min.mjs', ortBytes).static.length) throw new Error('ORT WASM has unexpected static imports')
const ortSource = member(ort.bytes, 'dist/ort.wasm.mjs').toString()
if (!ortSource.includes(commonVersion) || !ortSource.includes(ortVersion)) throw new Error('Embedded ORT version differs')
const embeddedDependencies = [...transformerSource.toString().matchAll(/^\/\/ .*node_modules\/\.pnpm\/([^/]+)\/node_modules\/([^\n]+)$/gmu)].map((m) => m[1])
if (embeddedDependencies.join('|') !== '@huggingface+tokenizers@0.1.3|@huggingface+jinja@0.5.6') throw new Error('Unreviewed transformer embedded dependency closure')

const artifacts = []
async function emit(name, bytes, provenance) {
  await writeFile(path.join(output, 'assets', name), bytes)
  artifacts.push({ name, bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length, sha256: hash(bytes), ...provenance })
}
await emit('transformers.local.mjs', Buffer.from(resolved), { source: '@huggingface/transformers@4.2.0/dist/transformers.web.min.js', originalSha256: hash(transformerMin), transform: 'Only replace the two AST-located external module specifiers with ./ort.wasm.min.mjs; no library logic edits.' })
for (const name of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await emit(name, member(ort.bytes, `dist/${name}`), { source: `onnxruntime-web@${ortVersion}/dist/${name}` })
}
await emit('mediabunny.mjs', await readFile(path.join(root, 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs')),
  { source: 'Existing private baseline node_modules/mediabunny@1.50.9/dist/bundles/mediabunny.min.mjs; lab audio adapter support asset.' })

const inventory = [
  ['@huggingface/transformers', transformerVersion], ['@huggingface/tokenizers', '0.1.3'],
  ['@huggingface/jinja', '0.5.6'], ['onnxruntime-web', ortVersion], ['onnxruntime-common', commonVersion],
  ['mediabunny', '1.50.9'],
]
const licenses = []
for (const [name, version] of inventory) {
  const metadataUrl = `https://registry.npmjs.org/${name}/${version}`
  const bytes = await download(metadataUrl)
  const metadata = JSON.parse(bytes)
  licenses.push({ name, version, license: metadata.license, packageIntegrity: metadata.dist.integrity,
    metadataUrl, metadataSha256: hash(bytes) })
}
const notices = []
for (const [name, url] of [
  ['transformers-LICENSE.txt', 'https://raw.githubusercontent.com/huggingface/transformers.js/4.2.0/LICENSE'],
  ['onnxruntime-LICENSE.txt', 'https://raw.githubusercontent.com/microsoft/onnxruntime/b7804b056c/LICENSE'],
  ['onnxruntime-ThirdPartyNotices.txt', 'https://raw.githubusercontent.com/microsoft/onnxruntime/b7804b056c/ThirdPartyNotices.txt'],
]) {
  const bytes = await download(url)
  await writeFile(path.join(output, 'assets', name), bytes)
  notices.push({ name, url, bytes: bytes.length, sha256: hash(bytes) })
}
for (const [name, version] of [['@huggingface/jinja', '0.5.6'], ['@huggingface/tokenizers', '0.1.3']]) {
  const pkg = await archive(name, version)
  const bytes = member(pkg.bytes, 'LICENSE')
  const filename = name.split('/')[1] + '-LICENSE.txt'
  await writeFile(path.join(output, 'assets', filename), bytes)
  notices.push({ name: filename, source: `${name}@${version}/LICENSE`, bytes: bytes.length, sha256: hash(bytes) })
}
const bunnyLicense = await readFile(path.join(root, 'node_modules/mediabunny/LICENSE'))
await writeFile(path.join(output, 'assets/mediabunny-LICENSE.txt'), bunnyLicense)
notices.push({ name: 'mediabunny-LICENSE.txt', source: 'Existing mediabunny@1.50.9/LICENSE', bytes: bunnyLicense.length, sha256: hash(bunnyLicense) })
const auditInput = Object.fromEntries(inventory.map(([name, version]) => [name, [version]]))
const auditResponse = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(auditInput), signal: AbortSignal.timeout(15_000),
})
if (!auditResponse.ok) throw new Error('Public advisory lookup failed')
const advisories = await auditResponse.json()

function waveFacts(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF WAVE fixture')
  let format
  let pcm
  for (let i = 12; i + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', i, i + 4)
    const size = bytes.readUInt32LE(i + 4)
    if (i + 8 + size > bytes.length) throw new Error('Invalid WAV chunk')
    if (name === 'fmt ') format = { codec: bytes.readUInt16LE(i + 8), channels: bytes.readUInt16LE(i + 10), rate: bytes.readUInt32LE(i + 12), bits: bytes.readUInt16LE(i + 22) }
    if (name === 'data') pcm = bytes.subarray(i + 8, i + 8 + size)
    i += 8 + size + size % 2
  }
  if (!format || format.channels !== 1 || !pcm
    || !((format.codec === 1 && format.bits === 16) || (format.codec === 3 && format.bits === 32) || (format.codec === 7 && format.bits === 8))) {
    throw new Error(`Fixture is outside the mono PCM16/Float32/mu-law profile: ${JSON.stringify(format)}`)
  }
  const frames = pcm.length / (format.bits / 8)
  if (!Number.isSafeInteger(frames)) throw new Error('Invalid fixture sample alignment')
  return { ...format, frames, durationSeconds: frames / format.rate }
}
const fixtures = []
for (const [name, dataset, config, split, revision, textKey, licenseUrl] of [
  ['english', 'hf-internal-testing/librispeech_asr_dummy', 'clean', 'validation', '5be91486e11a2d616f4ec5db8d3fd248585ac07a', 'text', 'https://www.openslr.org/12'],
  ['french', 'PolyAI/minds14', 'fr-FR', 'train', '40ce77cb32a384e4d50a568e1ec39ac804019d33', 'transcription', 'https://huggingface.co/datasets/PolyAI/minds14'],
]) {
  const indexUrl = `https://datasets-server.huggingface.co/first-rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${split}`
  const index = JSON.parse(await download(indexUrl))
  const row = index.rows.find((entry) => entry.row_idx === 0).row
  const url = new URL(row.audio[0].src)
  if (url.origin !== 'https://datasets-server.huggingface.co' || url.pathname !== `/assets/${dataset}/--/${revision}/--/${config}/${split}/0/audio/audio.wav`) throw new Error('Fixture revision/path changed')
  const bytes = await download(url.href)
  const facts = waveFacts(bytes)
  if (facts.durationSeconds > 30) throw new Error('Fixture exceeds one inference window')
  await writeFile(path.join(output, 'fixtures', `${name}.wav`), bytes)
  fixtures.push({ name, dataset, revision, config, split, row: 0, originalId: row.id ?? row.path,
    sourceUrl: url.origin + url.pathname, metadataUrl: indexUrl, license: 'CC-BY-4.0', licenseUrl,
    transcript: row[textKey], bytes: bytes.length, sha256: hash(bytes), ...facts })
}
const oldModel = JSON.parse(await readFile(path.join(evidence, 'package-measurements.json'), 'utf8')).model
for (const file of oldModel.files) {
  const bytes = await readFile(path.join(scratch, 'model', file.path))
  if (hash(bytes) !== file.sha256) throw new Error('Original pinned model changed')
}
function monoPcm16Wave(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
const englishBytes = await readFile(path.join(output, 'fixtures/english.wav'))
let englishPcm
for (let offset = 12; offset + 8 <= englishBytes.length;) {
  const size = englishBytes.readUInt32LE(offset + 4)
  if (englishBytes.toString('ascii', offset, offset + 4) === 'data') englishPcm = englishBytes.subarray(offset + 8, offset + 8 + size)
  offset += 8 + size + size % 2
}
if (!englishPcm || fixtures[0].codec !== 1 || fixtures[0].rate !== 16_000 || fixtures[0].bits !== 16) throw new Error('Stress derivative requires the frozen PCM16 English fixture')
const longPcm = Buffer.alloc(300 * 32_000)
for (let offset = 0; offset < longPcm.length; offset += englishPcm.length + 16_000) englishPcm.copy(longPcm, offset, 0, Math.min(englishPcm.length, longPcm.length - offset))
const derivatives = []
for (const [name, bytes, description] of [
  ['english-300.wav', monoPcm16Wave(longPcm), '300 seconds repeating the pinned English recording with 0.5 seconds digital silence between repeats; the final repeat may be cut at the exact limit. Workload stress, not a natural long-form quality fixture.'],
  ['silence.wav', monoPcm16Wave(Buffer.alloc(32_000)), 'Exactly one second of digital silence; no audible tone.'],
  ['corrupt.wav', Buffer.from('Deliberately invalid bounded audio fixture.'), 'Deliberately malformed data for decoder rejection.'],
]) {
  await writeFile(path.join(output, 'fixtures', name), bytes)
  derivatives.push({ name, bytes: bytes.length, sha256: hash(bytes), description })
}
const manifest = {
  kind: 'issue201-speech-lab-assets-v1', preparedAt: new Date().toISOString(),
  qualification: 'Static package/import/notice/advisory/fixture preflight only; inference/offline/memory not yet qualified.',
  runtime: { transformerVersion, ortVersion, commonVersion, device: 'wasm', dtype: 'q8', threads: 1,
    sessionOptions: { graphOptimizationLevel: 'all', extra: { session: { disable_quant_qdq: '1' } } },
    originalImportSpecifiers: parsedImports.static.map(({ specifier }) => specifier),
    embeddedTransformerDependencies: embeddedDependencies, ortWasmSources: ortMap.sources,
    ortWasmMapSha256: hash(member(ort.bytes, 'dist/ort.wasm.min.mjs.map')), artifacts,
    totalRawBytes: artifacts.reduce((n, a) => n + a.bytes, 0), totalGzipBytes: artifacts.reduce((n, a) => n + a.gzipBytes, 0),
    licenses, notices, advisoryInput: auditInput, advisories,
  },
  model: oldModel, fixtures, derivatives,
  thresholds: { maxWindowSeconds: 30, maxJobSeconds: 300, maxNewTokens: 448, maxWindowWallMs: 120_000,
    terminationFallbackMs: 100, maxIncrementalResidentBytes: 1_073_741_824, maxPcmBytes: 3_840_000,
    maxPreparationScratchBytes: 2_097_152, modelCacheByteLimit: 100_663_296,
    englishMaximumWordErrorRate: 0.2, frenchMaximumWordErrorRate: 0.4,
    timestampPolicy: 'Finite positive ordered segment intervals within source coverage; missing endpoints stay visible and prohibit automatic cue apply.',
    silencePolicy: 'All-zero PCM yields empty output without calling inference; this is not a general VAD claim.',
    repeatPolicy: 'Complete 300-second bounded-window workload plus repeated jobs; report residual process memory, do not equate GC timing to live-owner leaks.' },
}
await writeFile(path.join(evidence, 'replacement-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ runtimeBytes: manifest.runtime.totalRawBytes, runtimeGzipBytes: manifest.runtime.totalGzipBytes,
  artifacts, advisories, fixtures }, null, 2))
