import { describe, expect, test } from 'vitest'
import { expandedTitleProject, legacyTitleProject } from '../test/titleOwnerFixtures'
import { projectTitleOwnershipError, MAX_PROJECT_TITLE_ELEMENTS } from './titleOwnership'
import { proceduralTextAssetId } from './textOverlay'
import { sequenceProjectWithinEditBudget } from './projectSequences'
import { createProjectFileSnapshot, parseProjectFile, serializeProjectFile } from './projectFile'
import type { Clip } from './schema'

function projectWithClips(clips: Clip[]) {
  const project = legacyTitleProject()
  return { ...project, sequences: project.sequences.map((sequence, index) => ({ ...sequence,
    tracks: sequence.tracks.map((track, trackIndex) => trackIndex ? track : { ...track,
      clips: clips.slice(index * Math.ceil(clips.length / 2), (index + 1) * Math.ceil(clips.length / 2)),
    }),
  })) }
}
function identity(clip: Clip, index: number): Clip {
  const id = `title-${index}`
  return { ...clip, id, assetId: proceduralTextAssetId(id), timelineRange: { startFrame: index * 100, durationFrames: 100 } }
}

describe('all-sequence title logical-element and text counts', () => {
  test('admits 100,000 logical elements across dormant future owners and compact text, then rejects one more', () => {
    const base = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const legacy = legacyTitleProject().sequences[0].tracks[0].clips[0]
    // Unknown definitions conservatively reserve all sixteen possible elements.
    const clips = Array.from({ length: MAX_PROJECT_TITLE_ELEMENTS / 16 - 1 }, (_, index) => identity({ ...base, title: { version: 2 } }, index))
    for (let index = 0; index < 16; index++) clips.push(identity({ ...legacy, text: { ...legacy.text!, content: '' } }, clips.length))
    const exact = projectWithClips(clips)
    expect(projectTitleOwnershipError(exact)).toBeNull()
    expect(sequenceProjectWithinEditBudget(exact)).toBe(true)
    const file = serializeProjectFile(createProjectFileSnapshot(exact, []))
    expect(file.length).toBeLessThan(10_000_000)
    expect(parseProjectFile(file).sequences).toHaveLength(2)
    const over = projectWithClips([...clips, identity(legacy, clips.length)])
    expect(projectTitleOwnershipError(over)).toMatch(/100,000 logical/)
    expect(sequenceProjectWithinEditBudget(over)).toBe(false)
    expect(() => createProjectFileSnapshot(over, [])).toThrow(/100,000 logical/)
  }, 30_000)

  test('counts all opaque payload strings plus known compact text toward 10m independently of the file cap', () => {
    const base = expandedTitleProject().sequences[0].tracks[0].clips[0]
    const legacy = legacyTitleProject().sequences[0].tracks[0].clips[0]
    const content = '界'.repeat(20_000)
    const clips = Array.from({ length: 499 }, (_, index) => identity({ ...base, title: { version: 2, payload: content } }, index))
    clips.push(identity({ ...legacy, text: { ...legacy.text!, content } }, clips.length))
    expect(projectTitleOwnershipError(projectWithClips(clips))).toBeNull()
    const over = [...clips, identity({ ...base, title: { version: 2, hidden: 'x' } }, clips.length)]
    expect(projectTitleOwnershipError(projectWithClips(over))).toMatch(/10,000,000 text/)
    expect(sequenceProjectWithinEditBudget(projectWithClips(over))).toBe(false)
  })
})
