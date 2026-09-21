import { candidateById } from '../../ranking.mjs'

export const candidate = candidateById('mpeg-ts-mov')
export const expectedNamed = Object.freeze({
  'avc-aac.mov': ['avc', 'aac'],
  'avc-aac.ts': ['avc', 'aac'],
})
export const mpeg2MustNotBeNamed = 'mpeg2-aac.ts'
