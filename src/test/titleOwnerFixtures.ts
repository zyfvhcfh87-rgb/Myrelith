import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../domain/projectSettings'
import { createTextClip } from '../domain/operations/creation'
import { proceduralTextAssetId } from '../domain/textOverlay'
import { upgradeLegacyTextTitle } from '../domain/titleUpgrade'
import type { SequenceProject } from '../domain/projectSequences'
import type { Clip } from '../domain/schema'

export function legacyTitleProject(): SequenceProject {
  const sequences = ['root', 'dormant'].map((id) => {
    const sequence = structuredClone(createTimelineDoc(id, DEFAULT_PROJECT_SETTINGS, id))
    for (const track of sequence.tracks) track.id = `${id}-${track.id}`
    const clip = createTextClip(sequence, 0, 100, 'Title 世界\nSecond line')
    clip.id = `${id}-text`; clip.assetId = proceduralTextAssetId(clip.id)
    sequence.tracks[0].clips.push(clip)
    return sequence
  })
  return { id: 'title-project', name: 'Title project', rootSequenceId: 'root', sequences, multicams: [], colorLuts: [] }
}

export function expandedTitleProject(): SequenceProject {
  const result = upgradeLegacyTextTitle(legacyTitleProject(), 'root', 'root-text', () => 'root-element')
  if (!result.ok) throw new Error(result.reason)
  return result.project
}

export function replaceFirstTitleClip(project: SequenceProject, patch: (clip: Clip) => Clip): SequenceProject {
  const root = project.sequences[0], track = root.tracks[0]
  return { ...project, sequences: [{ ...root, tracks: [{ ...track, clips: [patch(track.clips[0]), ...track.clips.slice(1)] }, ...root.tracks.slice(1)] }, ...project.sequences.slice(1)] }
}
