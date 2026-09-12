/** Shared Issue #207 evidence schema. Research only; not a product module. */

export const SCHEMA = 'myrelith-issue207-v1'

export const PATH_KINDS = Object.freeze(['direct', 'fallback'])

export const CELL_VALUES = Object.freeze([
  'ready',
  'limited',
  'unsupported',
  'error',
  'n/a',
  'U',
])

export const PRODUCT_DECODER_PATHS = Object.freeze([
  'native',
  'local-prores',
  'local-ac3',
])

export const PRODUCT_EXPORT_PAIRS = Object.freeze([
  Object.freeze({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac' }),
  Object.freeze({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' }),
  Object.freeze({ container: 'webm', videoCodec: 'av1', audioCodec: 'opus' }),
  Object.freeze({ container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' }),
])

export const MEDIABUNNY_VIDEO_CODECS = Object.freeze([
  'avc', 'hevc', 'vp9', 'av1', 'vp8', 'prores',
])

export const MEDIABUNNY_AUDIO_CODECS = Object.freeze([
  'aac', 'opus', 'mp3', 'vorbis', 'flac', 'ac3', 'eac3',
  'pcm-s16', 'pcm-s16be', 'pcm-s24', 'pcm-s24be', 'pcm-s32', 'pcm-s32be',
  'pcm-f32', 'pcm-f32be', 'pcm-f64', 'pcm-f64be', 'pcm-u8', 'pcm-s8',
  'ulaw', 'alaw',
])

export const MEDIABUNNY_FORMAT_NAMES = Object.freeze([
  'HLS', 'MP4', 'QTFF', 'MATROSKA', 'WEBM', 'WAVE', 'OGG', 'FLAC', 'MP3', 'ADTS', 'MPEG_TS',
])

export const FORBIDDEN_VOCABULARY = Object.freeze([
  'mpeg2', 'mpeg-2', 'mp2v', 'dts', 'dnxhd', 'dnxhr', 'dnx', 'mxf',
  'cineform', 'hap', 'braw', 'r3d',
])

export const RECOMMENDATIONS = Object.freeze(['bounded-child', 'no-go'])

export const UNMEASURED_BROWSERS = Object.freeze(['firefox', 'safari'])

export function isCellValue(value) {
  return CELL_VALUES.includes(value)
}

export function errorMessage(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
