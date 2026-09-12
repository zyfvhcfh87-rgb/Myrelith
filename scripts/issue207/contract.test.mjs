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
  SCHEMA,
} from './protocol.mjs'
import { assertPinnedVocabulary, vocabularyBlocks } from './inventory.mjs'

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
