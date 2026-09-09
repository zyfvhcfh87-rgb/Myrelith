import { createTextClip } from '../domain/operations/creation'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { createProjectFileSnapshot, serializeProjectFile, CURRENT_TIMELINE_SCHEMA_VERSION, type ProjectFile } from '../domain/projectFile'
import { proceduralTextAssetId } from '../domain/textOverlay'
import type { SequenceProject } from '../domain/projectSequences'
import { attributeClip } from './clipAttributeFixtures'
import { ATTRIBUTE_ASSET_DESCRIPTOR, scalarKey } from './animationFoundationFixtures'

/** Canonical bounded historical wire, padded through real text fields only. */
export function exactLegacyTitleFile(characters: number, schema: 21 | 22 = 22, media = true): string {
  const sequences = ['root', 'dormant'].map((id) => structuredClone(createTimelineDoc(id, DEFAULT_PROJECT_SETTINGS, id)))
  for (const sequence of sequences) {
    for (const track of sequence.tracks) track.id = `${sequence.id}-${track.id}`
    for (let index = 0; index < 300; index++) {
      const clip = createTextClip(sequence, 60 + index * 30, 30, index === 1 ? '世界 😀\u0000 e\u0301\n' : '')
      clip.id = `${sequence.id}-text-${index}`; clip.assetId = proceduralTextAssetId(clip.id)
      clip.name = 'A'.repeat(77) + '...'
      sequence.tracks[0].clips.push(clip)
    }
  }
  if (media) {
    const clip = attributeClip('dormant-media')
    clip.animation = { tracks: [{ property: 'opacity', keyframes: [scalarKey(0, 0.25), scalarKey(10, 1)] }], effectTracks: [] }
    sequences[1].tracks[0].clips.unshift(clip)
  }
  if (schema === 22) {
    const clip = sequences[1].tracks[0].clips.at(-1)!
    clip.animation = { ...clip.animation!, titleTracks: [{ elementId: 'reserved-orphan', propertyVersion: 77, property: 'future-position', keyframes: [scalarKey(-10, 1e5), scalarKey(75, -1e5)] }] }
  }
  const file = createProjectFileSnapshot({ id: 'title-boundary', name: 'Title boundary', rootSequenceId: 'root', sequences, multicams: [], colorLuts: [] }, media ? [ATTRIBUTE_ASSET_DESCRIPTOR] : [])
  let remaining = characters - serializeProjectFile(file).length
  if (remaining < 0) throw new Error('Boundary target is below fixture metadata size.')
  for (const sequence of file.sequences) for (const clip of sequence.tracks[0].clips) if (clip.text) {
    const count = Math.min(20_000 - clip.text.content.length, remaining)
    clip.text.content += 'A'.repeat(count)
    remaining -= count
  }
  if (remaining !== 0) throw new Error('Boundary target exceeds bounded fixture text capacity.')
  const encoded = serializeProjectFile(file).replaceAll(`"schemaVersion":${CURRENT_TIMELINE_SCHEMA_VERSION}`, `"schemaVersion":${schema}`)
  if (encoded.length !== characters) throw new Error('Canonical fixture size differs from its target.')
  return encoded
}

export function titleProjectFromFile(file: ProjectFile): SequenceProject {
  return { id: file.id, name: file.name, rootSequenceId: file.rootSequenceId, sequences: file.sequences, multicams: file.multicams, colorLuts: file.colorLuts }
}
