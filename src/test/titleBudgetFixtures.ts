import { TITLE_LIMITS } from '../domain/titleElements'
import { expandedTitleProject } from './titleOwnerFixtures'
import { proceduralTextAssetId } from '../domain/textOverlay'

/** ASCII JSON with exact measured wire bytes and individually bounded strings. */
export function opaqueTitleWithBytes(size = TITLE_LIMITS.serializedBytes) {
  const payload: string[] = []
  const count = Math.ceil(size / 20_000)
  let remaining = size - JSON.stringify({ version: 2, payload }).length - (3 * count - 1)
  for (let index = 0; index < count; index++) {
    const length = Math.min(20_000, remaining)
    payload.push('a'.repeat(length))
    remaining -= length
  }
  const title = { version: 2, payload }
  if (JSON.stringify(title).length !== size) throw new Error('Incorrect exact-byte title fixture')
  return title
}

/** Eight separate roots per real portable snapshot; clips span both sequences. */
export function opaqueTitleHistoryProject() {
  const project = expandedTitleProject()
  const base = project.sequences[0].tracks[0].clips[0]
  return { ...project, sequences: project.sequences.map((sequence) => ({
    ...sequence, tracks: sequence.tracks.map((track, index) => index ? track : {
      ...track, clips: Array.from({ length: 4 }, (_, index) => {
        const id = `${sequence.id}-opaque-${index}`
        return { ...base, id, assetId: proceduralTextAssetId(id), title: opaqueTitleWithBytes(),
          timelineRange: { startFrame: index * 100, durationFrames: 100 },
        }
      }),
    }),
  })) }
}
