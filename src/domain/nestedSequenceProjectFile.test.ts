import { describe, expect, test } from 'vitest'
import type { SequenceInstance, TimelineDoc, Track } from './schema'
import {
  CURRENT_TIMELINE_SCHEMA_VERSION,
  ProjectFileError,
  createProjectFileSnapshot,
  parseProjectFile,
  serializeProjectFile,
} from './projectFile'
import type { SequenceProject } from './projectSequences'

function nested(
  id: string,
  sequenceId: string,
  sourceStartFrame = 0,
): SequenceInstance {
  return {
    kind: 'sequence',
    id,
    name: id,
    sequenceId,
    sourceStartFrame,
    timelineRange: { startFrame: 0, durationFrames: 20 },
  }
}

function track(id: string, instances: SequenceInstance[] = []): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips: [],
    sequenceInstances: instances,
    adjustments: [],
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    volume: 1,
    balance: 0,
    audioEffects: [],
  }
}

function sequence(id: string, instances: SequenceInstance[] = []): TimelineDoc {
  return {
    schemaVersion: CURRENT_TIMELINE_SCHEMA_VERSION,
    id,
    name: id,
    frameRate: { num: 30, den: 1 },
    width: 1_920,
    height: 1_080,
    audioSampleRate: 48_000,
    tracks: [track(`${id}-track`, instances)],
    markers: [],
    captionTracks: [],
    masterAudio: { volume: 1, balance: 0, muted: false, audioEffects: [] },
  }
}

function project(...sequences: TimelineDoc[]): SequenceProject {
  return {
    id: 'nested-project',
    name: 'Nested project',
    rootSequenceId: sequences[0].id,
    sequences,
  }
}

describe('nested sequence project-file seam', () => {
  test('schema 18 migrates every historical track to an empty instance list', () => {
    const historical = createProjectFileSnapshot(project(sequence('root')), [])
    const value = JSON.parse(JSON.stringify(historical)) as Record<string, unknown>
    const sequences = value.sequences as Array<Record<string, unknown>>
    sequences[0].schemaVersion = 18
    const tracks = sequences[0].tracks as Array<Record<string, unknown>>
    delete tracks[0].sequenceInstances

    const parsed = parseProjectFile(JSON.stringify(value))

    expect(parsed.sequences[0].schemaVersion).toBe(19)
    expect(parsed.sequences[0].tracks[0].sequenceInstances).toEqual([])
  })

  test('round-trips live references through the allowlisted portable snapshot', () => {
    const child = sequence('child')
    const root = sequence('root', [nested('root-child-video', 'child', 7)])

    const snapshot = createProjectFileSnapshot(project(root, child), [])
    const parsed = parseProjectFile(serializeProjectFile(snapshot))

    expect(parsed.sequences[0].tracks[0].sequenceInstances).toEqual([
      nested('root-child-video', 'child', 7),
    ])
  })

  test('rejects missing refs and dormant cycles before returning a project', () => {
    const validMissingBase = createProjectFileSnapshot(project(
      sequence('root'),
      sequence('dormant', [nested('missing', 'absent')]),
      sequence('absent'),
    ), [])
    const missing = JSON.parse(serializeProjectFile(validMissingBase)) as {
      sequences: TimelineDoc[]
    }
    missing.sequences = missing.sequences.filter((item) => item.id !== 'absent')
    expect(() => parseProjectFile(JSON.stringify(missing))).toThrow(ProjectFileError)
    expect(() => parseProjectFile(JSON.stringify(missing))).toThrow(/missing sequence/u)

    const validCycleBase = createProjectFileSnapshot(project(
      sequence('root'),
      sequence('dormant-a'),
      sequence('dormant-b'),
    ), [])
    const cycle = JSON.parse(serializeProjectFile(validCycleBase)) as {
      sequences: TimelineDoc[]
    }
    cycle.sequences[1].tracks[0].sequenceInstances = [
      nested('a-b', 'dormant-b'),
    ]
    cycle.sequences[2].tracks[0].sequenceInstances = [
      nested('b-a', 'dormant-a'),
    ]
    expect(() => parseProjectFile(JSON.stringify(cycle))).toThrow(/cycle/u)
  })

  test('rejects unknown sequence-instance fields', () => {
    const snapshot = createProjectFileSnapshot(project(
      sequence('root', [nested('root-child', 'child')]),
      sequence('child'),
    ), [])
    const value = JSON.parse(serializeProjectFile(snapshot)) as Record<string, unknown>
    const sequences = value.sequences as Array<Record<string, unknown>>
    const tracks = sequences[0].tracks as Array<Record<string, unknown>>
    const instances = tracks[0].sequenceInstances as Array<Record<string, unknown>>
    instances[0].surprise = true

    expect(() => parseProjectFile(JSON.stringify(value))).toThrow(/surprise: unknown field/u)
  })
})
