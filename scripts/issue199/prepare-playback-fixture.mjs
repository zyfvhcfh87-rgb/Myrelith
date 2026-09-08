// Source-only preparation. No browser, playback, encoder, or listening server.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const productSource = '75b89ef6b70460a03ea99ca44d888b5ec06373ec'
const output = new URL('./fixtures/playback/', import.meta.url)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } }).trim()
const productDiff = () => git('diff', productSource, '--', 'src', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json')
assert.equal(productDiff(), '')
const originalHead = git('rev-parse', 'HEAD')
const preserved = {
  'mixed.myrelith': 'e510cb67197ed771049dea65cfccf02820d4550841f6b32dde9ac6c0f4618ac0',
  'dense.myrelith': '26814d074c6e94230b1e3004c863d32490bd84cd266123c27720f228b851c574',
  'many-lanes.myrelith': '2461ff539f8db3515c5845dbdbe1d3427fbe792d8a852906c6504f74221fda4c',
  'continuation/dense-scalar.myrelith': '2518406e6d2759bb7a8cdceb0d2d555ec460c0e34130325fa61f4b9b775dadbf',
}
const checkPreserved = () => {
  for (const [name, expected] of Object.entries(preserved)) assert.equal(hash(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))), expected, name)
}
checkPreserved()

// Exact integer triangle, 250 Hz, opposite stereo channels, peak 1536/32768.
// The signal is non-silent; the browser's existing --mute-audio controls output.
const sampleRate = 48000, channels = 2, seconds = 30, bitsPerSample = 16
const sampleFrames = sampleRate * seconds, blockAlign = channels * bitsPerSample / 8
const wav = Buffer.alloc(44 + sampleFrames * blockAlign)
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22)
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * blockAlign, 28)
wav.writeUInt16LE(blockAlign, 32); wav.writeUInt16LE(bitsPerSample, 34)
wav.write('data', 36); wav.writeUInt32LE(sampleFrames * blockAlign, 40)
for (let frame = 0; frame < sampleFrames; frame++) {
  const phase = frame % 192, value = phase < 96 ? -1536 + 32 * phase : 4608 - 32 * phase
  wav.writeInt16LE(value, 44 + frame * blockAlign)
  wav.writeInt16LE(-value, 46 + frame * blockAlign)
}
const input = new Input({ source: new BufferSource(wav), formats: ALL_FORMATS })
let probe
try {
  const audio = await input.getPrimaryAudioTrack()
  assert.ok(audio); assert.equal(await input.getPrimaryVideoTrack(), null)
  probe = { codec: await audio.getCodec(), sampleRate: await audio.getSampleRate(), channels: await audio.getNumberOfChannels(), firstTimestamp: await input.getFirstTimestamp(), durationSeconds: await input.computeDuration() }
  assert.deepEqual(probe, { codec: 'pcm-s16', sampleRate, channels, firstTimestamp: 0, durationSeconds: seconds })
} finally { input.dispose() }

const server = await createServer({ root, configFile: false, envFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
try {
  const { parseProjectFile, serializeProjectFile } = await server.ssrLoadModule('/src/domain/projectFile.ts')
  const { descriptorMatches } = await server.ssrLoadModule('/src/app/projectMediaMatching.ts')
  const { createSourceBoundsCatalog } = await server.ssrLoadModule('/src/domain/crossfadePlan.ts')
  const { createProjectTimelineAudioMixPlan } = await server.ssrLoadModule('/src/domain/projectAudioMixPlan.ts')
  const original = parseProjectFile(readFileSync(new URL('./fixtures/mixed.myrelith', import.meta.url), 'utf8'))
  const file = structuredClone(original), descriptor = file.assets.find((asset) => asset.id === 'audio-asset')
  assert.equal(descriptor.size, 1)
  descriptor.size = wav.length
  const restored = structuredClone(file)
  restored.assets.find((asset) => asset.id === 'audio-asset').size = 1
  assert.deepEqual(restored, original, 'Only the supplemental audio descriptor size may change')
  const analyzed = { ...descriptor, frameRate: null, sourceBounds: { video: null, audio: { status: 'exact', firstTimestampUs: 0, endTimestampUs: seconds * 1000000 } } }
  assert.equal(descriptorMatches(original.assets.find((asset) => asset.id === descriptor.id), analyzed), false)
  assert.equal(descriptorMatches(descriptor, analyzed), true)
  const catalog = createSourceBoundsCatalog(file.assets)
  const plans = Object.fromEntries(file.sequences.map((sequence) => [sequence.id, createProjectTimelineAudioMixPlan(file, sequence.id, catalog)]))
  const audioDependencies = Object.fromEntries(Object.entries(plans).map(([id, plan]) => [id, plan.clips.map((clip) => ({ clipId: clip.clipId, assetId: clip.assetId, startFrame: clip.timelineStartFrame, endFrame: clip.timelineEndFrame }))]))
  assert.deepEqual(audioDependencies, { root: [{ clipId: 'ordinary-audio', assetId: 'audio-asset', startFrame: 0, endFrame: 60 }], dormant: [] })
  assert.deepEqual(plans.root.mutedClips, [])
  const serialized = serializeProjectFile(file)
  assert.equal(serializeProjectFile(parseProjectFile(serialized)), serialized)
  const projectBytes = Buffer.from(serialized + '\n')
  const files = { 'silent-offline.wav': wav, 'mixed-playback.myrelith': projectBytes }
  const manifest = {
    productSource, generatorSha256: hash(readFileSync(fileURLToPath(import.meta.url))), preserved,
    scope: 'Supplemental gestures-only input. Original portable bytes retained; only audio-asset.size corrected for the actual Relink file-input path. Browser output remains muted.',
    pcm: { container: 'RIFF/WAVE', formatTag: 1, bitsPerSample, sampleRate, channels, sampleFrames, durationMicroseconds: seconds * 1000000, headerBytes: 44, dataBytes: wav.length - 44, dataSha256: hash(wav.subarray(44)), signal: 'For phase=frame%192: left=phase<96 ? -1536+32*phase : 4608-32*phase; right=-left. Signed little-endian 16-bit interleaved stereo. No random values or timestamps.' },
    metadataProbe: { library: 'mediabunny 1.50.9', ...probe, qualification: 'Host demux/metadata only; no browser compatibility probe, decoding, playback, PCM output, or export acceptance.' },
    canonicalValidation: { audioDescriptorSize: { before: 1, after: wav.length }, allOtherPortableFieldsEqual: true, canonicalRoundTripExact: true, originalRelinkSizeRejected: true, supplementalMetadataMatchAccepted: true, audioDependencies },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])),
  }
  checkPreserved(); assert.equal(productDiff(), ''); assert.equal(git('rev-parse', 'HEAD'), originalHead)
  mkdirSync(output, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(new URL(name, output), bytes)
  writeFileSync(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
} finally { await server.close() }
