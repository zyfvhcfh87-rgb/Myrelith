/**
 * Three-layer inventory: demux / decode / encode.
 * Import and export stay in separate columns. This module reads pinned
 * Mediabunny and the product allow-lists; it does not register decoders.
 */

import {
  ALL_FORMATS,
  AUDIO_CODECS,
  PCM_AUDIO_CODECS,
  VIDEO_CODECS,
} from 'mediabunny'
import {
  FORBIDDEN_VOCABULARY,
  MEDIABUNNY_AUDIO_CODECS,
  MEDIABUNNY_FORMAT_NAMES,
  MEDIABUNNY_VIDEO_CODECS,
  PRODUCT_DECODER_PATHS,
  PRODUCT_EXPORT_PAIRS,
} from './protocol.mjs'

const FORMAT_EXPORT_NAME = {
  'HTTP Live Streaming (HLS)': 'HLS',
  'MP4': 'MP4',
  'QuickTime File Format': 'QTFF',
  'Matroska': 'MATROSKA',
  'WebM': 'WEBM',
  'WAVE': 'WAVE',
  'Ogg': 'OGG',
  'FLAC': 'FLAC',
  'MP3': 'MP3',
  'ADTS': 'ADTS',
  'MPEG Transport Stream': 'MPEG_TS',
}

function formatToken(format) {
  return FORMAT_EXPORT_NAME[format.name] ?? format.name
}

export function pinnedVocabulary() {
  const formats = ALL_FORMATS.map((format) => ({
    token: formatToken(format),
    name: format.name,
    mimeType: format.mimeType,
  }))
  return {
    mediabunny: '1.50.9',
    formats,
    formatTokens: formats.map((entry) => entry.token),
    videoCodecs: [...VIDEO_CODECS],
    audioCodecs: [...AUDIO_CODECS],
    pcmAudioCodecs: [...PCM_AUDIO_CODECS],
  }
}

export function assertPinnedVocabulary() {
  const vocabulary = pinnedVocabulary()
  const missingVideo = MEDIABUNNY_VIDEO_CODECS.filter((codec) => !VIDEO_CODECS.includes(codec))
  const extraVideo = VIDEO_CODECS.filter((codec) => !MEDIABUNNY_VIDEO_CODECS.includes(codec))
  const missingAudio = MEDIABUNNY_AUDIO_CODECS.filter((codec) => !AUDIO_CODECS.includes(codec))
  const extraAudio = AUDIO_CODECS.filter((codec) => !MEDIABUNNY_AUDIO_CODECS.includes(codec))
  const missingFormats = MEDIABUNNY_FORMAT_NAMES.filter((token) => !vocabulary.formatTokens.includes(token))
  if (missingVideo.length || extraVideo.length || missingAudio.length || extraAudio.length || missingFormats.length) {
    throw new Error(
      'Pinned Mediabunny vocabulary drifted from the Issue #207 contract: '
        + JSON.stringify({ missingVideo, extraVideo, missingAudio, extraAudio, missingFormats }),
    )
  }
  return vocabulary
}

export function vocabularyBlocks(name) {
  const lowered = String(name).toLowerCase()
  return FORBIDDEN_VOCABULARY.some((token) => lowered.includes(token))
}

/**
 * Static inventory rows for formats the product already talks about or
 * Mediabunny already names. Decode/encode cells are filled by the lab.
 */
export function staticInventoryRows() {
  return [
    row('avc', 'video', 'MP4 / MOV / MPEG-TS / MKV', 'native canDecode', 'allow-listed MP4+AVC+AAC'),
    row('hevc', 'video', 'MP4 / MOV / MPEG-TS', 'native canDecode; never Auto', 'explicit MP4+HEVC+AAC only'),
    row('vp8', 'video', 'WebM / MKV', 'native canDecode', 'not an export pair'),
    row('vp9', 'video', 'WebM / MKV', 'native canDecode', 'allow-listed WebM+VP9+Opus'),
    row('av1', 'video', 'WebM / MKV', 'native canDecode', 'allow-listed WebM+AV1+Opus; Auto may select'),
    row('prores', 'video', 'MOV / MP4', 'local-prores fallback after native miss', 'no encoder fallback'),
    row('aac', 'audio', 'MP4 / MOV / MPEG-TS / ADTS', 'native canDecode', 'allow-listed with AVC/HEVC'),
    row('ac3', 'audio', 'MKV / MPEG-TS', 'local-ac3 fallback after native miss', 'encoder exists in package, not wired'),
    row('eac3', 'audio', 'MKV / MPEG-TS', 'shared local-ac3 family', 'no encoder path'),
    row('mp3', 'audio', 'MP3 / MPEG-TS', 'native canDecode if browser supports', 'not a classic export pair'),
    row('opus', 'audio', 'WebM / MKV / OGG', 'native canDecode', 'allow-listed with VP9/AV1'),
    row('vorbis', 'audio', 'OGG / MKV', 'native canDecode if browser supports', 'not an export pair'),
    row('flac', 'audio', 'FLAC / MKV', 'native canDecode if browser supports', 'not a classic export pair'),
    row('pcm-s16', 'audio', 'WAVE', 'Mediabunny PCM path; no AudioDecoder required', 'Issue #204 WAV delivery is export-only PCM'),
    row('mpeg-ts-unnamed', 'container', 'MPEG-TS', 'named AVC/AAC/MP3/AC-3 only; others omitted', 'n/a'),
    row('hls-blob', 'container', 'HLS', 'BlobSource is not a PathedSource; fail closed', 'not an export source'),
    row('mxf', 'container', 'MXF', 'not in ALL_FORMATS', 'n/a'),
    row('mpeg2', 'video', 'MPEG-TS / MXF / MKV', 'not in VIDEO_CODECS; TS omits the stream', 'n/a'),
    row('dts', 'audio', 'MKV / TS', 'not in AUDIO_CODECS', 'n/a'),
    row('dnx', 'video', 'MXF / MOV', 'not in VIDEO_CODECS', 'n/a'),
  ]
}

function row(id, kind, demux, decode, encode) {
  return { id, kind, demux, decode, encode }
}

export function productPolicy() {
  return {
    decoderPaths: [...PRODUCT_DECODER_PATHS],
    exportPairs: PRODUCT_EXPORT_PAIRS.map((pair) => ({ ...pair })),
    localEncoderFallback: false,
    silentSubstitution: false,
    runtimeCdn: false,
    unrestrictedFfmpeg: false,
  }
}
