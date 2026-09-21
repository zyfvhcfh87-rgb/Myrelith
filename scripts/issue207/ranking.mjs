/**
 * Frozen demand ranking for Issue #207.
 *
 * Recorded before any decoder, encoder, or production-format change.
 * There is no in-app analytics (PRIVACY.md), so rank uses comparison research,
 * the Issue #19 Limited/Unsupported matrix, camera/phone/pro interchange
 * practice, and advertised-vs-demuxed honesty — never telemetry.
 */

export const RUBRIC = Object.freeze([
  Object.freeze({
    id: 'pro-interchange',
    weight: 1,
    title: 'Professional camera / finishing interchange still failing after ProRes and AC-3',
    examples: 'DNx, MXF, MPEG-2 camera/TS, DTS',
  }),
  Object.freeze({
    id: 'everyday-audio',
    weight: 2,
    title: 'Everyday audio files that Mediabunny already names but the product language under-describes',
    examples: 'WAVE PCM, MP3, FLAC, OGG Vorbis',
  }),
  Object.freeze({
    id: 'phone-native',
    weight: 3,
    title: 'Phone/screen-capture families that are already native-gated',
    examples: 'HEVC, AAC — documentation, not new WASM',
  }),
  Object.freeze({
    id: 'nle-checkbox',
    weight: 4,
    title: 'Desktop-NLE checkbox codecs with no Mediabunny codec or container name',
    examples: 'BRAW, R3D, HAP',
  }),
])

export const RANKING_RECORDED_AT = '2026-09-12T00:00:00Z'
export const RANKING_AUTHORITY = [
  'docs/OPEN_SOURCE_VIDEO_EDITOR_FEATURE_COMPARISON_RESEARCH.md',
  'docs/decisions/ISSUE_19_CODEC_CLOSEOUT.md',
  'docs/decisions/ISSUE_19_PROXY_CONVERSION.md',
  'README.md known limitations',
  'PRIVACY.md (no analytics)',
  'pinned mediabunny 1.50.9 codec/format vocabulary',
]

/**
 * Highest user friction first. This list is the experiment order.
 * It is not permission to implement a decoder.
 */
export const CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'honesty-audio',
    rank: 1,
    rubric: 'everyday-audio',
    title: 'Honesty pass on already-demuxable audio (WAVE PCM, MP3, FLAC, OGG Vorbis)',
    demand:
      'Users bringing .wav / .mp3 / .flac / .ogg hit README language that names video/audio generically while Mediabunny already demuxes those containers. WAVE PCM is already a first-party playback fixture.',
    fixtures: ['pcm-s16.wav', 'mp3.mp3', 'flac.flac', 'vorbis.ogg'],
    paperVocabularyBlock: false,
    browserLab: true,
    defaultRecommendation: 'bounded-child',
    childShape: 'docs-fixtures-media-pool-copy',
  }),
  Object.freeze({
    id: 'mpeg-ts-mov',
    rank: 2,
    rubric: 'pro-interchange',
    title: 'MOV / MPEG-TS wrapping codecs Myrelith already names',
    demand:
      'Camera and broadcast files often arrive as MOV or MPEG-TS around AVC/AAC. Advertised support is MP4/WebM. MPEG-TS silently omits unrecognized stream types instead of reporting them.',
    fixtures: ['avc-aac.mov', 'avc-aac.ts', 'mpeg2-aac.ts'],
    paperVocabularyBlock: false,
    browserLab: true,
    defaultRecommendation: 'bounded-child',
    childShape: 'docs-and-mpegts-omission-diagnostics',
  }),
  Object.freeze({
    id: 'mpeg2-dts',
    rank: 3,
    rubric: 'pro-interchange',
    title: 'MPEG-2 video and DTS audio',
    demand:
      'Issue #19 already saw MPEG-2 as Limited. Broadcast/camera TS and DTS interchange remain high-friction on desktop NLEs.',
    fixtures: ['mpeg2-aac.ts', 'avc-dts.mkv'],
    paperVocabularyBlock: true,
    blockedNames: ['mpeg2', 'dts'],
    browserLab: true,
    defaultRecommendation: 'no-go',
    childShape: null,
  }),
  Object.freeze({
    id: 'mxf-dnx',
    rank: 4,
    rubric: 'pro-interchange',
    title: 'MXF container and DNxHD/HR',
    demand:
      'Finishing interchange after ProRes still names DNx in MXF. Mediabunny 1.50.9 has no MXF format and no dnx codec id.',
    fixtures: ['dnx-or-mpeg2.mxf'],
    paperVocabularyBlock: true,
    blockedNames: ['mxf', 'dnxhd', 'dnxhr'],
    browserLab: false,
    defaultRecommendation: 'no-go',
    childShape: null,
  }),
  Object.freeze({
    id: 'hevc-software-fallback',
    rank: 5,
    rubric: 'phone-native',
    title: 'Software decode fallback for native-but-spotty HEVC',
    demand:
      'Phone capture is often HEVC. Hosts without a hardware decoder report unsupported. A WASM HEVC decoder is a new payload, not a named Mediabunny fallback family.',
    fixtures: ['hevc-aac.mp4'],
    paperVocabularyBlock: false,
    browserLab: true,
    defaultRecommendation: 'no-go',
    childShape: null,
  }),
  Object.freeze({
    id: 'ac3-prores-encode',
    rank: 6,
    rubric: 'pro-interchange',
    title: 'AC-3 or ProRes encode',
    demand:
      '@mediabunny/ac3 ships an unused encoder. ProRes remains decode-only. Architecture and Issue #16 ban local encoder fallbacks.',
    fixtures: [],
    paperVocabularyBlock: false,
    browserLab: true,
    defaultRecommendation: 'no-go',
    childShape: null,
  }),
  Object.freeze({
    id: 'braw-r3d-hap',
    rank: 7,
    rubric: 'nle-checkbox',
    title: 'BRAW, R3D, and HAP',
    demand:
      'Desktop NLE format checkboxes. None appear in Mediabunny 1.50.9 VIDEO_CODECS or ALL_FORMATS.',
    fixtures: ['not-media.braw'],
    paperVocabularyBlock: true,
    blockedNames: ['braw', 'r3d', 'hap'],
    browserLab: false,
    defaultRecommendation: 'no-go',
    childShape: null,
  }),
])

export function candidateById(id) {
  const candidate = CANDIDATES.find((entry) => entry.id === id)
  if (!candidate) throw new Error(`Unknown Issue #207 candidate: ${id}`)
  return candidate
}
