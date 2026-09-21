import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CANDIDATES, RUBRIC } from './ranking.mjs'
import { evaluateCandidate, evaluateAll } from './decision.mjs'
import {
  FORBIDDEN_VOCABULARY,
  MEDIABUNNY_AUDIO_CODECS,
  MEDIABUNNY_VIDEO_CODECS,
  PRODUCT_DECODER_PATHS,
  PRODUCT_EXPORT_PAIRS,
  PUBLIC_SUPPORT_CLAIM,
  SCHEMA,
} from './protocol.mjs'
import { assertPinnedVocabulary, vocabularyBlocks } from './inventory.mjs'
import { selectPrimaryBundle } from './sizes.mjs'
import { assertResearchClaim, decodeCell, renderMarkdown } from './summary.mjs'

const root = process.cwd()

test('ranking is complete, unique, and recorded before any decoder', () => {
  assert.equal(CANDIDATES.length, 7)
  assert.deepEqual(CANDIDATES.map((candidate) => candidate.rank), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(new Set(CANDIDATES.map((candidate) => candidate.id)).size, 7)
  assert.ok(RUBRIC.length >= 4)
  const ranking = readFileSync(resolve(root, 'scripts/issue207/ranking.mjs'), 'utf8')
  assert.match(ranking, /Recorded before any decoder/)
  assert.match(ranking, /PRIVACY.md/)
})

test('pinned Mediabunny vocabulary matches the contract and excludes forbidden names', () => {
  const vocabulary = assertPinnedVocabulary()
  assert.equal(vocabulary.mediabunny, '1.50.9')
  assert.deepEqual(vocabulary.videoCodecs, [...MEDIABUNNY_VIDEO_CODECS])
  assert.deepEqual(vocabulary.audioCodecs, [...MEDIABUNNY_AUDIO_CODECS])
  for (const token of FORBIDDEN_VOCABULARY) {
    assert.equal(MEDIABUNNY_VIDEO_CODECS.includes(token), false)
    assert.equal(MEDIABUNNY_AUDIO_CODECS.includes(token), false)
  }
  assert.equal(vocabularyBlocks('mpeg2'), true)
  assert.equal(vocabularyBlocks('dnxhd'), true)
  assert.equal(vocabularyBlocks('avc'), false)
})

test('product decoder paths and export pairs stayed closed', () => {
  const compatibility = readFileSync(resolve(root, 'src/domain/mediaCompatibility.ts'), 'utf8')
  assert.match(compatibility, /export type MediaDecoderPath =/)
  assert.match(compatibility, /'native'/)
  assert.match(compatibility, /'local-prores'/)
  assert.match(compatibility, /'local-ac3'/)
  assert.doesNotMatch(compatibility, /local-hevc|local-mpeg2|local-dts|ffmpeg/)
  const fallbacks = readFileSync(resolve(root, 'src/codecs/mediaCodecFallbacks.ts'), 'utf8')
  assert.match(fallbacks, /export type LocalDecoderId = 'prores' \| 'ac3'/)
  assert.doesNotMatch(fallbacks, /registerAc3Encoder/)
  const exportProfile = readFileSync(resolve(root, 'src/domain/exportProfile.ts'), 'utf8')
  for (const pair of PRODUCT_EXPORT_PAIRS) {
    assert.ok(exportProfile.includes(`container: '${pair.container}'`))
    assert.ok(exportProfile.includes(`videoCodec: '${pair.videoCodec}'`))
  }
  assert.deepEqual(PRODUCT_DECODER_PATHS, ['native', 'local-prores', 'local-ac3'])
})

test('paper no-go candidates never require a WASM spike', () => {
  const empty = { demux: {}, browser: null, product: { registersAc3Encoder: false } }
  for (const id of ['mpeg2-dts', 'mxf-dnx', 'braw-r3d-hap']) {
    const decision = evaluateCandidate(id, empty)
    assert.equal(decision.recommendation, 'no-go')
    assert.match(decision.reason, /vocabulary|Blocked/)
    assert.equal(decision.childShape, null)
  }
})

test('honesty-audio is a docs child only after named demux, not a new decoder', () => {
  const demux = {
    'pcm-s16.wav': { tracks: [{ kind: 'audio', codec: 'pcm-s16', canDecode: true }] },
    'mp3.mp3': { tracks: [{ kind: 'audio', codec: 'mp3', canDecode: false }] },
    'flac.flac': { tracks: [{ kind: 'audio', codec: 'flac', canDecode: false }] },
    'vorbis.ogg': { tracks: [{ kind: 'audio', codec: 'vorbis', canDecode: false }] },
  }
  const decision = evaluateCandidate('honesty-audio', { demux })
  assert.equal(decision.recommendation, 'bounded-child')
  assert.equal(decision.childShape, 'docs-fixtures-media-pool-copy')
  assert.match(decision.reason, /no new decoder/)
})

test('AC-3/ProRes encode and HEVC software fallback stay no-go', () => {
  const encode = evaluateCandidate('ac3-prores-encode', {
    demux: {},
    browser: { encoders: { video: [], audio: [] } },
    product: { registersAc3Encoder: false },
  })
  assert.equal(encode.recommendation, 'no-go')
  assert.match(encode.reason, /Issue #16|encoder fallback/)
  const hevc = evaluateCandidate('hevc-software-fallback', { demux: {}, browser: { fixtures: {} } })
  assert.equal(hevc.recommendation, 'no-go')
})

test('public support claim stays false', () => {
  assert.equal(PUBLIC_SUPPORT_CLAIM, false)
  assert.throws(() => assertResearchClaim({ publicSupportClaim: true }), /publicSupportClaim/)
  assert.doesNotThrow(() => assertResearchClaim({ publicSupportClaim: false }))
})

test('primary bundle selection ignores umd copies and reports the real script', () => {
  const bundle = selectPrimaryBundle([
    { path: 'node_modules/turbores/dist/turbores.umd.cjs', bytes: 189948 },
    { path: 'node_modules/turbores/dist/turbores.js', bytes: 200453 },
    { path: 'node_modules/turbores/dist/turbores.d.ts', bytes: 12869 },
    { path: 'node_modules/@mediabunny/ac3/dist/bundles/mediabunny-ac3.min.js', bytes: 900000 },
    { path: 'node_modules/@mediabunny/ac3/dist/bundles/mediabunny-ac3.js', bytes: 1154782 },
  ])
  assert.equal(bundle.path, 'node_modules/@mediabunny/ac3/dist/bundles/mediabunny-ac3.js')
  const turbo = selectPrimaryBundle([
    { path: 'node_modules/turbores/dist/turbores.umd.cjs', bytes: 189948 },
    { path: 'node_modules/turbores/dist/turbores.js', bytes: 200453 },
  ])
  assert.equal(turbo.path, 'node_modules/turbores/dist/turbores.js')
})

test('measured-run markdown records the required gates without a support claim', () => {
  const ready = {
    canRead: true,
    format: { name: 'MP4' },
    decode: {
      video: { ok: true },
      audio: { ok: true },
      ok: true,
    },
    sequential: {
      video: { ok: true, count: 30, ownedAfter: 0 },
      audio: { ok: true, count: 40, ownedAfter: 0 },
    },
    correctness: {
      video: { kind: 'video', rgb: [49, 91, 125], matchesFixtureColor: true },
      audio: { kind: 'audio', finite: true, peak: 0, nearSilence: true },
    },
    throughput: { videoSamplesPerSecond: 100, audioFramesPerSecond: 48000 },
    knownResources: { peakOwnedRgbaBytes: 320 * 180 * 4, nativeRss: 'unmeasured' },
    avSync: { applicable: true, withinOneFrame: true },
    audioClock: { applicable: true, clockAdvanced: true, derivedFrame: 3, withinOneFrame: true },
    cdpJsHeapBefore: 1000,
    cdpJsHeapAfter: 1200,
    cancel: { rejected: true, disposed: true },
  }
  const markdown = renderMarkdown({
    schema: SCHEMA,
    publicSupportClaim: false,
    machine: { platform: 'linux', arch: 'x64' },
    decisions: [{ id: 'honesty-audio', recommendation: 'bounded-child' }],
    demux: { 'pcm-s16.wav': { format: { name: 'WAVE' }, tracks: [{ kind: 'audio', codec: 'pcm-s16', canDecode: true }] } },
    browser: {
      host: { userAgent: 'HeadlessChrome', crossOriginIsolated: false, hevcHardwareObservation: false, av1HardwareObservation: true },
      fixtures: { 'avc-aac.mp4': ready },
      encoders: { video: [{ id: 'avc', supported: true }], audio: [] },
      fallbacks: {
        registerMs: 0,
        direct: { prores: { tracks: [{ kind: 'video', nativeCanDecode: false }] }, ac3: { tracks: [{ kind: 'audio', nativeCanDecode: false }] } },
        fallback: {
          prores: { tracks: [{ kind: 'video', nativeCanDecode: true }], decode: { video: { ok: true } }, sequential: { video: { count: 30, ownedAfter: 0 } }, durationMs: 12 },
          ac3: { tracks: [{ kind: 'audio', nativeCanDecode: true }], decode: { audio: { ok: false } }, sequential: { audio: { count: 0, ownedAfter: 0 } }, durationMs: 8 },
        },
        encoderRegistration: false,
      },
      recovery: { decodeCancel: { 'pcm-s16.wav': { rejected: true, disposed: true, ownedAfter: 0 } } },
    },
    sizes: { payloads: [{ packageName: 'turbores', license: 'MPL-2.0', totalBytes: 10, primaryBundle: { bytes: 200453, path: 'node_modules/turbores/dist/turbores.js' } }] },
  })
  assert.equal(decodeCell(ready), 'ready')
  assert.match(markdown, /publicSupportClaim/)
  assert.match(markdown, /Correctness, seek, throughput, memory/)
  assert.match(markdown, /Failure recovery/)
  assert.match(markdown, /Firefox and Safari/)
  assert.match(markdown, /turbores\.js/)
  assert.doesNotMatch(markdown, /primary bundle/)
  assert.throws(() => renderMarkdown({
    schema: SCHEMA,
    publicSupportClaim: true,
    machine: { platform: 'linux', arch: 'x64' },
    decisions: [],
    demux: {},
    sizes: { payloads: [] },
  }), /publicSupportClaim/)
})

test('evaluateAll covers every ranked candidate exactly once', () => {
  const decisions = evaluateAll({
    demux: {
      'pcm-s16.wav': { tracks: [{ codec: 'pcm-s16' }] },
      'mp3.mp3': { tracks: [{ codec: 'mp3' }] },
      'flac.flac': { tracks: [{ codec: 'flac' }] },
      'vorbis.ogg': { tracks: [{ codec: 'vorbis' }] },
      'avc-aac.mov': { tracks: [{ codec: 'avc' }, { codec: 'aac' }] },
      'avc-aac.ts': { tracks: [{ codec: 'avc' }, { codec: 'aac' }] },
      'mpeg2-aac.ts': { tracks: [{ kind: 'audio', codec: 'aac' }] },
    },
    browser: { fixtures: {}, encoders: { video: [], audio: [] } },
    product: { registersAc3Encoder: false },
  })
  assert.equal(decisions.length, CANDIDATES.length)
  assert.equal(new Set(decisions.map((entry) => entry.id)).size, CANDIDATES.length)
  assert.ok(decisions.every((entry) => entry.recommendation === 'bounded-child' || entry.recommendation === 'no-go'))
  assert.equal(SCHEMA, 'myrelith-issue207-v1')
})
