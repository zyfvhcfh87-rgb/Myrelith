import { candidateById } from '../../ranking.mjs'

export const candidate = candidateById('honesty-audio')
export const expectedCodecs = Object.freeze({
  'pcm-s16.wav': 'pcm-s16',
  'mp3.mp3': 'mp3',
  'flac.flac': 'flac',
  'vorbis.ogg': 'vorbis',
})
